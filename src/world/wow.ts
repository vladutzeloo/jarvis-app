// JARVIS — WOW mode (Warcraft III sound-hook flavor).
//
// Inspired by github.com/warmwind/warcraft3-claude-code-sound-hook, but
// re-cast for the chat experience instead of Claude Code CLI hooks. We pick
// a random race once per browser session, then play a race-flavored cue at
// three points:
//
//   • accept   — user submits a prompt (send button or Enter)
//   • ask      — JARVIS needs the user (incoming-call notification)
//   • complete — assistant finishes streaming a reply
//
// Audio is synthesised on the Web Audio graph (no shipped clips, no
// Blizzard copyright in the bundle). Each race uses a distinct timbre and
// scale so the four feel different without us shipping a single .wav. If
// the user drops their own files in `public/wow/<race>/<event>.{mp3,ogg,wav}`
// (e.g. their own ripped voice lines), those are preferred at runtime.
//
// State lives in localStorage (enabled, volume) + sessionStorage (race),
// matching the original repo's "race is consistent for one session".

import { getAudioContext } from "./sfx";

type Race = "human" | "orc" | "undead" | "nightelf";
type WowEvent = "accept" | "ask" | "complete";

const RACES: Race[] = ["human", "orc", "undead", "nightelf"];

const STORAGE_ENABLED = "jarvis.wow.enabled";
const STORAGE_VOLUME  = "jarvis.wow.volume";
const SESSION_RACE    = "jarvis.wow.race";

let enabled = localStorage.getItem(STORAGE_ENABLED) === "1";
let volume  = (() => {
  const raw = parseFloat(localStorage.getItem(STORAGE_VOLUME) || "0.6");
  return Number.isFinite(raw) ? Math.max(0, Math.min(1, raw)) : 0.6;
})();
let race: Race = (() => {
  const stored = sessionStorage.getItem(SESSION_RACE);
  if (stored && (RACES as string[]).includes(stored)) return stored as Race;
  const picked = RACES[Math.floor(Math.random() * RACES.length)];
  sessionStorage.setItem(SESSION_RACE, picked);
  return picked;
})();

let wowGain: GainNode | null = null;

function gain(): GainNode {
  if (!wowGain) {
    const c = getAudioContext();
    wowGain = c.createGain();
    wowGain.gain.value = volume;
    // Bypass the sfx master gain — the global SFX mute and WOW mode are
    // independent toggles in the user's mind, so we route straight out.
    wowGain.connect(c.destination);
  }
  return wowGain;
}

// ─── File overrides ────────────────────────────────────────────────────────
//
// On first play of (race,event), probe `/wow/<race>/<event>.{mp3|ogg|wav}`.
// Cache the resolved URL or `null` (= use synth) so we only HEAD once per
// pair per session.

const fileCache = new Map<string, string | null>();

async function tryFile(r: Race, e: WowEvent): Promise<HTMLAudioElement | null> {
  const key = `${r}/${e}`;
  if (!fileCache.has(key)) {
    let found: string | null = null;
    for (const ext of ["mp3", "ogg", "wav"]) {
      const url = `/wow/${r}/${e}.${ext}`;
      try {
        const res = await fetch(url, { method: "HEAD" });
        if (res.ok) { found = url; break; }
      } catch { /* CORS / 404 — fall through */ }
    }
    fileCache.set(key, found);
  }
  const url = fileCache.get(key);
  if (!url) return null;
  const audio = new Audio(url);
  audio.volume = volume;
  return audio;
}

// ─── Synthesis ─────────────────────────────────────────────────────────────
//
// Each race has a distinct voice (oscillator type, base frequency, scale
// degrees) so the cues feel tonally different without shipping audio assets.
// Notes are expressed as semitones above the race's base.

interface Voice {
  type: OscillatorType;
  base: number;       // Hz of scale-degree 0
  noteDur: number;    // seconds per note
  spacing: number;    // start-to-start gap; 0 = single note
  vol: number;        // peak gain per note
  detune?: number;    // cents — used for "off" feel
  noise?: boolean;    // overlay a short noise burst on attack
  notes: Record<WowEvent, number[]>;
}

const VOICES: Record<Race, Voice> = {
  // Human — bright, classic fanfare
  human: {
    type: "square", base: 392, noteDur: 0.18, spacing: 0.12, vol: 0.16,
    notes: {
      accept:   [0, 7],
      ask:      [4],
      complete: [0, 4, 7, 12],
    },
  },
  // Orc — low, gritty, with a thunky noise transient
  orc: {
    type: "sawtooth", base: 147, noteDur: 0.22, spacing: 0.13, vol: 0.18,
    noise: true,
    notes: {
      accept:   [0, 5],
      ask:      [0],
      complete: [0, 3, 5, 8],
    },
  },
  // Undead — minor third, slightly detuned for a haunted feel
  undead: {
    type: "triangle", base: 220, noteDur: 0.28, spacing: 0.16, vol: 0.14,
    detune: -15,
    notes: {
      accept:   [0, 3],
      ask:      [3],
      complete: [0, 3, 7, 10],
    },
  },
  // Night Elf — high, bell-like sine harmonics
  nightelf: {
    type: "sine", base: 783, noteDur: 0.10, spacing: 0.07, vol: 0.13,
    notes: {
      accept:   [0, 7, 12],
      ask:      [12],
      complete: [0, 4, 7, 12, 16],
    },
  },
};

function synth(r: Race, e: WowEvent): void {
  const v = VOICES[r];
  const c = getAudioContext();
  const t0 = c.currentTime;
  const out = gain();

  const seq = v.notes[e];
  for (let i = 0; i < seq.length; i++) {
    const start = t0 + i * v.spacing;
    const freq = v.base * Math.pow(2, seq[i] / 12);
    const osc = c.createOscillator();
    osc.type = v.type;
    osc.frequency.setValueAtTime(freq, start);
    if (v.detune) osc.detune.value = v.detune;

    const g = c.createGain();
    g.gain.setValueAtTime(0, start);
    g.gain.linearRampToValueAtTime(v.vol, start + 0.008);
    g.gain.exponentialRampToValueAtTime(0.0001, start + v.noteDur);
    osc.connect(g).connect(out);
    osc.start(start);
    osc.stop(start + v.noteDur + 0.02);
  }

  if (v.noise) {
    const dur = 0.08;
    const buf = c.createBuffer(1, Math.max(1, Math.floor(c.sampleRate * dur)), c.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < data.length; i++) {
      data[i] = (Math.random() * 2 - 1) * (1 - i / data.length) * 0.5;
    }
    const src = c.createBufferSource();
    src.buffer = buf;
    const ng = c.createGain();
    ng.gain.value = v.vol * 0.6;
    src.connect(ng).connect(out);
    src.start(t0);
  }
}

async function play(e: WowEvent): Promise<void> {
  if (!enabled) return;
  try {
    const audio = await tryFile(race, e);
    if (audio) {
      try { await audio.play(); return; } catch { /* fall through to synth */ }
    }
  } catch { /* ignore */ }
  synth(race, e);
}

// ─── Public API ────────────────────────────────────────────────────────────

export function isWowEnabled(): boolean { return enabled; }

export function setWowEnabled(on: boolean): void {
  enabled = on;
  localStorage.setItem(STORAGE_ENABLED, on ? "1" : "0");
  if (on) void play("accept"); // audible confirmation when toggling on
}

export function getWowVolume(): number { return volume; }

export function setWowVolume(v: number): void {
  volume = Math.max(0, Math.min(1, v));
  localStorage.setItem(STORAGE_VOLUME, String(volume));
  if (wowGain) wowGain.gain.value = volume;
}

export function getWowRace(): Race { return race; }

export function rerollWowRace(): Race {
  let next = race;
  // Force a different race so the button always feels responsive.
  while (RACES.length > 1 && next === race) {
    next = RACES[Math.floor(Math.random() * RACES.length)];
  }
  race = next;
  sessionStorage.setItem(SESSION_RACE, race);
  fileCache.clear(); // re-probe overrides for the new race on next play
  return race;
}

export function setWowRace(r: Race): void {
  if (!RACES.includes(r) || r === race) return;
  race = r;
  sessionStorage.setItem(SESSION_RACE, race);
  fileCache.clear();
}

export function previewWowRace(): void {
  // Used by the settings drawer "test" button — bypasses the enabled flag
  // so users can audition voices without committing.
  void (async () => {
    try {
      const audio = await tryFile(race, "complete");
      if (audio) { await audio.play(); return; }
    } catch { /* ignore */ }
    synth(race, "complete");
  })();
}

export const WOW_RACES: readonly Race[] = RACES;

// ─── Event hooks ───────────────────────────────────────────────────────────
//
// We hook the existing DOM directly so the rest of the codebase doesn't
// need to know WOW mode exists. Delete this file + its index.html section
// + its main.ts import and the app behaves exactly as before.

// Accept — user submits a prompt
const sendBtn = document.getElementById("send");
const chatInput = document.getElementById("input") as HTMLTextAreaElement | null;

const onAccept = () => {
  if (!enabled) return;
  if (chatInput && chatInput.value.trim()) void play("accept");
};

sendBtn?.addEventListener("click", onAccept);
chatInput?.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) onAccept();
});

// Complete — assistant message stops streaming. The chat module adds
// `streaming` to the assistant bubble while tokens flow and removes it on
// finalize; we watch class transitions on assistant bubbles within #chat.
const chat = document.getElementById("chat");
if (chat) {
  const seen = new WeakMap<HTMLElement, boolean>();
  const obs = new MutationObserver((muts) => {
    for (const m of muts) {
      if (m.type !== "attributes" || m.attributeName !== "class") continue;
      const t = m.target as HTMLElement;
      if (!t.classList?.contains("msg") || !t.classList.contains("assistant")) continue;
      const was = seen.get(t) ?? false;
      const isStreaming = t.classList.contains("streaming");
      seen.set(t, isStreaming);
      if (was && !isStreaming && enabled) void play("complete");
    }
  });
  obs.observe(chat, { attributes: true, attributeFilter: ["class"], subtree: true });
}

// Ask — incoming-call notification slides in (hidden -> visible).
const callNotif = document.getElementById("call-notification");
if (callNotif) {
  let wasHidden = callNotif.classList.contains("hidden");
  const obs = new MutationObserver(() => {
    const nowHidden = callNotif.classList.contains("hidden");
    if (wasHidden && !nowHidden && enabled) void play("ask");
    wasHidden = nowHidden;
  });
  obs.observe(callNotif, { attributes: true, attributeFilter: ["class"] });
}
