// Chat model picker — populates from Ollama and (optionally) NVIDIA. Each
// <option> is tagged with data-backend so the chat send loop can route
// without re-querying.

import {
  readEnvSnapshot,
  listNvidiaModels,
  type EnvSnapshot,
  type NvidiaModel,
} from "../backends/nvidia";
import type { BackendId } from "../types";
import { OLLAMA_BASE } from "../types";
import { addSystem } from "./messages";

const STORAGE_MODEL = "jarvis.model";

const modelPicker = document.getElementById("model-picker") as HTMLSelectElement;

let modelsLoaded = false;

export function getModelPicker(): HTMLSelectElement {
  return modelPicker;
}

export function backendOf(option: HTMLOptionElement | undefined): BackendId {
  return (option?.dataset.backend as BackendId) || "ollama";
}

export function selectedBackend(): BackendId {
  return backendOf(modelPicker.options[modelPicker.selectedIndex] as HTMLOptionElement | undefined);
}

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

  const remembered = localStorage.getItem(STORAGE_MODEL);
  if (remembered) {
    const all = Array.from(modelPicker.querySelectorAll("option")) as HTMLOptionElement[];
    if (all.some(o => o.value === remembered)) {
      modelPicker.value = remembered;
    }
  }
}

export async function loadModels(silent = false): Promise<boolean> {
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
export async function ensureModelsLoaded() {
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
