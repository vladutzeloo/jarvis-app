// JARVIS gamify — pixel-art workshop scenes.
//
// Each tile renders a tiny top-down room (120x72 internal units) populated
// with furniture and four NPC dots. The NPCs follow per-room CSS keyframe
// paths whose duration is bound to `data-state` (idle / working / busy) on
// the tile, so the scene literally speeds up when the matching feature is
// active. Pulses (single-event flashes) and visibility of NPC #3/#4 are
// driven by `activity.ts`.

export type Room = "chat" | "workspace" | "agents" | "vinted" | "brain";

export const ROOMS: Room[] = ["chat", "workspace", "agents", "vinted", "brain"];

// ─── 16-bit top-down pixel-art NPC sprites ───────────────────────────────────
//
// Each sprite is 8×12 pixels (1 SVG unit per pixel), centred at (0,0).
// Two walk frames — legs apart (A) and legs together (B) — are both rendered
// inside each <g class="npc">; CSS keyframes toggle their visibility so the
// sprite animates while the group translates along its path.
//
// Four colour palettes give each NPC slot a distinct look.

interface Palette {
  hair: string; skin: string; shirt: string; pants: string; boot: string;
}

const PALETTES: Palette[] = [
  { hair: "#2D1B0E", skin: "#F2C89E", shirt: "#2D5FA8", pants: "#1A3A7A", boot: "#120906" },
  { hair: "#111111", skin: "#F2C89E", shirt: "#A82D2D", pants: "#7A1A1A", boot: "#0E0606" },
  { hair: "#C8A93E", skin: "#D4905A", shirt: "#2DA855", pants: "#1A7A3A", boot: "#0A1206" },
  { hair: "#E0E0E0", skin: "#D4905A", shirt: "#7B2DA8", pants: "#3A1A7A", boot: "#0E060E" },
];

// 8-wide pixel rows, y from -6 to +5 (12 rows total), x from -4 to +4.
// Each row is 8 characters; key letters map to palette fields + special colours.
// '.' = transparent.
// Frame A — legs apart (walking)
const FRAME_A_ROWS = [
  "..HHHH..",  // y=-6  hair
  ".HSSSSH.",  // y=-5  head
  ".HSESSH.",  // y=-4  head (E = eye, dark dot)
  ".HSSSSH.",  // y=-3  chin
  "..TTTT..",  // y=-2  collar
  ".TTTTTT.",  // y=-1  torso
  ".TTTTTT.",  // y= 0  torso
  ".TTTTTT.",  // y= 1  torso
  "..PPPP..",  // y= 2  waist
  ".PP..PP.",  // y= 3  legs apart
  ".PP..PP.",  // y= 4  legs
  ".BB..BB.",  // y= 5  boots
];
// Frame B — legs together (other step)
const FRAME_B_ROWS = [
  "..HHHH..",  // y=-6
  ".HSSSSH.",  // y=-5
  ".HSESSH.",  // y=-4
  ".HSSSSH.",  // y=-3
  "..TTTT..",  // y=-2
  ".TTTTTT.",  // y=-1
  ".TTTTTT.",  // y= 0
  ".TTTTTT.",  // y= 1
  "..PPPP..",  // y= 2
  "..PPPP..",  // y= 3  legs together
  ".PP..PP.",  // y= 4
  ".BB..BB.",  // y= 5
];

function buildFrame(rows: string[], pal: Palette): string {
  const colourOf: Record<string, string> = {
    H: pal.hair, S: pal.skin, T: pal.shirt,
    P: pal.pants, B: pal.boot, E: "#1A0808",
  };
  const rects: string[] = [];
  rows.forEach((row, ry) => {
    for (let rx = 0; rx < 8; rx++) {
      const ch = row[rx];
      const fill = colourOf[ch];
      if (!fill) continue;
      rects.push(
        `<rect x="${rx - 4}" y="${ry - 6}" width="1" height="1" fill="${fill}"/>`,
      );
    }
  });
  return rects.join("");
}

function npcSprite(palIdx: number): string {
  const pal = PALETTES[palIdx % PALETTES.length];
  return `
    <g class="sprite-a">${buildFrame(FRAME_A_ROWS, pal)}</g>
    <g class="sprite-b">${buildFrame(FRAME_B_ROWS, pal)}</g>
  `;
}

// Shared SVG wrapper. Furniture is room-specific; NPC <g>s are identical and
// styled / animated by gamify.css. The four NPC slots are always rendered;
// CSS hides #3/#4 unless the room is in "working" or "busy" state.
function wrap(room: Room, furniture: string, fx: string = ""): string {
  const id = `floor-${room}`;
  return `
    <svg class="scene scene-${room}" viewBox="0 0 120 72"
         preserveAspectRatio="xMidYMid meet" shape-rendering="crispEdges"
         xmlns="http://www.w3.org/2000/svg">
      <defs>
        <pattern id="${id}" width="6" height="6" patternUnits="userSpaceOnUse">
          <rect width="6" height="6" fill="rgba(8, 12, 20, 0.85)"/>
          <rect x="0" y="0" width="1" height="1" fill="rgba(255, 255, 255, 0.05)"/>
          <rect x="3" y="3" width="1" height="1" fill="rgba(255, 255, 255, 0.03)"/>
        </pattern>
      </defs>

      <!-- Floor + walls -->
      <rect class="floor" width="120" height="72" fill="url(#${id})"/>
      <rect class="wall" x="0" y="0" width="120" height="2.5"/>
      <rect class="wall" x="0" y="69.5" width="120" height="2.5"/>
      <rect class="wall" x="0" y="0" width="2.5" height="72"/>
      <rect class="wall" x="117.5" y="0" width="2.5" height="72"/>

      <!-- Furniture (per room) -->
      <g class="furn-layer">${furniture}</g>

      <!-- Per-room flair (sparkles, screen lines, etc.) -->
      <g class="fx-layer">${fx}</g>

      <!-- 4 NPC slots — 16-bit pixel-art sprites, animated by CSS -->
      <g class="npc npc-1">${npcSprite(0)}</g>
      <g class="npc npc-2">${npcSprite(1)}</g>
      <g class="npc npc-3">${npcSprite(2)}</g>
      <g class="npc npc-4">${npcSprite(3)}</g>
    </svg>
  `;
}

// ─── Chat: terminal room — 4 monitors along the top wall ──────────────────
function chatScene(): string {
  const monitors = [16, 38, 60, 82].map(x => `
    <rect class="furn desk"   x="${x}" y="22" width="18" height="6"/>
    <rect class="furn screen" x="${x + 1}" y="11" width="16" height="11"/>
    <rect class="furn screen-glow" x="${x + 2}" y="13" width="14" height="7"/>
  `).join("");

  // Scrolling code lines on each screen (subtle blink)
  const lines = [16, 38, 60, 82].flatMap(x => [
    `<rect class="fx blink-a" x="${x + 3}" y="14" width="6" height="0.7"/>`,
    `<rect class="fx blink-b" x="${x + 3}" y="16" width="9" height="0.7"/>`,
    `<rect class="fx blink-a" x="${x + 3}" y="18" width="4" height="0.7"/>`,
  ]).join("");

  return wrap("chat", monitors, lines);
}

// ─── Workspace: code lab — central desk, side cabinets, monitor ──────────
function workspaceScene(): string {
  const furn = `
    <!-- big central desk + monitor -->
    <rect class="furn desk"   x="36" y="32" width="48" height="16"/>
    <rect class="furn screen" x="46" y="14" width="28" height="18"/>
    <rect class="furn screen-glow" x="48" y="16" width="24" height="14"/>
    <!-- side cabinets -->
    <rect class="furn cabinet" x="6"   y="46" width="20" height="20"/>
    <rect class="furn cabinet" x="94"  y="46" width="20" height="20"/>
    <rect class="furn cabinet-line" x="8"  y="50" width="16" height="0.8"/>
    <rect class="furn cabinet-line" x="8"  y="55" width="16" height="0.8"/>
    <rect class="furn cabinet-line" x="8"  y="60" width="16" height="0.8"/>
    <rect class="furn cabinet-line" x="96" y="50" width="16" height="0.8"/>
    <rect class="furn cabinet-line" x="96" y="55" width="16" height="0.8"/>
    <rect class="furn cabinet-line" x="96" y="60" width="16" height="0.8"/>
  `;
  // Code lines on the central monitor
  const fx = `
    <rect class="fx blink-a" x="50" y="18" width="14" height="0.8"/>
    <rect class="fx blink-b" x="50" y="20" width="20" height="0.8"/>
    <rect class="fx blink-a" x="50" y="22" width="10" height="0.8"/>
    <rect class="fx blink-b" x="50" y="24" width="18" height="0.8"/>
    <rect class="fx blink-a" x="50" y="26" width="12" height="0.8"/>
  `;
  return wrap("workspace", furn, fx);
}

// ─── Agents: control room — central console + 4 satellite stations ───────
function agentsScene(): string {
  const furn = `
    <!-- central command console -->
    <rect class="furn console" x="44" y="28" width="32" height="20"/>
    <rect class="furn console-screen" x="48" y="32" width="24" height="12"/>
    <!-- 4 satellite stations -->
    <rect class="furn desk" x="10"  y="14" width="16" height="8"/>
    <rect class="furn screen" x="11" y="6"  width="14" height="8"/>
    <rect class="furn desk" x="94"  y="14" width="16" height="8"/>
    <rect class="furn screen" x="95" y="6"  width="14" height="8"/>
    <rect class="furn desk" x="10"  y="54" width="16" height="8"/>
    <rect class="furn screen" x="11" y="46" width="14" height="8"/>
    <rect class="furn desk" x="94"  y="54" width="16" height="8"/>
    <rect class="furn screen" x="95" y="46" width="14" height="8"/>
  `;
  const fx = `
    <!-- central screen status bars -->
    <rect class="fx blink-a" x="50" y="34" width="20" height="0.8"/>
    <rect class="fx blink-b" x="50" y="37" width="14" height="0.8"/>
    <rect class="fx blink-a" x="50" y="40" width="18" height="0.8"/>
    <!-- station screen lights -->
    <circle class="fx blink-b" cx="18" cy="10" r="0.8"/>
    <circle class="fx blink-a" cx="102" cy="10" r="0.8"/>
    <circle class="fx blink-b" cx="18" cy="50" r="0.8"/>
    <circle class="fx blink-a" cx="102" cy="50" r="0.8"/>
  `;
  return wrap("agents", furn, fx);
}

// ─── Vinted: marketplace — row of stalls along the top, items on counters ──
function vintedScene(): string {
  const stalls = [6, 28, 50, 72, 94].map((x, i) => `
    <!-- stall awning -->
    <rect class="furn awning" x="${x}" y="6"  width="20" height="3"/>
    <rect class="furn stall-post" x="${x}" y="9" width="1.6" height="14"/>
    <rect class="furn stall-post" x="${x + 18.4}" y="9" width="1.6" height="14"/>
    <!-- counter -->
    <rect class="furn desk" x="${x}" y="22" width="20" height="5"/>
    <!-- item on counter (alternating shapes) -->
    ${i % 2 === 0
      ? `<rect class="furn item" x="${x + 6}" y="18" width="8" height="4"/>`
      : `<circle class="furn item" cx="${x + 10}" cy="20" r="2.5"/>`}
  `).join("");
  const fx = `
    <!-- floating coin sparkles above stalls -->
    <circle class="fx coin coin-1" cx="16" cy="12" r="1.2"/>
    <circle class="fx coin coin-2" cx="60" cy="12" r="1.2"/>
    <circle class="fx coin coin-3" cx="104" cy="12" r="1.2"/>
  `;
  return wrap("vinted", stalls, fx);
}

// ─── Brain: library — vertical bookshelves, NPCs walking the aisles ──────
function brainScene(): string {
  const shelves = [10, 26, 42, 58, 74, 90, 106].map(x => `
    <rect class="furn shelf" x="${x}" y="8" width="6" height="56"/>
    <rect class="furn shelf-line" x="${x}" y="18" width="6" height="0.8"/>
    <rect class="furn shelf-line" x="${x}" y="28" width="6" height="0.8"/>
    <rect class="furn shelf-line" x="${x}" y="38" width="6" height="0.8"/>
    <rect class="furn shelf-line" x="${x}" y="48" width="6" height="0.8"/>
    <rect class="furn shelf-line" x="${x}" y="58" width="6" height="0.8"/>
  `).join("");
  // The "active shelf" highlight that pulses on search.
  const fx = `
    <rect class="fx active-shelf" x="42" y="8" width="6" height="56"/>
  `;
  return wrap("brain", shelves, fx);
}

const SCENES: Record<Room, () => string> = {
  chat:      chatScene,
  workspace: workspaceScene,
  agents:    agentsScene,
  vinted:    vintedScene,
  brain:     brainScene,
};

export function sceneFor(room: Room): string {
  return SCENES[room]();
}
