#!/usr/bin/env python3
"""JARVIS unified HTTP server — Piper TTS + Whisper STT + system stats + ruflo runner + vinted.

Endpoints:
  POST /tts                  {"text": "...", "style": "alan"|"orc"|"narrator"}
  POST /stt                  raw audio body (e.g. WebM/Opus from MediaRecorder).
                             Optional ?lang=en. Returns {"text": "..."}.
  GET  /health               -> "ok"
  GET  /styles               -> JSON list of style names
  GET  /system-stats         -> JSON with CPU/RAM/GPU/VRAM/temp + ollama running models
  GET  /ruflo/health         -> {"ok": true, "node": ..., "npx": ...}
  GET  /ruflo/jobs           -> [{"id", "argv", "running", ...}]
  POST /ruflo/run            {"argv": [...]} -> {"job_id": "..."}
  GET  /ruflo/stream/<id>    -> SSE: data: {"type":"stdout|stderr|done", ...}
  POST /ruflo/cancel/<id>    -> {"cancelled": true|false}
  GET  /vinted/health        -> {"ok": true, "categories": [...], "conditions": [...]}
  GET  /vinted/bots          -> [{"id", "name", "query", ...}]
  POST /vinted/bots          {"name", "query", "category", ...} -> bot
  DELETE /vinted/bots/<id>   -> {"deleted": true|false}
  POST /vinted/scan/<id>     -> {"suggestions": [...], "summary": {...}}
  POST /vinted/scan-all      -> [{...}, ...]
  POST /vinted/negotiate/<bot_id>/<listing_id>
                             -> {"target_offer": ..., "drafts": [...], ...}
  GET  /chat/health          -> {"ok": true, "models": [...]} (probes local Ollama)
  POST /chat                 {"model": "...", "messages": [...]} -> streams ndjson
                             tokens: {"token":"..."}\n ... {"done":true}\n
  GET  /orc/state            -> JSON snapshot of the orc NPC's phase + position
  GET  /orc/tasks            -> [{"id", "prompt", "added_at"}]
  POST /orc/tasks            {"prompt": "..."} -> task
  DELETE /orc/tasks/<id>     -> {"deleted": true|false}
  GET  /orc/recent           -> recent completions (most recent first)
  POST /orc/run-now          -> kick a cycle now ({"started": bool})
  POST /orc/config           {"enabled"?, "model"?, "interval_s"?} -> applied config
  POST /orc/ack              -> clear unread notification counter

Voice path is taken from $JARVIS_VOICE_PATH (default
~/jarvis-tts/voices/en_GB-alan-medium.onnx). Listens on 0.0.0.0:5500.
"""
import http.client
import json
import os
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse, parse_qs

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

# vinted_runner is similarly optional.
try:
    import vinted_runner
except Exception as _vinted_import_err:  # pragma: no cover - defensive
    vinted_runner = None
    _VINTED_IMPORT_ERROR = str(_vinted_import_err)
else:
    _VINTED_IMPORT_ERROR = None

# orc_runner is also optional — older installs without the file get 503s on
# /orc/* but the rest of the server stays up.
try:
    import orc_runner
except Exception as _orc_import_err:  # pragma: no cover - defensive
    orc_runner = None
    _ORC_IMPORT_ERROR = str(_orc_import_err)
else:
    _ORC_IMPORT_ERROR = None


DEFAULT_VOICE = str(Path.home() / "jarvis-tts" / "voices" / "en_GB-alan-medium.onnx")
VOICE_PATH = os.environ.get("JARVIS_VOICE_PATH", DEFAULT_VOICE)
PORT = int(os.environ.get("JARVIS_PORT", "5500"))

# Local Ollama for the minimap helper bot. Override with $JARVIS_OLLAMA_URL.
OLLAMA_URL = os.environ.get("JARVIS_OLLAMA_URL", "http://localhost:11434")

# Cap inbound /tts payloads. The webview only ever sends short prompts; anything
# larger is almost certainly a bug or abuse and would otherwise be read into
# memory in a single rfile.read(length) call.
MAX_BODY_BYTES = 64 * 1024
# /stt receives audio blobs which are much larger than text payloads. ~30s of
# Opus-encoded mono webm is well under 1 MB; 16 MB is plenty of headroom.
MAX_AUDIO_BYTES = 16 * 1024 * 1024

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
        elif self.path == "/vinted/health":
            if vinted_runner is None:
                self._send_json(503, {"ok": False, "error": _VINTED_IMPORT_ERROR})
            else:
                self._send_json(200, vinted_runner.health())
        elif self.path == "/vinted/bots":
            if vinted_runner is None:
                self._send_json(503, {"error": _VINTED_IMPORT_ERROR})
            else:
                self._send_json(200, vinted_runner.list_bots())
        elif self.path == "/chat/health":
            self._handle_chat_health()
        elif self.path == "/orc/state":
            if orc_runner is None:
                self._send_json(503, {"error": _ORC_IMPORT_ERROR})
            else:
                self._send_json(200, orc_runner.state())
        elif self.path == "/orc/tasks":
            if orc_runner is None:
                self._send_json(503, {"error": _ORC_IMPORT_ERROR})
            else:
                self._send_json(200, orc_runner.list_tasks())
        elif self.path == "/orc/recent":
            if orc_runner is None:
                self._send_json(503, {"error": _ORC_IMPORT_ERROR})
            else:
                self._send_json(200, orc_runner.recent())
        else:
            self.send_response(404)
            self.end_headers()

    def do_POST(self):
        # /stt has a query string (?lang=...), so parse before string-matching.
        parsed = urlparse(self.path)
        route = parsed.path

        if route == "/stt":
            self._handle_stt(parse_qs(parsed.query))
            return
        if self.path == "/ruflo/run":
            self._handle_ruflo_run()
            return
        if self.path.startswith("/ruflo/cancel/"):
            self._handle_ruflo_cancel(self.path[len("/ruflo/cancel/"):])
            return
        if self.path == "/vinted/bots":
            self._handle_vinted_upsert()
            return
        if self.path == "/vinted/scan-all":
            self._handle_vinted_scan_all()
            return
        if self.path.startswith("/vinted/scan/"):
            self._handle_vinted_scan(self.path[len("/vinted/scan/"):])
            return
        if self.path.startswith("/vinted/negotiate/"):
            self._handle_vinted_negotiate(self.path[len("/vinted/negotiate/"):])
            return
        if self.path == "/chat":
            self._handle_chat()
            return
        if self.path == "/orc/tasks":
            self._handle_orc_add_task()
            return
        if self.path == "/orc/run-now":
            self._handle_orc_run_now()
            return
        if self.path == "/orc/config":
            self._handle_orc_config()
            return
        if self.path == "/orc/ack":
            self._handle_orc_ack()
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

    def do_DELETE(self):
        if self.path.startswith("/vinted/bots/"):
            self._handle_vinted_delete(self.path[len("/vinted/bots/"):])
            return
        if self.path.startswith("/orc/tasks/"):
            self._handle_orc_delete_task(self.path[len("/orc/tasks/"):])
            return
        self.send_response(404)
        self.end_headers()

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

    def _read_raw_body(self, max_bytes):
        """Validate Content-Length and return the body bytes, or None on error
        (response already sent)."""
        raw_length = self.headers.get("Content-Length")
        if raw_length is None:
            self.send_response(411)
            self.end_headers()
            return None
        try:
            length = int(raw_length)
        except ValueError:
            self.send_response(400)
            self.end_headers()
            return None
        if length <= 0:
            self.send_response(400)
            self.end_headers()
            return None
        if length > max_bytes:
            self.send_response(413)
            self.end_headers()
            return None
        return self.rfile.read(length)

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

    # ─── whisper STT handler ────────────────────────────────────────────

    def _handle_stt(self, query):
        body_bytes = self._read_raw_body(MAX_AUDIO_BYTES)
        if body_bytes is None:
            return
        # Lazy import so a missing faster-whisper only breaks /stt, not the
        # whole server.
        try:
            from transcription import transcribe
        except Exception as e:
            self._send_json(500, {"error": f"transcription module unavailable: {e}"})
            return
        lang = (query.get("lang") or [""])[0].strip() or None
        try:
            text = transcribe(body_bytes, language=lang)
        except RuntimeError as e:
            # Surfaced when faster-whisper isn't installed.
            self._send_json(503, {"error": str(e)})
            return
        except Exception as e:
            self._send_json(500, {"error": f"transcription failed: {e}"})
            return
        self._send_json(200, {"text": text})

    # ─── vinted handlers ────────────────────────────────────────────────

    def _handle_vinted_upsert(self):
        if vinted_runner is None:
            self._send_json(503, {"error": _VINTED_IMPORT_ERROR})
            return
        body = self._read_json_body()
        if body is None:
            return
        try:
            bot = vinted_runner.upsert_bot(body)
        except ValueError as e:
            self._send_json(400, {"error": str(e)})
            return
        self._send_json(200, bot)

    def _handle_vinted_delete(self, bot_id):
        if vinted_runner is None:
            self._send_json(503, {"error": _VINTED_IMPORT_ERROR})
            return
        ok = vinted_runner.delete_bot(bot_id)
        self._send_json(200 if ok else 404, {"deleted": ok})

    def _handle_vinted_scan(self, bot_id):
        if vinted_runner is None:
            self._send_json(503, {"error": _VINTED_IMPORT_ERROR})
            return
        try:
            result = vinted_runner.scan_bot(bot_id)
        except ValueError as e:
            self._send_json(404, {"error": str(e)})
            return
        self._send_json(200, result)

    def _handle_vinted_scan_all(self):
        if vinted_runner is None:
            self._send_json(503, {"error": _VINTED_IMPORT_ERROR})
            return
        self._send_json(200, vinted_runner.scan_all())

    def _handle_vinted_negotiate(self, tail):
        if vinted_runner is None:
            self._send_json(503, {"error": _VINTED_IMPORT_ERROR})
            return
        # Path tail is "<bot_id>/<listing_id>" — both are URL-encoded by the
        # client, so split on the first slash and unquote each half.
        if "/" not in tail:
            self._send_json(400, {"error": "bad path: expected /vinted/negotiate/<bot_id>/<listing_id>"})
            return
        bot_id, listing_id = tail.split("/", 1)
        from urllib.parse import unquote
        try:
            result = vinted_runner.compute_negotiation(unquote(bot_id), unquote(listing_id))
        except ValueError as e:
            self._send_json(404, {"error": str(e)})
            return
        self._send_json(200, result)

    # ─── orc handlers ──────────────────────────────────────────────────

    def _handle_orc_add_task(self):
        if orc_runner is None:
            self._send_json(503, {"error": _ORC_IMPORT_ERROR})
            return
        body = self._read_json_body()
        if body is None:
            return
        try:
            task = orc_runner.add_task(body.get("prompt") or "")
        except ValueError as e:
            self._send_json(400, {"error": str(e)})
            return
        self._send_json(200, task)

    def _handle_orc_delete_task(self, task_id):
        if orc_runner is None:
            self._send_json(503, {"error": _ORC_IMPORT_ERROR})
            return
        ok = orc_runner.delete_task(task_id)
        self._send_json(200 if ok else 404, {"deleted": ok})

    def _handle_orc_run_now(self):
        if orc_runner is None:
            self._send_json(503, {"error": _ORC_IMPORT_ERROR})
            return
        # No body required, but tolerate POST with Content-Length: 0.
        raw_length = self.headers.get("Content-Length")
        if raw_length and int(raw_length) > 0:
            self._read_json_body()  # drain, ignore content
        self._send_json(200, {"started": orc_runner.run_now()})

    def _handle_orc_config(self):
        if orc_runner is None:
            self._send_json(503, {"error": _ORC_IMPORT_ERROR})
            return
        body = self._read_json_body()
        if body is None:
            return
        cfg = orc_runner.set_config(
            enabled=body.get("enabled"),
            model=body.get("model"),
            interval_s=body.get("interval_s"),
        )
        self._send_json(200, cfg)

    def _handle_orc_ack(self):
        if orc_runner is None:
            self._send_json(503, {"error": _ORC_IMPORT_ERROR})
            return
        raw_length = self.headers.get("Content-Length")
        if raw_length and int(raw_length) > 0:
            self._read_json_body()
        self._send_json(200, {"cleared": orc_runner.ack()})

    # ─── chat (ollama proxy) handlers ──────────────────────────────────

    def _handle_chat_health(self):
        """Return reachability + tag list for the local Ollama server."""
        import urllib.request
        import urllib.error

        try:
            with urllib.request.urlopen(f"{OLLAMA_URL}/api/tags", timeout=2) as r:
                data = json.loads(r.read().decode())
        except (urllib.error.URLError, OSError, ValueError) as e:
            self._send_json(200, {"ok": False, "error": str(e)})
            return
        models = [m.get("name") for m in data.get("models", []) if m.get("name")]
        self._send_json(200, {"ok": True, "models": models})

    def _handle_chat(self):
        """Stream a chat response from local Ollama as line-delimited JSON.

        Request: {"model": "...", "messages": [{"role": "user|assistant", "content": "..."}]}
        Response: each line is a JSON object: {"token": "..."} or {"done": true} or {"error": "..."}.
        """
        import urllib.request
        import urllib.error

        body = self._read_json_body()
        if body is None:
            return
        model = (body.get("model") or "").strip()
        messages = body.get("messages") or []
        if not model or not isinstance(messages, list) or not messages:
            self._send_json(400, {"error": "expected {model, messages: [...]}"})
            return

        payload = json.dumps({
            "model": model,
            "messages": messages,
            "stream": True,
        }).encode()
        req = urllib.request.Request(
            f"{OLLAMA_URL}/api/chat",
            data=payload,
            headers={"Content-Type": "application/json"},
            method="POST",
        )

        try:
            upstream = urllib.request.urlopen(req, timeout=300)
        except urllib.error.HTTPError as e:
            self._send_json(502, {"error": f"ollama HTTP {e.code}: {e.reason}"})
            return
        except (urllib.error.URLError, OSError) as e:
            self._send_json(502, {"error": f"ollama unreachable: {e}"})
            return

        # Switch to streaming response — line-delimited JSON.
        self.send_response(200)
        self._cors()
        self.send_header("Content-Type", "application/x-ndjson")
        self.send_header("Cache-Control", "no-cache")
        self.send_header("X-Accel-Buffering", "no")
        self.end_headers()

        def write_frame(obj):
            """Write one ndjson frame. Raises on broken pipe so the loop can stop."""
            self.wfile.write((json.dumps(obj) + "\n").encode())
            self.wfile.flush()

        try:
            for raw in upstream:
                if not raw:
                    continue
                try:
                    chunk = json.loads(raw.decode())
                except ValueError:
                    continue
                # Ollama surfaces upstream errors via {"error": "..."} mid-stream.
                if chunk.get("error"):
                    try:
                        write_frame({"error": str(chunk["error"])})
                    except (BrokenPipeError, ConnectionResetError):
                        pass
                    break
                token = (chunk.get("message") or {}).get("content")
                if token:
                    try:
                        write_frame({"token": token})
                    except (BrokenPipeError, ConnectionResetError):
                        # Client went away; stop pulling from ollama.
                        break
                if chunk.get("done"):
                    try:
                        write_frame({"done": True})
                    except (BrokenPipeError, ConnectionResetError):
                        pass
                    break
        except (OSError, http.client.IncompleteRead) as e:
            # Connection to ollama died mid-stream — tell the client cleanly
            # rather than letting the response truncate without a marker.
            try:
                write_frame({"error": f"ollama stream interrupted: {e}"})
            except (BrokenPipeError, ConnectionResetError, OSError):
                pass
        finally:
            try:
                upstream.close()
            except Exception:
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
