// Speech-to-text via MediaRecorder + the JARVIS server's /stt endpoint
// (faster-whisper). Replaces the browser's webkitSpeechRecognition, which
// silently fails inside Tauri's WebView2 because it tries to round-trip
// audio through Google's online STT service.
//
// Flow: click mic -> getUserMedia -> MediaRecorder records until clicked
// again -> POST blob to {PIPER_BASE}/stt -> set input value -> auto-send.

import { addSystem } from "../chat/messages";
import { send } from "../chat/chat";
import { PIPER_BASE } from "../types";

const micBtn = document.getElementById("mic") as HTMLButtonElement;
const input = document.getElementById("input") as HTMLTextAreaElement;

// Pick the best Opus container the WebView supports. WebView2 reliably
// supports webm/opus; we fall back through a couple of alternatives just in
// case the host runtime is older.
function pickMime(): string {
  const candidates = [
    "audio/webm;codecs=opus",
    "audio/webm",
    "audio/ogg;codecs=opus",
    "audio/mp4",
  ];
  for (const m of candidates) {
    if (typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported(m)) {
      return m;
    }
  }
  return "";
}

let mediaStream: MediaStream | null = null;
let recorder: MediaRecorder | null = null;
let chunks: Blob[] = [];
let isRecording = false;

if (typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia) {
  micBtn.disabled = true;
  micBtn.title = "Microphone access not available in this webview";
}

async function startRecording(): Promise<void> {
  try {
    mediaStream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true },
    });
  } catch (e: any) {
    const reason = e?.name || e?.message || String(e);
    addSystem(
      "Mic permission denied (" + reason + "). " +
        "On Windows: Settings > Privacy & security > Microphone > allow desktop apps."
    );
    return;
  }

  const mime = pickMime();
  try {
    recorder = mime
      ? new MediaRecorder(mediaStream, { mimeType: mime })
      : new MediaRecorder(mediaStream);
  } catch (e: any) {
    addSystem("MediaRecorder unavailable: " + (e?.message || String(e)));
    stopStream();
    return;
  }

  chunks = [];
  recorder.ondataavailable = (e) => {
    if (e.data && e.data.size > 0) chunks.push(e.data);
  };
  recorder.onstop = () => transcribeAndSend(mime);

  recorder.start();
  isRecording = true;
  micBtn.classList.add("recording");
}

function stopRecording(): void {
  if (!recorder) return;
  if (recorder.state !== "inactive") {
    try {
      recorder.stop();
    } catch {
      /* already stopped */
    }
  }
  isRecording = false;
  micBtn.classList.remove("recording");
}

function stopStream(): void {
  if (mediaStream) {
    mediaStream.getTracks().forEach((t) => t.stop());
    mediaStream = null;
  }
}

async function transcribeAndSend(mime: string): Promise<void> {
  const blob = new Blob(chunks, { type: mime || "audio/webm" });
  chunks = [];
  stopStream();

  // Sub-1 KB recordings are usually accidental taps; skip the round-trip.
  if (blob.size < 1024) return;

  micBtn.classList.add("transcribing");
  try {
    const res = await fetch(`${PIPER_BASE}/stt`, {
      method: "POST",
      headers: { "Content-Type": blob.type || "application/octet-stream" },
      body: blob,
    });
    if (!res.ok) {
      let detail = String(res.status);
      try {
        const j = await res.json();
        if (j?.error) detail = res.status + ": " + j.error;
      } catch {
        /* not JSON */
      }
      addSystem("STT failed (" + detail + ").");
      return;
    }
    const { text } = (await res.json()) as { text: string };
    const cleaned = (text || "").trim();
    if (!cleaned) {
      addSystem("(no speech detected)");
      return;
    }
    input.value = cleaned;
    input.dispatchEvent(new Event("input"));
    send();
  } catch (e: any) {
    addSystem(
      "STT request failed: " + (e?.message || String(e)) + ". " +
        "Is the JARVIS server running? (bash scripts/jarvis-server.sh --whisper)"
    );
  } finally {
    micBtn.classList.remove("transcribing");
  }
}

micBtn.addEventListener("click", () => {
  if (micBtn.disabled) return;
  if (isRecording) stopRecording();
  else startRecording();
});
