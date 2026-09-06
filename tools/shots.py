# -*- coding: utf-8 -*-
"""화면 예시 그림 만들기 — 헤드리스 Chrome 으로 로컬 서버 화면을 찍는다(문서용). 실행: python tools/shots.py"""
import json
import os
import subprocess
import sys
import urllib.parse

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
OUT = os.path.join(ROOT, "docs", "img")
os.makedirs(OUT, exist_ok=True)
CHROME = r"C:\Program Files\Google\Chrome\Application\chrome.exe"
BASE = sys.argv[1] if len(sys.argv) > 1 else "http://localhost:7861/"

etfs = json.load(open(os.path.join(ROOT, "data", "etfs.json"), encoding="utf-8"))["etfs"]
code = {e["name"]: e["code"] for e in etfs}
SAMPLES = {
    "kr": [("KODEX 200", 300), ("TIGER 200", 300), ("KODEX 200TR", 200), ("KODEX 레버리지", 100), ("KODEX 반도체", 100)],
    "us": [("TIGER 미국나스닥100", 300), ("KODEX 미국나스닥100", 200), ("TIGER 미국테크TOP10 INDXX", 200), ("TIGER 미국S&P500", 300)],
    "cc": [("TIGER 미국배당다우존스", 300), ("SOL 미국배당다우존스", 200), ("KODEX 200타겟위클리커버드콜", 200), ("TIGER 미국배당다우존스타겟커버드콜2호", 200), ("KODEX 미국배당커버드콜액티브", 100)],
    "bal": [("KODEX 200", 250), ("TIGER 미국S&P500", 250), ("ACE 국고채10년", 200), ("ACE KRX금현물", 150), ("KODEX 머니마켓액티브", 150)],
}
def h(key):
    return "b=" + urllib.parse.quote(",".join(f"{code[n]}:{a}" for n, a in SAMPLES[key]))
for k in SAMPLES:
    print(k, h(k))

shots = [
    ("shot1_basket.png", BASE, 1100, 6000),
    ("shot2_overview.png", BASE + "#" + h("kr") + "&go=sec-overview", 1250, 8000),
    ("shot3_overlap.png", BASE + "#" + h("kr") + "&go=sec-overlap", 1500, 8000),
    ("shot4_findings.png", BASE + "#" + h("kr") + "&go=sec-findings", 1500, 8000),
    ("shot5_ai.png", BASE + "#" + h("kr") + "&go=sec-ai&ai=1", 1250, 30000),
    ("shot6_terms.png", BASE + "#" + h("cc") + "&go=sec-terms", 1500, 8000),
]
for fn, url, height, budget in shots:
    out = os.path.join(OUT, fn)
    cmd = [CHROME, "--headless=new", "--disable-gpu", "--hide-scrollbars", "--no-first-run", "--no-default-browser-check",
           "--force-device-scale-factor=2", f"--window-size=430,{height}", f"--virtual-time-budget={budget}",
           f"--screenshot={out}", url]
    r = subprocess.run(cmd, capture_output=True, text=True, timeout=120)
    print(fn, "ok" if os.path.exists(out) else "FAILED", os.path.getsize(out) // 1024 if os.path.exists(out) else "", r.stderr[-200:].strip().replace("\n", " ") if not os.path.exists(out) else "")
