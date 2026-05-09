#!/usr/bin/env bash
# Run as root: wsl -u root -- bash <thisfile>
set -uo pipefail

echo "=== A. nslookup-style: what does localhost resolve to inside WSL? ==="
getent ahosts localhost || true

echo
echo "=== B. listening sockets for :11434 (before fix) ==="
ss -tlnp | awk 'NR==1 || /:11434/' || true

echo
echo "=== C. update systemd override to dual-stack [::]:11434 ==="
mkdir -p /etc/systemd/system/ollama.service.d
cat > /etc/systemd/system/ollama.service.d/override.conf <<'EOF'
[Service]
Environment="OLLAMA_HOST=[::]:11434"
Environment="OLLAMA_ORIGINS=*"
EOF
cat /etc/systemd/system/ollama.service.d/override.conf

echo
echo "=== D. daemon-reload + restart ==="
systemctl daemon-reload
systemctl restart ollama
sleep 4
systemctl is-active ollama

echo
echo "=== E. listening sockets for :11434 (after fix) ==="
ss -tlnp | awk 'NR==1 || /:11434/' || true

echo
echo "=== F. WSL-side IPv4 probe ==="
curl --max-time 5 -fsS http://127.0.0.1:11434/api/version || echo "FAILED"

echo
echo "=== G. WSL-side IPv6 probe ==="
curl --max-time 5 -fsS http://[::1]:11434/api/version || echo "FAILED"

echo
echo "=== done in WSL ==="
