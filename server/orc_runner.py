"""Orc NPC agent — picks small "bug" tasks on a schedule and feeds them to a
local Ollama coder model (qwen2.5-coder by default).

The orc has a tiny state machine driven by a single background thread:

    idle ──tick──▶ walking ──arrive──▶ thinking ──done──▶ idle

The HTTP layer in `server.py` polls `state()` to render the orc's position on
the minimap, and reads `recent()` to surface completed answers as
notifications. Tasks live in a JSON file (default ~/jarvis-tts/orc-tasks.json)
so the queue survives restarts.

The runner is intentionally UI-agnostic: no SSE, no fancy framing — just a
state snapshot the frontend can poll. Polling is cheap; SSE is overkill for an
NPC that thinks once every few minutes.
"""
from __future__ import annotations

import json
import os
import random
import threading
import time
import urllib.error
import urllib.request
import uuid
from pathlib import Path
from typing import Optional


OLLAMA_URL = os.environ.get("JARVIS_OLLAMA_URL", "http://localhost:11434")
DEFAULT_MODEL = os.environ.get("JARVIS_ORC_MODEL", "qwen2.5-coder:latest")
DEFAULT_INTERVAL_S = int(os.environ.get("JARVIS_ORC_INTERVAL_S", "180"))

# Where to walk on the minimap. The frontend interprets these as named
# waypoints; we just pick one at random for each cycle.
WAYPOINTS = ["system", "jobs", "log", "chat"]

STORE_PATH = Path(
    os.environ.get(
        "JARVIS_ORC_STORE",
        str(Path.home() / "jarvis-tts" / "orc-tasks.json"),
    )
)

# Cap how much we hand back to the UI. Qwen-coder responses can run long, but
# the orc's thinking bubble only needs the gist — we keep the head + a hint.
MAX_ANSWER_CHARS = 1200

# Cap on how many completed runs we remember. Older ones fall off the back.
RECENT_LIMIT = 50

# Seed tasks the orc starts with on a fresh install. Phrased as small,
# self-contained dev musings — not "edit this file", since the orc only thinks
# out loud, it doesn't write to disk.
SEED_TASKS = [
    "Why might a setTimeout-based polling loop double-fire after a settings change? Sketch a one-paragraph fix.",
    "List three subtle bugs that hide in unescaped innerHTML in a status dashboard.",
    "When is `JSON.parse` inside a streaming reader a footgun? One short example.",
    "What's a common race condition between AbortController and a finally-reschedule pattern?",
    "Name three small ergonomics wins for a localStorage-backed settings module.",
    "Tiny audit: what could go wrong with EventSource auto-reconnect during job cancel?",
]


class _State:
    """Mutable orc state, guarded by a single lock.

    All public functions in this module are entry points from either the HTTP
    handler thread or the scheduler thread, so we serialize every read/write
    that touches mutable fields.
    """

    def __init__(self) -> None:
        self.lock = threading.RLock()

        # Scheduler config — surfaced via /orc/state and writable via /orc/config.
        self.enabled: bool = True
        self.model: str = DEFAULT_MODEL
        self.interval_s: int = DEFAULT_INTERVAL_S

        # Phase the frontend renders: idle | walking | thinking
        self.phase: str = "idle"
        self.waypoint: str = WAYPOINTS[0]
        self.next_waypoint: str = WAYPOINTS[0]
        self.phase_started_at: float = time.time()
        self.next_run_at: float = time.time() + DEFAULT_INTERVAL_S

        # In-flight task — set when phase == "thinking", cleared on completion.
        self.current_task: Optional[dict] = None
        self.current_partial: str = ""

        # Tasks queue (cycled through; not consumed). Loaded from disk.
        self.tasks: list[dict] = []
        # Completed runs, newest-first.
        self.recent: list[dict] = []
        # Counter the topbar reads for the "unread" badge. Cleared on /orc/ack.
        self.unread: int = 0

        # The scheduler thread is started lazily on first state() / endpoint hit
        # so importing this module never spins up background work by itself.
        self._thread: Optional[threading.Thread] = None
        self._stop_evt = threading.Event()
        self._wake_evt = threading.Event()


_S = _State()


# ─── persistence ────────────────────────────────────────────────────────────


def _ensure_loaded() -> None:
    """Populate the in-memory task list from disk on first access. If the file
    is missing or corrupt we fall back to SEED_TASKS and rewrite it so the next
    boot starts clean."""
    with _S.lock:
        if _S.tasks:
            return
        loaded: list[dict] = []
        if STORE_PATH.exists():
            try:
                raw = json.loads(STORE_PATH.read_text(encoding="utf-8"))
                if isinstance(raw, list):
                    for item in raw:
                        if isinstance(item, dict) and item.get("prompt"):
                            loaded.append(
                                {
                                    "id": str(item.get("id") or uuid.uuid4().hex[:8]),
                                    "prompt": str(item["prompt"])[:2000],
                                    "added_at": float(item.get("added_at") or time.time()),
                                }
                            )
            except (OSError, ValueError):
                loaded = []
        if not loaded:
            now = time.time()
            loaded = [
                {"id": uuid.uuid4().hex[:8], "prompt": p, "added_at": now}
                for p in SEED_TASKS
            ]
        _S.tasks = loaded
        _save_unlocked()


def _save_unlocked() -> None:
    """Persist tasks. Caller must hold _S.lock."""
    try:
        STORE_PATH.parent.mkdir(parents=True, exist_ok=True)
        tmp = STORE_PATH.with_suffix(".tmp")
        tmp.write_text(json.dumps(_S.tasks, indent=2), encoding="utf-8")
        os.replace(tmp, STORE_PATH)
    except OSError:
        # Best effort — losing persistence is annoying but not fatal.
        pass


# ─── public API ─────────────────────────────────────────────────────────────


def state() -> dict:
    """Snapshot the orc state for the frontend."""
    _ensure_loaded()
    _ensure_thread()
    with _S.lock:
        now = time.time()
        return {
            "enabled": _S.enabled,
            "model": _S.model,
            "interval_s": _S.interval_s,
            "phase": _S.phase,
            "waypoint": _S.waypoint,
            "next_waypoint": _S.next_waypoint,
            "phase_started_at": _S.phase_started_at,
            "phase_age_s": max(0.0, now - _S.phase_started_at),
            "seconds_until_next": max(0.0, _S.next_run_at - now),
            "tasks_total": len(_S.tasks),
            "current": (
                {
                    "id": _S.current_task["id"],
                    "prompt": _S.current_task["prompt"],
                    "partial": _S.current_partial,
                }
                if _S.current_task
                else None
            ),
            "unread": _S.unread,
            "recent": _S.recent[:10],
        }


def list_tasks() -> list[dict]:
    _ensure_loaded()
    with _S.lock:
        return list(_S.tasks)


def add_task(prompt: str) -> dict:
    _ensure_loaded()
    p = (prompt or "").strip()
    if not p:
        raise ValueError("prompt required")
    if len(p) > 2000:
        raise ValueError("prompt too long (max 2000 chars)")
    task = {"id": uuid.uuid4().hex[:8], "prompt": p, "added_at": time.time()}
    with _S.lock:
        _S.tasks.append(task)
        _save_unlocked()
    return task


def delete_task(task_id: str) -> bool:
    _ensure_loaded()
    with _S.lock:
        before = len(_S.tasks)
        _S.tasks = [t for t in _S.tasks if t.get("id") != task_id]
        changed = len(_S.tasks) != before
        if changed:
            _save_unlocked()
        return changed


def recent() -> list[dict]:
    with _S.lock:
        return list(_S.recent)


def ack() -> int:
    """Clear the unread counter. Returns the count that was cleared."""
    with _S.lock:
        cleared = _S.unread
        _S.unread = 0
        return cleared


def set_config(*, enabled: Optional[bool] = None, model: Optional[str] = None,
               interval_s: Optional[int] = None) -> dict:
    with _S.lock:
        if enabled is not None:
            _S.enabled = bool(enabled)
        if model is not None:
            m = str(model).strip()
            if m:
                _S.model = m
        if interval_s is not None:
            try:
                v = int(interval_s)
            except (TypeError, ValueError):
                v = _S.interval_s
            # Floor at 30s — anything tighter would hammer Ollama and the orc
            # would never visually be at rest. Ceiling at 1h.
            _S.interval_s = max(30, min(3600, v))
            _S.next_run_at = min(_S.next_run_at, time.time() + _S.interval_s)
        # Wake the scheduler so the new interval / enabled flag takes effect now.
        _S._wake_evt.set()
        return {
            "enabled": _S.enabled,
            "model": _S.model,
            "interval_s": _S.interval_s,
        }


def run_now() -> bool:
    """Ask the scheduler to start a cycle on the next tick (within ~1s).

    Returns False if the orc is already mid-cycle — we don't queue overlapping
    runs."""
    with _S.lock:
        if _S.phase != "idle":
            return False
        _S.next_run_at = time.time()
        _S._wake_evt.set()
        return True


# ─── scheduler ──────────────────────────────────────────────────────────────


def _ensure_thread() -> None:
    with _S.lock:
        if _S._thread and _S._thread.is_alive():
            return
        _S._stop_evt.clear()
        t = threading.Thread(target=_scheduler_loop, name="orc-scheduler", daemon=True)
        _S._thread = t
        t.start()


def _scheduler_loop() -> None:
    while not _S._stop_evt.is_set():
        # Wait until either the next run time or someone pokes the wake event.
        with _S.lock:
            wait = max(0.0, _S.next_run_at - time.time())
        # Cap individual sleeps so changes to interval_s take effect promptly.
        _S._wake_evt.wait(timeout=min(wait, 5.0))
        _S._wake_evt.clear()
        if _S._stop_evt.is_set():
            return

        with _S.lock:
            if not _S.enabled:
                _S.next_run_at = time.time() + _S.interval_s
                continue
            if time.time() < _S.next_run_at:
                continue
            if not _S.tasks:
                _S.next_run_at = time.time() + _S.interval_s
                continue
            if _S.phase != "idle":
                # A previous cycle is still running (shouldn't normally happen
                # because we clear phase before scheduling next). Reschedule.
                _S.next_run_at = time.time() + _S.interval_s
                continue
            task = random.choice(_S.tasks)
            target = random.choice([w for w in WAYPOINTS if w != _S.waypoint] or WAYPOINTS)
            _S.phase = "walking"
            _S.next_waypoint = target
            _S.phase_started_at = time.time()
            _S.current_task = task
            _S.current_partial = ""

        # Walking phase — purely cosmetic. Keep it short so the orc actually
        # gets to work. The frontend uses this window to animate movement.
        time.sleep(2.5)
        if _S._stop_evt.is_set():
            return
        with _S.lock:
            _S.waypoint = _S.next_waypoint
            _S.phase = "thinking"
            _S.phase_started_at = time.time()

        answer, error = _ask_ollama(task["prompt"])

        with _S.lock:
            entry = {
                "id": uuid.uuid4().hex[:8],
                "task_id": task["id"],
                "prompt": task["prompt"],
                "answer": (answer or "")[:MAX_ANSWER_CHARS],
                "error": error,
                "model": _S.model,
                "started_at": _S.phase_started_at,
                "finished_at": time.time(),
            }
            _S.recent.insert(0, entry)
            if len(_S.recent) > RECENT_LIMIT:
                _S.recent = _S.recent[:RECENT_LIMIT]
            if not error:
                _S.unread += 1
            _S.current_task = None
            _S.current_partial = ""
            _S.phase = "idle"
            _S.phase_started_at = time.time()
            _S.next_run_at = time.time() + _S.interval_s


# ─── ollama call ────────────────────────────────────────────────────────────


def _ask_ollama(prompt: str) -> tuple[str, Optional[str]]:
    """Single-shot non-streaming chat against local Ollama. We accumulate the
    streamed tokens server-side so the frontend can poll a partial via
    `state().current.partial` without each having to manage its own SSE.

    Returns (answer_text, error_message_or_None).
    """
    with _S.lock:
        model = _S.model

    payload = json.dumps(
        {
            "model": model,
            "messages": [
                {
                    "role": "system",
                    "content": (
                        "You are an orc dev who tackles tiny bugs. Reply in 2-4 short "
                        "sentences. No code blocks unless absolutely required."
                    ),
                },
                {"role": "user", "content": prompt},
            ],
            "stream": True,
        }
    ).encode()

    try:
        req = urllib.request.Request(
            f"{OLLAMA_URL}/api/chat",
            data=payload,
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        upstream = urllib.request.urlopen(req, timeout=300)
    except urllib.error.HTTPError as e:
        return "", f"ollama HTTP {e.code}: {e.reason}"
    except (urllib.error.URLError, OSError) as e:
        return "", f"ollama unreachable: {e}"

    acc: list[str] = []
    try:
        for raw in upstream:
            if not raw:
                continue
            try:
                chunk = json.loads(raw.decode())
            except ValueError:
                continue
            if chunk.get("error"):
                return "".join(acc), str(chunk["error"])
            token = (chunk.get("message") or {}).get("content")
            if token:
                acc.append(token)
                # Update partial under lock so /orc/state can show progress.
                with _S.lock:
                    if _S.current_task is not None:
                        _S.current_partial = ("".join(acc))[:MAX_ANSWER_CHARS]
            if chunk.get("done"):
                break
    except OSError as e:
        return "".join(acc), f"ollama stream interrupted: {e}"
    finally:
        try:
            upstream.close()
        except Exception:
            pass

    return "".join(acc).strip(), None
