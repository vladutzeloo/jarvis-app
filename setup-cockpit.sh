#!/bin/bash
# JARVIS Cockpit setup — adds /system-stats to the existing Piper server.
# Run from your WSL Ubuntu shell:
#   bash /mnt/c/Users/vdzoo/Projects/jarvis-local/setup-cockpit.sh
#
# What it does:
#   1. Installs psutil in the jarvis-tts venv
#   2. Rewrites server.py to ALSO expose /system-stats (alongside existing /tts, /health, /styles)
#   3. Restarts the jarvis-tts service
#
# Idempotent: safe to re-run.

set -e

echo "[1/3] Installing psutil into jarvis-tts venv ..."
~/jarvis-tts/venv/bin/pip install --quiet psutil

echo "[2/3] Rewriting ~/jarvis-tts/server.py with /system-stats endpoint ..."
cat > ~/jarvis-tts/server.py <<'PYEOF'
#!/usr/bin/env python3
"""JARVIS unified server — Piper TTS + system stats endpoint.

Endpoints:
  POST /tts          {"text": "...", "style": "alan"|"orc"|"narrator"}
  GET  /health       -> "ok"
  GET  /styles       -> JSON list of style names
  GET  /system-stats -> JSON with CPU/RAM/GPU/VRAM/temp + ollama running models
"""
import io
import json
import shutil
import subprocess
import time
import wave
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.request import urlopen
from urllib.error import URLError

import psutil
from piper import PiperVoice

VOICE_PATH = "/home/vdzoo/jarvis-tts/voices/en_GB-alan-medium.onnx"
print(f"Loading voice: {VOICE_PATH}", flush=True)
voice = PiperVoice.load(VOICE_PATH)
print("Voice ready.", flush=True)

import os as _os
SOX = shutil.which("sox")
# nvidia-smi is shipped via WSL2 at /usr/lib/wsl/lib/, often not on systemd PATH.
NVIDIA_SMI = shutil.which("nvidia-smi")
if not NVIDIA_SMI:
    for cand in ("/usr/lib/wsl/lib/nvidia-smi", "/usr/bin/nvidia-smi", "/usr/local/bin/nvidia-smi"):
        if _os.path.isfile(cand) and _os.access(cand, _os.X_OK):
            NVIDIA_SMI = cand
            break
print(f"sox: {SOX}  nvidia-smi: {NVIDIA_SMI}", flush=True)

STYLES = {
    "alan": [],
    "orc": [
        "pitch", "-550", "tempo", "0.85",
        "bass", "+10", "treble", "-4",
        "overdrive", "8",
        "reverb", "35", "60", "70", "100", "0", "0",
        "gain", "-n", "-3",
    ],
    "narrator": [
        "pitch", "-150", "bass", "+4",
        "reverb", "20", "50", "100", "100", "0", "0",
        "gain", "-n", "-2",
    ],
}

# --------------- Synthesis ---------------

def apply_effects(wav_bytes: bytes, style: str) -> bytes:
    chain = STYLES.get(style, [])
    if not chain or not SOX:
        return wav_bytes
    try:
        result = subprocess.run(
            [SOX, "-t", "wav", "-", "-t", "wav", "-", *chain],
            input=wav_bytes, capture_output=True, check=True, timeout=15,
        )
        return result.stdout
    except (subprocess.CalledProcessError, subprocess.TimeoutExpired):
        return wav_bytes


def synthesize(text: str, style: str) -> bytes:
    buf = io.BytesIO()
    with wave.open(buf, "wb") as wav_file:
        voice.synthesize(text, wav_file)
    return apply_effects(buf.getvalue(), style)


# --------------- System stats ---------------

# psutil.cpu_percent() needs a baseline call; use cached interval.
_last_cpu_t = 0.0
_last_cpu_v = 0.0


def cpu_percent_cached() -> float:
    global _last_cpu_t, _last_cpu_v
    now = time.time()
    if now - _last_cpu_t > 0.5:
        _last_cpu_v = psutil.cpu_percent(interval=None)
        _last_cpu_t = now
    return _last_cpu_v


def _try_float(v):
    if v is None or v in ("", "[N/A]", "[Not Supported]"):
        return None
    try:
        return float(v)
    except ValueError:
        return None


def gpu_stats():
    if not NVIDIA_SMI:
        return None
    try:
        out = subprocess.run(
            [
                NVIDIA_SMI,
                "--query-gpu=name,utilization.gpu,memory.used,memory.total,temperature.gpu,power.draw,power.limit,fan.speed",
                "--format=csv,noheader,nounits",
            ],
            capture_output=True, text=True, timeout=2, check=True,
        ).stdout.strip()
        if not out:
            return None
        first = out.splitlines()[0]
        parts = [p.strip() for p in first.split(",")]
        if len(parts) < 5:
            return None
        return {
            "name": parts[0],
            "util_pct": _try_float(parts[1]) or 0.0,
            "mem_used_mb": _try_float(parts[2]) or 0.0,
            "mem_total_mb": _try_float(parts[3]) or 0.0,
            "temp_c": _try_float(parts[4]) or 0.0,
            "power_w": _try_float(parts[5]) if len(parts) > 5 else None,
            "power_limit_w": _try_float(parts[6]) if len(parts) > 6 else None,
            "fan_pct": _try_float(parts[7]) if len(parts) > 7 else None,
        }
    except Exception:
        return None


def ollama_running():
    try:
        with urlopen("http://localhost:11434/api/ps", timeout=1) as resp:
            data = json.load(resp)
        out = []
        for m in data.get("models", []):
            out.append({
                "name": m.get("name"),
                "size": m.get("size"),
                "size_vram": m.get("size_vram"),
                "expires_at": m.get("expires_at"),
            })
        return out
    except (URLError, Exception):
        return []


def system_stats():
    vm = psutil.virtual_memory()
    sw = psutil.swap_memory()
    return {
        "cpu_percent": cpu_percent_cached(),
        "cpu_cores_logical": psutil.cpu_count(logical=True),
        "cpu_cores_physical": psutil.cpu_count(logical=False),
        "mem_used_bytes": vm.used,
        "mem_total_bytes": vm.total,
        "mem_percent": vm.percent,
        "swap_used_bytes": sw.used,
        "swap_total_bytes": sw.total,
        "swap_percent": sw.percent,
        "gpu": gpu_stats(),
        "ollama": ollama_running(),
        "timestamp": time.time(),
    }


# --------------- HTTP server ---------------

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
            self._send_text(200, "ok")
            return
        if self.path == "/styles":
            self._send_json(200, list(STYLES.keys()))
            return
        if self.path == "/system-stats":
            self._send_json(200, system_stats())
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

    def _send_text(self, status, body):
        encoded = body.encode() if isinstance(body, str) else body
        self.send_response(status)
        self._cors()
        self.send_header("Content-Type", "text/plain")
        self.send_header("Content-Length", str(len(encoded)))
        self.end_headers()
        self.wfile.write(encoded)

    def _send_json(self, status, body):
        encoded = json.dumps(body).encode()
        self.send_response(status)
        self._cors()
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(encoded)))
        self.end_headers()
        self.wfile.write(encoded)

    def log_message(self, *args, **kwargs):
        pass


if __name__ == "__main__":
    psutil.cpu_percent(interval=None)  # prime the meter
    server = ThreadingHTTPServer(("0.0.0.0", 5500), Handler)
    print("JARVIS server on http://0.0.0.0:5500", flush=True)
    server.serve_forever()
PYEOF

echo "[3/3] Restarting jarvis-tts service ..."
sudo systemctl restart jarvis-tts
sleep 1

echo
echo "=== Setup complete ==="
echo "Health:   $(curl -s http://localhost:5500/health || echo 'not yet ready')"
echo
echo "Test stats:"
curl -s http://localhost:5500/system-stats | python3 -m json.tool 2>/dev/null | head -30 || echo "(stats endpoint not responding yet)"
