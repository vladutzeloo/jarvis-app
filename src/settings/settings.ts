// Settings drawer — sliders, presets, system prompt textarea, and the
// integrations panel that writes NVIDIA credentials to .env via Rust. The
// drawer's `getSettings()` and prompt builders are consumed by the chat
// send loop.

import {
  readEnvSnapshot,
  writeEnvValue,
  listNvidiaModels,
} from "../backends/nvidia";
import type { JarvisSettings, Message } from "../types";
import { loadSystemPrompt } from "../vault";
import { loadModels } from "../chat/models";
import {
  isWowEnabled,
  setWowEnabled,
  getWowVolume,
  setWowVolume,
  getWowRace,
  setWowRace,
  rerollWowRace,
  previewWowRace,
  WOW_RACES,
} from "../world/wow";

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
    refreshNvidiaSettingsUI();
  }
});
drawerClose.addEventListener("click", () => {
  drawer.classList.add("hidden");
  drawerToggle.classList.remove("active");
});

applySettingsToUI();

// ─── Integrations · NVIDIA ─────────────────────────────────────────────

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
    // Don't echo the key back into the input; treat it as write-only.
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
    await loadModels(true);
  } catch (e: any) {
    setNvidiaMsg(`${e?.message || e}`, "err");
  }
}

nvidiaSaveBtn?.addEventListener("click", saveNvidiaSettings);
nvidiaTestBtn?.addEventListener("click", testNvidiaConnection);

refreshNvidiaSettingsUI();

// ─── WOW mode ──────────────────────────────────────────────────────────

const wowEnabledEl = document.getElementById("settings-wow-enabled") as HTMLInputElement | null;
const wowVolumeEl  = document.getElementById("settings-wow-volume") as HTMLInputElement | null;
const wowVolumeVal = document.getElementById("settings-wow-volume-value") as HTMLElement | null;
const wowTestBtn   = document.getElementById("settings-wow-test") as HTMLButtonElement | null;
const wowRerollBtn = document.getElementById("settings-wow-reroll") as HTMLButtonElement | null;
const wowRaceBtns  = document.querySelectorAll<HTMLButtonElement>(".wow-race-btn");

function refreshWowRaceUI(): void {
  const r = getWowRace();
  wowRaceBtns.forEach(b => b.classList.toggle("active", b.dataset.race === r));
}

function refreshWowUI(): void {
  if (wowEnabledEl) wowEnabledEl.checked = isWowEnabled();
  const vol = getWowVolume();
  if (wowVolumeEl)  wowVolumeEl.value = String(vol);
  if (wowVolumeVal) wowVolumeVal.textContent = `${Math.round(vol * 100)}%`;
  refreshWowRaceUI();
}

wowEnabledEl?.addEventListener("change", () => {
  setWowEnabled(wowEnabledEl.checked);
});

wowVolumeEl?.addEventListener("input", () => {
  const v = Number(wowVolumeEl.value);
  setWowVolume(v);
  if (wowVolumeVal) wowVolumeVal.textContent = `${Math.round(v * 100)}%`;
});

wowTestBtn?.addEventListener("click", () => {
  previewWowRace();
});

wowRerollBtn?.addEventListener("click", () => {
  rerollWowRace();
  refreshWowRaceUI();
  previewWowRace();
});

wowRaceBtns.forEach(btn => {
  btn.addEventListener("click", () => {
    const r = btn.dataset.race;
    if (!r || !(WOW_RACES as readonly string[]).includes(r)) return;
    setWowRace(r as typeof WOW_RACES[number]);
    refreshWowRaceUI();
    previewWowRace();
  });
});

refreshWowUI();

// ─── Public API for the chat send loop ─────────────────────────────────

export function getSettings(): JarvisSettings {
  return settings;
}

export function buildOllamaOptions(): Record<string, number> {
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

// Vault-derived identity prompt, loaded once per session. The promise is
// kicked off at startup so the first chat send doesn't pay the disk read.
let vaultSystemPrompt: string | null = null;
export const vaultSystemPromptReady: Promise<void> = loadSystemPrompt()
  .then((p) => {
    vaultSystemPrompt = p;
  })
  .catch(() => {
    vaultSystemPrompt = null;
  });

export function buildMessages(history: Message[]): { role: string; content: string }[] {
  const msgs: { role: string; content: string }[] = [];
  if (vaultSystemPrompt && vaultSystemPrompt.trim()) {
    msgs.push({ role: "system", content: vaultSystemPrompt });
  }
  if (settings.systemPrompt && settings.systemPrompt.trim()) {
    msgs.push({ role: "system", content: settings.systemPrompt });
  }
  for (const m of history) msgs.push({ role: m.role, content: m.content });
  return msgs;
}
