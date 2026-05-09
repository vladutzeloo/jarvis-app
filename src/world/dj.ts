// JARVIS — DJ NPC.
//
// One pawn on the holodeck ring, plus a floating "now playing" dock at the
// bottom-right. The DJ searches Audius (decentralized music, public API,
// no auth required) for tracks matching a genre query, picks one at random
// from the results, and plays it via an HTML5 <audio> element routed
// through the shared sfx AudioContext so we can also drive an analyser for
// audio-reactive visuals.
//
// Why Audius instead of SoundCloud: SoundCloud's public search API has
// been off the table for new app registrations for years. Audius gives us
// real search by genre, returns full streamable MP3 URLs with permissive
// CORS, and credits the original artists.

import { sfx, getAudioContext, getMasterGain } from "./sfx";
import type { NPCConfig } from "./npcs";

// ─── Audius client ───────────────────────────────────────────────────────

const APP_NAME = "jarvis-app";

interface AudiusTrack {
  id: string;
  title: string;
  duration: number;
  permalink?: string;
  user?: { name?: string; handle?: string };
  artwork?: { "150x150"?: string; "480x480"?: string; "1000x1000"?: string };
}

interface AudiusResponse<T> { data: T[] }

const DEFAULT_QUERIES = [
  "synthwave", "cyberpunk", "lo-fi", "electronic", "ambient",
  "chillwave", "vaporwave", "retrowave",
];

let cachedNodes: string[] | null = null;
async function getDiscoveryNodes(): Promise<string[]> {
  if (cachedNodes && cachedNodes.length) return cachedNodes;
  try {
    const res = await fetch("https://api.audius.co", { signal: AbortSignal.timeout(4000) });
    if (!res.ok) throw new Error(String(res.status));
    const j = await res.json() as { data?: string[] };
    cachedNodes = (j.data ?? []).filter(u => typeof u === "string" && u.startsWith("https://"));
    if (cachedNodes.length === 0) throw new Error("empty node list");
  } catch {
    // Fallback to a well-known stable node so we don't hard-fail on cold start.
    cachedNodes = ["https://discoveryprovider.audius.co"];
  }
  return cachedNodes;
}

async function audiusSearch(query: string, limit = 12): Promise<AudiusTrack[]> {
  const nodes = await getDiscoveryNodes();
  const node = nodes[(Math.random() * nodes.length) | 0];
  const url = `${node}/v1/tracks/search?query=${encodeURIComponent(query)}&app_name=${APP_NAME}&limit=${limit}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error(`audius search ${res.status}`);
  const j = await res.json() as AudiusResponse<AudiusTrack>;
  return j.data ?? [];
}

function streamUrl(trackId: string): string {
  // Stable node for streaming so we don't switch CDNs mid-track.
  return `https://discoveryprovider.audius.co/v1/tracks/${trackId}/stream?app_name=${APP_NAME}`;
}

// ─── Audio playback + analyser ────────────────────────────────────────────

interface Player {
  audio: HTMLAudioElement;
  source: MediaElementAudioSourceNode;
  analyser: AnalyserNode;
  freqData: Uint8Array;
}

let player: Player | null = null;

const STORAGE_MUSIC_VOL = "jarvis.music.volume";
let musicVolume = parseFloat(localStorage.getItem(STORAGE_MUSIC_VOL) ?? "0.7");

export function setMusicVolume(v: number): void {
  musicVolume = Math.max(0, Math.min(1, v));
  localStorage.setItem(STORAGE_MUSIC_VOL, String(musicVolume));
  if (player) player.audio.volume = musicVolume;
}

export function getMusicVolume(): number { return musicVolume; }

function ensurePlayer(): Player {
  if (player) return player;
  const audio = new Audio();
  audio.crossOrigin = "anonymous";
  audio.preload = "none";
  audio.volume = musicVolume;

  const ctx = getAudioContext();
  const source = ctx.createMediaElementSource(audio);
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 64;
  analyser.smoothingTimeConstant = 0.78;

  // Tap: source -> analyser -> master -> destination
  source.connect(analyser);
  analyser.connect(getMasterGain());

  const freqData = new Uint8Array(analyser.frequencyBinCount);
  player = { audio, source, analyser, freqData };
  return player;
}

/**
 * Returns a smoothed 0..1 audio level from the running analyser. Other
 * modules can poll this each frame to drive audio-reactive visuals.
 */
export function getAudioLevel(): number {
  if (!player) return 0;
  const { analyser, freqData } = player;
  analyser.getByteFrequencyData(freqData);
  let sum = 0;
  for (let i = 0; i < freqData.length; i++) sum += freqData[i];
  return sum / freqData.length / 255;
}

// ─── DJ controller ────────────────────────────────────────────────────────

interface DJState {
  query: string;
  results: AudiusTrack[];
  currentIndex: number;
  isPlaying: boolean;
  isLoading: boolean;
  error: string | null;
}

const state: DJState = {
  query: DEFAULT_QUERIES[(Math.random() * DEFAULT_QUERIES.length) | 0],
  results: [],
  currentIndex: -1,
  isPlaying: false,
  isLoading: false,
  error: null,
};

const listeners: Array<() => void> = [];
function notify() { for (const fn of listeners) fn(); }
function subscribe(fn: () => void): () => void {
  listeners.push(fn);
  return () => { const i = listeners.indexOf(fn); if (i >= 0) listeners.splice(i, 1); };
}

async function searchAndPick(query: string): Promise<void> {
  state.query = query;
  state.isLoading = true;
  state.error = null;
  notify();
  try {
    const results = await audiusSearch(query, 16);
    if (results.length === 0) {
      state.results = [];
      state.error = `No tracks found for "${query}"`;
    } else {
      state.results = results;
      state.currentIndex = (Math.random() * results.length) | 0;
      await playCurrent();
    }
  } catch (e) {
    state.error = `Audius search failed: ${(e as Error).message ?? e}`;
  } finally {
    state.isLoading = false;
    notify();
  }
}

async function playCurrent(): Promise<void> {
  const track = state.results[state.currentIndex];
  if (!track) return;
  const p = ensurePlayer();
  // Always reload — assigning .src triggers a fresh load.
  p.audio.src = streamUrl(track.id);
  try {
    await p.audio.play();
    state.isPlaying = true;
    sfx.discover();
  } catch (e) {
    state.isPlaying = false;
    state.error = `Playback failed: ${(e as Error).message ?? e}`;
  }
  notify();
}

function pause(): void {
  if (!player) return;
  player.audio.pause();
  state.isPlaying = false;
  notify();
}

function resume(): void {
  if (!player) return;
  player.audio.play().then(() => {
    state.isPlaying = true;
    notify();
  }).catch(() => {
    state.isPlaying = false;
    notify();
  });
}

function nextTrack(): void {
  if (state.results.length === 0) {
    void searchAndPick(state.query);
    return;
  }
  // Random next so the rotation feels like discovery, not sequential play.
  let next = state.currentIndex;
  if (state.results.length > 1) {
    while (next === state.currentIndex) {
      next = (Math.random() * state.results.length) | 0;
    }
  }
  state.currentIndex = next;
  void playCurrent();
}

// ─── HUD dock ────────────────────────────────────────────────────────────

let dockOpen = false;
let dockUnsub: (() => void) | null = null;
const dockRoot = (): HTMLElement | null => document.getElementById("dj-dock");

function buildDock(): void {
  const root = dockRoot();
  if (!root) return;
  root.innerHTML = `
    <div class="dj-dock-card">
      <div class="dj-dock-header">
        <div class="dj-dock-title">DJ-7 · NOW PLAYING</div>
        <button class="dj-dock-close" type="button" data-dj-close title="Close">×</button>
      </div>

      <div class="dj-dock-track">
        <div class="dj-dock-art" data-dj-art></div>
        <div class="dj-dock-meta">
          <div class="dj-dock-track-title" data-dj-track-title>Idle</div>
          <div class="dj-dock-track-artist" data-dj-track-artist></div>
          <div class="dj-dock-track-status" data-dj-status></div>
        </div>
      </div>

      <div class="dj-dock-vis" data-dj-vis>
        ${Array.from({ length: 16 }).map(() => `<span class="dj-dock-vis-bar"></span>`).join("")}
      </div>

      <div class="dj-dock-controls">
        <button type="button" data-dj-play title="Play / pause">▶</button>
        <button type="button" data-dj-next title="Next discovery">⏭</button>
        <input type="text" data-dj-query placeholder="genre / artist…" spellcheck="false" />
        <button type="button" data-dj-search title="Search Audius">🔍</button>
      </div>

      <div class="dj-dock-hint">via Audius · click 🔍 to discover new tracks</div>
    </div>
  `;

  // Defensively guard each lookup so a future markup tweak doesn't crash.
  const closeBtn = root.querySelector<HTMLButtonElement>("[data-dj-close]");
  const playBtn  = root.querySelector<HTMLButtonElement>("[data-dj-play]");
  const nextBtn  = root.querySelector<HTMLButtonElement>("[data-dj-next]");
  const searchBtn= root.querySelector<HTMLButtonElement>("[data-dj-search]");
  const queryEl  = root.querySelector<HTMLInputElement>("[data-dj-query]");

  closeBtn?.addEventListener("click", () => closeDock());
  playBtn?.addEventListener("click", () => {
    if (state.results.length === 0) {
      const q = queryEl?.value.trim() || state.query;
      void searchAndPick(q);
    } else if (state.isPlaying) {
      pause();
      sfx.click();
    } else {
      resume();
      sfx.click();
    }
  });
  nextBtn?.addEventListener("click", () => {
    nextTrack();
    sfx.click();
  });
  const triggerSearch = () => {
    const q = queryEl?.value.trim();
    if (!q) return;
    void searchAndPick(q);
    sfx.click();
  };
  searchBtn?.addEventListener("click", triggerSearch);
  queryEl?.addEventListener("keydown", e => {
    if (e.key === "Enter") {
      e.preventDefault();
      triggerSearch();
    }
  });
  if (queryEl) queryEl.value = state.query;
}

function refreshDock(): void {
  const root = dockRoot();
  if (!root || !dockOpen) return;
  const track = state.results[state.currentIndex];
  const titleEl  = root.querySelector<HTMLElement>("[data-dj-track-title]");
  const artistEl = root.querySelector<HTMLElement>("[data-dj-track-artist]");
  const statusEl = root.querySelector<HTMLElement>("[data-dj-status]");
  const playBtn  = root.querySelector<HTMLButtonElement>("[data-dj-play]");
  const artEl    = root.querySelector<HTMLElement>("[data-dj-art]");

  if (titleEl)  titleEl.textContent  = track?.title ?? (state.isLoading ? "Searching…" : "Idle");
  if (artistEl) artistEl.textContent = track?.user?.name ?? track?.user?.handle ?? "";
  if (statusEl) {
    statusEl.textContent = state.error
      ? state.error
      : state.isPlaying ? "PLAYING" : track ? "PAUSED" : "READY";
    statusEl.classList.toggle("error", !!state.error);
  }
  if (playBtn) playBtn.textContent = state.isPlaying ? "⏸" : "▶";
  if (artEl) {
    const art = track?.artwork?.["480x480"] ?? track?.artwork?.["150x150"];
    if (art) {
      artEl.style.backgroundImage = `url("${art}")`;
      artEl.classList.add("has-art");
    } else {
      artEl.style.backgroundImage = "";
      artEl.classList.remove("has-art");
    }
  }
}

function tickDockVis(): void {
  const root = dockRoot();
  if (!root || !dockOpen) return;
  const bars = root.querySelectorAll<HTMLElement>(".dj-dock-vis-bar");
  if (bars.length === 0) return;
  if (!player || !state.isPlaying) {
    // idle state: subtle wave
    const t = performance.now() * 0.002;
    bars.forEach((b, i) => {
      const v = 0.15 + Math.abs(Math.sin(t + i * 0.4)) * 0.1;
      b.style.transform = `scaleY(${v})`;
    });
    return;
  }
  player.analyser.getByteFrequencyData(player.freqData);
  const n = bars.length;
  const span = player.freqData.length;
  for (let i = 0; i < n; i++) {
    const fi = Math.floor((i / n) * span);
    const v = player.freqData[fi] / 255;
    bars[i].style.transform = `scaleY(${0.05 + v * 1.0})`;
  }
}

function openDock(): void {
  const root = dockRoot();
  if (!root) return;
  if (!dockOpen) {
    buildDock();
    dockOpen = true;
    root.classList.remove("hidden");
    dockUnsub = subscribe(refreshDock);
  }
  refreshDock();
  // Kick a discovery search if the user opened the dock cold.
  if (state.results.length === 0 && !state.isLoading) {
    void searchAndPick(state.query);
  }
}

function closeDock(): void {
  const root = dockRoot();
  if (root) root.classList.add("hidden");
  dockOpen = false;
  if (dockUnsub) { dockUnsub(); dockUnsub = null; }
  // Don't pause music when closing — let it keep playing in the background.
}

// Track-end hook: when the current track ends, auto-roll to the next so the
// DJ keeps spinning.
function attachAutoNext(): void {
  if (!player) return;
  player.audio.addEventListener("ended", () => {
    if (state.results.length > 0) nextTrack();
  });
}

// Re-attach autoNext after first ensurePlayer; safe to call again later.
let autoNextAttached = false;

export interface DJHandle {
  npcConfig: NPCConfig;
  open: () => void;
  close: () => void;
  step: () => void;
  dispose: () => void;
}

export function initDJ(): DJHandle {
  const npcConfig: NPCConfig = {
    id: "dj",
    name: "DJ-7",
    tag: "AUDIUS",
    color: 0xff8c00,
    onClick: () => {
      sfx.click();
      // Lazily build the audio graph the first time the user opens the dock.
      if (!autoNextAttached) {
        ensurePlayer();
        attachAutoNext();
        autoNextAttached = true;
      }
      openDock();
    },
  };

  function step(): void {
    tickDockVis();
  }

  function dispose(): void {
    if (player) {
      player.audio.pause();
      player.source.disconnect();
      player.analyser.disconnect();
    }
    closeDock();
  }

  return { npcConfig, open: openDock, close: closeDock, step, dispose };
}
