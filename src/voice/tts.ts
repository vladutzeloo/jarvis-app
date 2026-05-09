// Text-to-speech: prefer Piper (cinematic local voice via the WSL server)
// then fall back to the browser's Web Speech API. The Piper path hands the
// audio to the call UX rather than playing it directly.

import { PIPER_BASE } from "../types";
import { showIncomingCall, endCall, isCallActive, getCurrentCallAudio } from "./call";

const STORAGE_VOICE = "jarvis.voice";
const STORAGE_VOICE_ENABLED = "jarvis.voice.enabled";
const STORAGE_TTS_STYLE = "jarvis.tts.style";

const synth = window.speechSynthesis;
const voiceToggleBtn = document.getElementById("voice-toggle") as HTMLButtonElement;
const voicePicker = document.getElementById("voice-picker") as HTMLSelectElement;
const stopSpeakingBtn = document.getElementById("stop-speaking") as HTMLButtonElement;
const ttsStylePicker = document.getElementById("tts-style") as HTMLSelectElement | null;
const ttsEngineLabel = document.getElementById("tts-engine") as HTMLElement;

let availableVoices: SpeechSynthesisVoice[] = [];
let voiceEnabled = localStorage.getItem(STORAGE_VOICE_ENABLED) !== "false";
let piperAvailable: boolean | null = null;
let webSpeechAudio: { active: boolean } = { active: false };

export function getVoiceEnabled(): boolean {
  return voiceEnabled;
}

export function cancelSpeech() {
  synth.cancel();
  if (isCallActive()) {
    endCall();
    return;
  }
  const audio = getCurrentCallAudio();
  if (audio) audio.pause();
  stopSpeakingBtn.classList.add("hidden");
}

function rankJarvisVoice(v: SpeechSynthesisVoice): number {
  // Higher = better fit for JARVIS-style butler voice.
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

stopSpeakingBtn.addEventListener("click", cancelSpeech);

if (ttsStylePicker) {
  const remembered = localStorage.getItem(STORAGE_TTS_STYLE);
  if (remembered) ttsStylePicker.value = remembered;
  ttsStylePicker.addEventListener("change", () => {
    localStorage.setItem(STORAGE_TTS_STYLE, ttsStylePicker.value);
  });
}

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
  // Cache positive results for the session; re-check on miss so we pick up
  // Piper as soon as the service becomes reachable.
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

checkPiper();

export function cleanForSpeech(text: string): string {
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
    showIncomingCall(url);
    return true;
  } catch {
    return false;
  }
}

function speakViaWebSpeech(text: string) {
  synth.cancel();
  const utterance = new SpeechSynthesisUtterance(text);
  const selected = availableVoices.find(v => v.name === voicePicker.value);
  if (selected) utterance.voice = selected;
  utterance.rate = 1.0;
  utterance.pitch = 0.95;
  utterance.volume = 1.0;
  utterance.onstart = () => {
    webSpeechAudio.active = true;
    stopSpeakingBtn.classList.remove("hidden");
  };
  utterance.onend = () => {
    webSpeechAudio.active = false;
    stopSpeakingBtn.classList.add("hidden");
  };
  utterance.onerror = () => {
    webSpeechAudio.active = false;
    stopSpeakingBtn.classList.add("hidden");
  };
  synth.speak(utterance);
}

export async function speak(text: string) {
  if (!voiceEnabled) return;
  const clean = cleanForSpeech(text);
  if (!clean) return;

  synth.cancel();
  const existingAudio = getCurrentCallAudio();
  if (existingAudio) existingAudio.pause();

  if (await checkPiper()) {
    const ok = await speakViaPiper(clean);
    if (ok) return;
    piperAvailable = false; // mark down for this session
  }
  speakViaWebSpeech(clean);
}

export function cancelSynthOnly() {
  synth.cancel();
}
