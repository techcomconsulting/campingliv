#!/usr/bin/env python3
"""Publicerar Campingliv till Firebase. Körs av GitHub Actions.

Gör, i ordning (allt är säkert att köra flera gånger):
  1. Slår på inloggning med e-post/lösenord
  2. Skapar Firestore-databasen om den saknas (eur3)
  3. Publicerar firestore.rules
  4. Skapar databasindex från firestore.indexes.json
  5. Lägger ut mappen public/ på Firebase Hosting
"""
import gzip, hashlib, json, os, sys, time, urllib.error, urllib.request
from pathlib import Path

PROJECT = os.environ.get("PROJECT", "campingliv-a2e96")
TOKEN = os.environ["TOKEN"]
ROOT = Path(__file__).resolve().parent.parent


def call(method, url, body=None, raw=None, ctype="application/json", ok=(200,), quota=False):
    data = raw if raw is not None else (json.dumps(body).encode() if body is not None else None)
    req = urllib.request.Request(url, data=data, method=method, headers={
        "Authorization": f"Bearer {TOKEN}", "Content-Type": ctype,
        **({"x-goog-user-project": PROJECT} if quota else {})})
    try:
        with urllib.request.urlopen(req, timeout=120) as r:
            txt = r.read().decode() or "{}"
            return r.status, json.loads(txt) if txt.strip().startswith("{") else {}
    except urllib.error.HTTPError as e:
        txt = e.read().decode()
        if e.code in ok:
            return e.code, {}
        return e.code, {"error": txt}


def step(name):
    print(f"\n=== {name} ===", flush=True)


def gh(kind, msg):
    # Syns som anteckning i GitHub (läsbar via API)
    print(f"::{kind}::" + msg.replace("%", "%25").replace("\r", "").replace("\n", " ")[:3000], flush=True)


def fail(msg):
    print(f"FEL: {msg}", flush=True)
    gh("error", msg)
    sys.exit(1)


# 1. Inloggning
step("Inloggning med e-post")
code, res = call("PATCH",
    f"https://identitytoolkit.googleapis.com/admin/v2/projects/{PROJECT}/config"
    "?updateMask=signIn.email.enabled,signIn.email.passwordRequired",
    {"signIn": {"email": {"enabled": True, "passwordRequired": True}}}, quota=True)
print("OK") if code == 200 else gh("warning", f"Inloggning ({code}): {res.get('error','')[:400]}")

# 2. Databas
step("Firestore-databas")
fs = f"https://firestore.googleapis.com/v1/projects/{PROJECT}/databases"
code, res = call("GET", f"{fs}/(default)")
if code == 200:
    print("Finns redan:", res.get("locationId"))
elif code == 404:
    code, res = call("POST", f"{fs}?databaseId=(default)",
                     {"locationId": "eur3", "type": "FIRESTORE_NATIVE"})
    if code != 200:
        fail(f"Kunde inte skapa databasen ({code}): {res.get('error','')[:400]}")
    print("Skapad i eur3. Väntar 30 s…")
    time.sleep(30)
else:
    fail(f"Kunde inte läsa databasen ({code}): {res.get('error','')[:400]}")

# 3. Regler
step("Säkerhetsregler")
rules_api = f"https://firebaserules.googleapis.com/v1/projects/{PROJECT}"
src = (ROOT / "firestore.rules").read_text()
code, res = call("POST", f"{rules_api}/rulesets",
                 {"source": {"files": [{"name": "firestore.rules", "content": src}]}})
if code != 200:
    fail(f"Reglerna gick inte att spara ({code}): {res.get('error','')[:1500]}")
ruleset = res["name"]
rel = {"release": {"name": f"projects/{PROJECT}/releases/cloud.firestore", "rulesetName": ruleset}}
code, res = call("PATCH", f"{rules_api}/releases/cloud.firestore", rel)
if code == 404:
    code, res = call("POST", f"{rules_api}/releases", rel["release"])
if code != 200:
    fail(f"Reglerna gick inte att aktivera ({code}): {res.get('error','')[:400]}")
print("Publicerade:", ruleset)

# 4. Index
step("Databasindex")
idx_file = ROOT / "firestore.indexes.json"
for idx in json.loads(idx_file.read_text()).get("indexes", []) if idx_file.exists() else []:
    group = idx["collectionGroup"]
    body = {"queryScope": idx.get("queryScope", "COLLECTION"),
            "fields": [{"fieldPath": f["fieldPath"], "order": f["order"]} for f in idx["fields"]]}
    code, res = call("POST", f"{fs}/(default)/collectionGroups/{group}/indexes", body, ok=(409,))
    desc = ", ".join(f["fieldPath"] for f in idx["fields"])
    print(f"{group} ({desc}):", "finns redan" if code == 409 else ("skapas" if code == 200 else f"varning {code}"))
    if code not in (200, 409):
        gh("warning", f"Index {group} ({code}): {res.get('error','')[:300]}")

# 5. Hosting
step("Webbplats (Firebase Hosting)")
host = "https://firebasehosting.googleapis.com/v1beta1"
site = f"sites/{PROJECT}"
config = {"headers": [
    {"glob": "**", "headers": {
        "X-Content-Type-Options": "nosniff",
        "Referrer-Policy": "strict-origin-when-cross-origin",
        "Permissions-Policy": "geolocation=(self), camera=(self), microphone=()",
        "X-Frame-Options": "SAMEORIGIN"}},
    {"glob": "**/*.@(js|css|html|webmanifest)", "headers": {"Cache-Control": "no-cache"}},
]}
code, res = call("POST", f"{host}/{site}/versions", {"config": config})
if code != 200:
    fail(f"Kunde inte skapa version ({code}): {res.get('error','')[:400]}")
version = res["name"]

files, blobs = {}, {}
for p in sorted((ROOT / "public").rglob("*")):
    if p.is_file():
        gz = gzip.compress(p.read_bytes(), mtime=0)
        h = hashlib.sha256(gz).hexdigest()
        files["/" + p.relative_to(ROOT / "public").as_posix()] = h
        blobs[h] = gz
code, res = call("POST", f"{host}/{version}:populateFiles", {"files": files})
if code != 200:
    fail(f"populateFiles ({code}): {res.get('error','')[:400]}")
need, upload_url = res.get("uploadRequiredHashes", []), res.get("uploadUrl")
for h in need:
    c, r = call("POST", f"{upload_url}/{h}", raw=blobs[h], ctype="application/octet-stream")
    if c != 200:
        fail(f"Uppladdning ({c}): {r.get('error','')[:300]}")
print(f"{len(files)} filer, {len(need)} nya uppladdade")
code, res = call("PATCH", f"{host}/{version}?update_mask=status", {"status": "FINALIZED"})
if code != 200:
    fail(f"Finalize ({code}): {res.get('error','')[:400]}")
code, res = call("POST", f"{host}/{site}/releases?versionName={version}", {})
if code != 200:
    fail(f"Release ({code}): {res.get('error','')[:400]}")
print(f"\nKlart! Appen finns på https://{PROJECT}.web.app")
gh("notice", f"Publicerad: https://{PROJECT}.web.app")
