"""
Prototipo de la pantalla Fondos (solo lectura, no escribe en Supabase).

Arma el universo de ETF con CEDEAR en BYMA y, para cada uno:
  - ratio derivado del precio (CEDEAR ARS vs ETF USD vs CCL de referencia)
  - precio implicito del CEDEAR al CCL y prima/descuento
  - perfil de Yahoo: expense ratio, AUM, yield, rendimientos 1m/3m/1a/5a
  - volatilidad anual (1 año de cierres diarios)
  - top 10 holdings y sectores
  - solapamiento con una cartera dada (ticker -> USD)

Uso:
  python -I prototipo.py --cartera cartera.json --out salida.json
  (cartera.json = {"NVDA": 9465, "MU": 9853, ...} en USD)

Fuentes: data912 /live/arg_cedears (precio CEDEAR), Yahoo spark (precio USD
y tipo de instrumento), Yahoo quoteSummary con crumb (perfil y holdings),
Yahoo chart (cierres para volatilidad). Comafi 7281.xlsx como verificacion
del ratio cuando el ETF figura ahi.
"""
import argparse, json, math, statistics as st, sys, time, urllib.request, http.cookiejar

UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36"
ANCLAS = {"AAPL": 20, "MSFT": 30, "NVDA": 24, "KO": 5, "AMZN": 144, "META": 24, "GOOGL": 58}

cj = http.cookiejar.CookieJar()
op = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(cj))


def get(url, js=True, timeout=25):
    r = op.open(urllib.request.Request(url, headers={"User-Agent": UA}), timeout=timeout)
    b = r.read()
    return json.loads(b) if js else b


def spark(syms):
    out = {}
    for i in range(0, len(syms), 20):
        d = get("https://query1.finance.yahoo.com/v7/finance/spark?symbols=" + ",".join(syms[i:i + 20]) + "&range=1d&interval=1d")
        for x in d["spark"]["result"]:
            try:
                m = x["response"][0]["meta"]
                out[x["symbol"]] = {"px": m.get("regularMarketPrice"), "tipo": m.get("instrumentType"), "nombre": m.get("longName") or m.get("shortName")}
            except Exception:
                pass
    return out


def crumb():
    try:
        op.open(urllib.request.Request("https://fc.yahoo.com", headers={"User-Agent": UA}), timeout=15)
    except Exception:
        pass  # devuelve 404 pero deja la cookie
    return get("https://query2.finance.yahoo.com/v1/test/getcrumb", js=False).decode()


def raw(d, *ks):
    for k in ks:
        d = (d or {}).get(k)
    return d.get("raw") if isinstance(d, dict) else d


def perfil(sym, cr):
    mods = "topHoldings,fundProfile,summaryDetail,fundPerformance"
    d = get(f"https://query2.finance.yahoo.com/v10/finance/quoteSummary/{sym}?modules={mods}&crumb={cr}")
    r = d["quoteSummary"]["result"][0]
    th = r.get("topHoldings", {}) or {}
    tr = (r.get("fundPerformance") or {}).get("trailingReturns") or {}
    sect = {}
    for s in th.get("sectorWeightings") or []:
        for k, v in s.items():
            if raw(v):
                sect[k] = raw(v)
    return {
        "familia": (r.get("fundProfile") or {}).get("family"),
        "categoria": (r.get("fundProfile") or {}).get("categoryName"),
        "expense": raw(r, "fundProfile", "feesExpensesInvestment", "annualReportExpenseRatio"),
        "aum": raw(r, "summaryDetail", "totalAssets"),
        "yield": raw(r, "summaryDetail", "yield"),
        "ret": {k: raw(tr, k) for k in ("oneMonth", "threeMonth", "oneYear", "fiveYear")},
        "ret_fecha": (tr.get("asOfDate") or {}).get("fmt"),
        "top10": [(h.get("symbol"), raw(h, "holdingPercent")) for h in th.get("holdings") or []],
        "sectores": sect,
    }


def vol_anual(sym):
    d = get(f"https://query1.finance.yahoo.com/v8/finance/chart/{sym}?range=1y&interval=1d")
    c = [x for x in d["chart"]["result"][0]["indicators"]["adjclose"][0]["adjclose"] if x]
    rs = [math.log(b / a) for a, b in zip(c, c[1:])]
    return st.pstdev(rs) * math.sqrt(252) if len(rs) > 100 else None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--cartera")
    ap.add_argument("--out", default="salida.json")
    a = ap.parse_args()
    cartera = json.load(open(a.cartera)) if a.cartera else {}
    tot = sum(cartera.values()) or 1

    ced = {x["symbol"]: x for x in get("https://data912.com/live/arg_cedears")}
    syms = sorted(ced)
    base = [s for s in syms if not (len(s) > 2 and s[-1] in "DC" and s[:-1] in ced)]
    sp = spark([s.replace(".", "-") for s in base] + list(ANCLAS))
    ccl = st.median(ced[k]["c"] * r / sp[k]["px"] for k, r in ANCLAS.items() if sp.get(k, {}).get("px") and ced.get(k, {}).get("c"))
    etfs = [s for s in base if sp.get(s, {}).get("tipo") == "ETF"]
    print(f"CCL ref {ccl:.1f} | {len(base)} CEDEARs base, {len(etfs)} ETF", file=sys.stderr)

    cr = crumb()
    out = []
    for s in etfs:
        c, u = ced[s].get("c"), sp[s]["px"]
        fila = {"ticker": s, "nombre": sp[s]["nombre"], "cedear_ars": c, "usd": u, "vol_cedear": ced[s].get("v")}
        if c and u:
            r_impl = u * ccl / c
            ratio = round(r_impl)
            fila.update(ratio=ratio, ratio_desvio=r_impl / ratio - 1 if ratio else None,
                        ccl_implicito=c * ratio / u if ratio else None,
                        precio_implicito_ars=u * ccl / ratio if ratio else None)
            # con ratios grandes la resolucion del redondeo es peor que el spread
            fila["ratio_dudoso"] = bool(ratio == 0 or ratio > 150 or abs(fila["ratio_desvio"]) > 0.01)
        try:
            fila.update(perfil(s, cr))
            fila["vol_1a"] = vol_anual(s)
        except Exception as e:
            fila["error"] = str(e)[:120]
        if cartera and fila.get("top10"):
            sol = {t: w for t, w in fila["top10"] if t in cartera and w}
            fila["solapa_top10"] = sol
            fila["solapa_top10_pct"] = sum(sol.values())
        out.append(fila)
        time.sleep(0.4)
    json.dump({"ccl_ref": ccl, "fecha": time.strftime("%Y-%m-%d %H:%M"), "etfs": out}, open(a.out, "w"), indent=1, ensure_ascii=False)
    print(f"ok {len(out)} -> {a.out}", file=sys.stderr)


if __name__ == "__main__":
    main()
