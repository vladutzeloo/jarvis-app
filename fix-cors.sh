#!/usr/bin/env bash
# Configure ollama systemd unit with OLLAMA_ORIGINS=* and OLLAMA_HOST=0.0.0.0:11434.
# Must run as root inside WSL: `wsl -u root -- bash <thisfile>`.

set -euo pipefail

echo "=== Step A: write systemd override ==="
mkdir -p /etc/systemd/system/ollama.service.d
cat > /etc/systemd/system/ollama.service.d/override.conf <<'EOF'
[Service]
Environment="OLLAMA_HOST=0.0.0.0:11434"
Environment="OLLAMA_ORIGINS=*"
EOF
echo "--- override.conf ---"
cat /etc/systemd/system/ollama.service.d/override.conf

echo
echo "=== Step B: daemon-reload + restart ==="
systemctl daemon-reload
systemctl restart ollama
sleep 4

echo
echo "=== Step C: status (top 15 lines) ==="
systemctl status ollama --no-pager 2>&1 | head -15 || true

echo
echo "=== Step D: env actually loaded by the running ollama process ==="
PID=$(pgrep -x ollama | head -1 || true)
if [ -n "$PID" ]; then
  echo "ollama pid=$PID"
  tr '\0' '\n' < /proc/$PID/environ | grep -E '^OLLAMA_' || echo "(no OLLAMA_* env vars seen)"
else
  echo "no ollama process found!"
fi

echo
echo "=== Step E: WSL-side version probe ==="
curl --max-time 5 -fsS http://127.0.0.1:11434/api/version
echo

echo
echo "=== Step F: simulated Tauri preflight (Origin: https://tauri.localhost) ==="
curl --max-time 5 -s -i -X OPTIONS \
  -H "Origin: https://tauri.localhost" \
  -H "Access-Control-Request-Method: POST" \
  -H "Access-Control-Request-Headers: content-type" \
  http://127.0.0.1:11434/api/chat | head -20

echo
echo "=== Step G: simulated Tauri /api/tags GET (Origin: https://tauri.localhost) ==="
curl --max-time 5 -s -i \
  -H "Origin: https://tauri.localhost" \
  http://127.0.0.1:11434/api/tags | head -20

echo
echo "=== done ==="
