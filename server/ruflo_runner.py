"""Ruflo subprocess runner.

Wraps `npx -y ruflo@latest <argv...>` invocations behind a small in-memory job
table. The HTTP layer in `server.py` exposes these as JSON + SSE endpoints; we
keep the runner UI-agnostic so it can be unit-tested without HTTP.

A "job" owns one Popen process plus three threads:

  - stdout reader  -> pushes ("stdout", line) into the job's queue
  - stderr reader  -> pushes ("stderr", line) into the job's queue
  - waiter         -> on proc exit, pushes ("done", returncode) sentinel

A single SSE consumer drains the queue. Multiple consumers are not supported
(the second attach gets 409 from the HTTP layer); that matches the UX where
one Agents tab streams one job at a time.
"""
import json
import os
import queue
import shutil
import signal
import subprocess
import threading
import time
import uuid
from typing import Optional


# Hard cap on concurrent jobs. The webview only ever runs one at a time, but
# orphaned jobs on cancel/disconnect could otherwise pile up.
MAX_JOBS = 8

# Cap on argv length and per-arg length. Stops a misbehaving client from
# pushing megabytes of args into Popen.
MAX_ARGV = 64
MAX_ARG_LEN = 4096

# Output ring buffer per job (latest N lines). The SSE consumer streams live;
# this lets a re-attaching consumer or /jobs caller see recent context.
RING_LINES = 500


def _resolve_node_bin() -> Optional[str]:
    """Best-effort detection of the directory containing `node`/`npx`. The
    systemd unit runs with a minimal PATH; we add the detected dir at startup.
    """
    for cmd in ("npx", "node"):
        path = shutil.which(cmd)
        if path:
            return os.path.dirname(path)
    # Fall back to common nvm install dir if PATH is too narrow.
    home = os.path.expanduser("~")
    nvm_root = os.path.join(home, ".nvm", "versions", "node")
    if os.path.isdir(nvm_root):
        # Sort by numeric version components so v10 ranks above v9 (a plain
        # string sort would pick v9 as "highest" descending).
        def _semver_key(s: str) -> list:
            return [int(x) for x in s.lstrip("v").split(".") if x.isdigit()]

        versions = sorted(os.listdir(nvm_root), key=_semver_key, reverse=True)
        for v in versions:
            cand = os.path.join(nvm_root, v, "bin")
            if os.path.isfile(os.path.join(cand, "npx")):
                return cand
    return None


_NODE_BIN_DIR = _resolve_node_bin()


def _build_env() -> dict:
    env = os.environ.copy()
    if _NODE_BIN_DIR and _NODE_BIN_DIR not in env.get("PATH", "").split(":"):
        env["PATH"] = f"{_NODE_BIN_DIR}:{env.get('PATH', '/usr/bin:/bin')}"
    # Make ruflo non-interactive: it should never block waiting on a TTY.
    env.setdefault("CI", "1")
    env.setdefault("RUFLO_NONINTERACTIVE", "1")
    return env


class Job:
    __slots__ = (
        "id",
        "argv",
        "started_at",
        "proc",
        "queue",
        "ring",
        "ring_lock",
        "consumer_attached",
        "exit_code",
        "_threads",
    )

    def __init__(self, argv: list):
        self.id = uuid.uuid4().hex[:12]
        self.argv = argv
        self.started_at = time.time()
        self.queue: "queue.Queue[tuple]" = queue.Queue()
        self.ring: list = []
        self.ring_lock = threading.Lock()
        self.consumer_attached = False
        self.exit_code: Optional[int] = None
        self.proc: Optional[subprocess.Popen] = None
        self._threads: list = []

    def append_ring(self, kind: str, line: str) -> None:
        with self.ring_lock:
            self.ring.append((kind, line))
            if len(self.ring) > RING_LINES:
                del self.ring[: len(self.ring) - RING_LINES]


_jobs: "dict[str, Job]" = {}
_jobs_lock = threading.Lock()


def _gc_finished(now: float) -> None:
    """Drop jobs that exited more than 10 minutes ago. Called opportunistically
    on every list/run; cheap because the table stays small."""
    cutoff = now - 600
    dead = [
        jid
        for jid, j in _jobs.items()
        if j.exit_code is not None and j.started_at < cutoff
    ]
    for jid in dead:
        _jobs.pop(jid, None)


def health() -> dict:
    """Cheap probe — does not invoke npx, just checks PATH."""
    npx = shutil.which("npx") or (
        os.path.join(_NODE_BIN_DIR, "npx") if _NODE_BIN_DIR else None
    )
    node = shutil.which("node") or (
        os.path.join(_NODE_BIN_DIR, "node") if _NODE_BIN_DIR else None
    )
    return {
        "ok": True,
        "node": node if node and os.path.isfile(node) else None,
        "npx": npx if npx and os.path.isfile(npx) else None,
        "node_bin_dir": _NODE_BIN_DIR,
        "max_jobs": MAX_JOBS,
    }


def list_jobs() -> list:
    with _jobs_lock:
        _gc_finished(time.time())
        return [
            {
                "id": j.id,
                "argv": j.argv,
                "started_at": j.started_at,
                "running": j.exit_code is None,
                "exit_code": j.exit_code,
            }
            for j in _jobs.values()
        ]


def get_job(job_id: str) -> Optional[Job]:
    with _jobs_lock:
        return _jobs.get(job_id)


def _validate_argv(argv) -> list:
    if not isinstance(argv, list):
        raise ValueError("argv must be a list of strings")
    if len(argv) > MAX_ARGV:
        raise ValueError(f"argv too long (>{MAX_ARGV})")
    out = []
    for a in argv:
        if not isinstance(a, str):
            raise ValueError("argv items must be strings")
        if len(a) > MAX_ARG_LEN:
            raise ValueError(f"argv item exceeds {MAX_ARG_LEN} chars")
        # Reject control chars except tab/newline-free args. Newlines in argv
        # would never be useful here and tend to indicate copy-paste mistakes.
        if any(ord(c) < 0x20 and c not in ("\t",) for c in a):
            raise ValueError("argv items must not contain control characters")
        out.append(a)
    return out


def start_job(argv: list, cwd: Optional[str] = None) -> Job:
    argv = _validate_argv(argv)
    with _jobs_lock:
        running = sum(1 for j in _jobs.values() if j.exit_code is None)
        if running >= MAX_JOBS:
            raise RuntimeError(f"too many running jobs ({running}/{MAX_JOBS})")
        _gc_finished(time.time())

        if not (shutil.which("npx") or (_NODE_BIN_DIR and os.path.isfile(os.path.join(_NODE_BIN_DIR, "npx")))):
            raise RuntimeError(
                "npx not found on server $PATH. Install Node.js (>=18) inside "
                "WSL and rerun `bash scripts/jarvis-server.sh --ruflo`."
            )

        full_argv = ["npx", "-y", "ruflo@latest", *argv]
        job = Job(argv=argv)

        # Resolve npx to absolute path so we don't depend on the shell PATH at
        # exec time (systemd's PATH may differ from interactive shells).
        npx_path = shutil.which("npx") or os.path.join(_NODE_BIN_DIR or "", "npx")
        full_argv[0] = npx_path

        try:
            job.proc = subprocess.Popen(
                full_argv,
                cwd=cwd or os.path.expanduser("~"),
                env=_build_env(),
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                stdin=subprocess.DEVNULL,
                bufsize=1,
                text=True,
                # Detach into its own process group so cancel can SIGTERM the
                # whole tree (npx -> node -> ruflo workers).
                start_new_session=True,
            )
        except FileNotFoundError as e:
            raise RuntimeError(f"failed to spawn npx: {e}") from e

        _jobs[job.id] = job

    def _pump(stream, kind: str) -> None:
        try:
            for raw in iter(stream.readline, ""):
                line = raw.rstrip("\r\n")
                job.append_ring(kind, line)
                job.queue.put((kind, line))
        finally:
            try:
                stream.close()
            except Exception:
                pass

    def _wait() -> None:
        rc = job.proc.wait() if job.proc else -1
        # Give the readers a moment to drain pipes after process exit.
        time.sleep(0.05)
        job.exit_code = rc
        job.queue.put(("done", rc))

    t_out = threading.Thread(target=_pump, args=(job.proc.stdout, "stdout"), daemon=True)
    t_err = threading.Thread(target=_pump, args=(job.proc.stderr, "stderr"), daemon=True)
    t_wait = threading.Thread(target=_wait, daemon=True)
    job._threads = [t_out, t_err, t_wait]
    for t in job._threads:
        t.start()
    return job


def cancel_job(job_id: str) -> bool:
    job = get_job(job_id)
    if not job or not job.proc or job.exit_code is not None:
        return False
    try:
        # Kill the whole process group so npm/npx wrappers don't leave
        # orphaned children behind.
        pgid = os.getpgid(job.proc.pid)
        os.killpg(pgid, signal.SIGTERM)
    except (ProcessLookupError, PermissionError):
        try:
            job.proc.terminate()
        except Exception:
            return False
    # Escalate after a grace period.
    def _hard_kill():
        try:
            job.proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            try:
                pgid = os.getpgid(job.proc.pid)
                os.killpg(pgid, signal.SIGKILL)
            except Exception:
                try:
                    job.proc.kill()
                except Exception:
                    pass
    threading.Thread(target=_hard_kill, daemon=True).start()
    return True


def attach_consumer(job: Job, on_event, *, idle_keepalive: float = 15.0) -> None:
    """Drain the job's queue until a `done` event arrives, calling `on_event`
    with each `(kind, payload)`. Emits ("keepalive", "") tuples on idle so the
    HTTP layer can keep the SSE socket from going idle.

    Raises RuntimeError if a consumer is already attached.
    """
    with _jobs_lock:
        if job.consumer_attached:
            raise RuntimeError("a consumer is already attached to this job")
        job.consumer_attached = True

    # Replay buffered output first so a consumer that attaches a beat after
    # /run sees the early lines that arrived before it connected.
    with job.ring_lock:
        replay = list(job.ring)
    for kind, line in replay:
        on_event((kind, line))

    try:
        while True:
            try:
                item = job.queue.get(timeout=idle_keepalive)
            except queue.Empty:
                on_event(("keepalive", ""))
                continue
            kind, payload = item
            on_event(item)
            if kind == "done":
                return
    finally:
        # Allow re-attach if the consumer disconnected before `done`.
        if job.exit_code is None:
            job.consumer_attached = False


def sse_for(item: tuple) -> bytes:
    """Format a (kind, payload) tuple as an SSE `data:` frame. Mirrors the
    NVIDIA streaming wire format on the Rust side: one JSON object per frame,
    keyed by `type`."""
    kind, payload = item
    if kind == "done":
        body = {"type": "done", "exit_code": payload}
    elif kind == "keepalive":
        # Comment frame — clients ignore it, but it keeps the socket warm.
        return b": keepalive\n\n"
    else:
        body = {"type": kind, "line": payload}
    return f"data: {json.dumps(body)}\n\n".encode()


__all__ = [
    "Job",
    "attach_consumer",
    "cancel_job",
    "get_job",
    "health",
    "list_jobs",
    "sse_for",
    "start_job",
]
