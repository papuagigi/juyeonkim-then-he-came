# -*- coding: utf-8 -*-
"""
ETF 엑스레이 — AI 진단서 서버 (FastAPI)

무엇: 화면(index.html)과 데이터(data/*.json)를 그대로 서비스하고,
      POST /api/diagnose 로 "AI 진단서"를 생성형 AI로 써 준다.
어떻게: 화면이 계산한 근거(구성 비율·겹침·발견 목록)를 그대로 받아
      생성형 AI(HyperCLOVA X · Claude · OpenAI 호환 중 설정된 것)에 넘기고,
      돌아온 문장 속 숫자를 근거 숫자와 대조해 근거에 없는 숫자가 든 문장은 지운다.
      AI 키가 없거나 호출이 실패하면 규칙 기반 진단서(템플릿)를 돌려준다 — 서비스는 항상 답한다.

환경변수(하나만 있으면 됨):
  CLOVASTUDIO_API_KEY   네이버 CLOVA Studio (HyperCLOVA X, 기본 모델 HCX-005)
  ANTHROPIC_API_KEY     Anthropic Claude (기본 모델 claude-sonnet-5)
  OPENAI_API_KEY        OpenAI 호환 API (OPENAI_BASE_URL · OPENAI_MODEL 로 변경 가능)
  LLM_PROVIDER          강제 지정: clova | anthropic | openai | none
실행: uvicorn api.main:app --host 0.0.0.0 --port 7860
"""
import json
import os
import re
import time
import uuid

import httpx
from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)


def _load_dotenv():
    """저장소 최상위 .env(커밋되지 않음)의 KEY=VALUE 를 환경변수로 올린다 — 운영체제 환경변수가 우선."""
    p = os.path.join(ROOT, ".env")
    if not os.path.exists(p):
        return
    with open(p, encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            k, v = line.split("=", 1)
            k, v = k.strip(), v.strip().strip('"').strip("'")
            if k and v and not os.environ.get(k):
                os.environ[k] = v


_load_dotenv()

app = FastAPI(title="ETF X-ray AI diagnosis API", docs_url=None, redoc_url=None)
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])

CLOVA_URL = "https://clovastudio.stream.ntruss.com/v3/chat-completions/{model}"
ANTHROPIC_URL = "https://api.anthropic.com/v1/messages"
TIMEOUT = float(os.environ.get("LLM_TIMEOUT", "40"))

SYSTEM_PROMPT = """당신은 사회초년생의 ETF 바구니를 쉬운 말로 설명해 주는 '금융 진단 도우미'입니다.
반드시 지킬 규칙:
1. 아래 [근거]에 있는 사실과 숫자만 사용합니다. 근거에 없는 숫자·상품명·종목명을 지어내지 않습니다.
2. 매수·매도·추천·전망("오를 것", "사세요", "파세요")을 말하지 않습니다. 사실을 설명하고 "확인해 볼 질문"만 제안합니다.
3. 전문용어는 처음 나올 때 괄호로 쉽게 풀어 씁니다. 대학 새내기가 읽어도 이해되는 문장으로 씁니다.
4. 형식은 정확히 아래 세 부분, 각 부분 제목은 그대로 씁니다. 전체 500자 안팎, 불릿은 '-' 로 시작합니다.
[한눈에 보기]
(2~3문장: 바구니가 어떤 성격인지, 가장 눈에 띄는 점)
[발견한 점]
- (근거의 '발견' 항목을 쉬운 말로 3~5개, 각 1~2문장, 숫자는 근거 그대로)
[확인해 볼 질문]
- (스스로 점검할 질문 2~3개, 추천이 아닌 질문 형태)
5. 마지막 줄에 "※ 이 진단은 2026-08-22 기준 공개 데이터로 계산한 사실 설명이며 투자 권유가 아닙니다." 를 그대로 붙입니다."""


def _provider():
    forced = os.environ.get("LLM_PROVIDER", "").strip().lower()
    if forced:
        return forced
    if os.environ.get("CLOVASTUDIO_API_KEY"):
        return "clova"
    if os.environ.get("ANTHROPIC_API_KEY"):
        return "anthropic"
    if os.environ.get("OPENAI_API_KEY"):
        return "openai"
    return "none"


def _evidence_text(payload: dict) -> str:
    """화면이 보낸 근거를 사람이 읽는 줄글로 바꾼다(AI 입력)."""
    lines = []
    basket = payload.get("basket") or []
    total = payload.get("total_amount")
    lines.append("[바구니]")
    for b in basket:
        lines.append(f"- {b.get('name')} : 투자 비중 {b.get('share')}%"
                     + (f", 운용사 {b.get('mgmt')}" if b.get("mgmt") else "")
                     + (f", 기초지수 {b.get('index')}" if b.get("index") else "")
                     + (f", 위험등급 {b.get('risk')}등급" if b.get("risk") else "")
                     + (f", 분배수익률 {b.get('dy')}%" if b.get("dy") is not None else ""))
    if total:
        lines.append(f"- 총 투자금액 {total}원")
    m = payload.get("metrics") or {}
    lines.append("[구성]")
    for key, label in (("asset", "자산 유형"), ("region", "투자 지역"), ("risk", "위험등급")):
        if m.get(key):
            lines.append(f"- {label}: " + ", ".join(f"{k} {v}%" for k, v in m[key].items()))
    if m.get("top_common"):
        lines.append("[여러 ETF에 함께 들어 있는 종목]")
        for t in m["top_common"][:8]:
            s = f"- {t.get('name')}: {t.get('count')}개 ETF에 포함"
            if t.get("exposure") is not None:
                s += f", 확인된 실효 비중 {t.get('exposure')}%"
            lines.append(s)
    if m.get("pairs"):
        lines.append("[ETF끼리 겹침]")
        for p in m["pairs"][:6]:
            lines.append(f"- {p.get('a')} ↔ {p.get('b')}: 겹침 {p.get('overlap')}% ({p.get('basis')})")
    if m.get("weighted_share") is not None:
        lines.append(f"- 비중이 확인되는 ETF의 금액 비중: {m['weighted_share']}%")
    lines.append("[발견]")
    for f in payload.get("findings") or []:
        lines.append(f"- ({f.get('level')}) {f.get('title')}: {f.get('detail')}")
    return "\n".join(lines)


def _numbers(text: str) -> set:
    return set(re.findall(r"\d+(?:[.,]\d+)*", text or ""))


def _norm_num(s: str) -> str:
    s = s.replace(",", "")
    if "." in s:
        s = s.rstrip("0").rstrip(".")
    return s


def post_check(report: str, evidence: str) -> tuple[str, list]:
    """AI 문장 속 숫자를 근거 숫자와 대조 — 근거에 없는 숫자가 든 문장은 지운다(사후 대조)."""
    allowed = {_norm_num(n) for n in _numbers(evidence)}
    allowed |= {"2026", "08", "22", "8", "2", "3", "4", "5", "1", "0", "10", "100", "20", "50", "30", "6"}
    kept, dropped = [], []
    for line in (report or "").splitlines():
        nums = {_norm_num(n) for n in _numbers(line)}
        # 날짜 문구 안의 숫자는 허용
        nums -= {"2026", "08", "22"}
        bad = [n for n in nums if n not in allowed]
        if bad:
            dropped.append({"line": line, "numbers": bad})
        else:
            kept.append(line)
    return "\n".join(kept).strip(), dropped


def fallback_report(payload: dict) -> str:
    """AI 없이도 항상 나가는 규칙 기반 진단서."""
    basket = payload.get("basket") or []
    findings = payload.get("findings") or []
    m = payload.get("metrics") or {}
    names = ", ".join(b.get("name", "") for b in basket)
    region = m.get("region") or {}
    top_region = max(region.items(), key=lambda kv: kv[1])[0] if region else None
    lines = ["[한눈에 보기]",
             f"이 바구니는 ETF {len(basket)}개({names})로 이루어져 있습니다."
             + (f" 투자 지역은 {top_region} 비중이 {region[top_region]}%로 가장 큽니다." if top_region else "")]
    warns = [f for f in findings if f.get("level") == "warn"]
    if warns:
        lines[-1] += f" 눈여겨볼 점이 {len(warns)}가지 있습니다."
    lines.append("[발견한 점]")
    for f in findings[:5]:
        lines.append(f"- {f.get('title')}: {f.get('detail')}")
    if not findings:
        lines.append("- 특별히 겹치거나 몰린 부분은 확인되지 않았습니다.")
    lines.append("[확인해 볼 질문]")
    qs = []
    if any(f.get("code") in ("same_index", "high_overlap") for f in findings):
        qs.append("- 같은 지수를 따르는 ETF를 두 개 이상 가진 이유가 있나요? 하나로 합쳐도 같은 효과인지 확인해 보세요.")
    if any(f.get("code") in ("stock_concentration", "common_stock") for f in findings):
        qs.append("- 여러 ETF에 같은 종목이 겹쳐 들어 있어요. 그 종목이 흔들리면 바구니 전체가 같이 흔들려도 괜찮은가요?")
    if any(f.get("code") in ("leverage", "risk_grade1", "covered_call", "synthetic") for f in findings):
        qs.append("- 상품 이름 속 특수 구조(레버리지·커버드콜·합성)가 무엇을 뜻하는지 '이름 해독' 탭에서 확인했나요?")
    if not qs:
        qs.append("- 이 바구니를 몇 년 동안, 어떤 목적(비상금·주택·노후)으로 들고 갈 계획인가요?")
    qs.append("- 투자 지역이나 자산이 한쪽에 몰려 있다면, 그것이 의도한 선택인지 스스로 물어보세요.")
    lines += qs[:3]
    lines.append("※ 이 진단은 2026-08-22 기준 공개 데이터로 계산한 사실 설명이며 투자 권유가 아닙니다.")
    return "\n".join(lines)


async def call_clova(user_text: str) -> str:
    key = os.environ["CLOVASTUDIO_API_KEY"]
    model = os.environ.get("CLOVA_MODEL", "HCX-005")
    body = {
        "messages": [{"role": "system", "content": SYSTEM_PROMPT}, {"role": "user", "content": user_text}],
        "temperature": 0.3, "topP": 0.8, "maxTokens": 1200, "seed": 7,
    }
    headers = {"Authorization": f"Bearer {key}", "Content-Type": "application/json",
               "X-NCP-CLOVASTUDIO-REQUEST-ID": str(uuid.uuid4())}
    async with httpx.AsyncClient(timeout=TIMEOUT) as c:
        r = await c.post(CLOVA_URL.format(model=model), headers=headers, json=body)
        r.raise_for_status()
        j = r.json()
    return j["result"]["message"]["content"]


async def call_anthropic(user_text: str) -> str:
    key = os.environ["ANTHROPIC_API_KEY"]
    model = os.environ.get("ANTHROPIC_MODEL", "claude-sonnet-5")
    body = {"model": model, "max_tokens": 1200, "temperature": 0.3, "system": SYSTEM_PROMPT,
            "messages": [{"role": "user", "content": user_text}]}
    headers = {"x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json"}
    async with httpx.AsyncClient(timeout=TIMEOUT) as c:
        r = await c.post(ANTHROPIC_URL, headers=headers, json=body)
        r.raise_for_status()
        j = r.json()
    return "".join(p.get("text", "") for p in j.get("content", []) if p.get("type") == "text")


async def call_openai(user_text: str) -> str:
    key = os.environ["OPENAI_API_KEY"]
    base = os.environ.get("OPENAI_BASE_URL", "https://api.openai.com/v1").rstrip("/")
    model = os.environ.get("OPENAI_MODEL", "gpt-4o-mini")
    body = {"model": model, "temperature": 0.3, "max_tokens": 1200,
            "messages": [{"role": "system", "content": SYSTEM_PROMPT}, {"role": "user", "content": user_text}]}
    headers = {"Authorization": f"Bearer {key}", "Content-Type": "application/json"}
    async with httpx.AsyncClient(timeout=TIMEOUT) as c:
        r = await c.post(f"{base}/chat/completions", headers=headers, json=body)
        r.raise_for_status()
        j = r.json()
    return j["choices"][0]["message"]["content"]


CALLERS = {"clova": call_clova, "anthropic": call_anthropic, "openai": call_openai}

# 아주 단순한 호출량 제한(심사용 소규모 트래픽 가정): IP당 분당 12회
_hits: dict = {}


def _rate_ok(ip: str) -> bool:
    now = time.time()
    q = [t for t in _hits.get(ip, []) if now - t < 60]
    if len(q) >= 12:
        _hits[ip] = q
        return False
    q.append(now)
    _hits[ip] = q
    return True


@app.get("/api/health")
async def health():
    return {"status": "ok", "provider": _provider(), "time": time.strftime("%Y-%m-%dT%H:%M:%S")}


@app.post("/api/diagnose")
async def diagnose(request: Request):
    try:
        payload = await request.json()
    except Exception:
        return JSONResponse({"error": "JSON 본문이 필요합니다."}, status_code=400)
    ip = request.client.host if request.client else "?"
    evidence = _evidence_text(payload)
    provider = _provider()
    t0 = time.time()
    if provider == "none" or not _rate_ok(ip):
        return {"report": fallback_report(payload), "provider": "rule", "dropped": [],
                "elapsed": round(time.time() - t0, 2), "evidence": evidence}
    try:
        raw = await CALLERS[provider](f"[근거]\n{evidence}\n\n위 근거만으로 진단서를 써 주세요.")
        report, dropped = post_check(raw, evidence)
        if len(report) < 80:      # 대조 후 남은 내용이 너무 적으면 규칙 진단서로
            return {"report": fallback_report(payload), "provider": "rule(ai-rejected)", "dropped": dropped,
                    "elapsed": round(time.time() - t0, 2), "evidence": evidence}
        return {"report": report, "provider": provider, "dropped": dropped,
                "elapsed": round(time.time() - t0, 2), "evidence": evidence}
    except Exception as e:  # 어떤 오류에도 답은 나간다
        return {"report": fallback_report(payload), "provider": f"rule(ai-error)", "error": str(e)[:200],
                "dropped": [], "elapsed": round(time.time() - t0, 2), "evidence": evidence}


@app.get("/")
async def index():
    return FileResponse(os.path.join(ROOT, "index.html"))


app.mount("/", StaticFiles(directory=ROOT, html=True), name="static")
