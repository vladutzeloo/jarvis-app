#!/bin/bash
# JARVIS Piper TTS one-shot setup.
# Run from your WSL Ubuntu shell:
#   bash /mnt/c/Users/vdzoo/Projects/jarvis-local/setup-piper.sh
#
# What it does:
#   1. Creates ~/jarvis-tts with a Python venv
#   2. Installs piper-tts inside the venv
#   3. Downloads the en_GB-alan-medium voice (~63 MB)
#   4. Generates a test.wav so you can hear Alan
#   5. Writes a small HTTP server (server.py) wrapping Piper on :5500
#   6. Registers it as a systemd service that auto-starts with WSL
#
# Idempotent: safe to re-run.

set -e

cd ~

echo "[1/6] Setting up ~/jarvis-tts ..."
mkdir -p ~/jarvis-tts/voices
cd ~/jarvis-tts

if [ ! -d venv ]; then
    echo "       creating venv (python3 -m venv venv)"
    python3 -m venv venv
fi

echo "[2/6] Installing piper-tts into venv (~80 MB) ..."
./venv/bin/pip install --quiet --upgrade pip
./venv/bin/pip install --quiet piper-tts

echo "[3/6] Downloading en_GB-alan-medium voice (~63 MB) ..."
cd voices
[ -f en_GB-alan-medium.onnx ] || wget -q --show-progress \
    https://huggingface.co/rhasspy/piper-voices/resolve/main/en/en_GB/alan/medium/en_GB-alan-medium.onnx
[ -f en_GB-alan-medium.onnx.json ] || wget -q \
    https://huggingface.co/rhasspy/piper-voices/resolve/main/en/en_GB/alan/medium/en_GB-alan-medium.onnx.json
cd ..

echo "[4/6] Generating test.wav ..."
echo "Good evening sir. JARVIS is now online and at your service." \
    | ./venv/bin/piper -m voices/en_GB-alan-medium.onnx -f test.wav 2>/dev/null

if [ -f test.wav ]; then
    SIZE=$(stat -c%s test.wav)
    echo "       ✓ test.wav created ($(numfmt --to=iec $SIZE))"
else
    echo "       ✗ Piper test failed. Aborting."
    exit 1
fi

echo "[5/6] Writing HTTP server (~/jarvis-tts/server.py) ..."
cat > server.py <<'PYEOF'
#!/usr/bin/env python3
"""Tiny HTTP server wrapping Piper TTS for JARVIS. Listens on :5500."""
import io
import json
import wave
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from piper import PiperVoice

VOICE_PATH = "/home/vdzoo/jarvis-tts/voices/en_GB-alan-medium.onnx"
print(f"Loading voice: {VOICE_PATH}", flush=True)
voice = PiperVoice.load(VOICE_PATH)
print("Ready.", flush=True)


class Handler(BaseHTTPRequestHandler):
    def _cors(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")

    def do_OPTIONS(self):
        self.send_response(204)
        self._cors()
        self.end_headers()

    def do_GET(self):
        if self.path == "/health":
            self.send_response(200)
            self._cors()
            self.send_header("Content-Type", "text/plain")
            self.end_headers()
            self.wfile.write(b"ok")
            return
        self.send_response(404)
        self.end_headers()

    def do_POST(self):
        if self.path != "/tts":
            self.send_response(404)
            self.end_headers()
            return
        length = int(self.headers.get("Content-Length", 0))
        try:
            body = json.loads(self.rfile.read(length).decode())
        except Exception:
            self.send_response(400)
            self.end_headers()
            return
        text = (body.get("text") or "").strip()
        if not text:
            self.send_response(400)
            self.end_headers()
            return

        buf = io.BytesIO()
        with wave.open(buf, "wb") as wav_file:
            voice.synthesize(text, wav_file)
        audio = buf.getvalue()

        self.send_response(200)
        self._cors()
        self.send_header("Content-Type", "audio/wav")
        self.send_header("Content-Length", str(len(audio)))
        self.end_headers()
        self.wfile.write(audio)

    def log_message(self, *args, **kwargs):
        pass  # quiet


if __name__ == "__main__":
    server = ThreadingHTTPServer(("0.0.0.0", 5500), Handler)
    print("JARVIS TTS on http://0.0.0.0:5500", flush=True)
    server.serve_forever()
PYEOF

echo "[6/6] Registering systemd service jarvis-tts.service ..."
sudo tee /etc/systemd/system/jarvis-tts.service > /dev/null <<EOF
[Unit]
Description=JARVIS TTS (Piper)
After=network.target

[Service]
Type=simple
User=vdzoo
WorkingDirectory=/home/vdzoo/jarvis-tts
ExecStart=/home/vdzoo/jarvis-tts/venv/bin/python /home/vdzoo/jarvis-tts/server.py
Restart=on-failure
RestartSec=2

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable jarvis-tts
sudo systemctl restart jarvis-tts

echo
echo "=== Setup complete ==="
echo
sleep 1
echo "Health check:"
curl -s http://localhost:5500/health || echo "(server not yet ready — check: sudo systemctl status jarvis-tts)"
echo
echo
echo "Listen to test.wav from Windows:"
echo "  \\\\wsl.localhost\\Ubuntu-24.04\\home\\vdzoo\\jarvis-tts\\test.wav"
