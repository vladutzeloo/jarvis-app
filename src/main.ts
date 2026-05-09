// JARVIS — local chat + workspace + brain. Tabbed UI with voice I/O + gestures.

import { readDir, readTextFile, writeTextFile, exists } from "@tauri-apps/plugin-fs";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { GestureRecognizer, FilesetResolver } from "@mediapipe/tasks-vision";
import { marked } from "marked";
import hljs from "highlight.js";

// NVIDIA hosted-inference integration. Mirrors the integrations layer from
// the own-jarvis vault — see 02_Capabilities/integrations/nvidia.md.
import {
  readEnvSnapshot,
  writeEnvValue,
  listNvidiaModels,
  nvidiaChatStream,
  type EnvSnapshot,
  type NvidiaModel,
} from "./backends/nvidia";

import { EditorState, Compartment } from "@codemirror/state";
import { EditorView, keymap, lineNumbers, highlightActiveLine, highlightActiveLineGutter } from "@codemirror/view";
import { defaultKeymap, indentWithTab, history as historyExt, historyKeymap } from "@codemirror/commands";
import { searchKeymap, highlightSelectionMatches } from "@codemirror/search";
import { autocompletion, completionKeymap } from "@codemirror/autocomplete";
import { bracketMatching, indentOnInput, foldGutter, foldKeymap, defaultHighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { oneDark } from "@codemirror/theme-one-dark";
import { javascript } from "@codemirror/lang-javascript";
import { python } from "@codemirror/lang-python";
import { rust } from "@codemirror/lang-rust";
import { markdown } from "@codemirror/lang-markdown";
import { json } from "@codemirror/lang-json";
import { html } from "@codemirror/lang-html";
import { css } from "@codemirror/lang-css";

// Configure marked: GFM features, line breaks, and syntax highlighting via highlight.js.
marked.setOptions({
  gfm: true,
  breaks: true,
});

function renderMarkdown(text: string): string {
  const html = marked.parse(text, { async: false }) as string;
  // Run syntax highlighting on rendered code blocks.
  const wrapper = document.createElement("div");
  wrapper.innerHTML = html;
  wrapper.querySelectorAll("pre code").forEach((block) => {
    hljs.highlightElement(block as HTMLElement);
  });
  return wrapper.innerHTML;
}

const OLLAMA_BASE = "http://localhost:11434";

// Backends — Ollama is the local default; NVIDIA is the hosted integration
// from .env. The model picker tags each <option> with `data-backend` so the
// chat send loop can route without re-querying.
type BackendId = "ollama" | "nvidia";

function backendOf(option: HTMLOptionElement | undefined): BackendId {
  return (option?.dataset.backend as BackendId) || "ollama";
}

function selectedBackend(): BackendId {
  return backendOf(modelPicker.options[modelPicker.selectedIndex] as HTMLOptionElement | undefined);
}

interface Message {
  role: "user" | "assistant";
  content: string;
}

interface IndexedDoc {
  path: string;
  rel: string;
  content: string;
}

// ---------------- Tabs ----------------

const tabs = document.querySelectorAll<HTMLButtonElement>(".tab");
const views = document.querySelectorAll<HTMLElement>(".view");

tabs.forEach(tab => {
  tab.addEventListener("click", () => {
    const target = tab.dataset.tab!;
    tabs.forEach(t => t.classList.toggle("active", t === tab));
    views.forEach(v => v.classList.toggle("active", v.dataset.view === target));
    if (target === "chat") input.focus();
    if (target === "brain") brainSearch.focus();
  });
});

// ---------------- Chat elements ----------------

const chat = document.getElementById("chat") as HTMLElement;
const input = document.getElementById("input") as HTMLTextAreaElement;
const sendBtn = document.getElementById("send") as HTMLButtonElement;
const clearBtn = document.getElementById("clear") as HTMLButtonElement;
const modelPicker = document.getElementById("model-picker") as HTMLSelectElement;
const stats = document.getElementById("stats") as HTMLElement;
const micBtn = document.getElementById("mic") as HTMLButtonElement;
const voiceToggleBtn = document.getElementById("voice-toggle") as HTMLButtonElement;
const voicePicker = document.getElementById("voice-picker") as HTMLSelectElement;
const stopSpeakingBtn = document.getElementById("stop-speaking") as HTMLButtonElement;

const STORAGE_MODEL = "jarvis.model";
const STORAGE_VOICE = "jarvis.voice";
const STORAGE_VOICE_ENABLED = "jarvis.voice.enabled";

let history: Message[] = [];
let isGenerating = false;

// ---------------- Models ----------------

let modelsLoaded = false;

async function fetchOllamaModels(): Promise<string[]> {
  const res = await fetch(`${OLLAMA_BASE}/api/tags`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  const models: { name: string }[] = data.models || [];
  return models
    .map(m => m.name)
    .sort((a, b) => {
      const aCustom = a.includes("4070");
      const bCustom = b.includes("4070");
      if (aCustom !== bCustom) return aCustom ? -1 : 1;
      return a.localeCompare(b);
    });
}

async function fetchNvidiaModels(): Promise<NvidiaModel[]> {
  try {
    return await listNvidiaModels();
  } catch (e: any) {
    addSystem(`NVIDIA API: ${e?.message || e}`);
    return [];
  }
}

function paintModelPicker(ollama: string[], nvidia: NvidiaModel[]): void {
  modelPicker.innerHTML = "";

  if (ollama.length) {
    const group = document.createElement("optgroup");
    group.label = "── Ollama (local) ──";
    for (const name of ollama) {
      const opt = document.createElement("option");
      opt.value = name;
      opt.textContent = name;
      opt.dataset.backend = "ollama";
      group.appendChild(opt);
    }
    modelPicker.appendChild(group);
  }

  if (nvidia.length) {
    const group = document.createElement("optgroup");
    group.label = "── NVIDIA (cloud) ──";
    for (const m of nvidia) {
      const opt = document.createElement("option");
      opt.value = m.id;
      opt.textContent = m.id;
      opt.dataset.backend = "nvidia";
      group.appendChild(opt);
    }
    modelPicker.appendChild(group);
  }

  // Restore previously selected model when possible.
  const remembered = localStorage.getItem(STORAGE_MODEL);
  if (remembered) {
    const all = Array.from(modelPicker.querySelectorAll("option")) as HTMLOptionElement[];
    if (all.some(o => o.value === remembered)) {
      modelPicker.value = remembered;
    }
  }
}

async function loadModels(silent = false): Promise<boolean> {
  // Hit both backends in parallel. Ollama may be down (laptop, WSL stopped,
  // first launch) and NVIDIA may not be configured — we still want the
  // picker populated with whichever side worked.
  const [ollamaResult, nvidiaResult, snapshot] = await Promise.allSettled([
    fetchOllamaModels(),
    fetchNvidiaModels(),
    readEnvSnapshot(),
  ]);

  const ollama = ollamaResult.status === "fulfilled" ? ollamaResult.value : [];
  const nvidiaConfigured = snapshot.status === "fulfilled" && (snapshot.value as EnvSnapshot).has_nvidia_key;
  const nvidia = nvidiaConfigured && nvidiaResult.status === "fulfilled" ? nvidiaResult.value : [];

  paintModelPicker(ollama, nvidia);

  if (ollamaResult.status === "rejected" && !silent && !nvidia.length) {
    const e = (ollamaResult as PromiseRejectedResult).reason;
    addSystem(`Could not reach Ollama at ${OLLAMA_BASE}. Retrying in background… (${e?.message || e})`);
  }

  modelsLoaded = ollama.length + nvidia.length > 0;
  return modelsLoaded;
}

// Keep retrying in the background until Ollama answers, so the user doesn't
// have to manually Ctrl+R after a slow WSL/Ollama cold-start.
async function ensureModelsLoaded() {
  if (await loadModels()) return;
  let delayMs = 1000;
  for (let attempt = 0; attempt < 30 && !modelsLoaded; attempt++) {
    await new Promise(r => setTimeout(r, delayMs));
    if (await loadModels(true)) {
      addSystem("Connected to Ollama.");
      return;
    }
    delayMs = Math.min(delayMs * 1.5, 5000);
  }
}

modelPicker.addEventListener("change", () => {
  localStorage.setItem(STORAGE_MODEL, modelPicker.value);
});

// ---------------- Rendering ----------------

function addMessage(role: "user" | "assistant", content: string): HTMLElement {
  const wrap = document.createElement("div");
  wrap.className = `msg msg-${role}`;
  const body = document.createElement("div");
  body.className = "msg-body";
  body.textContent = content;
  wrap.appendChild(body);
  chat.appendChild(wrap);
  wrap.scrollIntoView({ behavior: "smooth", block: "end" });
  return body;
}

function addSystem(content: string) {
  const el = document.createElement("div");
  el.className = "msg msg-system";
  el.textContent = content;
  chat.appendChild(el);
  el.scrollIntoView({ block: "end" });
}

// ---------------- Voice synthesis (TTS) ----------------

const synth = window.speechSynthesis;
let availableVoices: SpeechSynthesisVoice[] = [];
let voiceEnabled = localStorage.getItem(STORAGE_VOICE_ENABLED) !== "false";

function rankJarvisVoice(v: SpeechSynthesisVoice): number {
  // Higher = better fit for JARVIS-style butler voice.
  // Prefer British neural male voices, then any neural voice, then en-GB, then en-US male, then anything.
  const name = v.name.toLowerCase();
  const lang = v.lang.toLowerCase();
  let score = 0;
  if (name.includes("ryan")) score += 100;       // Microsoft Ryan (en-GB Neural)
  if (name.includes("thomas")) score += 90;      // Microsoft Thomas (en-GB Neural)
  if (name.includes("eric")) score += 70;        // Microsoft Eric (en-GB)
  if (name.includes("alfie")) score += 60;
  if (name.includes("oliver")) score += 60;
  if (name.includes("george")) score += 50;
  if (lang.startsWith("en-gb")) score += 30;
  if (name.includes("neural") || name.includes("online")) score += 40;
  if (name.includes("david")) score += 20;       // Microsoft David (en-US, classic)
  if (name.includes("mark")) score += 15;
  if (lang.startsWith("en")) score += 5;
  // Penalize female voices for the JARVIS persona — easy to swap manually.
  if (name.includes("female") || name.includes("zira") || name.includes("hazel") || name.includes("susan")) score -= 30;
  return score;
}

function loadVoices() {
  availableVoices = synth.getVoices();
  if (availableVoices.length === 0) return;

  voicePicker.innerHTML = "";
  const sorted = [...availableVoices].sort((a, b) => rankJarvisVoice(b) - rankJarvisVoice(a));
  for (const v of sorted) {
    const opt = document.createElement("option");
    opt.value = v.name;
    opt.textContent = `${v.name} (${v.lang})`;
    voicePicker.appendChild(opt);
  }

  const remembered = localStorage.getItem(STORAGE_VOICE);
  if (remembered && availableVoices.some(v => v.name === remembered)) {
    voicePicker.value = remembered;
  } else {
    voicePicker.value = sorted[0]?.name ?? "";
    if (voicePicker.value) localStorage.setItem(STORAGE_VOICE, voicePicker.value);
  }
}

if (synth.onvoiceschanged !== undefined) {
  synth.onvoiceschanged = loadVoices;
}
loadVoices();

voicePicker.addEventListener("change", () => {
  localStorage.setItem(STORAGE_VOICE, voicePicker.value);
});

function refreshVoiceToggleUI() {
  if (voiceEnabled) {
    voiceToggleBtn.textContent = "🔊";
    voiceToggleBtn.classList.add("voice-on");
    voiceToggleBtn.classList.remove("voice-off");
    voiceToggleBtn.title = "Voice on — click to mute";
  } else {
    voiceToggleBtn.textContent = "🔇";
    voiceToggleBtn.classList.add("voice-off");
    voiceToggleBtn.classList.remove("voice-on");
    voiceToggleBtn.title = "Voice off — click to unmute";
  }
}
refreshVoiceToggleUI();

voiceToggleBtn.addEventListener("click", () => {
  voiceEnabled = !voiceEnabled;
  localStorage.setItem(STORAGE_VOICE_ENABLED, voiceEnabled ? "true" : "false");
  if (!voiceEnabled) synth.cancel();
  refreshVoiceToggleUI();
});

stopSpeakingBtn.addEventListener("click", () => {
  synth.cancel();
  // If a call is active, end it (also clears currentAudio).
  if (callAudio) {
    endCall();
    return;
  }
  if (currentAudio) {
    currentAudio.pause();
    currentAudio = null;
  }
  stopSpeakingBtn.classList.add("hidden");
});

const PIPER_BASE = "http://localhost:5500";
const STORAGE_TTS_STYLE = "jarvis.tts.style";
let piperAvailable: boolean | null = null;
let currentAudio: HTMLAudioElement | null = null;

const ttsStylePicker = document.getElementById("tts-style") as HTMLSelectElement;
if (ttsStylePicker) {
  const remembered = localStorage.getItem(STORAGE_TTS_STYLE);
  if (remembered) ttsStylePicker.value = remembered;
  ttsStylePicker.addEventListener("change", () => {
    localStorage.setItem(STORAGE_TTS_STYLE, ttsStylePicker.value);
  });
}

const ttsEngineLabel = document.getElementById("tts-engine") as HTMLElement;

function updateEngineLabel(usingPiper: boolean) {
  if (!ttsEngineLabel) return;
  if (usingPiper) {
    ttsEngineLabel.textContent = "🎤 Alan (Piper)";
    ttsEngineLabel.classList.add("piper-active");
  } else {
    ttsEngineLabel.textContent = "🌐 Web Speech";
    ttsEngineLabel.classList.remove("piper-active");
  }
}

async function checkPiper(): Promise<boolean> {
  // Cache positive results for the session; re-check if previously unavailable
  // so we pick up Piper as soon as the service becomes reachable.
  if (piperAvailable === true) return true;
  try {
    const res = await fetch(`${PIPER_BASE}/health`, { signal: AbortSignal.timeout(800) });
    piperAvailable = res.ok;
  } catch {
    piperAvailable = false;
  }
  updateEngineLabel(piperAvailable);
  return piperAvailable;
}

// Probe Piper at startup so the indicator reflects reality immediately.
checkPiper();

function cleanForSpeech(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, " (code block) ")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\*\*?([^*]+)\*\*?/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/^#+\s+/gm, "")
    .replace(/\s+/g, " ")
    .trim();
}

async function speakViaPiper(text: string): Promise<boolean> {
  const style = ttsStylePicker?.value || "alan";
  try {
    const res = await fetch(`${PIPER_BASE}/tts`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text, style }),
    });
    if (!res.ok) return false;

    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    // Hand the audio to the call UX rather than playing directly.
    showIncomingCall(url);
    return true;
  } catch {
    return false;
  }
}

// ---------------- Incoming call + audio-reactive waveform ----------------

const callNotification = document.getElementById("call-notification") as HTMLElement;
const callAcceptBtn = document.getElementById("call-accept") as HTMLButtonElement;
const callDeclineBtn = document.getElementById("call-decline") as HTMLButtonElement;
const callDialog = document.getElementById("call-dialog") as HTMLElement;
const callDialogStatus = document.getElementById("call-dialog-status") as HTMLElement;
const callHangupBtn = document.getElementById("call-hangup") as HTMLButtonElement;
const callWaveform = document.getElementById("call-waveform") as HTMLCanvasElement;

let pendingAudioUrl: string | null = null;
let callAudio: HTMLAudioElement | null = null;
let callAudioCtx: AudioContext | null = null;
let callAnalyser: AnalyserNode | null = null;
let callRafId = 0;
let callAutoAcceptTimer: number | undefined;

function hideIncomingCall() {
  callNotification.classList.add("hidden");
  clearTimeout(callAutoAcceptTimer);
}

function showIncomingCall(audioUrl: string) {
  // If a previous call audio is queued, drop it.
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

  // Tear down any previous call.
  endCall();

  callDialog.classList.remove("hidden");
  callDialogStatus.textContent = "connecting…";

  callAudio = new Audio(url);
  currentAudio = callAudio;
  stopSpeakingBtn.classList.remove("hidden");

  // Build Web Audio graph: source → analyser → destination.
  try {
    if (!callAudioCtx) callAudioCtx = new AudioContext();
    if (callAudioCtx.state === "suspended") await callAudioCtx.resume();
    const source = callAudioCtx.createMediaElementSource(callAudio);
    callAnalyser = callAudioCtx.createAnalyser();
    callAnalyser.fftSize = 256;
    callAnalyser.smoothingTimeConstant = 0.78;
    source.connect(callAnalyser);
    callAnalyser.connect(callAudioCtx.destination);
  } catch (e) {
    // Some browsers refuse a second createMediaElementSource on the same node — fine, fall back.
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

function endCall() {
  cancelAnimationFrame(callRafId);
  callDialog.classList.add("hidden");
  stopSpeakingBtn.classList.add("hidden");
  if (callAudio) {
    callAudio.pause();
    if (callAudio.src) URL.revokeObjectURL(callAudio.src);
    callAudio = null;
  }
  if (currentAudio === callAudio) currentAudio = null;
  callAnalyser = null;
}

function drawWaveform() {
  const ctx = callWaveform.getContext("2d");
  if (!ctx) return;
  const W = callWaveform.width;
  const H = callWaveform.height;
  const cx = W / 2;
  const cy = H / 2;
  const innerR = 110;        // empty zone around avatar text
  const maxBarLen = 90;
  const barCount = 96;
  const accent = "#5cd9ff";
  const accentSoft = "rgba(92, 217, 255, 0.18)";

  function frame() {
    callRafId = requestAnimationFrame(frame);
    ctx!.clearRect(0, 0, W, H);

    // Pull live frequency data (or fall back to zeros).
    let dataArray: Uint8Array;
    if (callAnalyser) {
      const bins = callAnalyser.frequencyBinCount;
      dataArray = new Uint8Array(bins);
      callAnalyser.getByteFrequencyData(dataArray);
    } else {
      dataArray = new Uint8Array(barCount);
    }

    // Outer halo ring — overall amplitude.
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

    // Circular frequency bars (mirrored top↔bottom for symmetry).
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

    // Soft inner glow ring
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

function speakViaWebSpeech(text: string) {
  synth.cancel();
  const utterance = new SpeechSynthesisUtterance(text);
  const selected = availableVoices.find(v => v.name === voicePicker.value);
  if (selected) utterance.voice = selected;
  utterance.rate = 1.0;
  utterance.pitch = 0.95;
  utterance.volume = 1.0;
  utterance.onstart = () => stopSpeakingBtn.classList.remove("hidden");
  utterance.onend = () => stopSpeakingBtn.classList.add("hidden");
  utterance.onerror = () => stopSpeakingBtn.classList.add("hidden");
  synth.speak(utterance);
}

async function speak(text: string) {
  if (!voiceEnabled) return;
  const clean = cleanForSpeech(text);
  if (!clean) return;

  synth.cancel();
  if (currentAudio) {
    currentAudio.pause();
    currentAudio = null;
  }

  // Prefer Piper (cinematic local voice). Fall back to Web Speech if unavailable.
  if (await checkPiper()) {
    const ok = await speakViaPiper(clean);
    if (ok) return;
    piperAvailable = false; // mark down for this session
  }
  speakViaWebSpeech(clean);
}

// ---------------- Voice recognition (STT) ----------------

const SpeechRec: any =
  (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
let recognition: any = null;
let isRecording = false;

if (SpeechRec) {
  recognition = new SpeechRec();
  recognition.lang = "en-US";
  recognition.interimResults = true;
  recognition.continuous = false;

  let finalTranscript = "";

  recognition.onstart = () => {
    isRecording = true;
    finalTranscript = "";
    micBtn.classList.add("recording");
  };

  recognition.onresult = (event: any) => {
    let interim = "";
    for (let i = event.resultIndex; i < event.results.length; ++i) {
      const result = event.results[i];
      if (result.isFinal) finalTranscript += result[0].transcript;
      else interim += result[0].transcript;
    }
    input.value = (finalTranscript + interim).trim();
    input.dispatchEvent(new Event("input"));
  };

  recognition.onend = () => {
    isRecording = false;
    micBtn.classList.remove("recording");
    // Auto-send if there's content from this dictation session.
    if (input.value.trim() && finalTranscript.trim()) {
      send();
    }
  };

  recognition.onerror = (e: any) => {
    isRecording = false;
    micBtn.classList.remove("recording");
    if (e.error !== "aborted" && e.error !== "no-speech") {
      addSystem(`Mic error: ${e.error}`);
    }
  };
} else {
  micBtn.disabled = true;
  micBtn.title = "Speech recognition not supported in this webview";
}

micBtn.addEventListener("click", () => {
  if (!recognition) return;
  if (isRecording) recognition.stop();
  else recognition.start();
});

// ---------------- Chat send loop ----------------

async function send() {
  if (isGenerating) return;
  const text = input.value.trim();
  if (!text) return;

  isGenerating = true;
  sendBtn.disabled = true;
  input.value = "";
  input.style.height = "auto";

  // Stop any current speech before generating a new turn.
  synth.cancel();

  history.push({ role: "user", content: text });
  addMessage("user", text);

  const assistantBody = addMessage("assistant", "");
  assistantBody.parentElement?.classList.add("streaming");

  // Show "thinking" HUD orb until the first token arrives.
  const thinkingHTML = (label = "processing") => `
    <div class="thinking">
      <div class="thinking-orb">
        <svg viewBox="0 0 60 60">
          <circle class="ring outer" cx="30" cy="30" r="26" />
          <circle class="ring middle" cx="30" cy="30" r="18" />
          <circle class="ring inner" cx="30" cy="30" r="10" />
          <rect class="tick" x="29" y="2" width="2" height="6" rx="1" />
          <circle class="core" cx="30" cy="30" r="3" />
        </svg>
      </div>
      <span class="thinking-text">${label}</span>
    </div>
  `;
  assistantBody.innerHTML = thinkingHTML(researchMode ? "researching" : "processing");

  // Global "busy" state: brand dot intensifies, chat gets scan line.
  document.querySelector("header")?.classList.add("busy");
  document.querySelector('.view[data-view="chat"]')?.classList.add("busy");

  const model = modelPicker.value;
  const startTime = performance.now();
  let tokenCount = 0;
  let assistantText = "";

  // If research mode is on, run the fast-model research pass first.
  let researchResult: ResearchResult | null = null;
  if (researchMode) {
    try {
      researchResult = await runResearch(text, (label) => {
        assistantBody.innerHTML = thinkingHTML(label);
      });
      // Replace the user's last history entry with the augmented prompt sent to the heavy model.
      const augmented = buildAugmentedPrompt(text, researchResult);
      history[history.length - 1] = { role: "user", content: augmented };

      // Render a collapsible research-notes card right before the assistant bubble.
      const card = document.createElement("details");
      card.className = "research-notes";
      const notesHTML = researchResult.notes.length
        ? researchResult.notes
            .map(n => `<div class="research-note"><div class="research-note-title">${escapeHtml(n.rel)}</div><div class="research-note-excerpt">${escapeHtml(n.excerpt.slice(0, 400))}${n.excerpt.length > 400 ? "…" : ""}</div></div>`)
            .join("")
        : `<div class="research-empty">No relevant notes found in your vault.</div>`;
      card.innerHTML = `
        <summary>
          <span class="research-icon">🔬</span>
          <span class="research-title">Research notes</span>
          <span class="research-meta">${researchResult.notes.length} note${researchResult.notes.length === 1 ? "" : "s"} · ${researchResult.fastModel}</span>
        </summary>
        <div class="research-body">
          ${researchResult.searchTerms.length ? `<div class="research-section"><div class="research-section-label">Search terms</div><div class="research-terms">${researchResult.searchTerms.map(t => `<span class="research-term">${escapeHtml(t)}</span>`).join("")}</div></div>` : ""}
          <div class="research-section"><div class="research-section-label">Notes</div>${notesHTML}</div>
          ${researchResult.outline ? `<div class="research-section"><div class="research-section-label">Outline</div><div class="research-outline">${renderMarkdown(researchResult.outline)}</div></div>` : ""}
        </div>
      `;
      chat.insertBefore(card, assistantBody.parentElement || null);
      card.scrollIntoView({ behavior: "smooth", block: "end" });

      assistantBody.innerHTML = thinkingHTML(`generating with ${model}`);
    } catch (e: any) {
      assistantBody.innerHTML = thinkingHTML("research failed — falling back");
    }
  }

  function escapeHtml(s: string): string {
    return s.replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
  }

  const backend = selectedBackend();

  try {
    if (backend === "nvidia") {
      // NVIDIA hosted inference. Streams via Tauri events from Rust;
      // the API key never reaches this JS context.
      const summary = await nvidiaChatStream(
        {
          model,
          messages: buildMessages(history) as { role: "system" | "user" | "assistant"; content: string }[],
          temperature: settings.temperature,
          top_p: settings.topP,
          max_tokens: settings.numPredict > 0 ? settings.numPredict : undefined,
        },
        (delta) => {
          assistantText += delta;
          assistantBody.innerHTML = renderMarkdown(assistantText);
          tokenCount++;
          tokensSession++;
          tokensTotal++;
          if (tokenCount % 10 === 0) updateTokenCells();
          const elapsed = (performance.now() - startTime) / 1000;
          const rate = tokenCount / elapsed;
          stats.textContent = `${tokenCount} tok • ${rate.toFixed(1)} tok/s • ${elapsed.toFixed(1)}s · NVIDIA`;
        },
      );
      const elapsed = (performance.now() - startTime) / 1000;
      const finalCount = summary.tokens > 0 ? summary.tokens : tokenCount;
      const finalRate = elapsed > 0 ? finalCount / elapsed : 0;
      stats.textContent = `${finalCount} tok • ${finalRate.toFixed(1)} tok/s • ${elapsed.toFixed(1)}s · NVIDIA`;
    } else {
      const res = await fetch(`${OLLAMA_BASE}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model,
          messages: buildMessages(history),
          stream: true,
          options: buildOllamaOptions(),
        }),
      });

      if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";

        for (const line of lines) {
          if (!line.trim()) continue;
          let obj: any;
          try { obj = JSON.parse(line); } catch { continue; }

          const chunk = obj.message?.content || "";
          if (chunk) {
            assistantText += chunk;
            assistantBody.innerHTML = renderMarkdown(assistantText);
            tokenCount++;
            tokensSession++;
            tokensTotal++;
            // Update HUD counters every 10 tokens (cheap UX vs render cost).
            if (tokenCount % 10 === 0) updateTokenCells();
            const elapsed = (performance.now() - startTime) / 1000;
            const rate = tokenCount / elapsed;
            stats.textContent = `${tokenCount} tok • ${rate.toFixed(1)} tok/s • ${elapsed.toFixed(1)}s`;
          }

          if (obj.done) {
            const evalCount = obj.eval_count || tokenCount;
            const evalDur = (obj.eval_duration || 0) / 1e9;
            const finalRate = evalDur > 0 ? evalCount / evalDur : 0;
            stats.textContent = `${evalCount} tok • ${finalRate.toFixed(1)} tok/s • ${evalDur.toFixed(1)}s`;
          }
        }
      }
    }

    history.push({ role: "assistant", content: assistantText });
    speak(assistantText);
  } catch (e: any) {
    assistantBody.textContent = `Error: ${e.message}`;
    assistantBody.parentElement?.classList.add("error");
  } finally {
    assistantBody.parentElement?.classList.remove("streaming");
    document.querySelector("header")?.classList.remove("busy");
    document.querySelector('.view[data-view="chat"]')?.classList.remove("busy");
    // Persist token total to localStorage and update the HUD.
    localStorage.setItem(STORAGE_TOKENS_TOTAL, String(tokensTotal));
    updateTokenCells();
    isGenerating = false;
    sendBtn.disabled = false;
    input.focus();
  }
}

sendBtn.addEventListener("click", send);
input.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    send();
  }
});
input.addEventListener("input", () => {
  input.style.height = "auto";
  input.style.height = Math.min(input.scrollHeight, 200) + "px";
});
clearBtn.addEventListener("click", () => {
  if (isGenerating) return;
  history = [];
  chat.innerHTML = "";
  stats.textContent = "";
  synth.cancel();
  input.focus();
});

// ---------------- Research mode (fast model researches, heavy model answers) ----------------

const STORAGE_RESEARCH = "jarvis.research.mode";
const researchToggle = document.getElementById("research-toggle") as HTMLButtonElement;
let researchMode = localStorage.getItem(STORAGE_RESEARCH) === "true";

function refreshResearchUI() {
  if (researchMode) {
    researchToggle.classList.add("research-on");
    researchToggle.title = "Research mode ON — fast model researches first";
  } else {
    researchToggle.classList.remove("research-on");
    researchToggle.title = "Research mode OFF — direct query";
  }
}
refreshResearchUI();
researchToggle?.addEventListener("click", () => {
  researchMode = !researchMode;
  localStorage.setItem(STORAGE_RESEARCH, String(researchMode));
  refreshResearchUI();
});

// Pick a fast research model from what's available, with sensible fallbacks.
async function pickResearchModel(): Promise<string> {
  try {
    const res = await fetch(`${OLLAMA_BASE}/api/tags`);
    const data = await res.json();
    const names: string[] = (data.models || []).map((m: any) => m.name);
    const prefer = [
      "llama-4070:latest", "llama-4070",
      "qwen-coder-4070-fast:latest", "qwen-coder-4070-fast",
      "llama3.1:8b", "llama3.2:3b",
      "qwen2.5-coder:7b",
    ];
    for (const p of prefer) {
      if (names.includes(p)) return p;
    }
    // last-ditch: any 7-8B model
    const small = names.find(n => /:[37]b/i.test(n));
    return small || modelPicker.value;
  } catch {
    return modelPicker.value;
  }
}

// One-shot non-streaming call. Returns plain text content.
async function callOllamaOnce(model: string, prompt: string, temperature = 0.3): Promise<string> {
  const res = await fetch(`${OLLAMA_BASE}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      messages: [{ role: "user", content: prompt }],
      stream: false,
      options: { temperature },
    }),
  });
  if (!res.ok) throw new Error(`fast model HTTP ${res.status}`);
  const data = await res.json();
  return (data.message?.content || "").trim();
}

interface ResearchResult {
  searchTerms: string[];
  notes: { rel: string; excerpt: string }[];
  outline: string;
  fastModel: string;
}

async function runResearch(query: string, status: (msg: string) => void): Promise<ResearchResult> {
  const fastModel = await pickResearchModel();
  status(`Picking research topics with ${fastModel}…`);

  // 1. Extract search terms
  const termsPrompt = `You are a research assistant. Extract 1-3 short search terms from the user's question that I should look up in their personal knowledge base. Return ONLY the terms, one per line, no commentary, no numbering.

Question: ${query}

Search terms:`;
  let termsRaw = "";
  try {
    termsRaw = await callOllamaOnce(fastModel, termsPrompt, 0.2);
  } catch (e: any) {
    status(`Term extraction failed: ${e.message}`);
  }
  const terms = termsRaw
    .split("\n")
    .map(s => s.trim().replace(/^[-*•\d.\)]+\s*/, "").replace(/^["']|["']$/g, ""))
    .filter(s => s.length > 1 && s.length < 80)
    .slice(0, 3);

  // 2. Search vault for those terms
  if (vaultPath && !vaultIndex) {
    try { await indexVault(); } catch {}
  }

  const collectedDocs = new Map<string, IndexedDoc>();
  for (const t of terms) {
    const hits = searchVault(t);
    for (const h of hits.slice(0, 2)) collectedDocs.set(h.doc.path, h.doc);
  }
  const notes = Array.from(collectedDocs.values()).map(d => ({
    rel: d.rel,
    excerpt: d.content.slice(0, 1500),
  }));

  status(`Found ${notes.length} note(s). Outlining the answer…`);

  // 3. Ask fast model to outline an answer using collected notes (if any).
  const notesText = notes.length
    ? notes.map(n => `--- ${n.rel} ---\n${n.excerpt}`).join("\n\n")
    : "(no relevant notes found in vault)";

  const outlinePrompt = `You are a research assistant. The user asked: "${query}"

Here are excerpts from their personal knowledge base that may be relevant:
${notesText}

Based on the question and these notes, write a SHORT outline (3-5 bullet points) of what a good answer should cover. Be concise. Return only the bullets, no preamble.`;

  let outline = "";
  try {
    outline = await callOllamaOnce(fastModel, outlinePrompt, 0.3);
  } catch (e: any) {
    status(`Outline failed: ${e.message}`);
  }

  return { searchTerms: terms, notes, outline, fastModel };
}

function buildAugmentedPrompt(query: string, r: ResearchResult): string {
  const notesBlock = r.notes.length
    ? `\n\nResearch notes from the user's knowledge base:\n${r.notes.map(n => `--- ${n.rel} ---\n${n.excerpt}`).join("\n\n")}`
    : "";
  const outlineBlock = r.outline ? `\n\nOutline (from research assistant):\n${r.outline}` : "";
  return `${query}${notesBlock}${outlineBlock}\n\nProvide a thorough, well-structured answer using the outline and notes above where relevant.`;
}

// ---------------- Workspace (file tree + CodeMirror editor) ----------------

const wsOpenBtn = document.getElementById("ws-open-folder") as HTMLButtonElement;
const wsFolderPath = document.getElementById("ws-folder-path") as HTMLElement;
const wsFileInfo = document.getElementById("ws-file-info") as HTMLElement;
const wsSaveBtn = document.getElementById("ws-save") as HTMLButtonElement;
const wsRevertBtn = document.getElementById("ws-revert") as HTMLButtonElement;
const wsDirtyDot = document.getElementById("ws-dirty") as HTMLElement;
const wsTree = document.getElementById("ws-tree") as HTMLElement;
const wsEditorContainer = document.getElementById("ws-editor") as HTMLElement;

const STORAGE_WS_FOLDER = "jarvis.ws.folder";
const STORAGE_WS_FILE = "jarvis.ws.file";

let wsFolder = localStorage.getItem(STORAGE_WS_FOLDER) || "";
let wsCurrentFile: string | null = null;
let wsLoadedContent = "";
let wsTreeNodes: Map<string, HTMLElement> = new Map();

const SKIP_DIRS = new Set([".git", "node_modules", "target", "dist", "build", ".next", "__pycache__", ".venv", "venv", ".idea", ".vscode"]);

function languageForFile(path: string): any {
  const ext = path.split(".").pop()?.toLowerCase() || "";
  if (["js", "jsx", "mjs", "cjs"].includes(ext)) return javascript({ jsx: true });
  if (["ts", "tsx"].includes(ext)) return javascript({ typescript: true, jsx: true });
  if (ext === "py") return python();
  if (ext === "rs") return rust();
  if (ext === "md" || ext === "markdown") return markdown();
  if (ext === "json") return json();
  if (["html", "htm", "xhtml"].includes(ext)) return html();
  if (["css", "scss", "less"].includes(ext)) return css();
  return [];
}

function fileIcon(name: string): string {
  if (name.endsWith(".ts") || name.endsWith(".tsx")) return "𝐓";
  if (name.endsWith(".js") || name.endsWith(".jsx")) return "𝐉";
  if (name.endsWith(".py")) return "🐍";
  if (name.endsWith(".rs")) return "🦀";
  if (name.endsWith(".md")) return "▤";
  if (name.endsWith(".json")) return "{}";
  if (name.endsWith(".html")) return "<>";
  if (name.endsWith(".css")) return "✦";
  return "·";
}

// CodeMirror setup
let editorView: EditorView | null = null;
const languageCompartment = new Compartment();

function ensureEditor(): EditorView {
  if (editorView) return editorView;
  wsEditorContainer.innerHTML = ""; // remove the empty-state message
  const startState = EditorState.create({
    doc: "",
    extensions: [
      lineNumbers(),
      foldGutter(),
      highlightActiveLine(),
      highlightActiveLineGutter(),
      historyExt(),
      bracketMatching(),
      indentOnInput(),
      autocompletion(),
      highlightSelectionMatches(),
      syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
      oneDark,
      EditorView.lineWrapping,
      keymap.of([
        ...defaultKeymap,
        ...searchKeymap,
        ...historyKeymap,
        ...foldKeymap,
        ...completionKeymap,
        indentWithTab,
        {
          key: "Mod-s",
          preventDefault: true,
          run: () => { wsSave(); return true; },
        },
      ]),
      languageCompartment.of([]),
      EditorView.updateListener.of(update => {
        if (update.docChanged) refreshDirty();
      }),
    ],
  });
  editorView = new EditorView({ state: startState, parent: wsEditorContainer });
  return editorView;
}

function refreshDirty() {
  if (!editorView || !wsCurrentFile) return;
  const current = editorView.state.doc.toString();
  const dirty = current !== wsLoadedContent;
  wsSaveBtn.disabled = !dirty;
  wsRevertBtn.disabled = !dirty;
  wsDirtyDot.classList.toggle("hidden", !dirty);
}

async function wsSave() {
  if (!editorView || !wsCurrentFile) return;
  const content = editorView.state.doc.toString();
  try {
    await writeTextFile(wsCurrentFile, content);
    wsLoadedContent = content;
    refreshDirty();
    addSystem(`Saved ${wsCurrentFile.split(/[\\/]/).pop()}`);
  } catch (e: any) {
    addSystem(`Save failed: ${e.message}`);
  }
}

function wsRevert() {
  if (!editorView) return;
  editorView.dispatch({
    changes: { from: 0, to: editorView.state.doc.length, insert: wsLoadedContent },
  });
  refreshDirty();
}

wsSaveBtn.addEventListener("click", wsSave);
wsRevertBtn.addEventListener("click", wsRevert);

async function wsOpenFolder() {
  let picked: string | null = null;
  try {
    const result = await openDialog({ directory: true, multiple: false });
    picked = (result as string) || null;
  } catch (e: any) {
    addSystem(`Folder picker error: ${e.message}`);
    return;
  }
  if (!picked) return;
  wsFolder = picked;
  localStorage.setItem(STORAGE_WS_FOLDER, wsFolder);
  await renderWsTree();
}

wsOpenBtn.addEventListener("click", wsOpenFolder);

interface WsTreeEntry {
  name: string;
  path: string;
  isDir: boolean;
  children?: WsTreeEntry[];
  loaded?: boolean;
}

async function listChildren(dir: string): Promise<WsTreeEntry[]> {
  let entries;
  try {
    entries = await readDir(dir);
  } catch {
    return [];
  }
  const result: WsTreeEntry[] = [];
  for (const e of entries) {
    if (e.name.startsWith(".") && SKIP_DIRS.has(e.name)) continue;
    if (e.isDirectory && SKIP_DIRS.has(e.name)) continue;
    const path = `${dir}\\${e.name}`;
    result.push({ name: e.name, path, isDir: !!e.isDirectory });
  }
  // sort: dirs first, then files, both alphabetical
  result.sort((a, b) => {
    if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  return result;
}

async function renderWsTree() {
  wsTree.innerHTML = "";
  wsTreeNodes.clear();
  if (!wsFolder) {
    wsTree.innerHTML = `<div class="ws-tree-empty">Open a folder to start editing.</div>`;
    wsFolderPath.textContent = "No folder open";
    return;
  }
  wsFolderPath.textContent = wsFolder;
  const root = document.createElement("ul");
  root.className = "ws-tree-list ws-tree-root";
  wsTree.appendChild(root);
  await fillTreeLevel(root, wsFolder);
}

async function fillTreeLevel(ul: HTMLElement, dir: string) {
  const entries = await listChildren(dir);
  if (entries.length === 0) {
    const li = document.createElement("li");
    li.className = "ws-tree-empty-node";
    li.textContent = "(empty)";
    ul.appendChild(li);
    return;
  }
  for (const e of entries) {
    const li = document.createElement("li");
    li.className = "ws-tree-item";
    li.dataset.path = e.path;
    wsTreeNodes.set(e.path, li);

    const row = document.createElement("div");
    row.className = "ws-tree-row";
    if (e.isDir) row.classList.add("ws-tree-dir");
    else row.classList.add("ws-tree-file");

    const icon = document.createElement("span");
    icon.className = "ws-tree-icon";
    icon.textContent = e.isDir ? "▸" : fileIcon(e.name);
    row.appendChild(icon);

    const label = document.createElement("span");
    label.className = "ws-tree-label";
    label.textContent = e.name;
    row.appendChild(label);

    li.appendChild(row);

    if (e.isDir) {
      const childUl = document.createElement("ul");
      childUl.className = "ws-tree-list";
      childUl.style.display = "none";
      li.appendChild(childUl);
      let loaded = false;
      row.addEventListener("click", async () => {
        const isOpen = childUl.style.display !== "none";
        childUl.style.display = isOpen ? "none" : "block";
        icon.textContent = isOpen ? "▸" : "▾";
        if (!loaded && !isOpen) {
          loaded = true;
          await fillTreeLevel(childUl, e.path);
        }
      });
    } else {
      row.addEventListener("click", () => openFileInEditor(e.path));
    }

    ul.appendChild(li);
  }
}

async function openFileInEditor(path: string) {
  if (wsCurrentFile && wsLoadedContent !== editorView?.state.doc.toString()) {
    if (!confirm("Discard unsaved changes?")) return;
  }
  ensureEditor();
  try {
    const content = await readTextFile(path);
    wsCurrentFile = path;
    wsLoadedContent = content;
    editorView!.dispatch({
      changes: { from: 0, to: editorView!.state.doc.length, insert: content },
      effects: languageCompartment.reconfigure(languageForFile(path)),
    });
    refreshDirty();
    wsFileInfo.textContent = path.split(/[\\/]/).pop() || "";
    // Mark active in tree
    document.querySelectorAll(".ws-tree-row.active").forEach(el => el.classList.remove("active"));
    wsTreeNodes.get(path)?.querySelector(".ws-tree-row")?.classList.add("active");
    localStorage.setItem(STORAGE_WS_FILE, path);
  } catch (e: any) {
    addSystem(`Could not open ${path}: ${e.message}`);
  }
}

// Restore on startup if a folder was previously open.
if (wsFolder) {
  renderWsTree().then(() => {
    const lastFile = localStorage.getItem(STORAGE_WS_FILE);
    if (lastFile) openFileInEditor(lastFile).catch(() => {});
  }).catch(() => {});
}

// ---------------- Brain ----------------

const brainSearch = document.getElementById("brain-search") as HTMLInputElement;
const brainSettings = document.getElementById("brain-settings") as HTMLButtonElement;
const brainStatus = document.getElementById("brain-status") as HTMLElement;
const brainResults = document.getElementById("brain-results") as HTMLElement;

const STORAGE_VAULT = "jarvis.vault.path";
const DEFAULT_VAULT = "C:\\Users\\vdzoo\\Documents\\obisidian\\brain";
let vaultPath = localStorage.getItem(STORAGE_VAULT) || "";
if (!vaultPath) {
  vaultPath = DEFAULT_VAULT;
  localStorage.setItem(STORAGE_VAULT, vaultPath);
}
let vaultIndex: IndexedDoc[] | null = null;
let indexingInFlight: Promise<void> | null = null;
let lastIndexedPath = "";

function setBrainStatus(text: string) {
  brainStatus.textContent = text;
}

function refreshBrainStatus() {
  if (!vaultPath) {
    setBrainStatus("No vault configured. Click ⚙ to point at your Obsidian vault.");
    return;
  }
  if (vaultIndex) {
    setBrainStatus(`Vault: ${vaultPath} • ${vaultIndex.length} notes indexed`);
  } else {
    setBrainStatus(`Vault: ${vaultPath} (not indexed yet — type to search and index)`);
  }
}
refreshBrainStatus();

brainSettings?.addEventListener("click", () => {
  const next = prompt(
    "Path to your Obsidian vault (we'll search markdown files here):",
    vaultPath || DEFAULT_VAULT
  );
  if (next == null) return;
  const trimmed = next.trim();
  if (!trimmed) return;
  vaultPath = trimmed;
  localStorage.setItem(STORAGE_VAULT, vaultPath);
  vaultIndex = null;
  brainResults.innerHTML = "";
  refreshBrainStatus();
});

async function walkMarkdown(dir: string, root: string, out: { path: string; rel: string }[] = []): Promise<{ path: string; rel: string }[]> {
  let entries;
  try {
    entries = await readDir(dir);
  } catch {
    return out;
  }
  for (const entry of entries) {
    const fullPath = `${dir}\\${entry.name}`;
    if (entry.isDirectory) {
      if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
      await walkMarkdown(fullPath, root, out);
    } else if (entry.name.toLowerCase().endsWith(".md")) {
      const rel = fullPath.startsWith(root) ? fullPath.slice(root.length).replace(/^[\\/]+/, "") : fullPath;
      out.push({ path: fullPath, rel });
    }
  }
  return out;
}

async function indexVault(): Promise<void> {
  if (!vaultPath) throw new Error("No vault path configured.");
  if (lastIndexedPath === vaultPath && vaultIndex) return;
  if (indexingInFlight) return indexingInFlight;

  setBrainStatus(`Indexing ${vaultPath}…`);

  indexingInFlight = (async () => {
    if (!(await exists(vaultPath))) {
      throw new Error(`Vault path does not exist: ${vaultPath}`);
    }
    const files = await walkMarkdown(vaultPath, vaultPath);
    const docs: IndexedDoc[] = [];
    for (const f of files) {
      try {
        const content = await readTextFile(f.path);
        docs.push({ path: f.path, rel: f.rel, content });
      } catch {
        // skip unreadable files
      }
    }
    vaultIndex = docs;
    lastIndexedPath = vaultPath;
  })();

  try {
    await indexingInFlight;
    refreshBrainStatus();
    if (typeof refreshBrainViz === "function") refreshBrainViz();
  } catch (e: any) {
    setBrainStatus(`Index failed: ${e.message}`);
    vaultIndex = null;
  } finally {
    indexingInFlight = null;
  }
}

interface SearchHit {
  doc: IndexedDoc;
  snippet: string;
  matchPos: number;
}

function searchVault(query: string): SearchHit[] {
  if (!vaultIndex) return [];
  const q = query.trim().toLowerCase();
  if (!q) return [];

  const hits: SearchHit[] = [];
  for (const doc of vaultIndex) {
    const lower = doc.content.toLowerCase();
    const pos = lower.indexOf(q);
    if (pos === -1) continue;
    const lineStart = doc.content.lastIndexOf("\n", pos);
    const ctxStart = Math.max(lineStart === -1 ? 0 : lineStart + 1, pos - 80);
    const ctxEnd = Math.min(doc.content.length, pos + q.length + 200);
    let snippet = doc.content.slice(ctxStart, ctxEnd).replace(/\s+/g, " ").trim();
    if (ctxStart > 0) snippet = "… " + snippet;
    if (ctxEnd < doc.content.length) snippet = snippet + " …";
    hits.push({ doc, snippet, matchPos: pos });
  }
  hits.sort((a, b) => a.matchPos - b.matchPos);
  return hits.slice(0, 50);
}

function renderHits(hits: SearchHit[], query: string) {
  brainResults.innerHTML = "";
  if (hits.length === 0) {
    const el = document.createElement("div");
    el.className = "brain-hint";
    el.textContent = vaultIndex ? `No matches for "${query}"` : "Index hasn't loaded yet";
    brainResults.appendChild(el);
    return;
  }
  for (const hit of hits) {
    const card = document.createElement("div");
    card.className = "brain-hit";
    const title = document.createElement("div");
    title.className = "brain-hit-title";
    title.textContent = hit.doc.rel;
    card.appendChild(title);
    const snippet = document.createElement("div");
    snippet.className = "brain-hit-snippet";
    const lowerSnippet = hit.snippet.toLowerCase();
    const lowerQ = query.toLowerCase();
    const matchIdx = lowerSnippet.indexOf(lowerQ);
    if (matchIdx === -1) snippet.textContent = hit.snippet;
    else {
      snippet.append(
        document.createTextNode(hit.snippet.slice(0, matchIdx)),
        Object.assign(document.createElement("mark"), {
          textContent: hit.snippet.slice(matchIdx, matchIdx + query.length),
        }),
        document.createTextNode(hit.snippet.slice(matchIdx + query.length))
      );
    }
    card.appendChild(snippet);
    const actions = document.createElement("div");
    actions.className = "brain-hit-actions";
    const askBtn = document.createElement("button");
    askBtn.className = "ghost";
    askBtn.textContent = "Ask in Chat";
    askBtn.addEventListener("click", () => askWithContext(hit.doc, query));
    actions.appendChild(askBtn);
    card.appendChild(actions);
    brainResults.appendChild(card);
  }
}

function askWithContext(doc: IndexedDoc, originalQuery: string) {
  (document.querySelector('.tab[data-tab="chat"]') as HTMLButtonElement)?.click();
  input.value = `Using this note as context, answer my question.\n\n--- ${doc.rel} ---\n${doc.content}\n--- end note ---\n\nQuestion: ${originalQuery}`;
  input.dispatchEvent(new Event("input"));
  input.focus();
}

let searchDebounce: number | undefined;
brainSearch?.addEventListener("input", () => {
  if (!vaultPath) {
    brainResults.innerHTML = `<div class="brain-hint">Set a vault path first (⚙).</div>`;
    return;
  }
  clearTimeout(searchDebounce);
  const query = brainSearch.value;
  searchDebounce = window.setTimeout(async () => {
    if (!vaultIndex) {
      try { await indexVault(); }
      catch (e: any) {
        brainResults.innerHTML = `<div class="brain-hint">${e.message}</div>`;
        return;
      }
    }
    if (!query.trim()) {
      brainResults.innerHTML = "";
      clearBrainHighlights();
      return;
    }
    const hits = searchVault(query);
    renderHits(hits, query);
    highlightFromHits(hits);
  }, 200);
});

// ---------------- Camera + gesture recognition ----------------

const cameraPanel = document.getElementById("camera-panel") as HTMLElement;
const cameraFeed = document.getElementById("camera-feed") as HTMLVideoElement;
const cameraOverlay = document.getElementById("camera-overlay") as HTMLElement;
const cameraToggleBtn = document.getElementById("camera-toggle") as HTMLButtonElement;
const cameraCloseBtn = document.getElementById("camera-close") as HTMLButtonElement;

let gestureRecognizer: GestureRecognizer | null = null;
let cameraStream: MediaStream | null = null;
let cameraActive = false;
let lastFiredGesture = "";
let lastFiredAt = 0;
const GESTURE_COOLDOWN_MS = 1500;

async function initGestureRecognizer() {
  if (gestureRecognizer) return;
  // Load WASM + model from bundled local files (no CDN dependency).
  const vision = await FilesetResolver.forVisionTasks("/mediapipe");
  gestureRecognizer = await GestureRecognizer.createFromOptions(vision, {
    baseOptions: {
      modelAssetPath: "/mediapipe/gesture_recognizer.task",
      delegate: "GPU",
    },
    runningMode: "VIDEO",
    numHands: 1,
  });
}

async function startCamera() {
  try {
    cameraOverlay.textContent = "loading model…";
    cameraPanel.classList.remove("hidden");
    await initGestureRecognizer();
    cameraStream = await navigator.mediaDevices.getUserMedia({
      video: { width: 320, height: 240 },
      audio: false,
    });
    cameraFeed.srcObject = cameraStream;
    cameraActive = true;
    cameraOverlay.textContent = "ready";
    cameraToggleBtn.classList.add("camera-on");
    requestAnimationFrame(processFrame);
  } catch (e: any) {
    cameraOverlay.textContent = `error: ${e.message}`;
    addSystem(`Camera error: ${e.message}`);
  }
}

function stopCamera() {
  cameraActive = false;
  cameraToggleBtn.classList.remove("camera-on");
  if (cameraStream) {
    cameraStream.getTracks().forEach(t => t.stop());
    cameraStream = null;
  }
  cameraFeed.srcObject = null;
  cameraPanel.classList.add("hidden");
}

let lastVideoTime = -1;
async function processFrame() {
  if (!cameraActive || !gestureRecognizer || !cameraFeed.videoWidth) {
    if (cameraActive) requestAnimationFrame(processFrame);
    return;
  }

  if (cameraFeed.currentTime !== lastVideoTime) {
    lastVideoTime = cameraFeed.currentTime;
    try {
      const result = gestureRecognizer.recognizeForVideo(cameraFeed, performance.now());
      if (result.gestures.length > 0 && result.gestures[0].length > 0) {
        const top = result.gestures[0][0];
        if (top.score > 0.7 && top.categoryName !== "None") {
          cameraOverlay.textContent = `${prettyGesture(top.categoryName)} ${Math.round(top.score * 100)}%`;
          handleGesture(top.categoryName);
        } else {
          cameraOverlay.textContent = "—";
        }
      } else {
        cameraOverlay.textContent = "show your hand";
      }
    } catch (e) {
      // Inference can fail on rare frames; ignore and continue.
    }
  }

  requestAnimationFrame(processFrame);
}

function prettyGesture(name: string): string {
  return ({
    "Open_Palm": "✋ Open Palm",
    "Closed_Fist": "✊ Fist",
    "Pointing_Up": "☝️ Point",
    "Thumb_Up": "👍 Thumb Up",
    "Thumb_Down": "👎 Thumb Down",
    "Victory": "✌️ Victory",
    "ILoveYou": "🤟 I love you",
  } as any)[name] || name;
}

function handleGesture(name: string) {
  const now = performance.now();
  // Debounce: same gesture must wait the cooldown before firing again.
  if (name === lastFiredGesture && now - lastFiredAt < GESTURE_COOLDOWN_MS) return;
  lastFiredGesture = name;
  lastFiredAt = now;

  switch (name) {
    case "Open_Palm":
      // Stop speech immediately.
      synth.cancel();
      if (currentAudio) {
        currentAudio.pause();
        currentAudio = null;
      }
      stopSpeakingBtn.classList.add("hidden");
      flashCamera("stopped speech");
      break;
    case "Thumb_Up":
      if (input.value.trim() && !isGenerating) {
        send();
        flashCamera("sent");
      }
      break;
    case "Victory":
      micBtn.click();
      flashCamera("mic toggled");
      break;
    case "Thumb_Down":
      if (!isGenerating) {
        clearBtn.click();
        flashCamera("conversation cleared");
      }
      break;
  }
}

let flashTimer: number | undefined;
function flashCamera(action: string) {
  cameraOverlay.classList.add("flash");
  cameraOverlay.textContent = `→ ${action}`;
  clearTimeout(flashTimer);
  flashTimer = window.setTimeout(() => {
    cameraOverlay.classList.remove("flash");
  }, 800);
}

cameraToggleBtn.addEventListener("click", () => {
  if (cameraActive) stopCamera();
  else startCamera();
});
cameraCloseBtn.addEventListener("click", stopCamera);

// ---------------- Settings drawer (tweaks) ----------------

interface JarvisSettings {
  systemPrompt: string;
  temperature: number;
  topP: number;
  topK: number;
  repeatPenalty: number;
  numCtx: number;
  numPredict: number;
  preset: "focused" | "balanced" | "creative" | "custom";
}

const STORAGE_SETTINGS = "jarvis.settings";

const DEFAULT_SETTINGS: JarvisSettings = {
  systemPrompt: "You are JARVIS, a personal AI assistant. Be concise, helpful, and direct. Use markdown formatting where appropriate.",
  temperature: 0.7,
  topP: 0.9,
  topK: 40,
  repeatPenalty: 1.05,
  numCtx: 4096,
  numPredict: -1,
  preset: "balanced",
};

const PRESETS: Record<string, Partial<JarvisSettings>> = {
  focused:  { temperature: 0.2, topP: 0.9, topK: 40, repeatPenalty: 1.05, preset: "focused" },
  balanced: { temperature: 0.7, topP: 0.9, topK: 40, repeatPenalty: 1.10, preset: "balanced" },
  creative: { temperature: 1.0, topP: 0.95, topK: 60, repeatPenalty: 1.05, preset: "creative" },
};

let settings: JarvisSettings = (() => {
  const stored = localStorage.getItem(STORAGE_SETTINGS);
  if (stored) {
    try { return { ...DEFAULT_SETTINGS, ...JSON.parse(stored) }; } catch {}
  }
  return { ...DEFAULT_SETTINGS };
})();

const drawer = document.getElementById("settings-drawer") as HTMLElement;
const drawerToggle = document.getElementById("settings-toggle") as HTMLButtonElement;
const drawerClose = document.getElementById("settings-close") as HTMLButtonElement;
const presetBtns = document.querySelectorAll<HTMLButtonElement>(".preset-btn");
const sysPromptEl = document.getElementById("settings-system-prompt") as HTMLTextAreaElement;
const resetBtn = document.getElementById("settings-reset") as HTMLButtonElement;
const savedIndicator = document.getElementById("settings-saved") as HTMLElement;

interface SliderBinding {
  inputId: string;
  valueId: string;
  key: keyof JarvisSettings;
  format?: (v: number) => string;
}

const sliders: SliderBinding[] = [
  { inputId: "settings-temperature", valueId: "settings-temperature-value", key: "temperature", format: v => v.toFixed(2) },
  { inputId: "settings-top-p", valueId: "settings-top-p-value", key: "topP", format: v => v.toFixed(2) },
  { inputId: "settings-top-k", valueId: "settings-top-k-value", key: "topK", format: v => v.toString() },
  { inputId: "settings-repeat-penalty", valueId: "settings-repeat-penalty-value", key: "repeatPenalty", format: v => v.toFixed(2) },
  { inputId: "settings-num-ctx", valueId: "settings-num-ctx-value", key: "numCtx", format: v => v.toString() },
  { inputId: "settings-num-predict", valueId: "settings-num-predict-value", key: "numPredict", format: v => v < 0 ? "unlimited" : v.toString() },
];

function applySettingsToUI() {
  for (const s of sliders) {
    const input = document.getElementById(s.inputId) as HTMLInputElement;
    const value = settings[s.key] as number;
    input.value = String(value);
    const valEl = document.getElementById(s.valueId);
    if (valEl) valEl.textContent = s.format ? s.format(value) : String(value);
  }
  sysPromptEl.value = settings.systemPrompt;
  presetBtns.forEach(btn => {
    btn.classList.toggle("active", btn.dataset.preset === settings.preset);
  });
}

function persistSettings() {
  localStorage.setItem(STORAGE_SETTINGS, JSON.stringify(settings));
  if (savedIndicator) {
    savedIndicator.classList.add("show");
    clearTimeout((savedIndicator as any)._t);
    (savedIndicator as any)._t = setTimeout(() => savedIndicator.classList.remove("show"), 1200);
  }
}

// Slider change → update setting → mark preset custom (if not from preset click) → save.
let suppressPresetReset = false;
for (const s of sliders) {
  const input = document.getElementById(s.inputId) as HTMLInputElement;
  input.addEventListener("input", () => {
    const v = Number(input.value);
    (settings[s.key] as any) = v;
    const valEl = document.getElementById(s.valueId);
    if (valEl) valEl.textContent = s.format ? s.format(v) : String(v);
    if (!suppressPresetReset && (s.key === "temperature" || s.key === "topP" || s.key === "topK" || s.key === "repeatPenalty")) {
      settings.preset = "custom";
      presetBtns.forEach(b => b.classList.toggle("active", b.dataset.preset === "custom"));
    }
    persistSettings();
  });
}

sysPromptEl.addEventListener("input", () => {
  settings.systemPrompt = sysPromptEl.value;
  persistSettings();
});

presetBtns.forEach(btn => {
  btn.addEventListener("click", () => {
    const name = btn.dataset.preset!;
    if (name === "custom") {
      settings.preset = "custom";
    } else {
      Object.assign(settings, PRESETS[name]);
    }
    suppressPresetReset = true;
    applySettingsToUI();
    suppressPresetReset = false;
    persistSettings();
  });
});

resetBtn.addEventListener("click", () => {
  settings = { ...DEFAULT_SETTINGS };
  applySettingsToUI();
  persistSettings();
});

drawerToggle.addEventListener("click", () => {
  drawer.classList.toggle("hidden");
  drawerToggle.classList.toggle("active", !drawer.classList.contains("hidden"));
  if (!drawer.classList.contains("hidden")) {
    // Refresh integrations status whenever the drawer opens so the user sees
    // the live state of `.env` rather than a stale snapshot.
    refreshNvidiaSettingsUI();
  }
});
drawerClose.addEventListener("click", () => {
  drawer.classList.add("hidden");
  drawerToggle.classList.remove("active");
});

applySettingsToUI();

// ─── Integrations · NVIDIA settings wiring ──────────────────────────────────

const nvidiaKeyEl       = document.getElementById("settings-nvidia-key") as HTMLInputElement;
const nvidiaKeyStatusEl = document.getElementById("settings-nvidia-key-status") as HTMLElement;
const nvidiaBaseEl      = document.getElementById("settings-nvidia-base") as HTMLInputElement;
const nvidiaDefaultEl   = document.getElementById("settings-nvidia-default") as HTMLInputElement;
const nvidiaSaveBtn     = document.getElementById("settings-nvidia-save") as HTMLButtonElement;
const nvidiaTestBtn     = document.getElementById("settings-nvidia-test") as HTMLButtonElement;
const nvidiaMsgEl       = document.getElementById("settings-nvidia-msg") as HTMLElement;
const nvidiaPathEl      = document.getElementById("settings-nvidia-path") as HTMLElement;

function setNvidiaMsg(text: string, kind: "ok" | "err" | "info" = "info") {
  if (!nvidiaMsgEl) return;
  nvidiaMsgEl.textContent = text;
  nvidiaMsgEl.classList.remove("ok", "err");
  if (kind === "ok") nvidiaMsgEl.classList.add("ok");
  if (kind === "err") nvidiaMsgEl.classList.add("err");
}

async function refreshNvidiaSettingsUI(): Promise<void> {
  try {
    const snap = await readEnvSnapshot();
    nvidiaKeyStatusEl.textContent = snap.has_nvidia_key ? "set" : "not set";
    nvidiaKeyStatusEl.classList.toggle("ok", snap.has_nvidia_key);
    // Don't echo the key back into the input; treat it as write-only from
    // the UI side. Placeholder stays so the user knows the format.
    nvidiaKeyEl.value = "";
    nvidiaKeyEl.placeholder = snap.has_nvidia_key ? "•••••••• (set — paste a new key to replace)" : "nvapi-…";
    nvidiaBaseEl.value = snap.nvidia_api_base;
    nvidiaDefaultEl.value = snap.nvidia_default_model;
    if (nvidiaPathEl) nvidiaPathEl.textContent = `.env: ${snap.path}`;
  } catch (e: any) {
    setNvidiaMsg(`env read failed: ${e?.message || e}`, "err");
  }
}

async function saveNvidiaSettings(): Promise<void> {
  setNvidiaMsg("saving…");
  try {
    const writes: Promise<unknown>[] = [];
    const key = nvidiaKeyEl.value.trim();
    if (key) writes.push(writeEnvValue("NVIDIA_API_KEY", key));
    const base = nvidiaBaseEl.value.trim();
    if (base) writes.push(writeEnvValue("NVIDIA_API_BASE", base));
    const def = nvidiaDefaultEl.value.trim();
    if (def) writes.push(writeEnvValue("NVIDIA_DEFAULT_MODEL", def));
    if (writes.length === 0) {
      setNvidiaMsg("nothing to save", "info");
      return;
    }
    await Promise.all(writes);
    setNvidiaMsg("saved ✓", "ok");
    await refreshNvidiaSettingsUI();
    // Re-pull the model list now that credentials may have changed.
    await loadModels(true);
  } catch (e: any) {
    setNvidiaMsg(`save failed: ${e?.message || e}`, "err");
  }
}

async function testNvidiaConnection(): Promise<void> {
  setNvidiaMsg("testing…");
  try {
    const models = await listNvidiaModels();
    setNvidiaMsg(`${models.length} models reachable`, "ok");
    // Refresh the chat picker too — the user almost always wants this next.
    await loadModels(true);
  } catch (e: any) {
    setNvidiaMsg(`${e?.message || e}`, "err");
  }
}

nvidiaSaveBtn?.addEventListener("click", saveNvidiaSettings);
nvidiaTestBtn?.addEventListener("click", testNvidiaConnection);

// Populate the integrations panel on first load too, so opening the drawer
// for the first time shows real state rather than placeholders.
refreshNvidiaSettingsUI();

function buildOllamaOptions(): Record<string, number> {
  const opts: Record<string, number> = {
    temperature: settings.temperature,
    top_p: settings.topP,
    top_k: settings.topK,
    repeat_penalty: settings.repeatPenalty,
    num_ctx: settings.numCtx,
  };
  if (settings.numPredict > 0) opts.num_predict = settings.numPredict;
  return opts;
}

function buildMessages(history: Message[]): { role: string; content: string }[] {
  const msgs: { role: string; content: string }[] = [];
  if (settings.systemPrompt && settings.systemPrompt.trim()) {
    msgs.push({ role: "system", content: settings.systemPrompt });
  }
  for (const m of history) msgs.push({ role: m.role, content: m.content });
  return msgs;
}

// ---------------- Cockpit HUD (system stats + token tracking) ----------------

const STORAGE_TOKENS_TOTAL = "jarvis.tokens.total";

let tokensSession = 0;
let tokensTotal = parseInt(localStorage.getItem(STORAGE_TOKENS_TOTAL) || "0", 10) || 0;

const cockpit = document.getElementById("cockpit") as HTMLElement;

function setCell(key: string, value: string, fillPct?: number, alarm?: boolean) {
  const cell = cockpit?.querySelector(`.cockpit-cell[data-key="${key}"]`);
  if (!cell) return;
  const valEl = cell.querySelector(".cockpit-value") as HTMLElement | null;
  const fillEl = cell.querySelector(".cockpit-bar-fill") as HTMLElement | null;
  if (valEl) valEl.textContent = value;
  if (fillEl && typeof fillPct === "number") {
    fillEl.style.width = `${Math.min(100, Math.max(0, fillPct))}%`;
  }
  if (alarm !== undefined) cell.classList.toggle("alarm", alarm);
}


function fmtMB(mb: number): string {
  if (mb >= 1024) return `${(mb / 1024).toFixed(1)}G`;
  return `${Math.round(mb)}M`;
}

function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return `${n}`;
}

function updateTokenCells() {
  setCell("tokens-session", `${fmtTokens(tokensSession)} tok`);
  setCell("tokens-total", `${fmtTokens(tokensTotal)} tok`);
}
updateTokenCells();

async function pollSystemStats() {
  try {
    const res = await fetch(`${PIPER_BASE}/system-stats`, { signal: AbortSignal.timeout(1500) });
    if (!res.ok) throw new Error(String(res.status));
    const s = await res.json();

    setCell("cpu", `${s.cpu_percent.toFixed(0)}%`, s.cpu_percent, s.cpu_percent > 85);

    const memPct = s.mem_percent;
    setCell(
      "ram",
      `${(s.mem_used_bytes / 1_073_741_824).toFixed(1)}/${(s.mem_total_bytes / 1_073_741_824).toFixed(0)}G`,
      memPct,
      memPct > 90,
    );

    if (s.gpu) {
      setCell("gpu", `${s.gpu.util_pct.toFixed(0)}%`, s.gpu.util_pct, s.gpu.util_pct > 95);
      const vramPct = (s.gpu.mem_used_mb / s.gpu.mem_total_mb) * 100;
      setCell("vram", `${fmtMB(s.gpu.mem_used_mb)}/${fmtMB(s.gpu.mem_total_mb)}`, vramPct, vramPct > 92);
      setCell("temp", `${s.gpu.temp_c.toFixed(0)}°C`, undefined, s.gpu.temp_c > 82);
      if (s.gpu.power_w !== null && s.gpu.power_w !== undefined) {
        const pwr = s.gpu.power_w;
        const lim = s.gpu.power_limit_w || 0;
        setCell("power", lim ? `${pwr.toFixed(0)}/${lim.toFixed(0)}W` : `${pwr.toFixed(0)}W`);
      }

      // Drive the background fans from real metrics.
      // fan_pct comes from nvidia-smi when supported; on most laptops it's null,
      // so we fall back to a temp-derived proxy (hotter = faster).
      const tempProxy = Math.max(0, Math.min(100, ((s.gpu.temp_c - 35) / (90 - 35)) * 100));
      const realFan = s.gpu.fan_pct;
      const fanA = realFan != null ? realFan : Math.max(s.gpu.util_pct, tempProxy);
      const fanB = s.cpu_percent;                      // CPU side
      const fanC = realFan != null ? realFan : tempProxy;
      applyFanSpeeds(fanA, fanB, fanC, realFan != null);

      // Sync the circuit board to GPU usage:
      //   util 0%  -> calm, dim, slow node pulses
      //   util 100%-> bright, saturated, fast node pulses, blue throb intensifies
      applyBackgroundLoad(s.gpu.util_pct);
    } else {
      setCell("gpu", "n/a", 0);
      setCell("vram", "n/a", 0);
      setCell("temp", "n/a");
      setCell("power", "n/a");
      applyFanSpeeds(0, s.cpu_percent || 0, 0, false);
    }

    if (s.ollama && s.ollama.length > 0) {
      const m = s.ollama[0];
      const sizeG = m.size_vram ? (m.size_vram / 1_073_741_824).toFixed(1) : "—";
      setCell("loaded", `${m.name.split(":")[0]} · ${sizeG}G`);
    } else {
      setCell("loaded", "idle");
    }
  } catch {
    // Service down — show dashes, don't error-spam.
    setCell("cpu", "—");
    setCell("ram", "—");
    setCell("gpu", "—");
    setCell("vram", "—");
    setCell("temp", "—");
    setCell("power", "—");
    setCell("loaded", "tts server offline");
  }
}

// Map a 0-100 percentage to a CSS animation duration string.
// 0% → 30s (basically idle), 100% → 0.45s (raging).
function fanDurationForPct(pct: number): string {
  const p = Math.max(0, Math.min(100, pct)) / 100;
  // Smooth power curve so high-end is dramatically faster.
  const dur = 0.45 + 30 * Math.pow(1 - p, 1.6);
  return `${dur.toFixed(2)}s`;
}

// RPM "feel" — purely cosmetic. Roughly 0..3500 mapped to the same percentage.
function fanRpmForPct(pct: number): number {
  return Math.round(Math.max(0, Math.min(100, pct)) * 35);
}

// Smoothed GPU load — softens the change so the background doesn't jitter
// every poll cycle.
let _bgLoadSmoothed = 0;

function applyBackgroundLoad(utilPct: number) {
  // 1st-order low-pass: blend toward target.
  const target = Math.max(0, Math.min(100, utilPct));
  _bgLoadSmoothed = _bgLoadSmoothed * 0.7 + target * 0.3;
  const u = _bgLoadSmoothed / 100; // 0..1

  const root = document.documentElement.style;
  // Brightness: 0.85 idle (slightly dim) → 1.4 max load
  root.setProperty("--bg-bright", (0.85 + u * 0.55).toFixed(3));
  // Saturation: 0.9 idle → 1.7 max
  root.setProperty("--bg-sat", (0.9 + u * 0.8).toFixed(3));
  // Node pulse rate: 5s idle → 0.9s frantic
  root.setProperty("--bg-node-dur", `${(5 - u * 4.1).toFixed(2)}s`);
  // Blue throb opacity: 0.04 idle → 0.18 high load
  root.setProperty("--bg-throb", (0.04 + u * 0.14).toFixed(3));
}

function applyFanSpeeds(a: number, b: number, c: number, gpuFanIsReal: boolean) {
  document.documentElement.style.setProperty("--fan-1-dur", fanDurationForPct(a));
  document.documentElement.style.setProperty("--fan-2-dur", fanDurationForPct(b));
  document.documentElement.style.setProperty("--fan-3-dur", fanDurationForPct(c));

  const labels = [
    { sel: ".bg-circuit .fan-1 text", text: gpuFanIsReal ? `FAN A · ${fanRpmForPct(a)} RPM` : `GPU LOAD · ${a.toFixed(0)}%` },
    { sel: ".bg-circuit .fan-2 text", text: `CPU · ${b.toFixed(0)}%` },
    { sel: ".bg-circuit .fan-3 text", text: gpuFanIsReal ? `FAN C · ${fanRpmForPct(c)} RPM` : `GPU TEMP · ${c.toFixed(0)}` },
  ];
  for (const { sel, text } of labels) {
    const el = document.querySelector(sel) as SVGTextElement | null;
    if (el) el.textContent = text;
  }
}

setInterval(pollSystemStats, 1500);
pollSystemStats(); // first run immediately

// ---------------- Brain visualization ----------------

const SVG_NS = "http://www.w3.org/2000/svg";
const brainNodesGroup = document.querySelector(".brain-nodes") as SVGGElement | null;
const brainPulsesGroup = document.querySelector(".brain-pulses") as SVGGElement | null;
const brainStatNotes = document.getElementById("brain-stat-notes");
const brainStatWords = document.getElementById("brain-stat-words");
const brainStatActive = document.getElementById("brain-stat-active");

interface BrainNode {
  el: SVGCircleElement;
  docIndex: number;
  cx: number;
  cy: number;
}

let brainNodes: BrainNode[] = [];

const BRAIN_CX = 230;
const BRAIN_CY = 140;
const BRAIN_RINGS = [
  { r: 48,  cap: 8 },
  { r: 78,  cap: 14 },
  { r: 108, cap: 22 },
  { r: 132, cap: 28 },
];

function rebuildBrainNodes(noteCount: number) {
  if (!brainNodesGroup) return;
  brainNodesGroup.innerHTML = "";
  brainNodes = [];
  if (noteCount <= 0) return;

  const nodeBudget = Math.min(noteCount, BRAIN_RINGS.reduce((acc, r) => acc + r.cap, 0));
  let placed = 0;

  for (const ring of BRAIN_RINGS) {
    if (placed >= nodeBudget) break;
    // Spread the remaining budget proportionally across remaining rings.
    const remainingRings = BRAIN_RINGS.slice(BRAIN_RINGS.indexOf(ring));
    const remainingCap = remainingRings.reduce((acc, r) => acc + r.cap, 0);
    const wantHere = Math.min(
      ring.cap,
      Math.ceil(((nodeBudget - placed) / remainingCap) * ring.cap),
    );
    const onRing = Math.max(1, wantHere);
    const angleStep = (Math.PI * 2) / onRing;
    const phase = Math.random() * Math.PI * 2;
    for (let i = 0; i < onRing && placed < nodeBudget; i++) {
      const angle = phase + i * angleStep;
      const jitter = (Math.random() - 0.5) * 6;
      const cx = BRAIN_CX + Math.cos(angle) * (ring.r + jitter);
      const cy = BRAIN_CY + Math.sin(angle) * (ring.r + jitter);
      const c = document.createElementNS(SVG_NS, "circle");
      c.setAttribute("cx", String(cx));
      c.setAttribute("cy", String(cy));
      c.setAttribute("r", "2.5");
      c.classList.add("brain-node");
      brainNodesGroup.appendChild(c);
      brainNodes.push({ el: c, docIndex: placed, cx, cy });
      placed++;
    }
  }
}

function highlightBrainNodes(activeIndices: Set<number>) {
  for (const n of brainNodes) {
    if (activeIndices.has(n.docIndex)) n.el.classList.add("matched");
    else n.el.classList.remove("matched");
  }
  if (brainStatActive) brainStatActive.textContent = String(activeIndices.size);
}

function clearBrainHighlights() {
  for (const n of brainNodes) n.el.classList.remove("matched");
  if (brainStatActive) brainStatActive.textContent = "0";
}

// Periodically fire random nodes so the brain looks alive even when idle.
function fireRandomNode() {
  if (brainNodes.length === 0) return;
  const node = brainNodes[Math.floor(Math.random() * brainNodes.length)];
  node.el.classList.add("firing");
  setTimeout(() => node.el.classList.remove("firing"), 700);

  // Travelling pulse from core to that node.
  if (brainPulsesGroup && Math.random() < 0.55) {
    const pulse = document.createElementNS(SVG_NS, "circle");
    pulse.setAttribute("r", "2.5");
    pulse.setAttribute("cx", String(BRAIN_CX));
    pulse.setAttribute("cy", String(BRAIN_CY));
    pulse.classList.add("brain-pulse");
    brainPulsesGroup.appendChild(pulse);
    // Animate via Web Animations API for smooth transform.
    pulse.animate(
      [
        { cx: String(BRAIN_CX), cy: String(BRAIN_CY), opacity: 1 },
        { cx: String(node.cx), cy: String(node.cy), opacity: 0 },
      ] as any,
      { duration: 700, easing: "cubic-bezier(0.4, 0, 0.2, 1)" },
    ).onfinish = () => pulse.remove();
  }
}

let brainPulseTimer: number | undefined;
let brainPulseInterval = 480;

function startBrainPulse() {
  clearInterval(brainPulseTimer);
  brainPulseTimer = window.setInterval(fireRandomNode, brainPulseInterval);
}

function setBrainActivity(generating: boolean) {
  brainPulseInterval = generating ? 130 : 480;
  startBrainPulse();
}

// Wire activity to the global busy state.
const observer = new MutationObserver(() => {
  const busy = document.querySelector("header")?.classList.contains("busy");
  setBrainActivity(!!busy);
});
const headerEl = document.querySelector("header");
if (headerEl) observer.observe(headerEl, { attributes: true, attributeFilter: ["class"] });

startBrainPulse();

// Update stats and node graph after vault index is built.
function refreshBrainViz() {
  if (!vaultIndex) {
    if (brainStatNotes) brainStatNotes.textContent = "0";
    if (brainStatWords) brainStatWords.textContent = "0";
    rebuildBrainNodes(0);
    return;
  }
  const totalWords = vaultIndex.reduce(
    (acc, doc) => acc + (doc.content.match(/\S+/g)?.length || 0),
    0,
  );
  if (brainStatNotes) brainStatNotes.textContent = String(vaultIndex.length);
  if (brainStatWords) brainStatWords.textContent = totalWords > 999 ? `${(totalWords / 1000).toFixed(1)}k` : String(totalWords);
  rebuildBrainNodes(vaultIndex.length);
}

function highlightFromHits(hits: SearchHit[]) {
  if (!vaultIndex) return;
  const matchedPaths = new Set(hits.map(h => h.doc.path));
  const indices = new Set<number>();
  for (let i = 0; i < vaultIndex.length; i++) {
    if (matchedPaths.has(vaultIndex[i].path)) indices.add(i);
  }
  highlightBrainNodes(indices);
}

// Reset highlights when search is cleared.
brainSearch?.addEventListener("input", () => {
  if (!brainSearch.value.trim()) clearBrainHighlights();
});

// ---------------- Init ----------------

ensureModelsLoaded();
if (vaultPath) indexVault().then(refreshBrainViz).catch(() => {});
