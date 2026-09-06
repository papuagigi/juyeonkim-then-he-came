# ETF 엑스레이 — 내 ETF 바구니, 겹치는 건 없을까?

2026 금융 AI Challenge 출품작 · 팀 **김주연 등장**

사회초년생이 산 ETF 여러 개를 "바구니"로 담으면, 겹치는 종목·몰린 지역·특수 구조(레버리지·커버드콜·합성)를
투시해서 보여 주고, 생성형 AI가 **계산된 근거만으로** 쉬운 말 진단서를 써 주는 웹서비스입니다.
추천·전망은 하지 않고, 사실을 설명하고 "확인해 볼 질문"만 제안합니다.

## 바로 쓰기

- 웹서비스: `https://papuagigi.github.io/juyeonkim-then-he-came/` (정적 화면 — 바구니 투시·겹침·발견·이름 해독·같은 지수 비교는 브라우저 안에서 계산)
- AI 진단서: 위 화면의 "AI 진단서 받기" 버튼. AI 서버(`api/`)가 연결되어 있으면 생성형 AI(HyperCLOVA X 등)가 쓰고,
  없으면 같은 근거로 규칙 기반 진단서를 씁니다. 서비스는 항상 답합니다.

## 구성

```
index.html          화면(단일 페이지, 모바일 우선)
assets/app.js       바구니 · 투시 계산(겹침·실효 비중·구성 비율·발견 규칙) · AI 진단서 호출 · 이름 해독 · 같은 지수 비교
assets/terms.js     이름 해독 사전(운용사 브랜드 · 상품 구조 · 지수 · 자산 · 지역 · 테마)
assets/style.css    화면 꾸밈
config.js           AI 서버 주소 설정(비우면 같은 주소, 없으면 규칙 진단서)
data/etfs.json      국내 상장 ETF 1,162종 속성(기준일 2026-08-22)
data/holdings.json  ETF별 구성종목 74,010건 + 종목 사전 11,351건(기준일 2026-08-21)
api/main.py         AI 진단서 서버(FastAPI) — 근거 → 생성형 AI → 숫자 사후 대조 → 규칙 진단서 대체
tools/build_data.py 미래에셋 AI 페스티벌 지식베이스(DuckDB)에서 data/*.json 을 만드는 스크립트
Dockerfile          AI 서버 컨테이너(Hugging Face Spaces · Render 등)
```

## AI 서버 실행(선택)

```bash
pip install -r requirements.txt
# 셋 중 하나만 환경변수(또는 .env 파일)에 넣으면 됩니다
#   CLOVASTUDIO_API_KEY=...   네이버 HyperCLOVA X(HCX-005)
#   ANTHROPIC_API_KEY=...     Claude
#   OPENAI_API_KEY=...        OpenAI 호환(OPENAI_BASE_URL, OPENAI_MODEL 로 바꿀 수 있음)
uvicorn api.main:app --host 0.0.0.0 --port 7860
```

브라우저에서 `http://localhost:7860/` 을 열면 화면과 AI 진단서가 함께 동작합니다.
정적 화면(GitHub Pages)에서 따로 띄운 AI 서버를 쓰려면 `config.js` 의 `ETF_XRAY_API` 에 서버 주소를 적습니다.

## 데이터 출처와 한계

- 국내 상장 ETF 마스터: 미래에셋증권 AI Festival 제공 데이터(기준일 2026-08-22) — 이름·운용사·기초지수·위험등급·순자산·분배수익률·수익률·변동성.
- ETF 구성종목: 한국거래소 정보데이터시스템에서 직접 수집(기준일 2026-08-21). 국내 주식 구성종목은 비중이 있고,
  해외 주식 구성종목은 원천에 비중이 없어 **종목 이름만** 씁니다. 그래서 겹침은 "비중 기준"(둘 다 비중 공개)과
  "종목 수 기준"(하나라도 비공개)으로 나눠 표시합니다.
- 총보수는 원천 값 보유율이 낮아(18%) 쓰지 않았습니다. 값이 없는 것은 없다고 표시합니다.
- 기준일 이후의 상장·상장폐지·가격 변화는 반영되지 않습니다. 이 서비스는 투자 권유가 아닙니다.

## 데이터 다시 만들기

미래에셋 AI 페스티벌 저장소(`mirae-asset-dev`)가 옆 폴더에 있을 때:

```bash
python tools/build_data.py
```
