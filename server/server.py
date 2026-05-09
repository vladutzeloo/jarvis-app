#!/usr/bin/env python3
"""JARVIS unified HTTP server — Piper TTS + system stats endpoint.

Endpoints:
  POST /tts          {"text": "...", "style": "alan"|"orc"|"narrator"}
  GET  /health       -> "ok"
  GET  /styles       -> JSON list of style names
  GET  /system-stats -> JSON with CPU/RAM/GPU/VRAM/temp + ollama running models

Voice path is taken from $JARVIS_VOICE_PATH (default
~/jarvis-tts/voices/en_GB-alan-medium.onnx). Listens on 0.0.0.0:5500.
"""
import json
import os
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

# Make sibling modules importable regardless of how systemd invokes us.
sys.path.insert(0, str(Path(__file__).resolve().parent))

from synthesis import STYLES, Synthesizer
from system_stats import prime, system_stats


DEFAULT_VOICE = str(Path.home() / "jarvis-tts" / "voices" / "en_GB-alan-medium.onnx")
VOICE_PATH = os.environ.get("JARVIS_VOICE_PATH", DEFAULT_VOICE)
PORT = int(os.environ.get("JARVIS_PORT", "5500"))

# Cap inbound /tts payloads. The webview only ever sends short prompts; anything
# larger is almost certainly a bug or abuse and would otherwise be read into
# memory in a single rfile.read(length) call.
MAX_BODY_BYTES = 64 * 1024

synth = Synthesizer(VOICE_PATH)


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
        elif self.path == "/styles":
            self._send_json(200, list(STYLES.keys()))
        elif self.path == "/system-stats":
            self._send_json(200, system_stats())
        else:
            self.send_response(404)
            self.end_headers()

    def do_POST(self):
        if self.path != "/tts":
            self.send_response(404)
            self.end_headers()
            return
        raw_length = self.headers.get("Content-Length")
        if raw_length is None:
            self.send_response(411)
            self.end_headers()
            return
        try:
            length = int(raw_length)
        except ValueError:
            self.send_response(400)
            self.end_headers()
            return
        if length > MAX_BODY_BYTES:
            self.send_response(413)
            self.end_headers()
            return
        if length <= 0:
            self.send_response(400)
            self.end_headers()
            return
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
        audio = synth.synthesize(text, style)
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
    prime()
    server = ThreadingHTTPServer(("0.0.0.0", PORT), Handler)
    print(f"JARVIS server on http://0.0.0.0:{PORT}", flush=True)
    server.serve_forever()
