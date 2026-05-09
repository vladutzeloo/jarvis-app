#!/usr/bin/env bash
# JARVIS server installer — composable replacement for the old
# setup-piper.sh + setup-orc.sh + setup-cockpit.sh trio.
#
# Usage:
#   bash scripts/jarvis-server.sh [--piper] [--styles] [--cockpit] [--all]
#
# Flags map to the three feature layers:
#   --piper    install Piper, download the en_GB-alan voice, copy server.py
#   --styles   add sox so STYLES (orc / narrator) actually post-process
#   --cockpit  add psutil for /system-stats
#   --all      do all of the above (default if no flags given)
#
# The Python sources live under server/ in this repo. They get copied (not
# overwritten in place) into ~/jarvis-tts so the venv has stable imports.
# Re-run any time — idempotent.

set -e

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SERVER_SRC="$REPO_ROOT/server"
INSTALL_DIR="${JARVIS_HOME:-$HOME/jarvis-tts}"
SERVICE_USER="${SUDO_USER:-$USER}"

DO_PIPER=0
DO_STYLES=0
DO_COCKPIT=0

if [ $# -eq 0 ]; then
    DO_PIPER=1; DO_STYLES=1; DO_COCKPIT=1
else
    for arg in "$@"; do
        case "$arg" in
            --piper)   DO_PIPER=1 ;;
            --styles)  DO_STYLES=1 ;;
            --cockpit) DO_COCKPIT=1 ;;
            --all)     DO_PIPER=1; DO_STYLES=1; DO_COCKPIT=1 ;;
            -h|--help)
                grep -E '^# ' "$0" | sed 's/^# //; s/^#//'
                exit 0 ;;
            *) echo "Unknown flag: $arg"; exit 1 ;;
        esac
    done
fi

# Piper requires the directory + venv before anything else can install into it.
if [ "$DO_STYLES" = "1" ] || [ "$DO_COCKPIT" = "1" ]; then
    if [ ! -d "$INSTALL_DIR/venv" ]; then
        DO_PIPER=1
    fi
fi

mkdir -p "$INSTALL_DIR/voices"

if [ "$DO_PIPER" = "1" ]; then
    echo "[piper] $INSTALL_DIR ..."
    if [ ! -d "$INSTALL_DIR/venv" ]; then
        echo "        creating venv (python3 -m venv)"
        python3 -m venv "$INSTALL_DIR/venv"
    fi
    "$INSTALL_DIR/venv/bin/pip" install --quiet --upgrade pip
    "$INSTALL_DIR/venv/bin/pip" install --quiet piper-tts

    cd "$INSTALL_DIR/voices"
    [ -f en_GB-alan-medium.onnx ] || wget -q --show-progress \
        https://huggingface.co/rhasspy/piper-voices/resolve/main/en/en_GB/alan/medium/en_GB-alan-medium.onnx
    [ -f en_GB-alan-medium.onnx.json ] || wget -q \
        https://huggingface.co/rhasspy/piper-voices/resolve/main/en/en_GB/alan/medium/en_GB-alan-medium.onnx.json
    cd - >/dev/null
fi

if [ "$DO_STYLES" = "1" ]; then
    echo "[styles] installing sox ..."
    if ! command -v sox > /dev/null; then
        sudo apt-get update -qq
        sudo apt-get install -y sox
    else
        echo "         sox already present"
    fi
fi

if [ "$DO_COCKPIT" = "1" ]; then
    echo "[cockpit] installing psutil into venv ..."
    "$INSTALL_DIR/venv/bin/pip" install --quiet psutil
fi

echo "[server] copying Python modules from $SERVER_SRC -> $INSTALL_DIR ..."
cp "$SERVER_SRC/server.py" "$INSTALL_DIR/server.py"
cp "$SERVER_SRC/synthesis.py" "$INSTALL_DIR/synthesis.py"
cp "$SERVER_SRC/system_stats.py" "$INSTALL_DIR/system_stats.py"

if [ "$DO_PIPER" = "1" ]; then
    echo "[piper] generating test.wav ..."
    echo "Good evening sir. JARVIS is now online and at your service." \
        | "$INSTALL_DIR/venv/bin/piper" -m "$INSTALL_DIR/voices/en_GB-alan-medium.onnx" \
        -f "$INSTALL_DIR/test.wav" 2>/dev/null || true
fi

echo "[systemd] writing /etc/systemd/system/jarvis-tts.service ..."
sudo tee /etc/systemd/system/jarvis-tts.service > /dev/null <<EOF
[Unit]
Description=JARVIS server (Piper TTS + system stats)
After=network.target

[Service]
Type=simple
User=$SERVICE_USER
WorkingDirectory=$INSTALL_DIR
Environment=JARVIS_VOICE_PATH=$INSTALL_DIR/voices/en_GB-alan-medium.onnx
ExecStart=$INSTALL_DIR/venv/bin/python $INSTALL_DIR/server.py
Restart=on-failure
RestartSec=2

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable jarvis-tts >/dev/null 2>&1 || true
sudo systemctl restart jarvis-tts

echo
echo "=== Setup complete ==="
sleep 1
echo "Health:    $(curl -s http://localhost:5500/health || echo '(not yet ready)')"
echo "Styles:    $(curl -s http://localhost:5500/styles || echo '(no response)')"
if [ "$DO_COCKPIT" = "1" ]; then
    echo "Stats sample:"
    curl -s http://localhost:5500/system-stats | python3 -m json.tool 2>/dev/null | head -20 || echo "(stats endpoint not responding yet)"
fi
