// JARVIS — Librarian NPC.
//
// One pawn on the holodeck ring, plus a small console at the bottom-left of
// the World tab. The librarian is the in-app caretaker of the Obsidian
// "brain" (the user's local markdown vault): click them, ask a question, and
// the agent answers using only what's actually in the vault.
//
// Pipeline:
//   user question → searchVault() → top-K markdown excerpts → NVIDIA
//   chat completion (key stays in Rust) → streaming answer in the dock.
//
// The librarian visually appears on the map "reading" — its NPC group is
// decorated post-creation with a small open book mesh (gold spine + glowing
// pages) so the pawn isn't just another generic body.
//
// Implementation notes:
//   - We deliberately bypass the chat tab's selected backend. The user said
//     "running on nvidia api key" and the librarian is its own agent — it
//     should never silently fall back to Ollama.
//   - We reuse the existing brain index (src/brain/brain.ts) instead of
//     building a parallel walker. If the brain hasn't been indexed yet we
//     trigger indexVault() from the dock so the user doesn't have to visit
//     the Brain tab first.

import * as THREE from "three";
import { sfx } from "./sfx";
import type { NPC, NPCConfig } from "./npcs";
import { nvidiaChatStream, readEnvSnapshot } from "../backends/nvidia";
import { getVaultIndex, getVaultPath, indexVault, searchVault } from "../brain/brain";

const LIBRARIAN_ID = "librarian";
const LIBRARIAN_GOLD = 0xfdb462;

// Fallback model if the user hasn't set NVIDIA_DEFAULT_MODEL. Matches
// `.env.example`. We still prefer the env value when present so users can
// swap models without editing code.
const FALLBACK_MODEL = "meta/llama-3.1-70b-instruct";

const SYSTEM_PROMPT = `You are the Librarian, a quiet AI agent inside a personal "Obsidian brain" — a vault of markdown notes the user has written about themselves, their projects, and their ideas. You are not a general assistant. You are the custodian of these notes.

Rules:
- Ground every answer in the supplied note excerpts. Cite the note path in parentheses when useful.
- If the excerpts do not cover the question, say so plainly. Do not invent facts about the user, their projects, or their preferences.
- Keep replies short — 1 to 4 sentences unless the user asks for more.
- Speak calmly, in the manner of a librarian who has read every note.`;

// ─── Reactive state + dock ────────────────────────────────────────────────

interface LibrarianState {
  status: string;
  answer: string;
  isThinking: boolean;
  error: string | null;
  noteCount: number;
}

const state: LibrarianState = {
  status: "READY",
  answer: "",
  isThinking: false,
  error: null,
  noteCount: 0,
};

const listeners: Array<() => void> = [];
function notify() { for (const fn of listeners) fn(); }
function subscribe(fn: () => void): () => void {
  listeners.push(fn);
  return () => { const i = listeners.indexOf(fn); if (i >= 0) listeners.splice(i, 1); };
}

let dockOpen = false;
let dockUnsub: (() => void) | null = null;
const dockRoot = (): HTMLElement | null => document.getElementById("librarian-dock");

const PLACEHOLDER = "Ask the librarian anything about your vault. They only speak from your notes.";

function buildDock(): void {
  const root = dockRoot();
  if (!root) return;
  root.innerHTML = `
    <div class="librarian-dock-card">
      <div class="librarian-dock-header">
        <div class="librarian-dock-title">LIBRARIAN · OBSIDIAN BRAIN</div>
        <button class="librarian-dock-close" type="button" data-lib-close title="Close" aria-label="Close librarian">×</button>
      </div>
      <div class="librarian-dock-status" data-lib-status>READY</div>
      <div class="librarian-dock-answer" data-lib-answer></div>
      <form class="librarian-dock-form" data-lib-form autocomplete="off">
        <input type="text" data-lib-input placeholder="What does my vault say about…" spellcheck="false" />
        <button type="submit" data-lib-ask title="Ask" aria-label="Ask librarian">→</button>
      </form>
      <div class="librarian-dock-hint">via NVIDIA · grounded in your local Obsidian vault</div>
    </div>
  `;

  const closeBtn = root.querySelector<HTMLButtonElement>("[data-lib-close]");
  const form     = root.querySelector<HTMLFormElement>("[data-lib-form]");
  const input    = root.querySelector<HTMLInputElement>("[data-lib-input]");

  closeBtn?.addEventListener("click", () => closeDock());
  form?.addEventListener("submit", (e) => {
    e.preventDefault();
    const q = input?.value.trim();
    if (!q || state.isThinking) return;
    void ask(q);
  });
}

function refreshDock(): void {
  const root = dockRoot();
  if (!root || !dockOpen) return;
  const statusEl = root.querySelector<HTMLElement>("[data-lib-status]");
  const answerEl = root.querySelector<HTMLElement>("[data-lib-answer]");
  const askBtn   = root.querySelector<HTMLButtonElement>("[data-lib-ask]");
  if (statusEl) {
    statusEl.textContent = state.error ? `ERROR · ${state.error}` : state.status;
    statusEl.classList.toggle("error", !!state.error);
    statusEl.classList.toggle("thinking", state.isThinking);
  }
  // While streaming, the delta loop writes directly to answerEl so we don't
  // overwrite each token here. Only refresh idle states from canonical state.
  if (answerEl && !state.isThinking) {
    answerEl.textContent = state.answer || PLACEHOLDER;
    answerEl.classList.toggle("placeholder", !state.answer);
  }
  if (askBtn) askBtn.disabled = state.isThinking;
}

async function ensureIndex(): Promise<boolean> {
  const path = getVaultPath();
  if (!path) {
    state.error = "no vault configured — open the Brain tab and set a vault path";
    return false;
  }
  if (!getVaultIndex()) {
    state.status = "INDEXING VAULT…";
    notify();
    try {
      await indexVault();
    } catch (e: unknown) {
      state.error = `index failed: ${(e as Error)?.message || String(e)}`;
      return false;
    }
  }
  const idx = getVaultIndex();
  state.noteCount = idx?.length ?? 0;
  return !!idx;
}

function buildContext(query: string): string {
  // Take the top hits and clip each excerpt so the prompt stays bounded.
  const hits = searchVault(query).slice(0, 6);
  if (hits.length === 0) return "(no matching notes found in vault)";
  return hits
    .map(h => `--- ${h.doc.rel} ---\n${h.snippet}`)
    .join("\n\n");
}

async function ask(question: string): Promise<void> {
  state.answer = "";
  state.error = null;
  state.isThinking = true;
  state.status = "READING NOTES…";
  notify();

  // Resolve which NVIDIA model to use. The env snapshot lives in Rust; the
  // key itself never reaches this JS context — we only learn whether one is
  // configured.
  let model = FALLBACK_MODEL;
  try {
    const env = await readEnvSnapshot();
    if (!env.has_nvidia_key) {
      state.error = "no NVIDIA_API_KEY in .env — add one in Settings";
      state.isThinking = false;
      state.status = "FAILED";
      notify();
      return;
    }
    if (env.nvidia_default_model) model = env.nvidia_default_model;
  } catch (e: unknown) {
    state.error = `env error: ${(e as Error)?.message || String(e)}`;
    state.isThinking = false;
    state.status = "FAILED";
    notify();
    return;
  }

  if (!(await ensureIndex())) {
    state.isThinking = false;
    state.status = "FAILED";
    notify();
    return;
  }

  const ctx = buildContext(question);
  const userPrompt = `Vault excerpts:\n\n${ctx}\n\nQuestion: ${question}`;

  state.status = "THINKING…";
  notify();

  // Stream tokens straight into the answer pane so the dock feels alive.
  const root = dockRoot();
  const answerEl = root?.querySelector<HTMLElement>("[data-lib-answer]");
  if (answerEl) {
    answerEl.classList.remove("placeholder");
    answerEl.textContent = "";
  }

  try {
    await nvidiaChatStream(
      {
        model,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: userPrompt },
        ],
        temperature: 0.3,
      },
      (delta) => {
        state.answer += delta;
        if (answerEl) answerEl.textContent = state.answer;
      },
      (err) => {
        state.error = err;
      },
    );
    state.status = `ANSWERED · ${state.noteCount} notes indexed`;
  } catch (e: unknown) {
    if (!state.error) state.error = (e as Error)?.message || String(e);
    state.status = "FAILED";
  } finally {
    state.isThinking = false;
    notify();
  }
}

function openDock(): void {
  const root = dockRoot();
  if (!root) return;
  if (!dockOpen) {
    buildDock();
    dockOpen = true;
    root.classList.remove("hidden");
    dockUnsub = subscribe(refreshDock);
  }
  refreshDock();
  // Warm the index in the background so the first question is fast.
  void ensureIndex().then(() => {
    if (state.error || state.isThinking) return;
    state.status = state.noteCount > 0
      ? `READY · ${state.noteCount} notes indexed`
      : "READY";
    notify();
  });
  root.querySelector<HTMLInputElement>("[data-lib-input]")?.focus();
}

function closeDock(): void {
  const root = dockRoot();
  if (root) root.classList.add("hidden");
  dockOpen = false;
  if (dockUnsub) { dockUnsub(); dockUnsub = null; }
}

// ─── Visual: open book floating in the librarian's hands. ────────────────
//
// createNPCs builds every pawn from the same shared geometry, so the
// librarian gets a generic body. We decorate it post-creation by adding a
// small open book as a child of its group — that way it tracks the body's
// idle bob "for free" via Three's scene graph, and the existing label /
// hover / flash effects all keep working.

interface BookHandle {
  group: THREE.Group;
  pages: THREE.Mesh;
  baseY: number;
  geom: THREE.BufferGeometry[];
  mats: THREE.Material[];
}
let book: BookHandle | null = null;

function buildBook(npc: NPC): void {
  const coverGeom = new THREE.BoxGeometry(0.34, 0.04, 0.24);
  const coverMat = new THREE.MeshStandardMaterial({
    color: 0x6b3e1f,
    metalness: 0.1,
    roughness: 0.8,
    emissive: LIBRARIAN_GOLD,
    emissiveIntensity: 0.08,
  });
  const cover = new THREE.Mesh(coverGeom, coverMat);

  const pageGeom = new THREE.BoxGeometry(0.32, 0.02, 0.22);
  const pageMat = new THREE.MeshStandardMaterial({
    color: 0xf8f1de,
    emissive: 0xfffbe8,
    emissiveIntensity: 0.35,
    metalness: 0.0,
    roughness: 0.95,
  });
  const pages = new THREE.Mesh(pageGeom, pageMat);
  pages.position.y = 0.03;

  const spineGeom = new THREE.BoxGeometry(0.04, 0.06, 0.24);
  const spineMat = new THREE.MeshStandardMaterial({
    color: LIBRARIAN_GOLD,
    metalness: 0.6,
    roughness: 0.3,
    emissive: LIBRARIAN_GOLD,
    emissiveIntensity: 0.4,
  });
  const spine = new THREE.Mesh(spineGeom, spineMat);

  const group = new THREE.Group();
  group.add(cover, pages, spine);
  // Hold the book in front of the chest, tilted up like an open volume the
  // librarian is looking down into.
  group.position.set(0, 0.18, 0.32);
  group.rotation.x = -0.7;
  npc.group.add(group);

  book = {
    group,
    pages,
    baseY: 0.18,
    geom: [coverGeom, pageGeom, spineGeom],
    mats: [coverMat, pageMat, spineMat],
  };
}

function stepBook(_dt: number): void {
  if (!book) return;
  // Page-glow pulse + a faint hover so the book reads as actively-being-read,
  // not a static prop. Independent of the body's bob (which is applied to
  // the parent group by createNPCs.step).
  const t = performance.now() * 0.001;
  const pulse = 0.30 + (Math.sin(t * 1.6) * 0.5 + 0.5) * 0.25;
  (book.pages.material as THREE.MeshStandardMaterial).emissiveIntensity = pulse;
  book.group.position.y = book.baseY + Math.sin(t * 1.1) * 0.015;
}

// ─── Public handle ───────────────────────────────────────────────────────

export interface LibrarianHandle {
  npcConfig: NPCConfig;
  /** Call after createNPCs so the book mesh can be parented to the pawn. */
  attachVisual: (npcs: NPC[]) => void;
  step: (dt: number) => void;
  open: () => void;
  close: () => void;
  dispose: () => void;
}

export function initLibrarian(): LibrarianHandle {
  const npcConfig: NPCConfig = {
    id: LIBRARIAN_ID,
    name: "Librarian",
    tag: "OBSIDIAN BRAIN",
    color: LIBRARIAN_GOLD,
    onClick: () => {
      sfx.click();
      openDock();
    },
  };

  function attachVisual(npcs: NPC[]): void {
    const npc = npcs.find(n => n.cfg.id === LIBRARIAN_ID);
    if (!npc) return;
    buildBook(npc);
  }

  function dispose(): void {
    closeDock();
    if (book) {
      book.group.parent?.remove(book.group);
      for (const g of book.geom) g.dispose();
      for (const m of book.mats) m.dispose();
      book = null;
    }
  }

  return {
    npcConfig,
    attachVisual,
    step: stepBook,
    open: openDock,
    close: closeDock,
    dispose,
  };
}
