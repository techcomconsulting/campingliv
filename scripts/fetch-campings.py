#!/usr/bin/env python3
"""Hämtar alla campingar och ställplatser i Norden från OpenStreetMap
och sparar dem kompakt i public/data/campings.json.
Format per plats: [lat, lon, typ(0=camping,1=ställplats), namn, faciliteter(bitar), telefon, webb, adress]"""
import json, time, urllib.parse, urllib.request
from pathlib import Path

OUT = Path(__file__).resolve().parent.parent / "public" / "data" / "campings.json"
SERVERS = ["https://overpass-api.de/api/interpreter", "https://overpass.kumi.systems/api/interpreter"]
QUERY = """[out:json][timeout:300];
area["ISO3166-1"~"^(SE|NO|DK|FI)$"][admin_level=2]->.a;
nwr["tourism"~"^(camp_site|caravan_site)$"](area.a);
out center tags;"""
FAC = ["toilets", "shower", "power_supply", "internet_access", "drinking_water",
       "sanitary_dump_station", "dog", "swimming_pool"]

def fetch():
    body = urllib.parse.urlencode({"data": QUERY}).encode()
    for attempt in range(3):
        for url in SERVERS:
            try:
                req = urllib.request.Request(url, data=body, headers={"User-Agent": "Campingliv/1.0 (github.com/techcomconsulting/campingliv)"})
                with urllib.request.urlopen(req, timeout=400) as r:
                    return json.load(r)
            except Exception as e:
                print("Försök misslyckades:", url, e, flush=True)
        time.sleep(60)
    raise SystemExit("Kunde inte hämta data")

def yes(t, k):
    v = t.get(k)
    return bool(v) and v not in ("no", "none")

data = fetch()
rows = []
for el in data["elements"]:
    t = el.get("tags", {})
    lat = el.get("lat", el.get("center", {}).get("lat"))
    lon = el.get("lon", el.get("center", {}).get("lon"))
    if lat is None:
        continue
    bits = sum(1 << i for i, k in enumerate(FAC) if yes(t, k))
    addr = ", ".join(x for x in [
        f'{t.get("addr:street","")} {t.get("addr:housenumber","")}'.strip(), t.get("addr:city", "")] if x)
    web = t.get("website") or t.get("contact:website") or ""
    rows.append([round(lat, 5), round(lon, 5), 0 if t["tourism"] == "camp_site" else 1,
                 t.get("name", ""), bits, t.get("phone") or t.get("contact:phone") or "",
                 web if web.startswith("http") else "", addr])
if len(rows) < 1000:
    raise SystemExit(f"För få platser ({len(rows)}) – sparar inte")
OUT.parent.mkdir(parents=True, exist_ok=True)
OUT.write_text(json.dumps({"updated": time.strftime("%Y-%m-%d"), "fac": FAC, "places": rows},
                          ensure_ascii=False, separators=(",", ":")))
print(f"Sparade {len(rows)} platser, {OUT.stat().st_size // 1024} kB")
