#!/usr/bin/env bash
# Installs tree-show as a systemd service on Debian/Ubuntu (a Proxmox LXC works well).
# Run as root from the unzipped tree-show folder:  bash install.sh 192.168.1.50
set -euo pipefail
WLED_IP="${1:-}"
cd "$(dirname "$0")"

if ! command -v node >/dev/null || [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 18 ]; then
  echo "Installing Node.js and npm..."
  apt-get update -qq
  apt-get install -y -qq nodejs npm
fi
if [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 18 ]; then
  echo "This system's Node.js is $(node --version); tree-show needs 18 or newer."
  echo "Use a Debian 12 (or newer) LXC template, or install Node 20 from https://deb.nodesource.com and run this again."
  exit 1
fi
echo "Node $(node --version)"

id treeshow >/dev/null 2>&1 || useradd --system --home /var/lib/tree-show --shell /usr/sbin/nologin treeshow
mkdir -p /opt/tree-show /var/lib/tree-show
cp -r server.js dither.js ha.js package.json public /opt/tree-show/
[ -f package-lock.json ] && cp package-lock.json /opt/tree-show/
(cd /opt/tree-show && npm install --omit=dev --no-audit --no-fund --silent)
# Let the person who ran the installer update the code without sudo (tools/deploy.sh copies changes in;
# then just: sudo systemctl restart tree-show). The service still runs as treeshow, which only reads this folder.
OWNER="${SUDO_USER:-root}"; chown -R "$OWNER":"$OWNER" /opt/tree-show; chmod -R a+rX /opt/tree-show
chown -R treeshow:treeshow /var/lib/tree-show

if [ ! -f /etc/tree-show.env ]; then cp deploy/tree-show.env /etc/tree-show.env; fi
if [ -n "$WLED_IP" ]; then sed -i "s/^WLED_HOST=.*/WLED_HOST=$WLED_IP/" /etc/tree-show.env; fi

cp deploy/tree-show.service /etc/systemd/system/tree-show.service
systemctl daemon-reload
systemctl enable --now tree-show
systemctl restart tree-show
sleep 1
systemctl --no-pager --lines=5 status tree-show || true
IP=$(hostname -I 2>/dev/null | awk '{print $1}')
echo
echo "tree-show is running. Open http://${IP:-<container-ip>}:$(grep ^HTTP_PORT /etc/tree-show.env | cut -d= -f2) on your phone."
echo "Settings: /etc/tree-show.env   Data: /var/lib/tree-show/shows.json   Logs: journalctl -u tree-show -f"
