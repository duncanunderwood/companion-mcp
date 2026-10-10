#!/usr/bin/env bash
# Renders promo/src/*.html to 3200x1800 PNGs using headless Chrome.
set -euo pipefail
cd "$(dirname "$0")"
CHROME="${CHROME:-}"
for c in "/c/Program Files/Google/Chrome/Application/chrome.exe" "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" google-chrome chromium; do
  if [ -z "$CHROME" ] && command -v "$c" >/dev/null 2>&1; then CHROME="$c"; fi
done
[ -n "$CHROME" ] || { echo "set CHROME to a Chrome binary" >&2; exit 1; }
if command -v cygpath >/dev/null 2>&1; then HERE=$(cygpath -m "$PWD"); else HERE=$PWD; fi
for f in src/*.html; do
  n=$(basename "$f" .html)
  "$CHROME" --headless=new --disable-gpu --hide-scrollbars --window-size=1600,900 --force-device-scale-factor=2 \
    --screenshot="$HERE/$n.png" "file:///$HERE/src/$n.html" >/dev/null 2>&1
  echo "rendered $n.png"
done
