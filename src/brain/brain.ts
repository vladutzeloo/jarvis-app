// Brain: Obsidian-vault search. Walks the configured directory for markdown
// files, indexes them in memory, and serves substring search hits with
// surrounding context.

import { readDir, readTextFile, exists } from "@tauri-apps/plugin-fs";
import type { IndexedDoc, SearchHit } from "../types";

const STORAGE_VAULT = "jarvis.vault.path";

const brainSearch = document.getElementById("brain-search") as HTMLInputElement;
const brainSettings = document.getElementById("brain-settings") as HTMLButtonElement;
const brainStatus = document.getElementById("brain-status") as HTMLElement;
const brainResults = document.getElementById("brain-results") as HTMLElement;
const chatInput = document.getElementById("input") as HTMLTextAreaElement;

// No baked-in default — first launch shows the "no vault configured" prompt
// and the user picks their path via the ⚙ button. The own-jarvis repo
// (https://github.com/vladutzeloo/own-jarvis) is the intended target on the
// author's machine but isn't a sensible default for anyone else.
let vaultPath = localStorage.getItem(STORAGE_VAULT) || "";
let vaultIndex: IndexedDoc[] | null = null;
let indexingInFlight: Promise<void> | null = null;
let lastIndexedPath = "";

// Hooks the viz modules wire up so search hits update each surface (SVG + 3D).
const indexReadyHooks: Array<() => void> = [];
const searchHitsHooks: Array<(hits: SearchHit[]) => void> = [];
const clearHighlightsHooks: Array<() => void> = [];

export function setVizHooks(hooks: {
  onIndexReady?: () => void;
  onSearchHits?: (hits: SearchHit[]) => void;
  onClearHighlights?: () => void;
}) {
  if (hooks.onIndexReady) indexReadyHooks.push(hooks.onIndexReady);
  if (hooks.onSearchHits) searchHitsHooks.push(hooks.onSearchHits);
  if (hooks.onClearHighlights) clearHighlightsHooks.push(hooks.onClearHighlights);
}

const onIndexReady = () => indexReadyHooks.forEach(h => h());
const onSearchHits = (hits: SearchHit[]) => searchHitsHooks.forEach(h => h(hits));
const onClearHighlights = () => clearHighlightsHooks.forEach(h => h());

export function getVaultPath(): string {
  return vaultPath;
}

export function getVaultIndex(): IndexedDoc[] | null {
  return vaultIndex;
}

function setBrainStatus(text: string) {
  brainStatus.textContent = text;
}

export function refreshBrainStatus() {
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

brainSettings?.addEventListener("click", () => {
  const next = prompt(
    "Path to your Obsidian vault (we'll search markdown files here):",
    vaultPath,
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

export async function indexVault(): Promise<void> {
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
    onIndexReady?.();
  } catch (e: any) {
    setBrainStatus(`Index failed: ${e.message}`);
    vaultIndex = null;
  } finally {
    indexingInFlight = null;
  }
}

export function searchVault(query: string): SearchHit[] {
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
        document.createTextNode(hit.snippet.slice(matchIdx + query.length)),
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
  chatInput.value = `Using this note as context, answer my question.\n\n--- ${doc.rel} ---\n${doc.content}\n--- end note ---\n\nQuestion: ${originalQuery}`;
  chatInput.dispatchEvent(new Event("input"));
  chatInput.focus();
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
      onClearHighlights?.();
      return;
    }
    const hits = searchVault(query);
    renderHits(hits, query);
    onSearchHits?.(hits);
  }, 200);
});

brainSearch?.addEventListener("input", () => {
  if (!brainSearch.value.trim()) onClearHighlights?.();
});

refreshBrainStatus();
