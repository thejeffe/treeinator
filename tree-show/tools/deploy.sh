#!/usr/bin/env bash
# Copy the code from this folder into /opt/tree-show (no sudo needed once install.sh has run),
# then restart with:  sudo systemctl restart tree-show
set -euo pipefail
SRC="$(cd "$(dirname "$0")/.." && pwd)"; DST=/opt/tree-show
[ -w "$DST/server.js" ] || { echo "Can't write to $DST. Run 'sudo bash install.sh' once first."; exit 1; }
node --check "$SRC/server.js"
node --check "$SRC/dither.js"
node --check "$SRC/ha.js"
cp "$SRC/server.js" "$SRC/dither.js" "$SRC/ha.js" "$SRC/package.json" "$DST/"
[ -f "$SRC/package-lock.json" ] && cp "$SRC/package-lock.json" "$DST/"
cp -r "$SRC/public/." "$DST/public/"
chmod -R a+rX "$DST"
echo "Copied to $DST. Now run:  sudo systemctl restart tree-show"
