#!/usr/bin/env bash
# Which bWalletX extension build does each Chrome profile on this Mac actually load? (owner, 13 Nov 2026: Chrome ran a
# 6 Nov unpacked build for a week and nothing said so.) Read-only: it only reads Chrome's preference files and the
# loaded folders' manifest.json.
#
#   scripts/check-owner-builds.sh [release-version]
#
# release-version defaults to the extension version in https://bwalletx.com/download/latest.json, else this repo's
# package.json. Exit 1 when any profile loads an unpacked build older than that. Chrome Web Store installs are listed
# but never fail the check (Chrome updates them; the Web Store trails review), nor do profiles whose unpacked folder
# no longer exists (Chrome loads nothing there).
# CHROME_DIR overrides ~/Library/Application Support/Google/Chrome (tests).
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
CHROME_DIR="${CHROME_DIR:-$HOME/Library/Application Support/Google/Chrome}"
RELEASE="${1:-}"

if [ -z "$RELEASE" ] && [ -z "${NO_NETWORK:-}" ]; then
  RELEASE="$(curl -fsS --max-time 10 https://bwalletx.com/download/latest.json 2>/dev/null |
    python3 -c 'import json,sys; d=json.load(sys.stdin); print((d.get("channels") or {}).get("extension",{}).get("version") or d.get("version",""))' 2>/dev/null || true)"
fi
if [ -z "$RELEASE" ]; then
  RELEASE="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["version"])' "$HERE/../package.json")"
fi

exec python3 - "$CHROME_DIR" "$RELEASE" <<'PY'
import glob, json, os, re, sys

chrome, release = sys.argv[1], sys.argv[2]
# bWalletX extension IDs: the unpacked build (fixed by the manifest `key`, scripts/build.ts) and the Web Store listing.
KNOWN = {"bombmmcjghjdlbmcclnhjodgcelnehgl": "unpacked", "choopkcgggoaehffickjojkohmpbladd": "web store"}

def vparts(v):
    return [int(x) for x in re.findall(r"\d+", (v or "").split("-")[0])] or [0]

def older(a, b):
    x, y = vparts(a), vparts(b)
    n = max(len(x), len(y))
    return x + [0] * (n - len(x)) < y + [0] * (n - len(y))

def load(path):
    try:
        with open(path) as f:
            return json.load(f)
    except Exception:
        return {}

names = {}
local_state = load(os.path.join(chrome, "Local State"))
for prof, info in ((local_state.get("profile") or {}).get("info_cache") or {}).items():
    names[prof] = info.get("name", "")

rows, stale = [], []
def natural(p):
    return [int(t) if t.isdigit() else t for t in re.split(r"(\d+)", os.path.basename(p))]

for prof_dir in sorted(glob.glob(os.path.join(chrome, "*")), key=natural):
    prof = os.path.basename(prof_dir)
    settings = {}
    for fn in ("Preferences", "Secure Preferences"):
        for k, v in ((load(os.path.join(prof_dir, fn)).get("extensions") or {}).get("settings") or {}).items():
            settings.setdefault(k, {}).update(v)
    for ext_id, s in settings.items():
        path = s.get("path", "") or ""
        manifest = s.get("manifest") or {}
        unpacked = s.get("location") == 4
        folder = path if os.path.isabs(path) else os.path.join(prof_dir, "Extensions", path)
        if unpacked and not manifest:
            manifest = load(os.path.join(folder, "manifest.json"))
        name = str(manifest.get("name", ""))
        if not (ext_id in KNOWN or "bwallet" in path.lower() or re.search(r"bwallet", name, re.I)):
            continue
        version = manifest.get("version", "")
        exists = os.path.isdir(folder)
        kind = "unpacked" if unpacked else ("web store" if s.get("from_webstore") or ext_id in KNOWN else "other")
        disabled = bool(s.get("disable_reasons")) or s.get("state") == 0
        if unpacked and not exists:
            status = "not loaded (folder gone)"
        elif not version:
            status = "UNKNOWN"
        elif older(version, release):
            status = "OLD" if unpacked else "old (Chrome updates it)"
        else:
            status = "ok"
        if unpacked and status in ("OLD", "UNKNOWN"):
            stale.append((prof, folder, version))
        rows.append((prof, names.get(prof, ""), ext_id, kind, folder, version or "?", status, disabled))

print(f"bWalletX release: {release}")
print(f"Chrome profiles: {chrome}\n")
if not rows:
    print("No bWalletX extension found in any profile.")
for prof, name, ext_id, kind, folder, version, status, disabled in rows:
    label = f"{prof}" + (f" ({name})" if name else "")
    print(f"{label}")
    print(f"  {kind:9s} {ext_id}{'  [disabled]' if disabled else ''}")
    print(f"  folder   {folder}")
    print(f"  version  {version}  ->  {status}\n")

if stale:
    print(f"{len(stale)} profile(s) load an older unpacked bWalletX than {release}.\n")
    print("Update each folder IN PLACE (same folder = same extension ID + key = same wallet data):")
    print(f"  1. Build or unzip the release: dist/bwalletx-extension-{release}/ (or bwalletx-extension-{release}.zip).")
    print("  2. Copy the new build over the loaded folder, e.g.")
    for folder in sorted({f for _, f, _ in stale}):
        print(f'       cp -R dist/bwalletx-extension-{release}/. "{folder}/"')
    print("  3. In each profile: chrome://extensions > bWalletX > Reload (the ↻ arrow), or the banner's Reload button.")
    print("  NEVER press Remove: it deletes that profile's wallet records. The folder name may stay old; the")
    print("  manifest version inside is what counts (this script reads it).")
    sys.exit(1)
print("All unpacked bWalletX builds are current.")
PY
