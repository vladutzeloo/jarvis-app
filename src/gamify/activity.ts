// JARVIS gamify — activity engine.
//
// Maintains a "heat" counter per room (0..10) that decays over time. Heat
// rises when the user does something in that feature (`pulseRoom`) or while
// a sustained signal is on (chat busy, agent running, file dirty, vinted
// scanning). The current state is mirrored onto each tile via
// `data-state="idle | working | busy"`, which is read by gamify.css to set
// the NPC walk speed, opacity, and visible NPC count.

import type { Room } from "./scene";
import { ROOMS } from "./scene";

const HEAT_MAX = 10;
const HEAT_DECAY = 0.5;       // per second
const HEAT_PULSE = 2.0;       // per discrete event
const TICK_MS = 1000;

const STATE_WORKING_AT = 1;
const STATE_BUSY_AT = 4;

const heat: Record<Room, number> = {
  chat: 0, workspace: 0, agents: 0, vinted: 0, brain: 0,
};
const sustained: Record<Room, boolean> = {
  chat: false, workspace: false, agents: false, vinted: false, brain: false,
};

function tileFor(room: Room): HTMLElement | null {
  return document.querySelector<HTMLElement>(`.hub-tile[data-tab="${room}"]`);
}

function applyState(room: Room) {
  const h = sustained[room] ? Math.max(heat[room], STATE_BUSY_AT + 1) : heat[room];
  const state = h >= STATE_BUSY_AT ? "busy" : h >= STATE_WORKING_AT ? "working" : "idle";
  tileFor(room)?.setAttribute("data-state", state);
}

function applyAll() {
  for (const r of ROOMS) applyState(r);
}

// ─── Public API ───────────────────────────────────────────────────────────

export function pulseRoom(room: Room) {
  heat[room] = Math.min(HEAT_MAX, heat[room] + HEAT_PULSE);
  const tile = tileFor(room);
  if (tile) {
    tile.classList.add("pulse");
    // The CSS animation runs ~800ms; this keeps multiple pulses from
    // stacking and freezing the class on.
    window.setTimeout(() => tile.classList.remove("pulse"), 820);
  }
  applyState(room);
}

export function setSustained(room: Room, on: boolean) {
  if (sustained[room] === on) return;
  sustained[room] = on;
  if (on) heat[room] = Math.max(heat[room], STATE_BUSY_AT + 1);
  applyState(room);
}

// ─── Tick loop — slow heat decay ──────────────────────────────────────────

window.setInterval(() => {
  let dirty = false;
  for (const r of ROOMS) {
    if (sustained[r]) continue;
    if (heat[r] > 0) {
      heat[r] = Math.max(0, heat[r] - HEAT_DECAY);
      dirty = true;
    }
  }
  if (dirty) applyAll();
}, TICK_MS);

// ─── DOM observers — sustained busy signals ───────────────────────────────
//
// We avoid editing feature modules; instead we read their visible state.
// Each observer flips the `sustained` flag for its room so the NPCs stay
// in "busy" mode for as long as the activity is running, then fall back to
// the heat curve when it ends.

function attachObservers() {
  // Chat: header gets `.busy` while a generation is streaming.
  const header = document.querySelector("header");
  if (header) {
    new MutationObserver(() => setSustained("chat", header.classList.contains("busy")))
      .observe(header, { attributes: true, attributeFilter: ["class"] });
    // Initial state
    setSustained("chat", header.classList.contains("busy"));
  }

  // Agents: cancel button is only enabled while a job is running.
  const cancel = document.getElementById("agents-cancel") as HTMLButtonElement | null;
  if (cancel) {
    new MutationObserver(() => setSustained("agents", !cancel.disabled))
      .observe(cancel, { attributes: true, attributeFilter: ["disabled"] });
    setSustained("agents", !cancel.disabled);
  }

  // Vinted: scan button is disabled while a scan is in-flight.
  const scan = document.getElementById("vinted-scan") as HTMLButtonElement | null;
  if (scan) {
    new MutationObserver(() => setSustained("vinted", scan.disabled))
      .observe(scan, { attributes: true, attributeFilter: ["disabled"] });
    setSustained("vinted", scan.disabled);
  }

  // Workspace: dirty dot becomes visible (loses `.hidden`) when there are
  // unsaved edits — that's a good "actively working" proxy.
  const dirty = document.getElementById("ws-dirty");
  if (dirty) {
    new MutationObserver(() => setSustained("workspace", !dirty.classList.contains("hidden")))
      .observe(dirty, { attributes: true, attributeFilter: ["class"] });
    setSustained("workspace", !dirty.classList.contains("hidden"));
  }

  // Brain: no clean sustained signal (search debounces); we lean on pulses.
}

// Wait for the Hub tiles to exist before attaching observers — they need to
// resolve `.hub-tile[data-tab=...]` queries at construction time.
function whenHubReady(cb: () => void) {
  if (document.querySelector(".hub-tile")) { cb(); return; }
  const obs = new MutationObserver(() => {
    if (document.querySelector(".hub-tile")) {
      obs.disconnect();
      cb();
    }
  });
  obs.observe(document.body, { childList: true, subtree: true });
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", () => whenHubReady(attachObservers));
} else {
  whenHubReady(attachObservers);
}
