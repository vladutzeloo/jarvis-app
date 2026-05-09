#!/bin/bash
# JARVIS Orc-mode upgrade.
# Run from your WSL Ubuntu shell:
#   bash /mnt/c/Users/vdzoo/Projects/jarvis-local/setup-orc.sh
#
# What it does:
#   1. Installs sox (audio effects pipeline)
#   2. Rewrites ~/jarvis-tts/server.py with style support (alan / orc / narrator)
#   3. Restarts jarvis-tts service
#
# Idempotent: safe to re-run.

set -e

echo "[1/3] Installing sox ..."
if ! command -v sox > /dev/null; then
    sudo apt-get update -qq
    sudo apt-get install -y sox
else
    echo "       sox already present"
fi

echo "[2/3] Rewriting ~/jarvis-tts/server.py with style support ..."
cat > ~/jarvis-tts/server.py <<'PYEOF'
#!/usr/bin/env python3
"""JARVIS TTS — Piper synthesis + optional sox post-effects.

POST /tts {"text": "...", "style": "alan" | "orc" | "narrator"}
GET  /health             -> "ok"
GET  /styles             -> JSON list of available styles
"""
import io
import json
import shutil
import subprocess
import wave
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from piper import PiperVoice

VOICE_PATH = "/home/vdzoo/jarvis-tts/voices/en_GB-alan-medium.onnx"
print(f"Loading voice: {VOICE_PATH}", flush=True)
voice = PiperVoice.load(VOICE_PATH)
print("Voice ready.", flush=True)

SOX = shutil.which("sox")
if not SOX:
    print("WARN: sox not found — only 'alan' style will work.", flush=True)
else:
    print(f"sox: {SOX}", flush=True)

# Each preset is a sox effects chain applied to Piper's WAV output.
# Chain reference: https://linux.die.net/man/1/sox
STYLES = {
    "alan": [],
    "orc": [
        "pitch", "-550",            # ~5.5 semitones down — guttural
        "tempo", "0.85",            # slower, weightier
        "bass", "+10",              # heavy bottom
        "treble", "-4",             # take edge off
        "overdrive", "8",           # mild grit
        "reverb", "35", "60", "70", "100", "0", "0",  # cave-ish
        "gain", "-n", "-3",         # normalize then drop a touch
    ],
    "narrator": [
        "pitch", "-150",            # slight depth
        "bass", "+4",
        "reverb", "20", "50", "100", "100", "0", "0",
        "gain", "-n", "-2",
    ],
}


def apply_effects(wav_bytes: bytes, style: str) -> bytes:
    chain = STYLES.get(style, [])
    if not chain or not SOX:
        return wav_bytes
    try:
        result = subprocess.run(
            [SOX, "-t", "wav", "-", "-t", "wav", "-", *chain],
            input=wav_bytes,
            capture_output=True,
            check=True,
            timeout=15,
        )
        return result.stdout
    except (subprocess.CalledProcessError, subprocess.TimeoutExpired):
        return wav_bytes


def synthesize(text: str, style: str) -> bytes:
    buf = io.BytesIO()
    with wave.open(buf, "wb") as wav_file:
        voice.synthesize(text, wav_file)
    return apply_effects(buf.getvalue(), style)


class Handler(BaseHTTPRequestHandler):
    def _cors(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "POST, GET, OPTIONS")
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
        if self.path == "/styles":
            self.send_response(200)
            self._cors()
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(json.dumps(list(STYLES.keys())).encode())
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
        style = body.get("style") or "alan"
        if not text:
            self.send_response(400)
            self.end_headers()
            return

        audio = synthesize(text, style)
        self.send_response(200)
        self._cors()
        self.send_header("Content-Type", "audio/wav")
        self.send_header("Content-Length", str(len(audio)))
        self.end_headers()
        self.wfile.write(audio)

    def log_message(self, *args, **kwargs):
        pass


if __name__ == "__main__":
    server = ThreadingHTTPServer(("0.0.0.0", 5500), Handler)
    print("JARVIS TTS on http://0.0.0.0:5500", flush=True)
    server.serve_forever()
PYEOF

echo "[3/3] Restarting jarvis-tts service ..."
sudo systemctl restart jarvis-tts
sleep 1

echo
echo "=== Setup complete ==="
echo "Health:   $(curl -s http://localhost:5500/health || echo 'not yet ready')"
echo "Styles:   $(curl -s http://localhost:5500/styles)"
echo
echo "Test orc voice:"
echo "  curl -X POST http://localhost:5500/tts \\"
echo "    -H 'Content-Type: application/json' \\"
echo "    -d '{\"text\":\"You shall not pass without paying the toll, traveller.\",\"style\":\"orc\"}' \\"
echo "    --output /tmp/orc.wav && aplay /tmp/orc.wav 2>/dev/null || echo 'wrote /tmp/orc.wav'"
