// Incoming-call notification + full-screen dialog with the audio-reactive
// waveform. Owns its own audio element so multiple TTS playbacks can't trample
// each other.

const callNotification = document.getElementById("call-notification") as HTMLElement;
const callAcceptBtn = document.getElementById("call-accept") as HTMLButtonElement;
const callDeclineBtn = document.getElementById("call-decline") as HTMLButtonElement;
const callDialog = document.getElementById("call-dialog") as HTMLElement;
const callDialogStatus = document.getElementById("call-dialog-status") as HTMLElement;
const callHangupBtn = document.getElementById("call-hangup") as HTMLButtonElement;
const callWaveform = document.getElementById("call-waveform") as HTMLCanvasElement;
const stopSpeakingBtn = document.getElementById("stop-speaking") as HTMLButtonElement;

let pendingAudioUrl: string | null = null;
let callAudio: HTMLAudioElement | null = null;
let callAudioCtx: AudioContext | null = null;
let callAnalyser: AnalyserNode | null = null;
let callRafId = 0;
let callAutoAcceptTimer: number | undefined;

export function isCallActive(): boolean {
  return callAudio !== null;
}

export function getCurrentCallAudio(): HTMLAudioElement | null {
  return callAudio;
}

function hideIncomingCall() {
  callNotification.classList.add("hidden");
  clearTimeout(callAutoAcceptTimer);
}

export function showIncomingCall(audioUrl: string) {
  if (pendingAudioUrl) URL.revokeObjectURL(pendingAudioUrl);
  pendingAudioUrl = audioUrl;
  callNotification.classList.remove("hidden");
  // Auto-decline if ignored for a while (avoids stale audio building up).
  clearTimeout(callAutoAcceptTimer);
  callAutoAcceptTimer = window.setTimeout(() => {
    if (!callNotification.classList.contains("hidden")) {
      declineCall();
    }
  }, 30000);
}

function declineCall() {
  hideIncomingCall();
  if (pendingAudioUrl) {
    URL.revokeObjectURL(pendingAudioUrl);
    pendingAudioUrl = null;
  }
}

async function acceptCall() {
  if (!pendingAudioUrl) return;
  const url = pendingAudioUrl;
  pendingAudioUrl = null;
  hideIncomingCall();

  endCall();

  callDialog.classList.remove("hidden");
  callDialogStatus.textContent = "connecting…";

  callAudio = new Audio(url);
  stopSpeakingBtn.classList.remove("hidden");

  try {
    if (!callAudioCtx) callAudioCtx = new AudioContext();
    if (callAudioCtx.state === "suspended") await callAudioCtx.resume();
    const source = callAudioCtx.createMediaElementSource(callAudio);
    callAnalyser = callAudioCtx.createAnalyser();
    callAnalyser.fftSize = 256;
    callAnalyser.smoothingTimeConstant = 0.78;
    source.connect(callAnalyser);
    callAnalyser.connect(callAudioCtx.destination);
  } catch {
    // Some browsers refuse a second createMediaElementSource on the same node.
    callAnalyser = null;
  }

  callAudio.onended = endCall;
  callAudio.onerror = endCall;

  try {
    await callAudio.play();
    callDialogStatus.textContent = "speaking";
    drawWaveform();
  } catch (e: any) {
    callDialogStatus.textContent = `playback error: ${e.message}`;
    setTimeout(endCall, 2000);
  }
}

export function endCall() {
  cancelAnimationFrame(callRafId);
  callDialog.classList.add("hidden");
  stopSpeakingBtn.classList.add("hidden");
  if (callAudio) {
    callAudio.pause();
    if (callAudio.src) URL.revokeObjectURL(callAudio.src);
    callAudio = null;
  }
  callAnalyser = null;
}

function drawWaveform() {
  const ctx = callWaveform.getContext("2d");
  if (!ctx) return;
  const W = callWaveform.width;
  const H = callWaveform.height;
  const cx = W / 2;
  const cy = H / 2;
  const innerR = 110;
  const maxBarLen = 90;
  const barCount = 96;
  const accent = "#5cd9ff";
  const accentSoft = "rgba(92, 217, 255, 0.18)";

  function frame() {
    callRafId = requestAnimationFrame(frame);
    ctx!.clearRect(0, 0, W, H);

    let dataArray: Uint8Array;
    if (callAnalyser) {
      const bins = callAnalyser.frequencyBinCount;
      dataArray = new Uint8Array(bins);
      callAnalyser.getByteFrequencyData(dataArray);
    } else {
      dataArray = new Uint8Array(barCount);
    }

    let total = 0;
    for (let i = 0; i < dataArray.length; i++) total += dataArray[i];
    const avg = dataArray.length ? total / dataArray.length / 255 : 0;
    ctx!.beginPath();
    ctx!.arc(cx, cy, innerR + 14 + avg * 26, 0, Math.PI * 2);
    ctx!.strokeStyle = accent;
    ctx!.globalAlpha = 0.18 + avg * 0.5;
    ctx!.lineWidth = 1.5;
    ctx!.stroke();
    ctx!.globalAlpha = 1;

    for (let i = 0; i < barCount; i++) {
      const bin = Math.floor((i / barCount) * Math.min(dataArray.length, 64));
      const v = dataArray[bin] / 255;
      const len = innerR + 18 + v * maxBarLen;
      const angle = (i / barCount) * Math.PI * 2 - Math.PI / 2;
      const x1 = cx + Math.cos(angle) * (innerR + 16);
      const y1 = cy + Math.sin(angle) * (innerR + 16);
      const x2 = cx + Math.cos(angle) * len;
      const y2 = cy + Math.sin(angle) * len;
      ctx!.strokeStyle = `rgba(92, 217, 255, ${0.35 + v * 0.6})`;
      ctx!.lineWidth = 2;
      ctx!.lineCap = "round";
      ctx!.beginPath();
      ctx!.moveTo(x1, y1);
      ctx!.lineTo(x2, y2);
      ctx!.stroke();
    }

    ctx!.beginPath();
    ctx!.arc(cx, cy, innerR, 0, Math.PI * 2);
    ctx!.fillStyle = accentSoft;
    ctx!.fill();
    ctx!.strokeStyle = accent;
    ctx!.globalAlpha = 0.55 + avg * 0.4;
    ctx!.lineWidth = 1.5;
    ctx!.stroke();
    ctx!.globalAlpha = 1;
  }
  frame();
}

callAcceptBtn.addEventListener("click", acceptCall);
callDeclineBtn.addEventListener("click", declineCall);
callHangupBtn.addEventListener("click", endCall);
