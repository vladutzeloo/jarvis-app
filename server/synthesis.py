"""Piper TTS + optional sox post-effects.

The styles dict is a sox effects chain applied to Piper's WAV output.
Chain reference: https://linux.die.net/man/1/sox
"""
import io
import shutil
import subprocess
import wave

from piper import PiperVoice


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


class Synthesizer:
    def __init__(self, voice_path: str):
        print(f"Loading voice: {voice_path}", flush=True)
        self.voice = PiperVoice.load(voice_path)
        self.sox = shutil.which("sox")
        if not self.sox:
            print("WARN: sox not found — only 'alan' style will work.", flush=True)
        else:
            print(f"sox: {self.sox}", flush=True)
        print("Voice ready.", flush=True)

    def apply_effects(self, wav_bytes: bytes, style: str) -> bytes:
        chain = STYLES.get(style, [])
        if not chain or not self.sox:
            return wav_bytes
        try:
            result = subprocess.run(
                [self.sox, "-t", "wav", "-", "-t", "wav", "-", *chain],
                input=wav_bytes,
                capture_output=True,
                check=True,
                timeout=15,
            )
            return result.stdout
        except (subprocess.CalledProcessError, subprocess.TimeoutExpired):
            return wav_bytes

    def synthesize(self, text: str, style: str = "alan") -> bytes:
        buf = io.BytesIO()
        with wave.open(buf, "wb") as wav_file:
            self.voice.synthesize(text, wav_file)
        return self.apply_effects(buf.getvalue(), style)
