"""Whisper-based speech-to-text for JARVIS.

Lazy-loads a faster-whisper model on first request so server startup stays
fast. Model size and device are configurable via env vars:

  JARVIS_WHISPER_MODEL    e.g. tiny, base, small, medium, large-v3 (default: base)
  JARVIS_WHISPER_DEVICE   cpu, cuda, auto (default: auto)
  JARVIS_WHISPER_COMPUTE  int8, int8_float16, float16, float32 (default: auto)
  JARVIS_WHISPER_LANG     ISO code, e.g. en, ro. Empty = auto-detect (default: empty)

faster-whisper is the dependency; install with
  pip install faster-whisper

Audio is accepted as raw bytes from MediaRecorder (typically WebM/Opus).
faster-whisper internally pipes through ffmpeg/audioread to decode, so the
container format is mostly handled for us.
"""

from __future__ import annotations

import io
import os
import tempfile
from threading import Lock
from typing import Optional


_MODEL = None
_MODEL_LOCK = Lock()


def _load_model():
    """Import + load faster-whisper once. Held under a lock so two concurrent
    /stt requests don't both try to load the model."""
    global _MODEL
    if _MODEL is not None:
        return _MODEL
    with _MODEL_LOCK:
        if _MODEL is not None:
            return _MODEL
        try:
            from faster_whisper import WhisperModel  # type: ignore
        except ImportError as e:
            raise RuntimeError(
                "faster-whisper is not installed. Run "
                "`bash scripts/jarvis-server.sh --whisper` (or --all) to install it."
            ) from e

        size = os.environ.get("JARVIS_WHISPER_MODEL", "base")
        device = os.environ.get("JARVIS_WHISPER_DEVICE", "auto")
        # "auto" lets faster-whisper pick a sane compute_type for the device.
        compute = os.environ.get("JARVIS_WHISPER_COMPUTE", "auto")

        _MODEL = WhisperModel(size, device=device, compute_type=compute)
        return _MODEL


def transcribe(audio_bytes: bytes, language: Optional[str] = None) -> str:
    """Transcribe an audio blob and return the joined text.

    `language` is an ISO code (e.g. "en"); pass None or empty string to let
    Whisper auto-detect.
    """
    if not audio_bytes:
        return ""

    model = _load_model()
    lang = (language or os.environ.get("JARVIS_WHISPER_LANG") or "").strip() or None

    # faster-whisper's transcribe() accepts a path, a file-like object, or a
    # numpy array. We get an opaque container blob from MediaRecorder, so write
    # it to a temp file and let ffmpeg/audioread decode it.
    with tempfile.NamedTemporaryFile(suffix=".webm", delete=False) as f:
        f.write(audio_bytes)
        tmp_path = f.name

    try:
        segments, _info = model.transcribe(
            tmp_path,
            language=lang,
            vad_filter=True,             # drop silent/non-speech regions
            beam_size=1,                 # fast path; raise to 5 for accuracy
            condition_on_previous_text=False,
        )
        # segments is a generator — joining it here forces evaluation.
        return "".join(seg.text for seg in segments).strip()
    finally:
        try:
            os.unlink(tmp_path)
        except OSError:
            pass
