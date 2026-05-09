// Workspace tab — file tree on the left, CodeMirror on the right. Lazy-loads
// child entries when a directory is expanded so opening a giant tree doesn't
// stall the UI.

import { readDir, readTextFile, writeTextFile } from "@tauri-apps/plugin-fs";
import { open as openDialog } from "@tauri-apps/plugin-dialog";

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

import { addSystem } from "../chat/messages";

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
const wsTreeNodes: Map<string, HTMLElement> = new Map();

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

let editorView: EditorView | null = null;
const languageCompartment = new Compartment();

function ensureEditor(): EditorView {
  if (editorView) return editorView;
  wsEditorContainer.innerHTML = "";
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
    document.querySelectorAll(".ws-tree-row.active").forEach(el => el.classList.remove("active"));
    wsTreeNodes.get(path)?.querySelector(".ws-tree-row")?.classList.add("active");
    localStorage.setItem(STORAGE_WS_FILE, path);
  } catch (e: any) {
    addSystem(`Could not open ${path}: ${e.message}`);
  }
}

if (wsFolder) {
  renderWsTree().then(() => {
    const lastFile = localStorage.getItem(STORAGE_WS_FILE);
    if (lastFile) openFileInEditor(lastFile).catch(() => {});
  }).catch(() => {});
}
