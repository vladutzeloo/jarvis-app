#!/usr/bin/env bash
# Configure Ollama for Tauri: dual-stack listen + permissive CORS, persisted via systemd.
# Run as root inside WSL:  wsl -u root -- bash <thisfile>
#
# Replaces the old fix-cors.sh + diag-and-fix.sh pair. Uses [::]:11434 so the
# daemon answers on both 127.0.0.1 and ::1 — the Tauri webview hits whichever
# Windows resolves localhost to (often ::1 on modern stacks).

set -euo pipefail

echo "=== A. listening sockets for :11434 (before) ==="
ss -tlnp | awk 'NR==1 || /:11434/' || true

echo
echo "=== B. write systemd override ==="
mkdir -p /etc/systemd/system/ollama.service.d
cat > /etc/systemd/system/ollama.service.d/override.conf <<'EOF'
[Service]
Environment="OLLAMA_HOST=[::]:11434"
Environment="OLLAMA_ORIGINS=*"
EOF
cat /etc/systemd/system/ollama.service.d/override.conf

echo
echo "=== C. daemon-reload + restart ==="
systemctl daemon-reload
systemctl restart ollama
sleep 4
systemctl is-active ollama

echo
echo "=== D. listening sockets for :11434 (after) ==="
ss -tlnp | awk 'NR==1 || /:11434/' || true

echo
echo "=== E. env actually loaded by the running ollama process ==="
PID=$(pgrep -x ollama | head -1 || true)
if [ -n "${PID:-}" ]; then
  echo "ollama pid=$PID"
  tr '\0' '\n' < /proc/$PID/environ | grep -E '^OLLAMA_' || echo "(no OLLAMA_* env vars seen)"
else
  echo "no ollama process found!"
fi

echo
echo "=== F. WSL-side IPv4 + IPv6 probes ==="
curl --max-time 5 -fsS http://127.0.0.1:11434/api/version || echo "IPv4 FAILED"
echo
curl --max-time 5 -fsS http://[::1]:11434/api/version    || echo "IPv6 FAILED"

echo
echo "=== G. simulated Tauri preflight (Origin: https://tauri.localhost) ==="
curl --max-time 5 -s -i -X OPTIONS \
  -H "Origin: https://tauri.localhost" \
  -H "Access-Control-Request-Method: POST" \
  -H "Access-Control-Request-Headers: content-type" \
  http://127.0.0.1:11434/api/chat | head -20

echo
echo "=== done in WSL ==="
