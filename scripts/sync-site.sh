#!/usr/bin/env bash
# Keep www.bwallet.space (this repo's site/) in sync with bwalletx.com (/Volumes/2026/Projects/bwalletx-site),
# owner rule 4 Oct 2026: the two sites always match; bwalletx.com is the master.
#   bash scripts/sync-site.sh   → copies the public pages and assets into site/, then deploy site/ with vercel --prod
# Not copied (bwallet.space-only): api/, lib/, test/, .well-known/ (universal links), pair.html, social.html,
# vercel.json, package files, and privacy.html (the store app's privacy URL, branded bWallet).
# Downloads aren't copied either: /download/* redirects to bwalletx.com (site/vercel.json).
set -euo pipefail
SRC="${BWALLETX_SITE:-/Volumes/2026/Projects/bwalletx-site}"
DST="$(cd "$(dirname "$0")/.." && pwd)/site"
rsync -a \
  --exclude='.git' --exclude='.vercel' --exclude='node_modules' --exclude='.DS_Store' \
  --exclude='download/' --exclude='vercel.json' --exclude='privacy.html' --exclude='.gitignore' \
  --include='*.html' --include='*.css' --include='*.js' --include='*.png' --include='*.svg' --include='*.ico' \
  --include='*.webmanifest' --include='*.jpg' --include='*.mp4' --include='*.webp' --include='*/' --exclude='*' \
  "$SRC/" "$DST/"
echo "synced $SRC → $DST"
