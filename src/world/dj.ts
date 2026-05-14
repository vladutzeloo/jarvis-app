// JARVIS - DJ NPC.
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
import { PIPER_BASE } from "../types";

// ----- Audius client -----------------------------------------------------

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
  return `https://discoveryprovider.audius.co/v1/tracks/${trackId}/stream?app_name=${APP_NAME}`;
}

// ----- Audio playback + analyser -----------------------------------------

interface Player {
  audio: HTMLAudioElement;
  source: MediaElementAudioSourceNode;
  analyser: AnalyserNode;
  musicGain: GainNode;
  freqData: Uint8Array;
}

const STORAGE_MUSIC_VOL = "jarvis.music.volume";
let _musicVolume = Math.max(0, Math.min(1, parseFloat(localStorage.getItem(STORAGE_MUSIC_VOL) ?? "0.7")));

let player: Player | null = null;

function ensurePlayer(): Player {
  if (player) return player;
  const audio = new Audio();
  audio.crossOrigin = "anonymous";
  audio.preload = "none";
  audio.volume = _musicVolume;

  const ctx = getAudioContext();
  const source = ctx.createMediaElementSource(audio);
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 64;
  analyser.smoothingTimeConstant = 0.78;
  const musicGain = ctx.createGain();
  musicGain.gain.value = 1.0;

  source.connect(analyser);
  analyser.connect(musicGain);
  musicGain.connect(getMasterGain());

  const freqData = new Uint8Array(analyser.frequencyBinCount);
  player = { audio, source, analyser, musicGain, freqData };
  return player;
}

function duckMusic(level: number, dur = 0.25): void {
  if (!player) return;
  const ctx = getAudioContext();
  const t = ctx.currentTime;
  player.musicGain.gain.cancelScheduledValues(t);
  player.musicGain.gain.setTargetAtTime(Math.max(0.0001, level), t, Math.max(0.05, dur / 3));
}

// ----- DJ voice (Piper TTS announcer) ------------------------------------

let piperReachable: boolean | null = null;
let activeAnnouncement: { audio: HTMLAudioElement; cleanup: () => void } | null = null;

async function piperOk(): Promise<boolean> {
  if (piperReachable === true) return true;
  if (piperReachable === false) return false;
  try {
    const res = await fetch(`${PIPER_BASE}/health`, { signal: AbortSignal.timeout(800) });
    piperReachable = res.ok;
  } catch {
    piperReachable = false;
  }
  return piperReachable;
}

function stopAnnouncement(): void {
  if (!activeAnnouncement) return;
  try {
    activeAnnouncement.audio.pause();
    activeAnnouncement.audio.src = "";
  } catch { /* ignore */ }
  try { activeAnnouncement.cleanup(); } catch { /* ignore */ }
  activeAnnouncement = null;
}

async function speak(line: string): Promise<void> {
  const text = line.trim();
  if (!text) return;
  if (!await piperOk()) return;

  let blob: Blob;
  try {
    const res = await fetch(`${PIPER_BASE}/tts`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text, style: "dj" }),
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return;
    blob = await res.blob();
  } catch {
    piperReachable = false;
    return;
  }

  stopAnnouncement();

  const url = URL.createObjectURL(blob);
  const audio = new Audio(url);
  audio.crossOrigin = "anonymous";
  audio.preload = "auto";

  const ctx = getAudioContext();
  let source: MediaElementAudioSourceNode | null = null;
  let voiceGain: GainNode | null = null;
  try {
    source = ctx.createMediaElementSource(audio);
    voiceGain = ctx.createGain();
    voiceGain.gain.value = 1.05;
    source.connect(voiceGain).connect(getMasterGain());
  } catch {
    source = null;
    voiceGain = null;
  }

  const cleanup = () => {
    try { source?.disconnect(); } catch { /* ignore */ }
    try { voiceGain?.disconnect(); } catch { /* ignore */ }
    URL.revokeObjectURL(url);
  };

  duckMusic(0.22, 0.18);
  activeAnnouncement = { audio, cleanup };

  await new Promise<void>((resolve) => {
    const finish = () => {
      if (activeAnnouncement?.audio === audio) activeAnnouncement = null;
      cleanup();
      duckMusic(1.0, 0.4);
      resolve();
    };
    audio.addEventListener("ended", finish, { once: true });
    audio.addEventListener("error", finish, { once: true });
    audio.play().catch(() => finish());
  });
}

function announcementFor(track: AudiusTrack): string {
  const title = (track.title || "").trim();
  const artist = (track.user?.name || track.user?.handle || "").trim();
  if (title && artist) return `Now playing: ${title}, by ${artist}.`;
  if (title) return `Now playing: ${title}.`;
  return "Now spinning a fresh one.";
}

export function getAudioLevel(): number {
  if (!player) return 0;
  const { analyser, freqData } = player;
  analyser.getByteFrequencyData(freqData);
  let sum = 0;
  for (let i = 0; i < freqData.length; i++) sum += freqData[i];
  return sum / freqData.length / 255;
}

// ----- DJ controller -----------------------------------------------------

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
  stopAnnouncement();
  p.audio.src = streamUrl(track.id);
  try {
    await p.audio.play();
    state.isPlaying = true;
    sfx.whoosh();
  } catch (e) {
    state.isPlaying = false;
    state.error = `Playback failed: ${(e as Error).message ?? e}`;
  }
  notify();
  void speak(announcementFor(track));
}

function playByIndex(i: number): void {
  if (i < 0 || i >= state.results.length) return;
  if (i === state.currentIndex && state.isPlaying) return;
  state.currentIndex = i;
  void playCurrent();
}

function getSuggestions(): AudiusTrack[] {
  if (state.results.length <= 1) return [];
  const out: AudiusTrack[] = [];
  const n = state.results.length;
  for (let off = 1; off < n && out.length < 3; off++) {
    const idx = (state.currentIndex + off) % n;
    out.push(state.results[idx]);
  }
  return out;
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
  let next = state.currentIndex;
  if (state.results.length > 1) {
    while (next === state.currentIndex) {
      next = (Math.random() * state.results.length) | 0;
    }
  }
  state.currentIndex = next;
  void playCurrent();
}

// ----- HUD dock ----------------------------------------------------------

let dockOpen = false;
let dockUnsub: (() => void) | null = null;
const dockRoot = (): HTMLElement | null => document.getElementById("dj-dock");

function buildDock(): void {
  const root = dockRoot();
  if (!root) return;
  root.innerHTML = `
    <div class="dj-dock-card">
      <div class="dj-dock-header">
        <div class="dj-dock-title">DJ-7 - NOW PLAYING</div>
        <button class="dj-dock-close" type="button" data-dj-close title="Close" aria-label="Close DJ interface">x</button>
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
      <div class="dj-dock-suggestions" data-dj-suggestions>
        <div class="dj-dock-suggestions-label">SIMILAR TRACKS</div>
        <ul class="dj-dock-suggestions-list" data-dj-suggestions-list></ul>
      </div>
      <div class="dj-dock-controls">
        <button type="button" data-dj-play title="Play / pause" aria-label="Play or pause track">&#9654;</button>
        <button type="button" data-dj-next title="Next discovery" aria-label="Next track">&#9197;</button>
        <input type="text" data-dj-query placeholder="genre / artist..." spellcheck="false" aria-label="Search query" />
        <button type="button" data-dj-search title="Search Audius" aria-label="Search">&#128269;</button>
      </div>
      <div class="dj-dock-hint">via Audius - click to discover new tracks</div>
    </div>
  `;

  const closeBtn = root.querySelector<HTMLButtonElement>("[data-dj-close]");
  const playBtn  = root.querySelector<HTMLButtonElement>("[data-dj-play]");
  const nextBtn  = root.querySelector<HTMLButtonElement>("[data-dj-next]");
  const searchBtn= root.querySelector<HTMLButtonElement>("[data-dj-search]");
  const queryEl  = root.querySelector<HTMLInputElement>("[data-dj-query]");

  closeBtn?.addEventListener("click", () => { sfx.plock(); closeDock(); });
  playBtn?.addEventListener("click", () => {
    if (state.results.length === 0) {
      const q = queryEl?.value.trim() || state.query;
      sfx.zip();
      void searchAndPick(q);
    } else if (state.isPlaying) {
      sfx.plock();
      pause();
    } else {
      sfx.plock();
      resume();
    }
  });
  nextBtn?.addEventListener("click", () => {
    sfx.zip();
    nextTrack();
  });
  const triggerSearch = () => {
    const q = queryEl?.value.trim();
    if (!q) return;
    sfx.zip();
    void searchAndPick(q);
  };
  searchBtn?.addEventListener("click", triggerSearch);
  queryEl?.addEventListener("keydown", e => {
    if (e.key === "Enter") {
      e.preventDefault();
      triggerSearch();
    }
  });
  if (queryEl) queryEl.value = state.query;

  const suggList = root.querySelector<HTMLElement>("[data-dj-suggestions-list]");
  suggList?.addEventListener("click", (e) => {
    const item = (e.target as HTMLElement).closest<HTMLElement>("[data-dj-suggestion]");
    if (!item) return;
    const idx = Number(item.dataset.djSuggestion);
    if (Number.isFinite(idx)) {
      sfx.pop();
      playByIndex(idx);
    }
  });
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

  if (titleEl)  titleEl.textContent  = track?.title ?? (state.isLoading ? "Searching..." : "Idle");
  if (artistEl) artistEl.textContent = track?.user?.name ?? track?.user?.handle ?? "";
  if (statusEl) {
    statusEl.textContent = state.error
      ? state.error
      : state.isPlaying ? "PLAYING" : track ? "PAUSED" : "READY";
    statusEl.classList.toggle("error", !!state.error);
  }
  if (playBtn) playBtn.innerHTML = state.isPlaying ? "&#9208;" : "&#9654;";
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

  const suggWrap = root.querySelector<HTMLElement>("[data-dj-suggestions]");
  const suggList = root.querySelector<HTMLElement>("[data-dj-suggestions-list]");
  if (suggWrap && suggList) {
    const suggestions = getSuggestions();
    if (suggestions.length === 0) {
      suggWrap.classList.add("hidden");
      suggList.innerHTML = "";
    } else {
      suggWrap.classList.remove("hidden");
      const html = suggestions.map((t) => {
        const idx = state.results.indexOf(t);
        const title = escapeText(t.title || "Untitled");
        const artist = escapeText(t.user?.name || t.user?.handle || "");
        const art = t.artwork?.["150x150"] || t.artwork?.["480x480"] || "";
        const artStyle = art ? `style="background-image:url('${escapeAttr(art)}')"` : "";
        return `
          <li class="dj-dock-suggestion" data-dj-suggestion="${idx}" title="Play: ${title}">
            <span class="dj-dock-suggestion-art" ${artStyle}></span>
            <span class="dj-dock-suggestion-meta">
              <span class="dj-dock-suggestion-title">${title}</span>
              <span class="dj-dock-suggestion-artist">${artist}</span>
            </span>
            <span class="dj-dock-suggestion-play" aria-hidden="true">&#9654;</span>
          </li>`;
      }).join("");
      suggList.innerHTML = html;
    }
  }
}

function escapeText(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
function escapeAttr(s: string): string { return escapeText(s); }

function tickDockVis(): void {
  const root = dockRoot();
  if (!root || !dockOpen) return;
  const bars = root.querySelectorAll<HTMLElement>(".dj-dock-vis-bar");
  if (bars.length === 0) return;
  if (!player || !state.isPlaying) {
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
  if (state.results.length === 0 && !state.isLoading) {
    void searchAndPick(state.query);
  }
}

function closeDock(): void {
  const root = dockRoot();
  if (root) root.classList.add("hidden");
  dockOpen = false;
  if (dockUnsub) { dockUnsub(); dockUnsub = null; }
}

function attachAutoNext(): void {
  if (!player) return;
  player.audio.addEventListener("ended", () => {
    if (state.results.length > 0) nextTrack();
  });
}

let autoNextAttached = false;

// ----- Public DJ controller API ------------------------------------------
//
// These exports let other modules (e.g. the Radio tab) drive the same audio
// engine, share the analyser-driven visualizer, and react to track changes.

export type DJSubscriber = () => void;

export interface DJSnapshot {
  query: string;
  results: AudiusTrack[];
  currentIndex: number;
  isPlaying: boolean;
  isLoading: boolean;
  error: string | null;
  current: AudiusTrack | null;
  audio: HTMLAudioElement | null;
}

export function ensureDJEngine(): void {
  ensurePlayer();
  if (!autoNextAttached) {
    attachAutoNext();
    autoNextAttached = true;
  }
}

export function getDJSnapshot(): DJSnapshot {
  return {
    query: state.query,
    results: state.results,
    currentIndex: state.currentIndex,
    isPlaying: state.isPlaying,
    isLoading: state.isLoading,
    error: state.error,
    current: state.results[state.currentIndex] ?? null,
    audio: player?.audio ?? null,
  };
}

export function subscribeDJ(fn: DJSubscriber): () => void {
  return subscribe(fn);
}

export function djSearch(query: string): Promise<void> {
  return searchAndPick(query);
}

export function djPlay(): void {
  if (state.results.length === 0) {
    void searchAndPick(state.query);
    return;
  }
  if (state.isPlaying) return;
  resume();
}

export function djPause(): void { pause(); }

export function djTogglePlay(): void {
  if (state.results.length === 0) {
    void searchAndPick(state.query);
    return;
  }
  if (state.isPlaying) pause(); else resume();
}

export function djNext(): void { nextTrack(); }

export function djPrev(): void {
  if (state.results.length === 0) return;
  const n = state.results.length;
  let i = state.currentIndex - 1;
  if (i < 0) i = n - 1;
  state.currentIndex = i;
  void playCurrent();
}

export function djPlayIndex(i: number): void { playByIndex(i); }

export function djSetVolume(v: number): void {
  _musicVolume = Math.max(0, Math.min(1, v));
  localStorage.setItem(STORAGE_MUSIC_VOL, String(_musicVolume));
  if (player) player.audio.volume = _musicVolume;
}

export function djGetVolume(): number {
  return _musicVolume;
}

export function djGetAnalyser(): { analyser: AnalyserNode; freqData: Uint8Array } | null {
  if (!player) return null;
  return { analyser: player.analyser, freqData: player.freqData };
}

export function djSeekFraction(frac: number): void {
  if (!player) return;
  const dur = player.audio.duration;
  if (!isFinite(dur) || dur <= 0) return;
  player.audio.currentTime = Math.max(0, Math.min(dur, dur * Math.max(0, Math.min(1, frac))));
}

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
