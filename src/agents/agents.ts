// Agents tab — drives the ruflo runner.
//
// All four ruflo Tauri commands are wired here:
//   - `ruflo_health`  for the status pill at the top of the tab
//   - `ruflo_run`     to start a job and stream stdout/stderr
//   - `ruflo_cancel`  for the cancel button
// Plus a small set of preset templates that fill the argv field.
//
// We deliberately keep argv as a free-form textarea (with shell-like quoting)
// rather than a structured form because ruflo's CLI surface is wide and we
// don't want to block features by enumerating every subcommand.

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

interface Preset {
  label: string;
  hint: string;
  argv: string;
}

const PRESETS: Preset[] = [
  {
    label: "Probe version",
    hint: "Confirm ruflo can be fetched and starts up.",
    argv: "--version",
  },
  {
    label: "Init wizard",
    hint: "Interactive setup. Note: runs non-interactively under the bridge.",
    argv: "init wizard",
  },
  {
    label: "List agents",
    hint: "Print the agent catalog (subcommand may vary; edit if needed).",
    argv: "agent list",
  },
  {
    label: "MCP start",
    hint: "Run ruflo as a stdio MCP server (long-running; cancel to stop).",
    argv: "mcp start",
  },
  {
    label: "Help",
    hint: "Top-level help text for whichever ruflo version was fetched.",
    argv: "--help",
  },
];

const STORAGE_ARGV = "jarvis.agents.argv";

const statusEl = document.getElementById("agents-status") as HTMLElement;
const statusText = statusEl.querySelector(".agents-status-text") as HTMLElement;
const versionEl = document.getElementById("agents-version") as HTMLElement;
const presetsEl = document.getElementById("agents-presets") as HTMLUListElement;
const formEl = document.getElementById("agents-form") as HTMLFormElement;
const argvEl = document.getElementById("agents-argv") as HTMLTextAreaElement;
const runBtn = document.getElementById("agents-run") as HTMLButtonElement;
const cancelBtn = document.getElementById("agents-cancel") as HTMLButtonElement;
const clearBtn = document.getElementById("agents-clear-console") as HTMLButtonElement;
const consoleEl = document.getElementById("agents-console") as HTMLPreElement;
const jobIdEl = document.getElementById("agents-job-id") as HTMLElement;

// ─── argv parsing ──────────────────────────────────────────────────────────
// Tiny shell-like splitter: whitespace-separated, with single/double quoting
// and \\-escaping. Does NOT do globs, env-var expansion, or backticks — we
// don't want any of those reaching the bridge.
function parseArgv(input: string): string[] {
  const out: string[] = [];
  let current = "";
  let quote: "'" | '"' | null = null;
  let inToken = false;
  for (let i = 0; i < input.length; i++) {
    const c = input[i];
    if (c === "\\" && i + 1 < input.length) {
      current += input[++i];
      inToken = true;
      continue;
    }
    if (quote) {
      if (c === quote) {
        quote = null;
        // closing quote ends the token even if next char is whitespace
      } else {
        current += c;
      }
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      inToken = true;
      continue;
    }
    if (/\s/.test(c)) {
      if (inToken) {
        out.push(current);
        current = "";
        inToken = false;
      }
      continue;
    }
    current += c;
    inToken = true;
  }
  if (inToken) out.push(current);
  return out;
}

// ─── console output ────────────────────────────────────────────────────────

function appendLine(kind: "stdout" | "stderr" | "system" | "error", line: string) {
  const span = document.createElement("span");
  span.className = `agents-line agents-line-${kind}`;
  span.textContent = line;
  consoleEl.appendChild(span);
  consoleEl.appendChild(document.createTextNode("\n"));
  // Auto-scroll only if the user is already at the bottom (so reading older
  // output isn't yanked away mid-scroll).
  const slack = consoleEl.scrollHeight - consoleEl.clientHeight - consoleEl.scrollTop;
  if (slack < 60) consoleEl.scrollTop = consoleEl.scrollHeight;
}

clearBtn.addEventListener("click", () => {
  consoleEl.replaceChildren();
});

// ─── presets ───────────────────────────────────────────────────────────────

for (const p of PRESETS) {
  const li = document.createElement("li");
  li.className = "agents-preset";
  li.tabIndex = 0;
  li.title = p.hint;
  const head = document.createElement("div");
  head.className = "agents-preset-label";
  head.textContent = p.label;
  const argv = document.createElement("code");
  argv.className = "agents-preset-argv";
  argv.textContent = p.argv;
  li.appendChild(head);
  li.appendChild(argv);
  const apply = () => {
    argvEl.value = p.argv;
    argvEl.focus();
    argvEl.setSelectionRange(p.argv.length, p.argv.length);
  };
  li.addEventListener("click", apply);
  li.addEventListener("keydown", e => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      apply();
    }
  });
  presetsEl.appendChild(li);
}

// ─── argv persistence ──────────────────────────────────────────────────────

argvEl.value = localStorage.getItem(STORAGE_ARGV) || "--version";
argvEl.addEventListener("input", () => {
  localStorage.setItem(STORAGE_ARGV, argvEl.value);
});

// ─── health probe ──────────────────────────────────────────────────────────

interface RufloHealth {
  ok: boolean;
  node?: string | null;
  npx?: string | null;
  node_bin_dir?: string | null;
  max_jobs?: number;
  error?: string;
}

function setStatus(state: "online" | "offline" | "degraded" | "probing", text: string) {
  statusEl.dataset.state = state;
  statusText.textContent = text;
}

async function refreshHealth() {
  try {
    const h = await invoke<RufloHealth>("ruflo_health");
    if (h.ok && h.npx) {
      setStatus("online", "bridge online");
      versionEl.textContent = h.npx ? `npx: ${h.npx.split("/").pop()}` : "";
    } else {
      setStatus("degraded", "bridge up · npx missing");
      versionEl.textContent = h.error || "install Node.js >=18 in WSL";
    }
  } catch (e: any) {
    setStatus("offline", "bridge offline");
    versionEl.textContent = "run scripts/jarvis-server.sh --ruflo";
    void e;
  }
}

setStatus("probing", "probing…");
refreshHealth();
// Re-probe periodically so the badge reflects the bridge restarting.
setInterval(refreshHealth, 8000);

// ─── run lifecycle ─────────────────────────────────────────────────────────

let activeJobId: string | null = null;
let activeUnlisten: (() => void) | null = null;

function setRunning(jobId: string | null) {
  activeJobId = jobId;
  const running = jobId !== null;
  runBtn.disabled = running;
  cancelBtn.disabled = !running;
  argvEl.disabled = running;
  jobIdEl.textContent = running ? `job ${jobId}` : "";
}

formEl.addEventListener("submit", async e => {
  e.preventDefault();
  if (activeJobId) return;

  const argv = parseArgv(argvEl.value.trim());
  if (argv.length === 0) {
    appendLine("error", "no argv — type a ruflo subcommand first.");
    return;
  }

  appendLine("system", `$ npx -y ruflo@latest ${argv.map(quoteForDisplay).join(" ")}`);
  // Pre-mark running with a placeholder so the form is locked while we wait
  // for the bridge to confirm a real job id via the `started` event.
  setRunning("…");

  const eventName = `ruflo_stream_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  const unlisten = await listen<any>(eventName, evt => {
    const p = evt.payload || {};
    if (p.type === "started") {
      // Bridge returned a real job id — wire Cancel to it.
      setRunning(p.job_id);
    } else if (p.type === "stdout" || p.type === "stderr") {
      appendLine(p.type, p.line ?? "");
    } else if (p.type === "done") {
      const code = p.exit_code;
      appendLine("system", code === 0 ? "✓ done (exit 0)" : `✗ exit ${code}`);
    } else if (p.type === "error") {
      appendLine("error", `! ${p.message}`);
    }
  });
  activeUnlisten = unlisten;

  try {
    await invoke<{ job_id: string; exit_code: number | null }>(
      "ruflo_run",
      { argv, eventName },
    );
  } catch (err: any) {
    appendLine("error", `! ${err}`);
  } finally {
    setRunning(null);
    if (activeUnlisten) {
      activeUnlisten();
      activeUnlisten = null;
    }
  }
});

cancelBtn.addEventListener("click", async () => {
  if (!activeJobId || activeJobId === "…") return;
  try {
    await invoke("ruflo_cancel", { jobId: activeJobId });
    appendLine("system", "cancellation requested…");
  } catch (e: any) {
    appendLine("error", `cancel failed: ${e}`);
  }
});

// Display-only quoting so the echoed command line in the console is readable.
function quoteForDisplay(arg: string): string {
  if (arg === "" || /[\s"'\\$`*?{}<>|&;()]/.test(arg)) {
    return `"${arg.replace(/"/g, '\\"')}"`;
  }
  return arg;
}
