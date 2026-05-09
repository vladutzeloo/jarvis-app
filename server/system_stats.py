"""System stats collection for the JARVIS cockpit HUD.

Pulls CPU/RAM/swap from psutil, GPU from nvidia-smi (WSL2 ships it at
/usr/lib/wsl/lib/), and running models from a local Ollama daemon.
"""
import json
import os
import shutil
import subprocess
import time
from urllib.error import URLError
from urllib.request import urlopen

import psutil


# nvidia-smi is shipped via WSL2 at /usr/lib/wsl/lib/, often not on systemd PATH.
def _find_nvidia_smi():
    found = shutil.which("nvidia-smi")
    if found:
        return found
    for cand in ("/usr/lib/wsl/lib/nvidia-smi", "/usr/bin/nvidia-smi", "/usr/local/bin/nvidia-smi"):
        if os.path.isfile(cand) and os.access(cand, os.X_OK):
            return cand
    return None


NVIDIA_SMI = _find_nvidia_smi()


_last_cpu_t = 0.0
_last_cpu_v = 0.0


def cpu_percent_cached() -> float:
    """psutil.cpu_percent() with a 0.5s cache so callers don't pay per request."""
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
        return [
            {
                "name": m.get("name"),
                "size": m.get("size"),
                "size_vram": m.get("size_vram"),
                "expires_at": m.get("expires_at"),
            }
            for m in data.get("models", [])
        ]
    except (URLError, Exception):
        return []


def system_stats() -> dict:
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


def prime():
    """Prime psutil's CPU meter so the first sample isn't bogus."""
    psutil.cpu_percent(interval=None)
