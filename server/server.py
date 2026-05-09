#!/usr/bin/env python3
"""JARVIS unified HTTP server — Piper TTS + system stats + ruflo runner.

Endpoints:
  POST /tts                  {"text": "...", "style": "alan"|"orc"|"narrator"}
  GET  /health               -> "ok"
  GET  /styles               -> JSON list of style names
  GET  /system-stats         -> JSON with CPU/RAM/GPU/VRAM/temp + ollama running models
  GET  /ruflo/health         -> {"ok": true, "node": ..., "npx": ...}
  GET  /ruflo/jobs           -> [{"id", "argv", "running", ...}]
  POST /ruflo/run            {"argv": [...]} -> {"job_id": "..."}
  GET  /ruflo/stream/<id>    -> SSE: data: {"type":"stdout|stderr|done", ...}
  POST /ruflo/cancel/<id>    -> {"cancelled": true|false}

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

# ruflo_runner is optional — if the file is missing (older install), the
# /ruflo/* routes return 503 instead of crashing the whole server.
try:
    import ruflo_runner
except Exception as _ruflo_import_err:  # pragma: no cover - defensive
    ruflo_runner = None
    _RUFLO_IMPORT_ERROR = str(_ruflo_import_err)
else:
    _RUFLO_IMPORT_ERROR = None


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
        elif self.path == "/ruflo/health":
            if ruflo_runner is None:
                self._send_json(503, {"ok": False, "error": _RUFLO_IMPORT_ERROR})
            else:
                self._send_json(200, ruflo_runner.health())
        elif self.path == "/ruflo/jobs":
            if ruflo_runner is None:
                self._send_json(503, {"error": _RUFLO_IMPORT_ERROR})
            else:
                self._send_json(200, ruflo_runner.list_jobs())
        elif self.path.startswith("/ruflo/stream/"):
            self._handle_ruflo_stream(self.path[len("/ruflo/stream/"):])
        else:
            self.send_response(404)
            self.end_headers()

    def do_POST(self):
        if self.path == "/ruflo/run":
            self._handle_ruflo_run()
            return
        if self.path.startswith("/ruflo/cancel/"):
            self._handle_ruflo_cancel(self.path[len("/ruflo/cancel/"):])
            return
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

    # ─── ruflo handlers ─────────────────────────────────────────────────

    def _read_json_body(self, max_bytes=MAX_BODY_BYTES):
        raw_length = self.headers.get("Content-Length")
        if raw_length is None:
            self.send_response(411); self.end_headers(); return None
        try:
            length = int(raw_length)
        except ValueError:
            self.send_response(400); self.end_headers(); return None
        if length <= 0 or length > max_bytes:
            self.send_response(413 if length > max_bytes else 400)
            self.end_headers(); return None
        try:
            return json.loads(self.rfile.read(length).decode())
        except Exception:
            self.send_response(400); self.end_headers(); return None

    def _handle_ruflo_run(self):
        if ruflo_runner is None:
            self._send_json(503, {"error": _RUFLO_IMPORT_ERROR})
            return
        body = self._read_json_body()
        if body is None:
            return
        argv = body.get("argv")
        cwd = body.get("cwd") or None
        try:
            job = ruflo_runner.start_job(argv, cwd=cwd)
        except (ValueError, RuntimeError) as e:
            self._send_json(400, {"error": str(e)})
            return
        self._send_json(200, {"job_id": job.id, "argv": job.argv})

    def _handle_ruflo_cancel(self, job_id):
        if ruflo_runner is None:
            self._send_json(503, {"error": _RUFLO_IMPORT_ERROR})
            return
        ok = ruflo_runner.cancel_job(job_id)
        self._send_json(200 if ok else 404, {"cancelled": ok})

    def _handle_ruflo_stream(self, job_id):
        if ruflo_runner is None:
            self._send_json(503, {"error": _RUFLO_IMPORT_ERROR})
            return
        job = ruflo_runner.get_job(job_id)
        if not job:
            self.send_response(404); self.end_headers(); return
        self.send_response(200)
        self._cors()
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-cache")
        self.send_header("Connection", "keep-alive")
        self.send_header("X-Accel-Buffering", "no")
        self.end_headers()

        def push(item):
            try:
                self.wfile.write(ruflo_runner.sse_for(item))
                self.wfile.flush()
            except (BrokenPipeError, ConnectionResetError):
                # Consumer went away — let attach_consumer's `finally` reset
                # the attach flag. Re-raise to break the loop.
                raise

        try:
            ruflo_runner.attach_consumer(job, push)
        except RuntimeError as e:
            # Already-attached races land here; the headers are already sent,
            # so emit one error frame and close.
            try:
                self.wfile.write(
                    f"data: {json.dumps({'type':'error','message':str(e)})}\n\n".encode()
                )
                self.wfile.flush()
            except Exception:
                pass
        except (BrokenPipeError, ConnectionResetError):
            pass

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
