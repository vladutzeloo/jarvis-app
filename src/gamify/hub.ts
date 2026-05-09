// JARVIS gamify — Hub view.
//
// Renders the game-map landing screen: a player banner (level + title + XP),
// a grid of pixel-art "rooms" that each map to a tab, and the achievements
// list. Re-renders on every XP change via the `subscribe` hook.

import {
  ACHIEVEMENTS,
  getCounters,
  getLevelInfo,
  getTitle,
  subscribe,
  xpForLevel,
} from "./xp";

interface Room {
  tab: string;
  id: string;       // arcade-style id displayed in the title bar
  name: string;
  blurb: string;
  art: string;      // inline SVG pixel art
  statKey: keyof ReturnType<typeof getCounters> | null;
  statLabel: string;
}

// Inline pixel-art SVGs. Each is drawn on a 16x16 grid scaled up via viewBox
// so it stays crisp at any size. `currentColor` lets the tile theme tint each
// piece without per-room overrides.
const ART = {
  chat: `<svg viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg" shape-rendering="crispEdges">
    <g fill="currentColor">
      <rect x="2" y="3" width="12" height="1"/><rect x="1" y="4" width="14" height="1"/>
      <rect x="1" y="5" width="14" height="6"/><rect x="2" y="11" width="12" height="1"/>
      <rect x="3" y="12" width="3" height="1"/><rect x="4" y="13" width="2" height="1"/>
    </g>
    <g fill="#0a1018">
      <rect x="4" y="7" width="2" height="2"/><rect x="7" y="7" width="2" height="2"/><rect x="10" y="7" width="2" height="2"/>
    </g>
  </svg>`,
  workspace: `<svg viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg" shape-rendering="crispEdges">
    <g fill="currentColor">
      <rect x="2" y="2" width="12" height="1"/><rect x="2" y="3" width="1" height="11"/>
      <rect x="13" y="3" width="1" height="11"/><rect x="3" y="13" width="10" height="1"/>
    </g>
    <g fill="currentColor" opacity="0.55">
      <rect x="4" y="5" width="3" height="1"/><rect x="4" y="7" width="6" height="1"/>
      <rect x="4" y="9" width="4" height="1"/><rect x="4" y="11" width="5" height="1"/>
    </g>
  </svg>`,
  agents: `<svg viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg" shape-rendering="crispEdges">
    <g fill="currentColor">
      <rect x="6" y="2" width="4" height="1"/><rect x="5" y="3" width="6" height="2"/>
      <rect x="4" y="5" width="8" height="5"/><rect x="3" y="7" width="1" height="3"/>
      <rect x="12" y="7" width="1" height="3"/>
      <rect x="6" y="10" width="4" height="3"/><rect x="5" y="13" width="2" height="1"/>
      <rect x="9" y="13" width="2" height="1"/>
    </g>
    <g fill="#0a1018">
      <rect x="6" y="6" width="2" height="2"/><rect x="9" y="6" width="2" height="2"/>
    </g>
  </svg>`,
  vinted: `<svg viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg" shape-rendering="crispEdges">
    <g fill="currentColor">
      <rect x="3" y="4" width="10" height="1"/><rect x="2" y="5" width="12" height="1"/>
      <rect x="2" y="6" width="1" height="8"/><rect x="13" y="6" width="1" height="8"/>
      <rect x="2" y="14" width="12" height="1"/>
    </g>
    <g fill="currentColor" opacity="0.6">
      <rect x="5" y="2" width="2" height="3"/><rect x="9" y="2" width="2" height="3"/>
    </g>
    <g fill="#0a1018">
      <rect x="6" y="9" width="4" height="1"/><rect x="6" y="11" width="3" height="1"/>
    </g>
  </svg>`,
  brain: `<svg viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg" shape-rendering="crispEdges">
    <g fill="currentColor">
      <rect x="5" y="2" width="6" height="1"/><rect x="3" y="3" width="10" height="1"/>
      <rect x="2" y="4" width="12" height="2"/><rect x="2" y="6" width="1" height="6"/>
      <rect x="13" y="6" width="1" height="6"/><rect x="2" y="12" width="12" height="2"/>
      <rect x="3" y="14" width="10" height="1"/><rect x="5" y="15" width="6" height="1"/>
    </g>
    <g fill="#0a1018">
      <rect x="5" y="6" width="2" height="2"/><rect x="9" y="6" width="2" height="2"/>
      <rect x="7" y="9" width="2" height="1"/><rect x="6" y="10" width="4" height="1"/>
    </g>
  </svg>`,
};

const ROOMS: Room[] = [
  {
    tab: "chat", id: "RM:01", name: "Chat",
    blurb: "Talk to JARVIS. Models, voice, research.",
    art: ART.chat, statKey: "chat_sent", statLabel: "messages",
  },
  {
    tab: "workspace", id: "RM:02", name: "Workspace",
    blurb: "Edit local files in the JARVIS console.",
    art: ART.workspace, statKey: "file_saved", statLabel: "saves",
  },
  {
    tab: "agents", id: "RM:03", name: "Agents",
    blurb: "Spawn ruflo multi-agent runs.",
    art: ART.agents, statKey: "agent_run", statLabel: "runs",
  },
  {
    tab: "vinted", id: "RM:04", name: "Vinted",
    blurb: "Hunt PC parts. Score deals automatically.",
    art: ART.vinted, statKey: "vinted_scan", statLabel: "scans",
  },
  {
    tab: "brain", id: "RM:05", name: "Brain",
    blurb: "Search your knowledge vault.",
    art: ART.brain, statKey: "brain_search", statLabel: "searches",
  },
];

const hubView = document.querySelector<HTMLElement>('.view[data-view="hub"]');

function clickTab(name: string) {
  document.querySelector<HTMLButtonElement>(`.tab[data-tab="${name}"]`)?.click();
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, ch => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[ch] as string);
}

function renderTile(room: Room): string {
  const counters = getCounters();
  let statValue = "—";
  if (room.statKey) {
    const v = counters[room.statKey];
    if (typeof v === "number") statValue = String(v);
  }
  return `
    <button class="hub-tile" data-tab="${room.tab}" type="button">
      <div class="hub-tile-titlebar">
        <span>${escapeHtml(room.name)}</span>
        <span class="hub-tile-titlebar-id">${room.id}</span>
      </div>
      <div class="hub-tile-art">${room.art}</div>
      <div class="hub-tile-meta">
        <div class="hub-tile-name">▸ ENTER</div>
        <div class="hub-tile-blurb">${escapeHtml(room.blurb)}</div>
        <div class="hub-tile-stat">${statValue} ${room.statLabel.toUpperCase()}</div>
      </div>
    </button>
  `;
}

function render() {
  if (!hubView) return;

  const info = getLevelInfo();
  const counters = getCounters();
  const title = getTitle();
  const span = xpForLevel(info.level + 1) - xpForLevel(info.level);
  const unlockedCount = counters.achievements.length;

  hubView.innerHTML = `
    <div class="hub-banner">
      <div>
        <div class="hub-banner-greet">USER · ${escapeHtml(title.toUpperCase())}</div>
        <div class="hub-banner-sub">welcome back, operative</div>
      </div>
      <div class="hub-banner-stats">
        <div>
          <span>LEVEL</span>
          <b>${info.level}</b>
        </div>
        <div>
          <span>XP</span>
          <b class="cyan">${info.xpIntoLevel}/${span}</b>
        </div>
        <div>
          <span>UNLOCKED</span>
          <b class="lime">${unlockedCount}/${ACHIEVEMENTS.length}</b>
        </div>
      </div>
    </div>

    <div class="hub-grid">
      ${ROOMS.map(renderTile).join("")}
    </div>

    <div class="hub-achievements">
      <div class="hub-achievements-title">
        <span>ACHIEVEMENTS</span>
        <span class="hub-achievements-progress">${unlockedCount} / ${ACHIEVEMENTS.length}</span>
      </div>
      <ul class="hub-achievements-list">
        ${ACHIEVEMENTS.map(a => {
          const got = counters.achievements.includes(a.id);
          return `
            <li class="hub-ach ${got ? "unlocked" : ""}">
              <span class="hub-ach-icon">${escapeHtml(got ? a.icon : "·")}</span>
              <div class="hub-ach-body">
                <div class="hub-ach-name">${escapeHtml(a.name)}</div>
                <div class="hub-ach-desc">${escapeHtml(a.desc)}</div>
              </div>
            </li>
          `;
        }).join("")}
      </ul>
    </div>
  `;

  hubView.querySelectorAll<HTMLButtonElement>(".hub-tile").forEach(btn => {
    btn.addEventListener("click", () => {
      const target = btn.dataset.tab;
      if (target) clickTab(target);
    });
  });
}

if (hubView) {
  render();
  subscribe(render);
}
