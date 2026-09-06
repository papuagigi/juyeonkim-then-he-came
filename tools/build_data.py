# -*- coding: utf-8 -*-
"""
데이터 만들기 — 미래에셋 AI 페스티벌에서 만든 금융상품 지식베이스(DuckDB)에서
ETF 엑스레이가 쓰는 두 파일을 뽑아낸다.

  data/etfs.json      국내 상장 ETF(상장 중) 1종당 1행 — 이름·운용사·기초지수·지역·자산유형·
                      위험등급·순자산·분배수익률·1년 수익률·1년 변동성·복제 방식·배수·상장일
  data/holdings.json  ETF별 구성종목(비중은 원천에 있는 경우만) + 종목 사전

원천: 주최(미래에셋증권) 배포 국내 ETF 마스터(기준일 2026-08-22)와
      KRX 정보데이터시스템에서 직접 수집한 ETF 구성종목(기준일 2026-08-21).
원칙: 값이 없는 것은 없다고 남긴다(0이나 평균으로 채우지 않는다).
실행: python tools/build_data.py
"""
import collections
import csv
import json
import os
import re

import duckdb

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
FESTIVAL = os.path.normpath(os.path.join(ROOT, "..", "..", "mirae-asset-dev"))
DB = os.path.join(FESTIVAL, "storage", "output", "products.duckdb")
ALIAS = os.path.join(FESTIVAL, "external_data", "dictionaries", "constituent_aliases.csv")
OUT = os.path.join(ROOT, "data")

AS_OF_MASTER = "2026-08-22"
AS_OF_HOLDINGS = "2026-08-21"

ASSET_KO = {
    "Equity": "주식", "Bond": "채권", "Alternatives": "대체(파생·구조화)", "Mixed Assets": "혼합자산",
    "Money Market": "단기금융(현금성)", "Commodity": "원자재", "Other": "기타",
}
ISIN_RE = re.compile(r"^[A-Z]{2}[A-Z0-9]{9}[0-9]$")
CASH_RE = re.compile(r"현금|예금|설정현금액|외국환포워드")
FUT_RE = re.compile(r"\b(FUT|FUTURE|FUTURES|E-MINI|EMINI|INDEX FUT)\b|\d{4} \d{2}$|(JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|SEPT|OCT|NOV|DEC) ?20\d\d", re.I)


def fnum(v):
    if v is None:
        return None
    s = str(v).strip().replace(",", "")
    if s in ("", "-", "NULL", "None"):
        return None
    try:
        return float(s)
    except ValueError:
        return None


def fint(v):
    f = fnum(v)
    return int(f) if f is not None else None


def fdate(v):
    if not v:
        return None
    s = str(v).strip().replace("-", "")
    if len(s) >= 8 and s[:8].isdigit():
        return f"{s[:4]}-{s[4:6]}-{s[6:8]}"
    return None


def classify(mkt, grp, code, name):
    """구성종목 유형 코드 — KS 코스피주식 · KQ 코스닥주식 · KX 기타국내주식 · RT 리츠 · FS 해외증권 ·
    BD 채권 · MM 단기금융 · DV 파생 · EF ETF · EN ETN · CM 원자재 · OT 기타"""
    code = (code or "").strip()
    name = (name or "").strip()
    if grp == "ST":
        return {"STK": "KS", "KSQ": "KQ"}.get(mkt, "KX")
    if grp == "RT":
        return "RT"
    if grp == "BN" or mkt in ("BND", "KTS"):
        return "BD"
    if grp == "EF":
        return "EF"
    if grp == "EN":
        return "EN"
    if grp in ("FU", "OP", "DR", "IF") or mkt == "DRV":
        return "DV"
    if mkt == "CMD":
        return "CM"
    if code.startswith("KRZ"):
        return "MM"
    if ISIN_RE.match(code):
        return "FS"
    if FUT_RE.search(name) or (code and len(code) <= 6 and not code.isdigit()):
        return "DV"
    return "OT"


def main():
    os.makedirs(OUT, exist_ok=True)
    con = duckdb.connect(DB, read_only=True)

    # ---- 별칭(해외 종목 한글명) ----
    ko_by_isin = {}
    if os.path.exists(ALIAS):
        with open(ALIAS, encoding="utf-8-sig") as f:
            for row in csv.DictReader(f):
                isin = (row.get("isin") or "").strip()
                alias = (row.get("alias") or "").strip()
                if isin and alias and isin not in ko_by_isin:
                    ko_by_isin[isin] = alias

    # ---- ETF 마스터 ----
    rows = con.execute(
        """
        SELECT e.pd_itm_no, e.pd_ticker, e.pd_abrv_nm, e.pd_nm, COALESCE(m.resolved, e.cu_fund_mgmt_co),
               e.ref_base_index, e.ref_ast_type, e.wu_inv_rgn, e.ref_geo_focus, e.drv_risk_grade,
               e.du_last_aum, e.du_clpr, e.pd_dvid_yield, e.pd_dvid_cycl, e.du_er_1y, e.du_er_3m, e.du_er_ytd,
               e.du_vlty_1y, e.cu_strtegy, e.cu_lev_fector, e.pd_lstg_dt, e.pd_dvid_pay_months
        FROM kr_etp e LEFT JOIN mgmt_resolved m ON m.pd_itm_no = e.pd_itm_no
        WHERE e.drv_instrument_type = 'ETF' AND e.drv_listing_status = 'active'
        ORDER BY TRY_CAST(e.du_last_aum AS DOUBLE) DESC NULLS LAST
        """
    ).fetchall()

    etfs = []
    for r in rows:
        (isin, ticker, abrv, full, mgmt, idx, ast, rgn, geo, risk, aum, clpr, dy, dc, er1y, er3m, erytd,
         vol1y, strat, lev, lstg, paym) = r
        name = (abrv or "").strip()
        lname = name.lower()
        inverse = ("인버스" in name) or ("-1x" in lname) or ("-2x" in lname)
        etfs.append({
            "isin": isin, "code": (ticker or "").strip(), "name": name, "full": (full or "").strip(),
            "mgmt": (mgmt or "").strip() or None, "index": (idx or "").strip() or None,
            "asset": ASSET_KO.get(ast, ast) if ast else None, "region": rgn or None, "geo": geo or None,
            "risk": fint(risk), "aum": fnum(aum), "price": fnum(clpr), "dy": fnum(dy), "dc": dc or None,
            "er1y": fnum(er1y), "er3m": fnum(er3m), "erytd": fnum(erytd), "vol1y": fnum(vol1y),
            "strat": strat or None, "lev": fint(lev) or 1, "inverse": inverse, "listed": fdate(lstg),
            "paym": (paym or None),
        })
    active = {e["isin"] for e in etfs}

    # ---- 구성종목 ----
    crow = con.execute(
        """
        SELECT etf_isin, COMPST_ISU_CD, COMPST_ISU_CD2, MKT_ID, SECUGRP_ID, COMPST_ISU_NM, COMPST_RTO
        FROM etf_constituent
        """
    ).fetchall()

    sec_names = collections.defaultdict(collections.Counter)
    sec_type = {}
    per_etf = collections.defaultdict(list)
    cash_w = collections.defaultdict(float)
    for etf, cd, cd2, mkt, grp, nm, rto in crow:
        if etf not in active:
            continue
        nm = (nm or "").strip()
        cd = (cd or "").strip()
        cd2 = (cd2 or "").strip()
        w = fnum(rto)
        if CASH_RE.search(nm) or cd.startswith("FXFWD"):
            if w:
                cash_w[etf] += w
            continue
        key = cd2 if ISIN_RE.match(cd2) else (cd or nm)
        if not key:
            continue
        t = classify(mkt, grp, cd2 if ISIN_RE.match(cd2) else cd, nm)
        sec_names[key][nm] += 1
        sec_type.setdefault(key, t)
        per_etf[etf].append((key, w))

    keys = sorted(sec_names, key=lambda k: -sum(sec_names[k].values()))
    idx_of = {k: i for i, k in enumerate(keys)}
    sec = []
    for k in keys:
        name = sec_names[k].most_common(1)[0][0]
        entry = [k, name, sec_type[k]]
        if k in ko_by_isin:
            entry.append(ko_by_isin[k])
        sec.append(entry)

    holdings = {}
    for etf, lst in per_etf.items():
        seen = {}
        for k, w in lst:                     # 같은 종목이 두 줄이면 비중 합산
            i = idx_of[k]
            if i in seen:
                if w is not None:
                    seen[i] = (seen[i] or 0) + w
            else:
                seen[i] = w
        holdings[etf] = [[i, (round(w, 2) if w is not None else None)] for i, w in
                         sorted(seen.items(), key=lambda kv: -(kv[1] or 0))]

    for e in etfs:
        h = holdings.get(e["isin"], [])
        e["nh"] = len(h)
        e["nw"] = sum(1 for _, w in h if w is not None)
        e["cash"] = round(cash_w.get(e["isin"], 0.0), 2)

    with open(os.path.join(OUT, "etfs.json"), "w", encoding="utf-8") as f:
        json.dump({"asof": AS_OF_MASTER, "n": len(etfs), "etfs": etfs}, f, ensure_ascii=False, separators=(",", ":"))
    with open(os.path.join(OUT, "holdings.json"), "w", encoding="utf-8") as f:
        json.dump({"asof": AS_OF_HOLDINGS, "sec": sec, "etf": holdings}, f, ensure_ascii=False, separators=(",", ":"))

    n_pairs = sum(len(v) for v in holdings.values())
    n_w = sum(1 for v in holdings.values() for _, w in v if w is not None)
    types = collections.Counter(s[2] for s in sec)
    meta = {
        "asof_master": AS_OF_MASTER, "asof_holdings": AS_OF_HOLDINGS, "etfs": len(etfs),
        "etfs_with_holdings": len(holdings), "securities": len(sec), "holding_pairs": n_pairs,
        "pairs_with_weight": n_w, "security_types": dict(types),
        "etfs_fully_weighted": sum(1 for e in etfs if e["nh"] and e["nw"] == e["nh"]),
        "etfs_unweighted": sum(1 for e in etfs if e["nh"] and e["nw"] == 0),
    }
    with open(os.path.join(OUT, "meta.json"), "w", encoding="utf-8") as f:
        json.dump(meta, f, ensure_ascii=False, indent=2)
    print(json.dumps(meta, ensure_ascii=False, indent=2))
    for fn in ("etfs.json", "holdings.json"):
        print(fn, os.path.getsize(os.path.join(OUT, fn)) // 1024, "KB")


if __name__ == "__main__":
    main()
