// JARVIS gamify — XP triggers.
//
// We hook the existing DOM elements directly instead of editing each feature
// module. That keeps the gamify layer fully removable: delete this file and
// xp.ts and the app behaves exactly as before.

import { awardXP } from "./xp";

// ─── Chat: send button + Enter ────────────────────────────────────────────

const sendBtn = document.getElementById("send");
const chatInput = document.getElementById("input") as HTMLTextAreaElement | null;

function awardChatSent() {
  if (!chatInput) return;
  // The chat module clears the input *after* its own send handler runs, so we
  // sample the current value at the moment of the user gesture.
  if (chatInput.value.trim()) awardXP("chat_sent");
}

sendBtn?.addEventListener("click", awardChatSent);
chatInput?.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !(e as KeyboardEvent).shiftKey) awardChatSent();
});

// ─── Chat: token streaming ────────────────────────────────────────────────
//
// The chat module calls `bumpTokens(1)` on every streamed delta. We can't
// monkey-patch that from inside (the import resolves once), but the cockpit
// module exports it from `cockpit.ts` so we wrap by intercepting via a Proxy
// on the imported reference. Simpler: we attach a small batched watcher that
// observes the SESS cell's text and turns deltas into XP.

const sessCell = document.querySelector<HTMLElement>('.cockpit-cell[data-key="tokens-session"] .cockpit-value');
let lastSessTokens = 0;
let tokenBatch = 0;
let tokenBatchTimer: number | undefined;

function parseTokenLabel(s: string | null): number {
  if (!s) return 0;
  const m = s.match(/([\d.]+)\s*(K|M)?/i);
  if (!m) return 0;
  const n = parseFloat(m[1]);
  const unit = (m[2] || "").toUpperCase();
  if (unit === "M") return n * 1_000_000;
  if (unit === "K") return n * 1_000;
  return n;
}

function flushTokenBatch() {
  if (tokenBatch <= 0) {
    tokenBatchTimer = undefined;
    return;
  }
  awardXP("tokens_streamed", tokenBatch);
  tokenBatch = 0;
  tokenBatchTimer = undefined;
}

if (sessCell) {
  const obs = new MutationObserver(() => {
    const cur = parseTokenLabel(sessCell.textContent);
    const delta = cur - lastSessTokens;
    if (delta > 0) {
      tokenBatch += delta;
      if (tokenBatchTimer === undefined) {
        // Batch streamed tokens into ~600ms windows so we don't fire awardXP
        // on every single delta (a single answer can be hundreds of tokens).
        tokenBatchTimer = window.setTimeout(flushTokenBatch, 600);
      }
    } else if (delta < 0) {
      // Session counter only resets when total ticks; ignore the wrap.
    }
    lastSessTokens = cur;
  });
  obs.observe(sessCell, { childList: true, characterData: true, subtree: true });
}

// ─── Workspace save ───────────────────────────────────────────────────────

const wsSaveBtn = document.getElementById("ws-save") as HTMLButtonElement | null;
wsSaveBtn?.addEventListener("click", () => {
  // Only count it as a save if the button was actually enabled (i.e. dirty).
  if (!wsSaveBtn.disabled) awardXP("file_saved");
});

// ─── Agents run ───────────────────────────────────────────────────────────

const agentsForm = document.getElementById("agents-form") as HTMLFormElement | null;
agentsForm?.addEventListener("submit", () => {
  const argv = (document.getElementById("agents-argv") as HTMLTextAreaElement | null)?.value.trim();
  if (argv) awardXP("agent_run");
});

// ─── Vinted scan + bot create ─────────────────────────────────────────────

const vintedScanBtn = document.getElementById("vinted-scan");
vintedScanBtn?.addEventListener("click", () => awardXP("vinted_scan"));

const vintedScanAllBtn = document.getElementById("vinted-scan-all");
vintedScanAllBtn?.addEventListener("click", () => awardXP("vinted_scan", 1));

const vintedEditor = document.getElementById("vinted-editor") as HTMLFormElement | null;
vintedEditor?.addEventListener("submit", () => {
  // We only award once per submit — the module decides whether the save
  // succeeds, but creating/editing a bot is itself rewarding work.
  awardXP("vinted_bot_created");
});

// ─── Brain search ─────────────────────────────────────────────────────────
//
// Brain searches debounce on input; we award per *committed* (Enter) search
// to avoid awarding while the user is still typing.

const brainSearch = document.getElementById("brain-search") as HTMLInputElement | null;
let lastBrainQuery = "";
let brainCommitTimer: number | undefined;

brainSearch?.addEventListener("input", () => {
  if (brainCommitTimer) clearTimeout(brainCommitTimer);
  brainCommitTimer = window.setTimeout(() => {
    const q = brainSearch.value.trim();
    if (q && q !== lastBrainQuery) {
      awardXP("brain_search");
      lastBrainQuery = q;
    }
  }, 1500);
});

// ─── Voice call ───────────────────────────────────────────────────────────

const callAccept = document.getElementById("call-accept");
callAccept?.addEventListener("click", () => awardXP("voice_call"));

// ─── Research mode toggle ─────────────────────────────────────────────────
//
// Research isn't a discrete event we can hook from outside — we bump XP when
// the toggle goes ON (once per cycle) so flipping it at least pings the HUD.

const researchToggle = document.getElementById("research-toggle");
researchToggle?.addEventListener("click", () => {
  // The chat module flips `.research-on` after this handler. Read after a
  // microtask so we see the new state.
  queueMicrotask(() => {
    if (researchToggle.classList.contains("research-on")) {
      awardXP("research_run");
    }
  });
});
