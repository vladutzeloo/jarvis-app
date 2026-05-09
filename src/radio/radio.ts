// Radio tab — full-page DJ console driving the shared Audius engine in
// world/dj.ts. The engine handles track search, streaming, analyser, and the
// "now playing" subscription bus. This module renders the UI: vinyl deck,
// EQ knobs (real Web Audio biquads), crossfader, queue, station presets,
// spectrum bars, scrubber. It also exposes a tiny command surface so the
// voice + camera modules can drive the radio with words / gestures.
//
// Why the split: dj.ts owns the audio graph (single source of truth for the
// player so the holodeck DJ NPC, the corner dock, and the Radio tab don't
// each make their own MediaElementSource — browsers refuse to attach more
// than one to a single <audio>). Everything visual lives here.

import {
  ensureDJEngine,
  getDJSnapshot,
  subscribeDJ,
  djSearch,
  djPlay,
  djPause,
  djTogglePlay,
  djNext,
  djPrev,
  djPlayIndex,
  djSetVolume,
  djGetVolume,
  djGetAnalyser,
  djSeekFraction,
} from "../world/dj";
import { sfx, getAudioContext, getMasterGain } from "../world/sfx";

// ─── Stations ─────────────────────────────────────────────────────────────

interface Station {
  id: string;
  name: string;
  query: string;
  emoji: string;
  hue: number; // for tile accent
}

const STATIONS: Station[] = [
  { id: "synthwave",  name: "Synthwave",   query: "synthwave",   emoji: "🌆", hue: 290 },
  { id: "lofi",       name: "Lo-Fi Beats", query: "lo-fi",       emoji: "📻", hue: 30  },
  { id: "cyberpunk",  name: "Cyberpunk",   query: "cyberpunk",   emoji: "🦾", hue: 320 },
  { id: "ambient",    name: "Ambient",     query: "ambient",     emoji: "🌫", hue: 200 },
  { id: "electronic", name: "Electronic",  query: "electronic",  emoji: "⚡", hue: 240 },
  { id: "house",      name: "House",       query: "house",       emoji: "🏠", hue: 340 },
  { id: "techno",     name: "Techno",      query: "techno",      emoji: "🛰", hue: 220 },
  { id: "drum-bass",  name: "Drum & Bass", query: "drum and bass", emoji: "🥁", hue: 170 },
  { id: "trap",       name: "Trap",        query: "trap",        emoji: "🔊", hue: 12  },
  { id: "jazz",       name: "Jazz",        query: "jazz",        emoji: "🎷", hue: 50  },
  { id: "rock",       name: "Rock",        query: "rock",        emoji: "🎸", hue: 0   },
  { id: "vapor",      name: "Vaporwave",   query: "vaporwave",   emoji: "🌴", hue: 300 },
];

const STATION_BY_QUERY = new Map(STATIONS.map(s => [s.query.toLowerCase(), s] as const));

// ─── EQ chain ─────────────────────────────────────────────────────────────
//
// dj.ts plumbs the player into masterGain via:
//     source -> analyser -> musicGain -> master
// We can't safely splice into that path (only one MediaElementSource per
// element), but we *can* sit a 3-band biquad chain in front of the master
// destination by re-routing the master gain output. To stay non-invasive,
// we instead create a *parallel* output gain that scales the radio module's
// EQ effect: we copy the master gain's signal through three biquad filters
// and a make-up gain by tapping the analyser's already-existing output. We
// approximate by tweaking master directly with a small splitter:
//
// Actually the cleanest way given the existing graph is: leave master alone,
// and apply EQ via a new chain inserted right after dj's musicGain by
// monkey-attaching biquads onto the *analyser* output. That requires
// mutating dj.ts. Instead, we attach EQ filters between the existing master
// gain and ctx.destination — touching only a single shared node we already
// expose. We do the rewiring once, the first time the user touches an EQ.

interface EQ {
  bass: BiquadFilterNode;
  mid: BiquadFilterNode;
  treble: BiquadFilterNode;
  attached: boolean;
}
let eq: EQ | null = null;

function ensureEQ(): EQ {
  if (eq) return eq;
  const ctx = getAudioContext();
  const bass = ctx.createBiquadFilter();
  bass.type = "lowshelf"; bass.frequency.value = 200; bass.gain.value = 0;
  const mid = ctx.createBiquadFilter();
  mid.type = "peaking"; mid.frequency.value = 1000; mid.Q.value = 0.9; mid.gain.value = 0;
  const treble = ctx.createBiquadFilter();
  treble.type = "highshelf"; treble.frequency.value = 4500; treble.gain.value = 0;
  eq = { bass, mid, treble, attached: false };
  return eq;
}

/**
 * Splice the EQ chain between masterGain and ctx.destination. Only call
 * once — subsequent touches just adjust filter gains.
 */
function attachEQOnce(): void {
  const e = ensureEQ();
  if (e.attached) return;
  const ctx = getAudioContext();
  const master = getMasterGain();
  try {
    master.disconnect();
  } catch { /* already disconnected */ }
  master.connect(e.bass).connect(e.mid).connect(e.treble).connect(ctx.destination);
  e.attached = true;
}

// ─── DOM lookups ─────────────────────────────────────────────────────────

function $<T extends HTMLElement>(id: string): T | null {
  return document.getElementById(id) as T | null;
}

let bound = false;
let unsub: (() => void) | null = null;
let rafId = 0;

// Spectrum bars are created once when the tab is first opened.
let spectrumBars: HTMLElement[] = [];

// Local UI state that doesn't belong to the engine.
const ui = {
  shuffle: true,
  recordedIds: new Set<string>(),
  voiceCmd: false,
  cameraCmd: false,
};

// ─── Helpers ─────────────────────────────────────────────────────────────

function fmtTime(secs: number): string {
  if (!isFinite(secs) || secs < 0) secs = 0;
  const m = Math.floor(secs / 60);
  const s = Math.floor(secs % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

function escapeHTML(s: string): string {
  return s
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function findStationFor(query: string): Station | null {
  const q = (query || "").toLowerCase().trim();
  return STATION_BY_QUERY.get(q) ?? null;
}

// ─── Renderers ───────────────────────────────────────────────────────────

function renderStations(): void {
  const list = $<HTMLUListElement>("radio-stations");
  if (!list) return;
  const snap = getDJSnapshot();
  const html = STATIONS.map(s => {
    const active = (snap.query?.toLowerCase() === s.query.toLowerCase());
    return `
      <li>
        <button class="radio-station ${active ? "is-active" : ""}"
                style="--st-hue:${s.hue}"
                data-station="${s.id}"
                data-query="${escapeHTML(s.query)}"
                title="Tune to ${escapeHTML(s.name)}">
          <span class="radio-station-emoji">${s.emoji}</span>
          <span class="radio-station-name">${escapeHTML(s.name)}</span>
          <span class="radio-station-tag">${escapeHTML(s.query)}</span>
        </button>
      </li>
    `;
  }).join("");
  list.innerHTML = html;
}

function renderQueue(): void {
  const list = $<HTMLUListElement>("radio-queue-list");
  const stationLbl = $<HTMLElement>("radio-queue-station");
  if (!list) return;
  const snap = getDJSnapshot();

  if (stationLbl) {
    const station = findStationFor(snap.query);
    stationLbl.textContent = station ? `${station.emoji}  ${station.name}` : (snap.query || "");
  }

  if (snap.results.length === 0) {
    list.innerHTML = `<li class="radio-queue-empty">Pick a station — the auto-DJ will queue tracks here.</li>`;
    return;
  }

  // Show up to 8 upcoming + the current track marked.
  const n = snap.results.length;
  const items: string[] = [];
  const limit = Math.min(n, 10);
  for (let off = 0; off < limit; off++) {
    const idx = (snap.currentIndex + off) % n;
    const t = snap.results[idx];
    if (!t) continue;
    const art = t.artwork?.["150x150"] || t.artwork?.["480x480"] || "";
    const artStyle = art ? `style="background-image:url('${escapeHTML(art)}')"` : "";
    const isCur = idx === snap.currentIndex;
    const dur = isFinite(t.duration) ? fmtTime(t.duration) : "";
    items.push(`
      <li class="radio-queue-item ${isCur ? "is-current" : ""}" data-index="${idx}">
        <span class="radio-queue-art" ${artStyle}></span>
        <span class="radio-queue-meta">
          <span class="radio-queue-title">${escapeHTML(t.title || "Untitled")}</span>
          <span class="radio-queue-artist">${escapeHTML(t.user?.name || t.user?.handle || "")}</span>
        </span>
        <span class="radio-queue-dur">${dur}</span>
        <span class="radio-queue-cue" aria-hidden="true">${isCur ? "▶" : ""}</span>
      </li>
    `);
  }
  list.innerHTML = items.join("");
}

function renderNowPlaying(): void {
  const snap = getDJSnapshot();
  const t = snap.current;

  const titleEl   = $<HTMLElement>("radio-now-title");
  const artistEl  = $<HTMLElement>("radio-now-artist");
  const stationEl = $<HTMLElement>("radio-now-station");
  const statusEl  = $<HTMLElement>("radio-now-status");
  const dotEl     = $<HTMLElement>("radio-now-dot");
  const artEl     = $<HTMLElement>("radio-vinyl-art");
  const vinyl     = $<HTMLElement>("radio-vinyl");
  const arm       = $<HTMLElement>("radio-arm");
  const playBtn   = $<HTMLButtonElement>("radio-play");
  const totalEl   = $<HTMLElement>("radio-progress-tot");

  if (titleEl)  titleEl.textContent  = t ? (t.title || "Untitled") : (snap.isLoading ? "Tuning…" : "Pick a station to start spinning");
  if (artistEl) artistEl.textContent = t ? (t.user?.name || t.user?.handle || "") : "JARVIS · DJ-7";
  if (stationEl) {
    const st = findStationFor(snap.query);
    stationEl.textContent = st ? `${st.emoji} ${st.name}` : snap.query || "— no station —";
  }
  if (statusEl) {
    statusEl.textContent = snap.error
      ? "ERROR"
      : snap.isLoading
        ? "TUNING"
        : snap.isPlaying
          ? "ON AIR"
          : t ? "PAUSED" : "READY";
    statusEl.classList.toggle("error", !!snap.error);
    statusEl.classList.toggle("on-air", !!snap.isPlaying);
  }
  if (dotEl) {
    dotEl.classList.toggle("on-air", !!snap.isPlaying);
    dotEl.classList.toggle("error", !!snap.error);
  }
  if (artEl) {
    const art = t?.artwork?.["480x480"] || t?.artwork?.["150x150"];
    if (art) {
      artEl.style.backgroundImage = `url("${art}")`;
      artEl.classList.add("has-art");
    } else {
      artEl.style.backgroundImage = "";
      artEl.classList.remove("has-art");
    }
  }
  if (vinyl) vinyl.dataset.spinning = String(!!snap.isPlaying);
  if (arm)   arm.dataset.active = String(!!snap.isPlaying || !!t);
  if (playBtn) playBtn.textContent = snap.isPlaying ? "⏸" : "▶";
  if (totalEl) totalEl.textContent = t ? fmtTime(t.duration ?? 0) : "0:00";
}

// ─── Spectrum + progress (per-frame ticker) ───────────────────────────────

function ensureSpectrum(): void {
  const root = $<HTMLElement>("radio-spectrum");
  if (!root) return;
  if (spectrumBars.length === 0) {
    const N = 32;
    root.innerHTML = Array.from({ length: N })
      .map(() => `<span class="radio-spec-bar"></span>`)
      .join("");
    spectrumBars = Array.from(root.querySelectorAll<HTMLElement>(".radio-spec-bar"));
  }
}

function tick(): void {
  rafId = requestAnimationFrame(tick);

  // Spectrum
  const an = djGetAnalyser();
  if (an && spectrumBars.length > 0) {
    an.analyser.getByteFrequencyData(an.freqData);
    const span = an.freqData.length;
    const n = spectrumBars.length;
    for (let i = 0; i < n; i++) {
      const fi = Math.floor((i / n) * span);
      const v = an.freqData[fi] / 255;
      spectrumBars[i].style.transform = `scaleY(${0.06 + v * 1.0})`;
      spectrumBars[i].style.opacity = String(0.45 + v * 0.55);
    }
  } else if (spectrumBars.length > 0) {
    // Idle wave so the panel doesn't look dead.
    const t = performance.now() * 0.0025;
    for (let i = 0; i < spectrumBars.length; i++) {
      const v = 0.12 + Math.abs(Math.sin(t + i * 0.32)) * 0.08;
      spectrumBars[i].style.transform = `scaleY(${v})`;
      spectrumBars[i].style.opacity = "0.55";
    }
  }

  // Progress
  const snap = getDJSnapshot();
  const audio = snap.audio;
  const fill = $<HTMLElement>("radio-progress-fill");
  const handle = $<HTMLElement>("radio-progress-handle");
  const cur = $<HTMLElement>("radio-progress-cur");
  if (audio && fill && handle) {
    const dur = isFinite(audio.duration) ? audio.duration : 0;
    const pct = dur > 0 ? Math.min(1, audio.currentTime / dur) : 0;
    fill.style.width = (pct * 100).toFixed(2) + "%";
    handle.style.left = (pct * 100).toFixed(2) + "%";
    if (cur) cur.textContent = fmtTime(audio.currentTime);
  } else {
    if (fill) fill.style.width = "0%";
    if (handle) handle.style.left = "0%";
    if (cur) cur.textContent = "0:00";
  }
}

// ─── Knob behaviour ───────────────────────────────────────────────────────
//
// Each knob is a circular DOM element rotated -135°..+135° to map a 0..1
// value (or a -1..+1 value for EQ bands). We drag vertically — natural for
// rack-style controls — and update the underlying parameter in real time.

interface KnobSpec {
  id: string;
  /** -1..1 for EQ, 0..1 for volume. */
  min: number;
  max: number;
  initial: number;
  onChange: (v: number) => void;
  format: (v: number) => string;
}

const knobState = new Map<string, number>();

function bindKnob(spec: KnobSpec): void {
  const dial = $<HTMLElement>(spec.id);
  if (!dial) return;
  const valEl = $<HTMLElement>(spec.id + "-val");
  let v = spec.initial;
  knobState.set(spec.id, v);
  const apply = (next: number) => {
    v = Math.max(spec.min, Math.min(spec.max, next));
    knobState.set(spec.id, v);
    const range = spec.max - spec.min;
    const pct = range > 0 ? (v - spec.min) / range : 0;
    const deg = -135 + pct * 270;
    dial.style.transform = `rotate(${deg.toFixed(1)}deg)`;
    if (valEl) valEl.textContent = spec.format(v);
    spec.onChange(v);
  };
  apply(v);

  let dragging = false;
  let startY = 0;
  let startV = v;

  const onMove = (e: MouseEvent) => {
    if (!dragging) return;
    const dy = startY - e.clientY;
    const range = spec.max - spec.min;
    apply(startV + (dy / 140) * range);
  };
  const onUp = () => {
    dragging = false;
    document.removeEventListener("mousemove", onMove);
    document.removeEventListener("mouseup", onUp);
    sfx.plock();
  };

  dial.addEventListener("mousedown", (e) => {
    dragging = true;
    startY = e.clientY;
    startV = v;
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
    e.preventDefault();
  });

  dial.addEventListener("wheel", (e) => {
    e.preventDefault();
    const range = spec.max - spec.min;
    const step = range / 60;
    apply(v + (e.deltaY > 0 ? -step : step));
  }, { passive: false });

  dial.addEventListener("dblclick", () => {
    apply(spec.initial);
    sfx.click();
  });
}

// ─── Voice command parsing ──────────────────────────────────────────────
//
// We intercept the mic transcript before it goes to chat. Returns true when
// we consumed the line as a radio command.

const STOP_WORDS = /^(stop|stop music|kill the music|silence|mute)\.?$/i;
const PAUSE_WORDS = /^(pause|pause music|hold (it|on))\.?$/i;
const PLAY_WORDS = /^(play|resume|continue|unpause|play music|play radio)\.?$/i;
const NEXT_WORDS = /^(next( track| song)?|skip|skip( the)? track)\.?$/i;
const PREV_WORDS = /^(previous( track)?|back|go back)\.?$/i;
const VOL_UP = /^(volume up|louder|turn (it )?up)\.?$/i;
const VOL_DOWN = /^(volume down|quieter|turn (it )?down)\.?$/i;
const PLAY_STATION = /^(?:put on|tune to|play|switch to)\s+(?:some\s+|the\s+)?(.+?)(?:\s+(?:music|station|radio))?\.?$/i;
const OPEN_RADIO = /^(open|show|go to)\s+(the\s+)?radio(\s+tab)?\.?$/i;

export function tryRadioVoiceCommand(raw: string): boolean {
  const text = raw.trim();
  if (!text) return false;

  if (OPEN_RADIO.test(text)) {
    document.querySelector<HTMLButtonElement>('.tab[data-tab="radio"]')?.click();
    return true;
  }
  if (STOP_WORDS.test(text)) {
    djPause();
    return true;
  }
  if (PAUSE_WORDS.test(text)) {
    djPause();
    return true;
  }
  if (PLAY_WORDS.test(text)) {
    ensureDJEngine();
    djPlay();
    return true;
  }
  if (NEXT_WORDS.test(text)) {
    djNext();
    return true;
  }
  if (PREV_WORDS.test(text)) {
    djPrev();
    return true;
  }
  if (VOL_UP.test(text)) {
    djSetVolume(Math.min(1, djGetVolume() + 0.15));
    refreshVolumeKnob();
    return true;
  }
  if (VOL_DOWN.test(text)) {
    djSetVolume(Math.max(0, djGetVolume() - 0.15));
    refreshVolumeKnob();
    return true;
  }

  // "play synthwave" / "tune to lo-fi" / "put on some jazz"
  const m = PLAY_STATION.exec(text);
  if (m) {
    const target = m[1].trim().toLowerCase();
    const station = STATIONS.find(s =>
      s.name.toLowerCase() === target ||
      s.query.toLowerCase() === target ||
      s.id === target,
    );
    const query = station?.query ?? target;
    if (query.length > 0 && query.length <= 60) {
      ensureDJEngine();
      void djSearch(query);
      return true;
    }
  }
  return false;
}

function refreshVolumeKnob(): void {
  // Sync the on-screen volume knob with the engine's current volume.
  const dial = $<HTMLElement>("radio-knob-vol");
  const valEl = $<HTMLElement>("radio-knob-vol-val");
  if (!dial) return;
  const v = djGetVolume();
  const deg = -135 + v * 270;
  dial.style.transform = `rotate(${deg.toFixed(1)}deg)`;
  if (valEl) valEl.textContent = String(Math.round(v * 100));
  knobState.set("radio-knob-vol", v);
}

// ─── Camera/gesture command surface ─────────────────────────────────────

export function isRadioCameraActive(): boolean { return ui.cameraCmd; }
export function isRadioVoiceActive(): boolean { return ui.voiceCmd; }

/**
 * Map a MediaPipe gesture name to a radio action. Called from gestures.ts
 * when the Radio tab is active and the user has enabled camera commands.
 */
export function tryRadioGestureCommand(gesture: string): boolean {
  switch (gesture) {
    case "Open_Palm":   djPause();        return true;
    case "Closed_Fist": djPause();        return true;
    case "Thumb_Up":    ensureDJEngine(); djPlay(); return true;
    case "Pointing_Up": djNext();         return true;
    case "Victory":     djPrev();         return true;
    case "Thumb_Down":  djSetVolume(Math.max(0, djGetVolume() - 0.1)); refreshVolumeKnob(); return true;
  }
  return false;
}

// ─── Tab activation lifecycle ───────────────────────────────────────────

function isTabActive(): boolean {
  const view = document.querySelector<HTMLElement>('.view[data-view="radio"]');
  return !!view?.classList.contains("active");
}

function bindOnce(): void {
  if (bound) return;
  bound = true;

  ensureSpectrum();
  renderStations();

  // Bind transport
  $<HTMLButtonElement>("radio-play")?.addEventListener("click", () => {
    sfx.click();
    ensureDJEngine();
    djTogglePlay();
  });
  $<HTMLButtonElement>("radio-next")?.addEventListener("click", () => { sfx.zip(); djNext(); });
  $<HTMLButtonElement>("radio-prev")?.addEventListener("click", () => { sfx.zip(); djPrev(); });
  $<HTMLButtonElement>("radio-shuffle")?.addEventListener("click", (e) => {
    ui.shuffle = !ui.shuffle;
    (e.currentTarget as HTMLElement).setAttribute("aria-pressed", String(ui.shuffle));
    sfx.pop();
  });
  $<HTMLButtonElement>("radio-record")?.addEventListener("click", () => {
    const t = getDJSnapshot().current;
    if (!t) return;
    ui.recordedIds.add(t.id);
    sfx.cash();
  });

  // Stations
  $<HTMLElement>("radio-stations")?.addEventListener("click", (e) => {
    const btn = (e.target as HTMLElement).closest<HTMLElement>("[data-query]");
    if (!btn) return;
    const q = btn.dataset.query!;
    sfx.zip();
    ensureDJEngine();
    void djSearch(q);
  });

  // Search box
  const searchInput = $<HTMLInputElement>("radio-search-input");
  const searchBtn = $<HTMLButtonElement>("radio-search-btn");
  const triggerSearch = () => {
    const q = searchInput?.value.trim();
    if (!q) return;
    sfx.zip();
    ensureDJEngine();
    void djSearch(q);
  };
  searchBtn?.addEventListener("click", triggerSearch);
  searchInput?.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); triggerSearch(); }
  });

  // Queue list
  $<HTMLElement>("radio-queue-list")?.addEventListener("click", (e) => {
    const item = (e.target as HTMLElement).closest<HTMLElement>("[data-index]");
    if (!item) return;
    const idx = Number(item.dataset.index);
    if (Number.isFinite(idx)) {
      sfx.pop();
      djPlayIndex(idx);
    }
  });

  // Progress scrubber — click to seek
  const bar = $<HTMLElement>("radio-progress-bar");
  bar?.addEventListener("click", (e) => {
    const rect = bar.getBoundingClientRect();
    if (rect.width <= 0) return;
    const frac = (e.clientX - rect.left) / rect.width;
    djSeekFraction(frac);
  });

  // Knobs — bind volume + 3 EQ bands
  bindKnob({
    id: "radio-knob-vol",
    min: 0, max: 1, initial: djGetVolume(),
    onChange: (v) => djSetVolume(v),
    format: (v) => String(Math.round(v * 100)),
  });
  bindKnob({
    id: "radio-knob-bass",
    min: -12, max: 12, initial: 0,
    onChange: (v) => { attachEQOnce(); ensureEQ().bass.gain.value = v; },
    format: (v) => `${v >= 0 ? "+" : ""}${v.toFixed(0)} dB`,
  });
  bindKnob({
    id: "radio-knob-mid",
    min: -12, max: 12, initial: 0,
    onChange: (v) => { attachEQOnce(); ensureEQ().mid.gain.value = v; },
    format: (v) => `${v >= 0 ? "+" : ""}${v.toFixed(0)} dB`,
  });
  bindKnob({
    id: "radio-knob-treble",
    min: -12, max: 12, initial: 0,
    onChange: (v) => { attachEQOnce(); ensureEQ().treble.gain.value = v; },
    format: (v) => `${v >= 0 ? "+" : ""}${v.toFixed(0)} dB`,
  });

  // Crossfader — purely cosmetic for the single deck (drives the visual
  // tilt + a small left/right pan via a StereoPannerNode).
  const xfader = $<HTMLInputElement>("radio-crossfader");
  xfader?.addEventListener("input", () => {
    const v = (Number(xfader.value) - 50) / 50; // -1..+1
    attachEQOnce();
    setPan(v);
  });

  // Voice / camera command toggles
  $<HTMLButtonElement>("radio-voice-cmd")?.addEventListener("click", () => {
    ui.voiceCmd = !ui.voiceCmd;
    const sub = $<HTMLElement>("radio-voice-sub");
    if (sub) sub.textContent = ui.voiceCmd ? "listening" : "off";
    $<HTMLButtonElement>("radio-voice-cmd")?.classList.toggle("is-on", ui.voiceCmd);
    sfx.plock();
  });
  $<HTMLButtonElement>("radio-camera-cmd")?.addEventListener("click", () => {
    ui.cameraCmd = !ui.cameraCmd;
    const sub = $<HTMLElement>("radio-camera-sub");
    if (sub) sub.textContent = ui.cameraCmd ? "watching" : "off";
    $<HTMLButtonElement>("radio-camera-cmd")?.classList.toggle("is-on", ui.cameraCmd);
    // If the camera isn't already streaming, ask the camera button to open.
    if (ui.cameraCmd) {
      const camBtn = document.getElementById("camera-toggle") as HTMLButtonElement | null;
      if (camBtn && !camBtn.classList.contains("camera-on")) camBtn.click();
    }
    sfx.plock();
  });
}

let panNode: StereoPannerNode | null = null;
function setPan(v: number): void {
  const ctx = getAudioContext();
  if (!panNode) {
    // We can't easily intercept the dj graph here, so use a transient node
    // that just sits in the master path created lazily — done by leaning
    // into attachEQOnce: we add a panner after the EQ chain.
    panNode = ctx.createStereoPanner();
    const e = ensureEQ();
    try { e.treble.disconnect(); } catch { /* ignore */ }
    e.treble.connect(panNode).connect(ctx.destination);
  }
  panNode.pan.value = Math.max(-1, Math.min(1, v));
}

function refresh(): void {
  if (!isTabActive()) return;
  renderStations();
  renderNowPlaying();
  renderQueue();
}

function startTicker(): void {
  if (rafId) return;
  rafId = requestAnimationFrame(tick);
}

function stopTicker(): void {
  if (rafId) cancelAnimationFrame(rafId);
  rafId = 0;
}

// ─── Public init ────────────────────────────────────────────────────────

export function initRadio(): void {
  // The view markup is in index.html; we just bind once and listen for tab
  // changes to start/stop the spectrum ticker.
  bindOnce();
  if (!unsub) unsub = subscribeDJ(refresh);

  const tabBtn = document.querySelector<HTMLButtonElement>('.tab[data-tab="radio"]');
  tabBtn?.addEventListener("click", () => {
    refresh();
    startTicker();
  });

  // If the radio tab is already active on boot for some reason, hydrate.
  if (isTabActive()) {
    refresh();
    startTicker();
  }

  // Pause the per-frame ticker when navigating away to save CPU.
  document.querySelectorAll<HTMLButtonElement>(".tab").forEach((t) => {
    t.addEventListener("click", () => {
      if (t.dataset.tab !== "radio") stopTicker();
    });
  });
}
