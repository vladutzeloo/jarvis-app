#!/usr/bin/env bash
# JARVIS server installer — composable replacement for the old
# setup-piper.sh + setup-orc.sh + setup-cockpit.sh trio.
#
# Usage:
#   bash scripts/jarvis-server.sh [--piper] [--styles] [--cockpit] [--ruflo] [--whisper] [--all]
#
# Flags map to the feature layers:
#   --piper    install Piper, download the en_GB-alan voice, copy server.py
#   --styles   add sox so STYLES (orc / narrator) actually post-process
#   --cockpit  add psutil for /system-stats
#   --ruflo    enable the ruflo runner (multi-agent orchestration via npx);
#              requires node + npx already on PATH inside WSL
#   --whisper  add faster-whisper + ffmpeg so /stt can transcribe mic audio
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
DO_RUFLO=0
DO_WHISPER=0

if [ $# -eq 0 ]; then
    DO_PIPER=1; DO_STYLES=1; DO_COCKPIT=1; DO_RUFLO=1; DO_WHISPER=1
else
    for arg in "$@"; do
        case "$arg" in
            --piper)   DO_PIPER=1 ;;
            --styles)  DO_STYLES=1 ;;
            --cockpit) DO_COCKPIT=1 ;;
            --ruflo)   DO_RUFLO=1 ;;
            --whisper) DO_WHISPER=1 ;;
            --all)     DO_PIPER=1; DO_STYLES=1; DO_COCKPIT=1; DO_RUFLO=1; DO_WHISPER=1 ;;
            -h|--help)
                grep -E '^# ' "$0" | sed 's/^# //; s/^#//'
                exit 0 ;;
            *) echo "Unknown flag: $arg"; exit 1 ;;
        esac
    done
fi

# Carry forward a previous ruflo install on partial re-runs, so installing
# just (e.g.) --piper later doesn't quietly strip the runner's PATH override
# from the systemd unit.
if [ -f "$INSTALL_DIR/ruflo_runner.py" ] && [ "$DO_RUFLO" = "0" ]; then
    DO_RUFLO=1
fi

# Same idea for whisper: if transcription.py is already installed, keep it
# wired up on partial re-runs.
if [ -f "$INSTALL_DIR/transcription.py" ] && [ "$DO_WHISPER" = "0" ]; then
    DO_WHISPER=1
fi

# Piper requires the directory + venv before anything else can install into it.
if [ "$DO_STYLES" = "1" ] || [ "$DO_COCKPIT" = "1" ] || [ "$DO_WHISPER" = "1" ]; then
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

if [ "$DO_WHISPER" = "1" ]; then
    echo "[whisper] installing ffmpeg + faster-whisper ..."
    if ! command -v ffmpeg > /dev/null; then
        sudo apt-get update -qq
        sudo apt-get install -y ffmpeg
    else
        echo "          ffmpeg already present"
    fi
    "$INSTALL_DIR/venv/bin/pip" install --quiet faster-whisper
fi

NODE_BIN_DIR=""
if [ "$DO_RUFLO" = "1" ]; then
    echo "[ruflo] checking for node + npx ..."
    if ! command -v node >/dev/null || ! command -v npx >/dev/null; then
        echo "        node/npx not found on PATH."
        echo "        Install Node.js >=18 inside WSL first, e.g. via nvm:"
        echo "          curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.7/install.sh | bash"
        echo "          . ~/.nvm/nvm.sh && nvm install --lts"
        echo "        then re-run: bash scripts/jarvis-server.sh --ruflo"
        exit 1
    fi
    NODE_BIN_DIR="$(dirname "$(command -v npx)")"
    echo "        node:  $(command -v node) ($(node --version))"
    echo "        npx:   $(command -v npx)"
    echo "        bin:   $NODE_BIN_DIR (will be added to systemd PATH)"
fi

echo "[server] copying Python modules from $SERVER_SRC -> $INSTALL_DIR ..."
for _py in server.py synthesis.py system_stats.py vinted_runner.py ruflo_runner.py transcription.py; do
    [ -f "$SERVER_SRC/$_py" ] && cp "$SERVER_SRC/$_py" "$INSTALL_DIR/$_py"
done

if [ "$DO_PIPER" = "1" ]; then
    echo "[piper] generating test.wav ..."
    echo "Good evening sir. JARVIS is now online and at your service." \
        | "$INSTALL_DIR/venv/bin/piper" -m "$INSTALL_DIR/voices/en_GB-alan-medium.onnx" \
        -f "$INSTALL_DIR/test.wav" 2>/dev/null || true
fi

echo "[systemd] writing /etc/systemd/system/jarvis-tts.service ..."
RUFLO_PATH_LINE=""
RUFLO_HOME_LINE=""
if [ "$DO_RUFLO" = "1" ] && [ -n "$NODE_BIN_DIR" ]; then
    # Make node/npx visible to subprocess.Popen and let npx locate its cache
    # under the invoking user's HOME (systemd otherwise sets HOME=/).
    RUFLO_PATH_LINE="Environment=PATH=$NODE_BIN_DIR:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
    RUFLO_HOME_LINE="Environment=HOME=$HOME"
fi
sudo tee /etc/systemd/system/jarvis-tts.service > /dev/null <<EOF
[Unit]
Description=JARVIS server (Piper TTS + system stats + ruflo runner + whisper STT)
After=network.target

[Service]
Type=simple
User=$SERVICE_USER
WorkingDirectory=$INSTALL_DIR
Environment=JARVIS_VOICE_PATH=$INSTALL_DIR/voices/en_GB-alan-medium.onnx
$RUFLO_PATH_LINE
$RUFLO_HOME_LINE
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
if [ "$DO_RUFLO" = "1" ]; then
    echo "Ruflo health:"
    curl -s http://localhost:5500/ruflo/health | python3 -m json.tool 2>/dev/null || echo "(ruflo endpoint not responding yet)"
fi
