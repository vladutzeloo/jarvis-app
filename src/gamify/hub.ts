// JARVIS gamify — Hub view.
//
// Renders the game-map landing screen: a player banner (level + title + XP),
// a grid of pixel-art workshop "rooms" (each animated by activity.ts via the
// `data-state` attribute), and the achievements list. The shell is built
// once on first render so the running NPC animations don't restart; only the
// per-tick text content is mutated on XP changes.

import {
  ACHIEVEMENTS,
  getCounters,
  getLevelInfo,
  getTitle,
  subscribe,
  xpForLevel,
} from "./xp";
import type { Room } from "./scene";
import { ROOMS as ROOM_KEYS, sceneFor } from "./scene";
// Importing activity for its side effects (DOM observers + tick loop).
import "./activity";

interface RoomMeta {
  tab: Room;
  id: string;
  name: string;
  blurb: string;
  statKey: keyof ReturnType<typeof getCounters> | null;
  statLabel: string;
}

const ROOMS: RoomMeta[] = [
  { tab: "chat",      id: "RM:01", name: "Chat",      blurb: "Talk to JARVIS. Models, voice, research.",     statKey: "chat_sent",          statLabel: "messages" },
  { tab: "workspace", id: "RM:02", name: "Workspace", blurb: "Edit local files in the JARVIS console.",      statKey: "file_saved",         statLabel: "saves"    },
  { tab: "agents",    id: "RM:03", name: "Agents",    blurb: "Spawn ruflo multi-agent runs.",                statKey: "agent_run",          statLabel: "runs"     },
  { tab: "vinted",    id: "RM:04", name: "Vinted",    blurb: "Hunt PC parts. Score deals automatically.",    statKey: "vinted_scan",        statLabel: "scans"    },
  { tab: "brain",     id: "RM:05", name: "Brain",     blurb: "Search your knowledge vault.",                 statKey: "brain_search",       statLabel: "searches" },
];

// Sanity check — keep ROOMS aligned with scene's ROOMS list.
void ROOM_KEYS;

const hubView = document.querySelector<HTMLElement>('.view[data-view="hub"]');

function clickTab(name: string) {
  document.querySelector<HTMLButtonElement>(`.tab[data-tab="${name}"]`)?.click();
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, ch => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[ch] as string);
}

function tileMarkup(room: RoomMeta): string {
  return `
    <button class="hub-tile" data-tab="${room.tab}" data-state="idle" type="button">
      <div class="hub-tile-titlebar">
        <span>${escapeHtml(room.name)}</span>
        <span class="hub-tile-titlebar-id">${room.id}</span>
      </div>
      <div class="hub-tile-art">${sceneFor(room.tab)}</div>
      <div class="hub-tile-meta">
        <div class="hub-tile-name">▸ ENTER</div>
        <div class="hub-tile-blurb">${escapeHtml(room.blurb)}</div>
        <div class="hub-tile-stat" data-stat>—</div>
      </div>
    </button>
  `;
}

function achievementMarkup(): string {
  return ACHIEVEMENTS.map(a => `
    <li class="hub-ach" data-ach="${a.id}">
      <span class="hub-ach-icon" data-ach-icon>·</span>
      <div class="hub-ach-body">
        <div class="hub-ach-name">${escapeHtml(a.name)}</div>
        <div class="hub-ach-desc">${escapeHtml(a.desc)}</div>
      </div>
    </li>
  `).join("");
}

let mounted = false;

function mount() {
  if (!hubView) return;

  hubView.innerHTML = `
    <div class="hub-banner">
      <div>
        <div class="hub-banner-greet" data-greet>USER · CIVILIAN</div>
        <div class="hub-banner-sub">welcome back, operative</div>
      </div>
      <div class="hub-banner-stats">
        <div><span>LEVEL</span><b data-banner-level>0</b></div>
        <div><span>XP</span><b class="cyan" data-banner-xp>0/25</b></div>
        <div><span>UNLOCKED</span><b class="lime" data-banner-unlocked>0/${ACHIEVEMENTS.length}</b></div>
      </div>
    </div>

    <div class="hub-grid">
      ${ROOMS.map(tileMarkup).join("")}
    </div>

    <div class="hub-achievements">
      <div class="hub-achievements-title">
        <span>ACHIEVEMENTS</span>
        <span class="hub-achievements-progress" data-ach-progress>0 / ${ACHIEVEMENTS.length}</span>
      </div>
      <ul class="hub-achievements-list">
        ${achievementMarkup()}
      </ul>
    </div>
  `;

  hubView.querySelectorAll<HTMLButtonElement>(".hub-tile").forEach(btn => {
    btn.addEventListener("click", () => {
      const target = btn.dataset.tab;
      if (target) clickTab(target);
    });
  });

  mounted = true;
}

function update() {
  if (!hubView) return;
  if (!mounted) mount();

  const info = getLevelInfo();
  const counters = getCounters();
  const title = getTitle();
  const span = xpForLevel(info.level + 1) - xpForLevel(info.level);
  const unlockedCount = counters.achievements.length;

  setText("[data-greet]",            `USER · ${title.toUpperCase()}`);
  setText("[data-banner-level]",     String(info.level));
  setText("[data-banner-xp]",        `${info.xpIntoLevel}/${span}`);
  setText("[data-banner-unlocked]",  `${unlockedCount}/${ACHIEVEMENTS.length}`);
  setText("[data-ach-progress]",     `${unlockedCount} / ${ACHIEVEMENTS.length}`);

  // Per-tile counter — the SVG scene above is left untouched so its
  // animation timeline doesn't restart.
  for (const room of ROOMS) {
    const tile = hubView.querySelector(`.hub-tile[data-tab="${room.tab}"]`);
    if (!tile || !room.statKey) continue;
    const v = counters[room.statKey];
    const stat = tile.querySelector("[data-stat]");
    if (stat && typeof v === "number") {
      stat.textContent = `${v} ${room.statLabel.toUpperCase()}`;
    }
  }

  // Achievements: just toggle the unlocked class on each <li>; the row
  // structure is built once in mount().
  for (const a of ACHIEVEMENTS) {
    const li = hubView.querySelector(`.hub-ach[data-ach="${a.id}"]`);
    if (!li) continue;
    const got = counters.achievements.includes(a.id);
    li.classList.toggle("unlocked", got);
    const icon = li.querySelector("[data-ach-icon]");
    if (icon) icon.textContent = got ? a.icon : "·";
  }
}

function setText(selector: string, text: string) {
  if (!hubView) return;
  const el = hubView.querySelector(selector);
  if (el) el.textContent = text;
}

if (hubView) {
  update();
  subscribe(update);
}
