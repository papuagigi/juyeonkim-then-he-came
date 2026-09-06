/* ETF 엑스레이 — 화면 로직. 외부 라이브러리 없이 동작한다.
   흐름: 데이터 읽기 → 바구니 담기 → 투시(계산) → 결과 그리기 → AI 진단서(서버, 없으면 규칙 진단서) */
(function () {
  "use strict";
  const $ = (s) => document.querySelector(s);
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const API = (window.ETF_XRAY_API || "").replace(/\/$/, "");
  const AS_OF = "2026-08-22";
  const COLORS = ["#1f5fbf", "#f59f00", "#2b8a3e", "#d9480f", "#7048e8", "#0ca678", "#868e96", "#e64980", "#15aabf", "#5c940d"];
  const TYPE_KO = { KS: "코스피 주식", KQ: "코스닥 주식", KX: "국내 주식", RT: "리츠", FS: "해외 증권", BD: "채권", MM: "단기금융", DV: "파생", EF: "ETF", EN: "ETN", CM: "원자재", OT: "기타" };
  const RISK_KO = { 1: "1등급(매우 높은 위험)", 2: "2등급(높은 위험)", 3: "3등급(다소 높은 위험)", 4: "4등급(보통 위험)", 5: "5등급(낮은 위험)", 6: "6등급(매우 낮은 위험)" };
  const CYCLE_KO = { M: "매월", Q: "분기", S: "반기", A: "연 1회" };
  const BRAND_ALIAS = { "코덱스": "kodex", "타이거": "tiger", "라이즈": "rise", "케이비스타": "rise", "kbstar": "rise", "에이스": "ace", "킨덱스": "ace", "kindex": "ace", "솔": "sol", "플러스": "plus", "아리랑": "plus", "arirang": "plus", "하나로": "hanaro", "키움": "kiwoom", "kosef": "kiwoom", "원": "won", "나스닥": "나스닥", "에스앤피": "s&p", "snp": "s&p", "에센피": "s&p" };
  const SAMPLES = [
    { label: "🇺🇸 미국 빅테크 몰빵형", items: [["TIGER 미국나스닥100", 300], ["KODEX 미국나스닥100", 200], ["TIGER 미국테크TOP10 INDXX", 200], ["TIGER 미국S&P500", 300]] },
    { label: "🇰🇷 국내 대표지수 중복형", items: [["KODEX 200", 300], ["TIGER 200", 300], ["KODEX 200TR", 200], ["KODEX 레버리지", 100], ["KODEX 반도체", 100]] },
    { label: "💸 월배당 커버드콜형", items: [["TIGER 미국배당다우존스", 300], ["SOL 미국배당다우존스", 200], ["KODEX 200타겟위클리커버드콜", 200], ["TIGER 미국배당다우존스타겟커버드콜2호", 200], ["KODEX 미국배당커버드콜액티브", 100]] },
    { label: "⚖️ 골고루 균형형", items: [["KODEX 200", 250], ["TIGER 미국S&P500", 250], ["ACE 국고채10년", 200], ["ACE KRX금현물", 150], ["KODEX 머니마켓액티브", 150]] },
  ];

  let ETFS = [], HOLD = null, byIsin = {}, byName = {}, byCode = {};
  let basket = [];   // [{isin, amount}]
  let last = null;   // 마지막 투시 결과

  // ---------- 숫자 표기 ----------
  const fmt = (n, d = 1) => (n == null || isNaN(n)) ? "–" : Number(n).toLocaleString("ko-KR", { maximumFractionDigits: d, minimumFractionDigits: 0 });
  const pct = (n, d = 1) => (n == null || isNaN(n)) ? "–" : fmt(n, d) + "%";
  const won = (aum) => {
    if (aum == null) return "–";
    if (aum >= 1e12) return fmt(aum / 1e12, 1) + "조원";
    return fmt(aum / 1e8, 0) + "억원";
  };
  const norm = (s) => String(s || "").toLowerCase().replace(/\s+/g, "");

  // ---------- 데이터 ----------
  async function load() {
    const [e, h] = await Promise.all([
      fetch("data/etfs.json").then((r) => r.json()),
      fetch("data/holdings.json").then((r) => r.json()),
    ]);
    ETFS = e.etfs; HOLD = h;
    for (const x of ETFS) { byIsin[x.isin] = x; byName[x.name] = x; if (x.code) byCode[x.code] = x; }
    $("#badge-data").textContent = `국내 상장 ETF ${fmt(e.n, 0)}종 · 구성종목 ${fmt(Object.values(h.etf).reduce((a, v) => a + v.length, 0), 0)}건`;
  }

  // ---------- 검색 ----------
  function search(q) {
    let s = norm(q);
    if (!s) return [];
    for (const [k, v] of Object.entries(BRAND_ALIAS)) s = s.split(k).join(v);
    const toks = s.split(/[\s,]+/).filter(Boolean);
    const out = [];
    for (const x of ETFS) {
      const hay = norm(x.name) + "|" + norm(x.full) + "|" + (x.code || "") + "|" + norm(x.index || "");
      if (toks.every((t) => hay.includes(t))) out.push(x);
      if (out.length > 60) break;
    }
    out.sort((a, b) => (b.aum || 0) - (a.aum || 0));
    return out.slice(0, 8);
  }
  function renderSugg(list) {
    const box = $("#sugg");
    if (!list.length) { box.hidden = true; box.innerHTML = ""; return; }
    box.innerHTML = list.map((x) => `<button type="button" data-isin="${x.isin}"><div class="s-name">${esc(x.name)} <span class="tag gray">${esc(x.code)}</span></div><div class="s-meta">${esc(x.mgmt || "")} · ${esc(x.index || "기초지수 정보 없음")} · 순자산 ${won(x.aum)}</div></button>`).join("");
    box.hidden = false;
  }

  // ---------- 바구니 ----------
  function add(isin, amount = 100) {
    if (!byIsin[isin]) return;
    const cur = basket.find((b) => b.isin === isin);
    if (cur) cur.amount = amount; else basket.push({ isin, amount });
    renderBasket(); save();
  }
  function renderBasket() {
    const ul = $("#basket");
    ul.innerHTML = basket.map((b) => {
      const x = byIsin[b.isin];
      return `<li data-isin="${b.isin}"><div><div class="b-name">${esc(x.name)}</div><div class="b-meta">${esc(x.mgmt || "")} · ${esc(x.index || "기초지수 정보 없음")} · 위험 ${x.risk || "–"}등급</div></div>
        <div><input type="number" min="0" step="10" value="${b.amount}" aria-label="${esc(x.name)} 금액(만원)"><span class="unit">만원</span></div>
        <button class="rm" type="button" aria-label="빼기">×</button></li>`;
    }).join("");
    const total = basket.reduce((a, b) => a + (Number(b.amount) || 0), 0);
    $("#total").textContent = fmt(total, 0); $("#cnt").textContent = basket.length;
    $("#xray").disabled = !(basket.length >= 1 && total > 0);
  }
  function save() { try { localStorage.setItem("xray_basket", JSON.stringify(basket)); } catch (e) { /* 무시 */ } }
  function restore() {
    const m = location.hash.match(/#b=([^&]+)/);
    if (m) {
      basket = [];
      for (const p of decodeURIComponent(m[1]).split(",")) {
        const [code, amt] = p.split(":");
        const x = byCode[code] || byIsin[code];
        if (x) basket.push({ isin: x.isin, amount: Number(amt) || 100 });
      }
      return basket.length > 0;
    }
    try { const s = localStorage.getItem("xray_basket"); if (s) basket = JSON.parse(s).filter((b) => byIsin[b.isin]); } catch (e) { basket = []; }
    return false;
  }
  function shareUrl() {
    const q = basket.map((b) => `${byIsin[b.isin].code}:${b.amount}`).join(",");
    return location.origin + location.pathname + "#b=" + encodeURIComponent(q);
  }

  // ---------- 투시 계산 ----------
  function analyze() {
    const items = basket.filter((b) => Number(b.amount) > 0).map((b) => ({ e: byIsin[b.isin], amount: Number(b.amount) }));
    const total = items.reduce((a, b) => a + b.amount, 0);
    for (const it of items) { it.w = it.amount / total; it.h = HOLD.etf[it.e.isin] || []; it.full = it.h.length > 0 && it.e.nw === it.e.nh; }

    const agg = (key) => { const m = {}; for (const it of items) { const k = it.e[key] || "정보 없음"; m[k] = (m[k] || 0) + it.w * 100; } return Object.fromEntries(Object.entries(m).sort((a, b) => b[1] - a[1]).map(([k, v]) => [k, +v.toFixed(1)])); };
    const region = agg("region"), asset = agg("asset");
    const riskMap = {}; for (const it of items) { const k = it.e.risk ? `${it.e.risk}등급` : "정보 없음"; riskMap[k] = (riskMap[k] || 0) + it.w * 100; }
    const risk = Object.fromEntries(Object.entries(riskMap).sort().map(([k, v]) => [k, +v.toFixed(1)]));
    const wavg = (key) => { let s = 0, c = 0; for (const it of items) if (it.e[key] != null) { s += it.w * it.e[key]; c += it.w; } return c ? { v: s / c, cover: c } : null; };
    const riskAvg = wavg("risk"), dyAvg = wavg("dy"), volAvg = wavg("vol1y"), erAvg = wavg("er1y");

    // 종목 집계
    const sec = {};
    for (const it of items) {
      for (const [i, r] of it.h) {
        const s = sec[i] || (sec[i] = { i, count: 0, cover: 0, exposure: 0, known: 0, etfs: [] });
        s.count += 1; s.cover += it.w; s.etfs.push(it.e.name);
        if (r != null) { s.exposure += it.w * r / 100; s.known += 1; }
      }
    }
    const secList = Object.values(sec);
    const common = secList.filter((s) => s.count >= 2).sort((a, b) => b.count - a.count || b.cover - a.cover).slice(0, 12);
    const weightedShare = items.filter((it) => it.full).reduce((a, it) => a + it.w, 0);
    const exposure = secList.filter((s) => s.exposure > 0).sort((a, b) => b.exposure - a.exposure).slice(0, 10);

    // 쌍 겹침
    const pairs = [];
    for (let a = 0; a < items.length; a++) for (let b = a + 1; b < items.length; b++) {
      const A = items[a], B = items[b];
      if (!A.h.length || !B.h.length) continue;
      let overlap, basis;
      if (A.full && B.full) {
        const mb = new Map(B.h); let s = 0;
        for (const [i, r] of A.h) if (mb.has(i)) s += Math.min(r || 0, mb.get(i) || 0);
        overlap = s; basis = "비중 기준";
      } else {
        const sb = new Set(B.h.map((x) => x[0])); let n = 0;
        for (const [i] of A.h) if (sb.has(i)) n++;
        overlap = 100 * n / Math.min(A.h.length, B.h.length); basis = "종목 수 기준";
      }
      pairs.push({ a: A.e.name, b: B.e.name, overlap: +overlap.toFixed(1), basis, sameIndex: !!(A.e.index && A.e.index === B.e.index) });
    }
    pairs.sort((x, y) => y.overlap - x.overlap);

    const findings = buildFindings({ items, total, region, asset, risk, riskAvg, volAvg, common, exposure, weightedShare, pairs });
    return { items, total, region, asset, risk, riskAvg, dyAvg, volAvg, erAvg, common, exposure, weightedShare, pairs, findings,
      uniqueSec: secList.length, sharedSec: secList.filter((s) => s.count >= 2).length };
  }

  function secName(i) { const s = HOLD.sec[i]; return s[3] ? `${s[3]} (${s[1]})` : s[1]; }
  function secType(i) { return TYPE_KO[HOLD.sec[i][2]] || "기타"; }

  function buildFindings(r) {
    const F = [];
    const names = (arr) => arr.map((x) => x.e.name).join(", ");
    if (r.items.length === 1) F.push({ code: "single", level: "info", title: "ETF가 하나뿐이라 겹침 진단은 없어요", detail: "두 개 이상 담으면 서로 얼마나 겹치는지 보여 드립니다. 아래에서 이 ETF의 구성과 이름 뜻은 확인할 수 있어요." });
    // 같은 지수
    const byIdx = {};
    for (const it of r.items) if (it.e.index) (byIdx[it.e.index] = byIdx[it.e.index] || []).push(it);
    for (const [idx, arr] of Object.entries(byIdx)) if (arr.length >= 2) {
      const share = arr.reduce((a, it) => a + it.w * 100, 0);
      F.push({ code: "same_index", level: "warn", title: `같은 지수를 따르는 ETF를 ${arr.length}개 갖고 있어요`, detail: `${names(arr)}는 모두 '${idx}' 지수를 따릅니다. 이름과 운용사만 다를 뿐 내용물은 거의 같아서, 나눠 산 효과(분산)가 거의 없습니다. 내 돈의 ${share.toFixed(1)}%가 여기에 있어요.` });
    }
    const high = r.pairs.filter((p) => !p.sameIndex && p.overlap >= 70);
    if (high.length) F.push({ code: "high_overlap", level: "warn", title: high.length === 1 ? `${high[0].a}와 ${high[0].b}가 ${high[0].overlap}% 겹쳐요` : `70% 넘게 겹치는 ETF 쌍이 ${high.length}개 있어요`, detail: `${high.map((p) => `${p.a} ↔ ${p.b} ${p.overlap}%(${p.basis})`).join(", ")}. 둘 다 갖고 있으면 한 상품을 두 번 산 것과 비슷합니다.` });
    const mid = r.pairs.filter((p) => !p.sameIndex && p.overlap >= 40 && p.overlap < 70);
    if (mid.length) F.push({ code: "mid_overlap", level: "info", title: mid.length === 1 ? `${mid[0].a}와 ${mid[0].b}가 ${mid[0].overlap}% 겹쳐요` : `40~70% 겹치는 ETF 쌍이 ${mid.length}개 있어요`, detail: `${mid.map((p) => `${p.a} ↔ ${p.b} ${p.overlap}%(${p.basis})`).join(", ")}. 서로 다른 이름이지만 절반 가까이 같은 곳에 투자하고 있어요.` });
    // 공통 종목
    const top = r.common[0];
    if (top && (top.count >= 3 || top.cover >= 0.6)) {
      const others = r.common.slice(0, 3).map((s) => `${secName(s.i)}(${s.count}개)`).join(", ");
      F.push({ code: "common_stock", level: "warn", title: `${secName(top.i)}가 ETF ${top.count}개에 들어 있어요`, detail: `내 돈의 ${(top.cover * 100).toFixed(1)}%가 ${secName(top.i)}를 담은 ETF에 들어 있습니다. 이 종목이 흔들리면 바구니 전체가 같이 흔들립니다. 함께 겹치는 종목: ${others}.` });
    }
    const ex = r.exposure[0];
    if (ex && r.weightedShare >= 0.3 && ex.exposure * 100 >= 15) F.push({ code: "stock_concentration", level: "warn", title: `한 종목(${secName(ex.i)})에 실효 비중 ${(ex.exposure * 100).toFixed(1)}%`, detail: `비중이 공개된 ETF(내 돈의 ${(r.weightedShare * 100).toFixed(0)}%)만으로 계산해도 ${secName(ex.i)} 한 종목이 ${(ex.exposure * 100).toFixed(1)}%입니다. ETF를 여러 개 샀어도 사실상 한 종목에 크게 걸려 있는 셈이에요.` });
    // 지역·자산
    const [r0, rv] = Object.entries(r.region)[0] || [];
    if (r0 && r0 !== "정보 없음" && rv >= 80 && r.items.length >= 2) F.push({ code: "region_concentration", level: "info", title: `투자 지역의 ${rv}%가 ${r0}에 몰려 있어요`, detail: `${r0} 시장이 흔들리면 바구니 전체가 같이 움직입니다.${r0 === "미국" ? " 원화로 보면 환율 변화도 함께 들어옵니다." : ""} 의도한 선택이라면 괜찮지만, 모르고 몰린 것이라면 한 번 생각해 볼 지점이에요.` });
    const eq = r.asset["주식"] || 0;
    if (eq >= 95 && r.items.length >= 2) F.push({ code: "all_equity", level: "info", title: "바구니의 거의 전부가 주식형이에요", detail: `주식형 비중이 ${eq}%입니다. 채권·현금성 자산이 없어서 시장이 크게 내릴 때 완충 장치가 없습니다. 비상금이나 곧 쓸 돈이라면 특히 확인해 보세요.` });
    // 구조
    const lev = r.items.filter((it) => it.e.lev >= 2 || it.e.inverse);
    if (lev.length) F.push({ code: "leverage", level: "warn", title: `레버리지·인버스 상품이 있어요 (${names(lev)})`, detail: `지수의 하루 움직임을 2배로, 또는 반대로 따라가는 상품입니다. 오르내림이 반복되면 지수와 다르게 손실이 쌓일 수 있어 장기 보유용이 아닙니다. 내 돈의 ${(lev.reduce((a, it) => a + it.w, 0) * 100).toFixed(1)}%가 여기에 있어요.` });
    const r1 = r.items.filter((it) => it.e.risk === 1);
    if (r1.length && r1.reduce((a, it) => a + it.w, 0) >= 0.4) F.push({ code: "risk_grade1", level: "warn", title: "위험등급 1등급(매우 높은 위험) 상품이 절반 가까이예요", detail: `${names(r1)}는 판매사가 매기는 6단계 위험등급 중 가장 높은 1등급입니다. 내 돈의 ${(r1.reduce((a, it) => a + it.w, 0) * 100).toFixed(1)}%가 해당합니다.` });
    const cc = r.items.filter((it) => /커버드콜|프리미엄|타겟/.test(it.e.name));
    if (cc.length) F.push({ code: "covered_call", level: "info", title: `커버드콜 계열 상품이 있어요 (${names(cc)})`, detail: `옵션을 팔아 분배금을 높이는 구조라 매달 받는 돈은 많지만, 시장이 크게 오를 때 이익이 제한됩니다. 분배수익률 ${cc.map((it) => `${it.e.name} ${pct(it.e.dy)}`).join(", ")}가 곧 총수익률은 아니라는 점을 기억하세요.` });
    const syn = r.items.filter((it) => it.e.strat === "합성복제");
    if (syn.length) F.push({ code: "synthetic", level: "info", title: `합성복제 상품이 있어요 (${names(syn)})`, detail: "주식을 직접 사지 않고 증권사와 계약(스왑)으로 수익률만 받는 방식입니다. 계약 상대 증권사가 흔들리면 영향이 있을 수 있어요." });
    const small = r.items.filter((it) => it.e.aum != null && it.e.aum < 1e10);
    if (small.length) F.push({ code: "small_aum", level: "info", title: `순자산이 100억원보다 작은 ETF가 있어요 (${names(small)})`, detail: `순자산 ${small.map((it) => `${it.e.name} ${won(it.e.aum)}`).join(", ")}. 규모가 작은 ETF는 거래가 뜸하거나 상장폐지될 가능성이 상대적으로 큽니다.` });
    if (r.volAvg && r.volAvg.v >= 30) F.push({ code: "high_vol", level: "info", title: `지난 1년 변동성이 큰 편이에요 (가중 평균 ${pct(r.volAvg.v)})`, detail: "변동성은 가격이 얼마나 크게 출렁였는지를 나타냅니다. 1년 동안 위아래로 크게 움직였다는 뜻이며, 앞으로도 그렇다는 보장은 없습니다." });
    const monthly = r.items.filter((it) => it.e.dc === "M");
    if (monthly.length && !cc.length) F.push({ code: "monthly", level: "info", title: `매달 분배금을 주는 ETF가 있어요 (${names(monthly)})`, detail: "분배금은 통장에 들어오지만, 그만큼 ETF 가격에서 빠져나갑니다. 재투자할지 생활비로 쓸지 정해 두면 좋아요." });
    if (!F.some((f) => f.level === "warn") && r.items.length >= 2) F.push({ code: "ok", level: "ok", title: "크게 겹치거나 한쪽에 몰린 부분은 보이지 않아요", detail: "ETF끼리 같은 지수를 따르거나 70% 넘게 겹치는 쌍이 없습니다. 아래 구성 비율로 지역·자산이 내가 의도한 대로인지만 확인해 보세요." });
    return F;
  }

  // ---------- 결과 그리기 ----------
  function bar(title, map) {
    const entries = Object.entries(map);
    const seg = entries.map(([k, v], i) => `<span style="width:${v}%;background:${COLORS[i % COLORS.length]}" title="${esc(k)} ${v}%"></span>`).join("");
    const leg = entries.map(([k, v], i) => `<span><i style="background:${COLORS[i % COLORS.length]}"></i>${esc(k)} ${v}%</span>`).join("");
    return `<div class="bar-title"><span>${title}</span></div><div class="bar">${seg}</div><div class="legend">${leg}</div>`;
  }
  function render(r) {
    last = r;
    $("#results").hidden = false; $("#tabs").hidden = false;
    const kpi = [
      [r.items.length, "ETF 개수"], [fmt(r.uniqueSec, 0), "서로 다른 종목 수"], [fmt(r.sharedSec, 0), "2개 이상 ETF에 겹친 종목"],
      [r.riskAvg ? fmt(r.riskAvg.v, 1) + "등급" : "–", "위험등급(가중 평균)"],
      [r.dyAvg ? pct(r.dyAvg.v) : "–", "분배수익률(가중)"], [r.volAvg ? pct(r.volAvg.v) : "–", "지난 1년 변동성(가중)"],
    ];
    $("#kpis").innerHTML = kpi.map(([v, l]) => `<div class="kpi"><b>${v}</b><span>${l}</span></div>`).join("");
    $("#comp").innerHTML = bar("투자 지역", r.region) + bar("자산 유형", r.asset) + bar("위험등급(1등급이 가장 위험)", r.risk);
    const erNote = r.erAvg ? ` 지난 1년 수익률(가중 평균) ${pct(r.erAvg.v)}는 과거 기록일 뿐 앞날을 말해 주지 않습니다.` : "";
    $("#comp-note").textContent = `금액 비중으로 계산했습니다. 기준일 ${AS_OF}.${erNote}`;

    // 쌍
    if (!r.pairs.length) $("#pairs").innerHTML = `<p class="empty">비교할 ETF 쌍이 없어요. ETF를 두 개 이상 담아 보세요.</p>`;
    else $("#pairs").innerHTML = r.pairs.map((p) => `<div class="pair"><div><div class="p-names">${esc(p.a)} ↔ ${esc(p.b)}${p.sameIndex ? '<span class="tag warn">같은 지수</span>' : ""}${p.overlap >= 70 && !p.sameIndex ? '<span class="tag warn">사실상 같은 상품</span>' : ""}</div><div class="p-bar${p.overlap >= 70 ? " warn" : ""}"><span style="width:${Math.min(100, p.overlap)}%"></span></div></div><div><div class="p-pct">${pct(p.overlap)}</div><div class="p-basis">${p.basis}</div></div></div>`).join("");
    // 공통 종목
    if (!r.common.length) $("#common").innerHTML = `<p class="empty">두 개 이상의 ETF에 함께 들어 있는 종목이 없어요.</p>`;
    else $("#common").innerHTML = `<div class="tbl-wrap"><table><thead><tr><th>종목</th><th>유형</th><th class="num">담은 ETF</th><th class="num">담은 ETF 금액 비중</th><th class="num">확인된 실효 비중</th></tr></thead><tbody>` +
      r.common.map((s) => `<tr><td>${esc(secName(s.i))}<div class="note">${esc(s.etfs.join(", "))}</div></td><td>${secType(s.i)}</td><td class="num">${s.count}개</td><td class="num">${pct(s.cover * 100)}</td><td class="num">${s.known ? pct(s.exposure * 100) + (s.known < s.count ? '<span class="tag gray">일부</span>' : "") : '<span class="tag gray">비중 비공개</span>'}</td></tr>`).join("") + `</tbody></table></div>`;
    // 실효 비중
    if (r.exposure.length && r.weightedShare > 0.01) {
      $("#exposure").innerHTML = `<h3>확인된 실효 비중 TOP 10 <span class="tag">비중 공개 ETF = 내 돈의 ${pct(r.weightedShare * 100, 0)}</span></h3><p class="hint">국내 주식을 담은 ETF는 종목별 비중이 공개되어 있어 "내 돈이 실제로 어느 종목에 얼마나 들어가는지"를 계산할 수 있습니다. 해외 주식 구성종목은 원천에 비중이 없어 여기서 빠집니다.</p><div class="tbl-wrap"><table><thead><tr><th>종목</th><th>유형</th><th class="num">실효 비중</th></tr></thead><tbody>` +
        r.exposure.map((s) => `<tr><td>${esc(secName(s.i))}</td><td>${secType(s.i)}</td><td class="num">${pct(s.exposure * 100, 2)}</td></tr>`).join("") + `</tbody></table></div>`;
    } else $("#exposure").innerHTML = `<p class="note">담은 ETF의 구성종목 비중이 원천 데이터에 없어 실효 비중은 계산하지 않았습니다(해외 주식 구성종목은 이름만 제공됨).</p>`;
    // 발견
    $("#findings").innerHTML = r.findings.map((f) => `<div class="finding ${f.level}"><b>${esc(f.title)}</b>${esc(f.detail)}</div>`).join("") || `<p class="empty">특별한 발견이 없습니다.</p>`;
    // AI
    $("#ai-report").hidden = true; $("#ai-report").innerHTML = ""; $("#ai-status").textContent = ""; $("#ai-evidence").hidden = true;
    // 이름 해독
    $("#terms").innerHTML = r.items.map((it) => {
      const terms = decode(it.e.name);
      return `<div class="term-etf"><div class="t-name">${esc(it.e.name)} <span class="tag gray">${esc(it.e.full)}</span></div>` +
        `<div class="note">운용사 ${esc(it.e.mgmt || "–")} · 기초지수 ${esc(it.e.index || "정보 없음")} · ${esc(it.e.strat || "")} · 위험 ${esc(RISK_KO[it.e.risk] || "–")} · 분배 ${esc(CYCLE_KO[it.e.dc] || "–")} ${pct(it.e.dy)} · 순자산 ${won(it.e.aum)} · 상장 ${esc(it.e.listed || "–")}</div>` +
        (terms.length ? terms.map((t) => `<div class="term"><div class="t-key">${esc(t.t)}</div><div>${esc(t.ko)}${t.why ? `<div class="t-why">${esc(t.why)}</div>` : ""}</div></div>`).join("") : `<p class="note">사전에 있는 낱말이 없어요.</p>`) + `</div>`;
    }).join("");
    // 같은 지수
    $("#alts").innerHTML = r.items.map((it) => {
      if (!it.e.index) return `<div class="term-etf"><div class="t-name">${esc(it.e.name)}</div><p class="note">기초지수 정보가 없어 비교하지 않습니다.</p></div>`;
      const alts = ETFS.filter((x) => x.index === it.e.index && x.isin !== it.e.isin).sort((a, b) => (b.aum || 0) - (a.aum || 0)).slice(0, 8);
      if (!alts.length) return `<div class="term-etf"><div class="t-name">${esc(it.e.name)}</div><p class="note">'${esc(it.e.index)}' 지수를 따르는 다른 상장 ETF가 없습니다.</p></div>`;
      const row = (x, me) => `<tr${me ? ' style="background:#eef3fb"' : ""}><td>${esc(x.name)}${me ? '<span class="tag">내 것</span>' : ""}<div class="note">${esc(x.mgmt || "")}</div></td><td class="num">${won(x.aum)}</td><td class="num">${pct(x.dy)}</td><td class="num">${pct(x.er1y)}</td><td class="num">${pct(x.vol1y)}</td><td class="num">${x.risk || "–"}</td></tr>`;
      return `<div class="term-etf"><div class="t-name">${esc(it.e.name)} <span class="tag gray">${esc(it.e.index)}</span></div><div class="tbl-wrap"><table><thead><tr><th>ETF</th><th class="num">순자산</th><th class="num">분배수익률</th><th class="num">1년 수익률</th><th class="num">1년 변동성</th><th class="num">위험</th></tr></thead><tbody>${row(it.e, true)}${alts.map((x) => row(x, false)).join("")}</tbody></table></div></div>`;
    }).join("");
    $("#share-url").value = shareUrl();
    history.replaceState(null, "", "#b=" + encodeURIComponent(basket.map((b) => `${byIsin[b.isin].code}:${b.amount}`).join(",")));
    $("#results").scrollIntoView({ behavior: "smooth", block: "start" });
  }

  // ---------- 이름 해독 ----------
  function decode(name) {
    const out = [], seen = new Set();
    const terms = [...window.ETF_TERMS].sort((a, b) => b.t.length - a.t.length);
    const lat = /^[A-Za-z0-9&()+\-]+$/;
    for (const t of terms) {
      if (seen.has(t.t)) continue;
      let hit = false;
      if (t.kind === "brand") hit = name.toUpperCase().startsWith(t.t.toUpperCase() + " ") || name.toUpperCase().startsWith(t.t.toUpperCase());
      else if (t.t === "금") hit = /금/.test(name) && !/금리|금융|연금|예금|현금|자금|금현물/.test(name);
      else if (t.t === "200") hit = /(^|[^0-9])200($|[^0-9])/.test(name) && !/200선물/.test(name) || /200선물/.test(name);
      else if (lat.test(t.t)) { const re = new RegExp("(^|[^A-Za-z0-9])" + t.t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "($|[^A-Za-z0-9])", "i"); hit = re.test(name); }
      else hit = name.includes(t.t);
      if (hit) { out.push(t); seen.add(t.t); }
    }
    return out;
  }

  // ---------- AI 진단서 ----------
  function payloadFor(r) {
    return {
      basket: r.items.map((it) => ({ name: it.e.name, share: +(it.w * 100).toFixed(1), mgmt: it.e.mgmt, index: it.e.index, risk: it.e.risk, dy: it.e.dy != null ? +it.e.dy.toFixed(2) : null })),
      total_amount: r.total * 10000,
      metrics: { region: r.region, asset: r.asset, risk: r.risk, weighted_share: +(r.weightedShare * 100).toFixed(1),
        top_common: r.common.slice(0, 8).map((s) => ({ name: secName(s.i), count: s.count, cover: +(s.cover * 100).toFixed(1), exposure: s.known ? +(s.exposure * 100).toFixed(1) : null })),
        pairs: r.pairs.slice(0, 6) },
      findings: r.findings.map((f) => ({ code: f.code, level: f.level, title: f.title, detail: f.detail })),
    };
  }
  function ruleReport(p) {   // 서버와 같은 규칙 진단서(서버가 없을 때)
    const names = p.basket.map((b) => b.name).join(", ");
    const reg = Object.entries(p.metrics.region || {})[0];
    const warns = p.findings.filter((f) => f.level === "warn");
    const L = ["[한눈에 보기]", `이 바구니는 ETF ${p.basket.length}개(${names})로 이루어져 있습니다.` + (reg ? ` 투자 지역은 ${reg[0]} 비중이 ${reg[1]}%로 가장 큽니다.` : "") + (warns.length ? ` 눈여겨볼 점이 ${warns.length}가지 있습니다.` : ""), "[발견한 점]"];
    for (const f of p.findings.slice(0, 5)) L.push(`- ${f.title}: ${f.detail}`);
    if (!p.findings.length) L.push("- 특별히 겹치거나 몰린 부분은 확인되지 않았습니다.");
    L.push("[확인해 볼 질문]");
    const codes = new Set(p.findings.map((f) => f.code)); const qs = [];
    if (codes.has("same_index") || codes.has("high_overlap")) qs.push("- 같은 지수를 따르는 ETF를 두 개 이상 가진 이유가 있나요? 하나로 합쳐도 같은 효과인지 확인해 보세요.");
    if (codes.has("common_stock") || codes.has("stock_concentration")) qs.push("- 여러 ETF에 같은 종목이 겹쳐 들어 있어요. 그 종목이 흔들리면 바구니 전체가 같이 흔들려도 괜찮은가요?");
    if (codes.has("leverage") || codes.has("risk_grade1") || codes.has("covered_call") || codes.has("synthetic")) qs.push("- 상품 이름 속 특수 구조(레버리지·커버드콜·합성)가 무엇을 뜻하는지 '이름 해독'에서 확인했나요?");
    if (!qs.length) qs.push("- 이 바구니를 몇 년 동안, 어떤 목적(비상금·주택·노후)으로 들고 갈 계획인가요?");
    qs.push("- 투자 지역이나 자산이 한쪽에 몰려 있다면, 그것이 의도한 선택인지 스스로 물어보세요.");
    L.push(...qs.slice(0, 3));
    L.push("※ 이 진단은 2026-08-22 기준 공개 데이터로 계산한 사실 설명이며 투자 권유가 아닙니다.");
    return L.join("\n");
  }
  function showReport(text, label) {
    const html = esc(text).replace(/\*\*\s*\[?(한눈에 보기|발견한 점|확인해 볼 질문)\]?\s*\*\*/g, '<span class="h">$1</span>')
      .replace(/\[(한눈에 보기|발견한 점|확인해 볼 질문)\]/g, '<span class="h">$1</span>').replace(/\*\*/g, "");
    $("#ai-report").innerHTML = html; $("#ai-report").hidden = false;
    $("#ai-status").innerHTML = label;
  }
  async function diagnose() {
    if (!last) return;
    const p = payloadFor(last);
    $("#ai-btn").disabled = true;
    $("#ai-status").innerHTML = '<span class="spinner"></span>생성형 AI가 근거를 읽고 진단서를 쓰는 중이에요 (10초 안팎)…';
    const ctrl = new AbortController(); const timer = setTimeout(() => ctrl.abort(), 45000);
    try {
      const res = await fetch(API + "/api/diagnose", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(p), signal: ctrl.signal });
      if (!res.ok) throw new Error("HTTP " + res.status);
      const j = await res.json();
      const prov = { clova: "HyperCLOVA X", anthropic: "Claude", openai: "OpenAI 호환 모델" }[j.provider] || null;
      const dropped = (j.dropped || []).length;
      showReport(j.report, prov ? `✅ ${prov}가 작성 · ${j.elapsed}초 · 근거 대조로 지운 문장 ${dropped}개` : `ℹ️ AI 서버가 규칙 기반 진단서로 대신했어요 (${esc(j.provider)})`);
      if (j.evidence) { $("#ai-evidence-text").textContent = j.evidence; $("#ai-evidence").hidden = false; }
    } catch (e) {
      showReport(ruleReport(p), "ℹ️ AI 서버에 연결되지 않아 <b>규칙 기반 진단서</b>로 대신했어요. (같은 근거로, 사람이 정한 문장 틀에 맞춰 씁니다)");
    } finally { clearTimeout(timer); $("#ai-btn").disabled = false; }
  }

  // ---------- 이벤트 ----------
  function bind() {
    const q = $("#q");
    q.addEventListener("input", () => renderSugg(search(q.value)));
    q.addEventListener("focus", () => { if (q.value) renderSugg(search(q.value)); });
    document.addEventListener("click", (ev) => { if (!ev.target.closest(".search")) $("#sugg").hidden = true; });
    $("#sugg").addEventListener("click", (ev) => { const b = ev.target.closest("button[data-isin]"); if (!b) return; add(b.dataset.isin); q.value = ""; $("#sugg").hidden = true; q.focus(); });
    q.addEventListener("keydown", (ev) => { if (ev.key === "Enter") { const l = search(q.value); if (l.length) { add(l[0].isin); q.value = ""; $("#sugg").hidden = true; } } });
    $("#basket").addEventListener("input", (ev) => { const li = ev.target.closest("li"); const b = basket.find((x) => x.isin === li.dataset.isin); if (b) { b.amount = Number(ev.target.value) || 0; const total = basket.reduce((a, x) => a + (Number(x.amount) || 0), 0); $("#total").textContent = fmt(total, 0); $("#xray").disabled = !(basket.length && total > 0); save(); } });
    $("#basket").addEventListener("click", (ev) => { if (!ev.target.classList.contains("rm")) return; const li = ev.target.closest("li"); basket = basket.filter((x) => x.isin !== li.dataset.isin); renderBasket(); save(); });
    $("#clear").addEventListener("click", () => { basket = []; renderBasket(); save(); $("#results").hidden = true; $("#tabs").hidden = true; history.replaceState(null, "", location.pathname); });
    $("#xray").addEventListener("click", () => render(analyze()));
    $("#ai-btn").addEventListener("click", diagnose);
    $("#copy").addEventListener("click", async () => { try { await navigator.clipboard.writeText($("#share-url").value); $("#copy").textContent = "복사됨"; setTimeout(() => ($("#copy").textContent = "복사"), 1500); } catch (e) { $("#share-url").select(); } });
    $("#samples").innerHTML = SAMPLES.map((s, i) => `<button class="chip" type="button" data-i="${i}">${esc(s.label)}</button>`).join("");
    $("#samples").addEventListener("click", (ev) => { const b = ev.target.closest(".chip"); if (!b) return; const s = SAMPLES[+b.dataset.i]; basket = []; for (const [n, a] of s.items) if (byName[n]) basket.push({ isin: byName[n].isin, amount: a }); renderBasket(); save(); render(analyze()); });
  }

  async function checkApi() {
    try {
      const r = await fetch(API + "/api/health", { cache: "no-store" });
      if (r.ok) { const j = await r.json(); const a = $("#api-link"); a.hidden = false; a.href = API + "/api/health"; a.textContent = `AI 서버 연결됨 (${j.provider})`; }
    } catch (e) { /* 서버 없음 — 규칙 진단서로 동작 */ }
  }

  load().then(() => { bind(); const fromHash = restore(); renderBasket(); checkApi(); if (fromHash) { render(analyze()); if (/[#&]ai=1/.test(location.hash)) diagnose(); } })
    .catch((e) => { $("#build").insertAdjacentHTML("afterbegin", `<p class="finding warn">데이터를 불러오지 못했어요: ${esc(e.message)}</p>`); });
})();
