// JARVIS gamify — XP, levels, achievements.
//
// The engine is intentionally small: a single counter object persisted to
// localStorage, a level curve (`level = floor(sqrt(xp / 25))`), and a list of
// achievements that watch the same counter set. Triggers (see ./triggers.ts)
// just call `awardXP(kind, amount)` — they never touch the storage shape.
//
// Visual feedback is opt-in: the `awardXP` call animates the header XP bar,
// shows a "+N XP" droplet near the cursor or HUD, and pops a level-up banner
// when the level threshold crosses.

const STORAGE_KEY = "jarvis.gamify.v1";

export type XPKind =
  | "chat_sent"
  | "tokens_streamed"
  | "file_saved"
  | "agent_run"
  | "vinted_scan"
  | "vinted_bot_created"
  | "brain_search"
  | "voice_call"
  | "research_run";

export interface Counters {
  xp: number;
  chat_sent: number;
  tokens_streamed: number;
  file_saved: number;
  agent_run: number;
  vinted_scan: number;
  vinted_bot_created: number;
  brain_search: number;
  voice_call: number;
  research_run: number;
  achievements: string[]; // ids of unlocked achievements
}

const initialCounters: Counters = {
  xp: 0,
  chat_sent: 0,
  tokens_streamed: 0,
  file_saved: 0,
  agent_run: 0,
  vinted_scan: 0,
  vinted_bot_created: 0,
  brain_search: 0,
  voice_call: 0,
  research_run: 0,
  achievements: [],
};

function loadCounters(): Counters {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...initialCounters };
    const parsed = JSON.parse(raw);
    return { ...initialCounters, ...parsed };
  } catch {
    return { ...initialCounters };
  }
}

let counters: Counters = loadCounters();

function persist() {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(counters)); } catch { /* quota / private mode */ }
}

// Level curve — slow start, gentle acceleration. Level 1 at 25 XP, level 5 at
// 625, level 10 at 2500, level 20 at 10k. Token streaming is the easy way to
// climb the curve; one-shot actions (chat sent, agent run) give bigger pops.
export function levelForXP(xp: number): number {
  return Math.floor(Math.sqrt(Math.max(0, xp) / 25));
}

export function xpForLevel(level: number): number {
  return level * level * 25;
}

export interface LevelInfo {
  level: number;
  xp: number;
  xpIntoLevel: number;
  xpForNext: number;
  pctToNext: number; // 0-1
}

export function getLevelInfo(): LevelInfo {
  const level = levelForXP(counters.xp);
  const base = xpForLevel(level);
  const next = xpForLevel(level + 1);
  const span = Math.max(1, next - base);
  const into = counters.xp - base;
  return {
    level,
    xp: counters.xp,
    xpIntoLevel: into,
    xpForNext: next - counters.xp,
    pctToNext: Math.min(1, into / span),
  };
}

export function getCounters(): Readonly<Counters> {
  return counters;
}

// XP value table per action kind. Keep these small — chat streaming pumps a
// lot of tokens.
const XP_VALUES: Record<XPKind, number> = {
  chat_sent: 5,
  tokens_streamed: 1, // multiplied by `amount`, but capped per call below
  file_saved: 3,
  agent_run: 12,
  vinted_scan: 8,
  vinted_bot_created: 6,
  brain_search: 1,
  voice_call: 4,
  research_run: 4,
};

// Display names for the floating "+N XP" label
const KIND_LABELS: Record<XPKind, string> = {
  chat_sent: "chat",
  tokens_streamed: "tok",
  file_saved: "save",
  agent_run: "agent",
  vinted_scan: "scan",
  vinted_bot_created: "bot",
  brain_search: "search",
  voice_call: "voice",
  research_run: "research",
};

// ─── Achievements ──────────────────────────────────────────────────────────

export interface Achievement {
  id: string;
  icon: string;
  name: string;
  desc: string;
  test: (c: Counters) => boolean;
}

export const ACHIEVEMENTS: Achievement[] = [
  { id: "first_word",   icon: "✦", name: "First Word",      desc: "Send your first message", test: c => c.chat_sent >= 1 },
  { id: "chatterbox",   icon: "✦", name: "Chatterbox",      desc: "Send 50 messages",        test: c => c.chat_sent >= 50 },
  { id: "marathon",     icon: "✦", name: "Token Marathon",  desc: "Stream 100k tokens",      test: c => c.tokens_streamed >= 100_000 },
  { id: "code_monkey",  icon: "▤", name: "Code Monkey",     desc: "Save your first file",    test: c => c.file_saved >= 1 },
  { id: "code_master",  icon: "▤", name: "Code Master",     desc: "Save 100 files",          test: c => c.file_saved >= 100 },
  { id: "agent_first",  icon: "▶", name: "Agent Provoc.",   desc: "Run your first agent",    test: c => c.agent_run >= 1 },
  { id: "agent_pro",    icon: "▶", name: "Operator",        desc: "Run 25 agent jobs",       test: c => c.agent_run >= 25 },
  { id: "bot_wrangler", icon: "◉", name: "Bot Wrangler",    desc: "Run your first scan",     test: c => c.vinted_scan >= 1 },
  { id: "deal_hunter",  icon: "◉", name: "Deal Hunter",     desc: "Run 25 scans",            test: c => c.vinted_scan >= 25 },
  { id: "mind_reader",  icon: "◐", name: "Mind Reader",     desc: "Search the Brain",        test: c => c.brain_search >= 1 },
  { id: "telepath",     icon: "◐", name: "Telepath",        desc: "Run 50 brain searches",   test: c => c.brain_search >= 50 },
  { id: "voice_first",  icon: "♪", name: "Hello, JARVIS",   desc: "Take a voice call",       test: c => c.voice_call >= 1 },
  { id: "level_5",      icon: "◆", name: "Apprentice",      desc: "Reach level 5",           test: c => levelForXP(c.xp) >= 5 },
  { id: "level_10",     icon: "◆", name: "Operative",       desc: "Reach level 10",          test: c => levelForXP(c.xp) >= 10 },
  { id: "level_20",     icon: "◆", name: "Architect",       desc: "Reach level 20",          test: c => levelForXP(c.xp) >= 20 },
];

function checkNewAchievements(): Achievement[] {
  const unlocked: Achievement[] = [];
  for (const ach of ACHIEVEMENTS) {
    if (counters.achievements.includes(ach.id)) continue;
    if (ach.test(counters)) {
      counters.achievements.push(ach.id);
      unlocked.push(ach);
    }
  }
  return unlocked;
}

// ─── Public award API ──────────────────────────────────────────────────────

export interface AwardResult {
  xpGained: number;
  newLevel: number | null; // set if level up happened
  unlocked: Achievement[];
}

const TOKEN_AWARD_CAP = 5; // per call — streaming awards land in big batches

export function awardXP(kind: XPKind, amount = 1, opts?: { silent?: boolean }): AwardResult {
  const beforeLevel = levelForXP(counters.xp);

  // Update the per-kind counter
  counters[kind] = (counters[kind] as number) + amount;

  // Compute XP gain
  let gain: number;
  if (kind === "tokens_streamed") {
    // Tokens stream in huge batches; cap each call so a single answer can't
    // hand you 3 levels in one go. The full counter still ticks up.
    gain = Math.min(amount * XP_VALUES.tokens_streamed, TOKEN_AWARD_CAP);
  } else {
    gain = XP_VALUES[kind] * amount;
  }
  counters.xp += gain;

  const afterLevel = levelForXP(counters.xp);
  const unlocked = checkNewAchievements();
  persist();

  const res: AwardResult = {
    xpGained: gain,
    newLevel: afterLevel > beforeLevel ? afterLevel : null,
    unlocked,
  };

  if (!opts?.silent) {
    notifyHud(kind, gain);
    if (res.newLevel !== null) showLevelToast(res.newLevel);
    for (const ach of unlocked) showAchievementToast(ach);
  }

  for (const fn of subscribers) fn();
  return res;
}

// ─── Subscribers — used by the Hub view to redraw on changes ──────────────

const subscribers: Array<() => void> = [];

export function subscribe(fn: () => void): () => void {
  subscribers.push(fn);
  return () => {
    const i = subscribers.indexOf(fn);
    if (i >= 0) subscribers.splice(i, 1);
  };
}

// ─── HUD wiring ────────────────────────────────────────────────────────────

let hudEl: HTMLElement | null = null;
let hudLevelEl: HTMLElement | null = null;
let hudFillEl: HTMLElement | null = null;
let hudXpEl: HTMLElement | null = null;
let hudGainTimer: number | undefined;

export function mountHud(host: HTMLElement) {
  host.innerHTML = `
    <span class="xp-hud-level"><span data-level>LV 0</span></span>
    <span class="xp-hud-bar"><span class="xp-hud-bar-fill"></span></span>
    <span class="xp-hud-xp" data-xp>0 / 25</span>
  `;
  host.classList.add("xp-hud");
  host.title = "Open the Hub — XP, level, achievements";
  host.tabIndex = 0;
  host.setAttribute("role", "button");
  host.addEventListener("click", () => goToHub());
  host.addEventListener("keydown", e => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      goToHub();
    }
  });
  hudEl = host;
  hudLevelEl = host.querySelector("[data-level]");
  hudFillEl = host.querySelector(".xp-hud-bar-fill");
  hudXpEl = host.querySelector("[data-xp]");
  refreshHud();
  subscribe(refreshHud);
}

function refreshHud() {
  if (!hudEl) return;
  const info = getLevelInfo();
  if (hudLevelEl) hudLevelEl.textContent = `LV ${info.level}`;
  if (hudFillEl) hudFillEl.style.width = `${(info.pctToNext * 100).toFixed(1)}%`;
  if (hudXpEl) {
    const span = xpForLevel(info.level + 1) - xpForLevel(info.level);
    hudXpEl.textContent = `${info.xpIntoLevel} / ${span}`;
  }
}

function notifyHud(kind: XPKind, gain: number) {
  if (!hudEl || gain <= 0) return;
  hudEl.classList.add("gaining");
  if (hudGainTimer) clearTimeout(hudGainTimer);
  hudGainTimer = window.setTimeout(() => hudEl?.classList.remove("gaining"), 480);

  // Floating "+N XP · kind" droplet that drifts up and out from the HUD.
  const rect = hudEl.getBoundingClientRect();
  const drop = document.createElement("div");
  drop.className = "xp-droplet";
  drop.textContent = `+${gain} XP · ${KIND_LABELS[kind]}`;
  drop.style.left = `${rect.left + rect.width / 2}px`;
  drop.style.top = `${rect.bottom + 4}px`;
  document.body.appendChild(drop);
  setTimeout(() => drop.remove(), 1200);
}

function goToHub() {
  const hubTab = document.querySelector<HTMLButtonElement>('.tab[data-tab="hub"]');
  hubTab?.click();
}

// ─── Toast helpers ────────────────────────────────────────────────────────

function showLevelToast(newLevel: number) {
  const el = document.createElement("div");
  el.className = "level-toast";
  el.innerHTML = `
    <div class="level-toast-banner">
      <div class="level-toast-tag">LEVEL UP</div>
      <div class="level-toast-num">LV ${newLevel}</div>
      <div class="level-toast-title">${escapeHtml(titleForLevel(newLevel))}</div>
    </div>
  `;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 2700);
}

function showAchievementToast(ach: Achievement) {
  const el = document.createElement("div");
  el.className = "achievement-toast";
  el.innerHTML = `
    <div class="achievement-toast-icon">${escapeHtml(ach.icon)}</div>
    <div class="achievement-toast-body">
      <div class="achievement-toast-tag">ACHIEVEMENT</div>
      <div class="achievement-toast-title">${escapeHtml(ach.name)}</div>
      <div class="achievement-toast-desc">${escapeHtml(ach.desc)}</div>
    </div>
  `;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 4300);
}

const TITLES = [
  "Civilian", "Initiate", "Apprentice", "Adept", "Operative",
  "Sentinel", "Specialist", "Cyberpunk", "Architect", "Overseer",
  "Synthwave", "Netrunner", "Ghost", "Daemon", "Oracle",
  "Chronicler", "Architect-Prime", "Singularity", "Phantom", "Legend",
];

function titleForLevel(lvl: number): string {
  return TITLES[Math.min(lvl, TITLES.length - 1)];
}

export function getTitle(): string {
  return titleForLevel(levelForXP(counters.xp));
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, ch => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[ch] as string);
}

// Boot — make sure HUD is mounted as soon as the DOM is ready.
function bootHud() {
  const host = document.getElementById("xp-hud");
  if (host) mountHud(host);
}
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", bootHud);
} else {
  bootHud();
}
