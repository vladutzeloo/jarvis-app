// JARVIS — game sounds (Web Audio synth, no asset files).
//
// Browsers refuse to start an AudioContext until a user gesture; we lazily
// create the context on first use AND attach a once-only resume listener so
// the first click anywhere unblocks playback. Each sfx is a short envelope
// over one or two oscillators; we synthesise at runtime so the bundle stays
// tiny and we don't ship .mp3s.

let ctx: AudioContext | null = null;
let masterGain: GainNode | null = null;
let muted = false;
let volume = 0.5;

const STORAGE_VOL   = "jarvis.sfx.volume";

function ac(): AudioContext {
  if (!ctx) {
    ctx = new (window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext)();
    masterGain = ctx.createGain();
    masterGain.gain.value = muted ? 0 : volume;
    masterGain.connect(ctx.destination);
  }
  return ctx;
}

function out(): AudioNode {
  ac();
  return masterGain!;
}

interface BlipOpts {
  type?: OscillatorType;
  vol?: number;
  attack?: number;
  decay?: number;
  freqEnd?: number; // optional pitch glide target
}

function blip(freq: number, dur: number, opts: BlipOpts = {}): void {
  const c = ac();
  const o = c.createOscillator();
  o.type = opts.type ?? "square";
  o.frequency.setValueAtTime(freq, c.currentTime);
  if (opts.freqEnd !== undefined) {
    o.frequency.exponentialRampToValueAtTime(Math.max(20, opts.freqEnd), c.currentTime + dur);
  }
  const g = c.createGain();
  const vol = opts.vol ?? 0.18;
  const attack = opts.attack ?? 0.005;
  g.gain.setValueAtTime(0, c.currentTime);
  g.gain.linearRampToValueAtTime(vol, c.currentTime + attack);
  g.gain.exponentialRampToValueAtTime(0.0001, c.currentTime + dur);
  o.connect(g).connect(out());
  o.start();
  o.stop(c.currentTime + dur + 0.02);
}

function noiseBurst(dur: number, vol = 0.18): void {
  const c = ac();
  const buf = c.createBuffer(1, c.sampleRate * dur, c.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < data.length; i++) {
    // Pink-ish noise: smoothed white via single-pole filter for a thicker hit
    data[i] = (Math.random() * 2 - 1) * (1 - i / data.length);
  }
  const src = c.createBufferSource();
  src.buffer = buf;
  const g = c.createGain();
  g.gain.value = vol;
  src.connect(g).connect(out());
  src.start();
}

// ─── Public sfx ────────────────────────────────────────────────────────────

export const sfx = {
  hover()    { blip(880, 0.05, { type: "sine",   vol: 0.06 }); },
  click()    { blip(660, 0.07, { type: "square", vol: 0.10, freqEnd: 520 }); },
  launch()   {
    blip(440, 0.10, { type: "square", vol: 0.10 });
    setTimeout(() => blip(660, 0.10, { type: "square", vol: 0.10 }), 70);
    setTimeout(() => blip(880, 0.16, { type: "square", vol: 0.12 }), 140);
  },
  hit()      {
    noiseBurst(0.12, 0.18);
    blip(160, 0.14, { type: "sawtooth", vol: 0.14, freqEnd: 60 });
  },
  error()    { blip(160, 0.18, { type: "square", vol: 0.18, freqEnd: 90 }); },
  discover() {
    [523, 659, 784, 1047].forEach((f, i) =>
      setTimeout(() => blip(f, 0.12, { type: "square", vol: 0.10 }), i * 75),
    );
  },
  vault()    {
    // "Heavy door" thunk — low square + noise tail
    blip(120, 0.18, { type: "square",   vol: 0.20, freqEnd: 60 });
    setTimeout(() => noiseBurst(0.12, 0.10), 60);
  },
  cash()     {
    // Quick coin-pickup chirp
    blip(880, 0.06, { type: "square", vol: 0.10 });
    setTimeout(() => blip(1320, 0.08, { type: "square", vol: 0.10 }), 50);
  },
};

// ─── Lifecycle ─────────────────────────────────────────────────────────────

const STORAGE_MUTED = "jarvis.sfx.muted";
muted = localStorage.getItem(STORAGE_MUTED) === "1";
volume = parseFloat(localStorage.getItem(STORAGE_VOL) ?? "0.5");

export function setMuted(m: boolean): void {
  muted = m;
  localStorage.setItem(STORAGE_MUTED, m ? "1" : "0");
  if (masterGain) masterGain.gain.value = m ? 0 : volume;
}

export function isMuted(): boolean { return muted; }

export function setVolume(v: number): void {
  volume = Math.max(0, Math.min(1, v));
  localStorage.setItem(STORAGE_VOL, String(volume));
  if (masterGain && !muted) masterGain.gain.value = volume;
}

export function getVolume(): number { return volume; }

// Resume on first gesture — required by browser autoplay policies.
const resumeOnce = () => {
  ac().resume().catch(() => {});
  window.removeEventListener("pointerdown", resumeOnce);
  window.removeEventListener("keydown", resumeOnce);
};
window.addEventListener("pointerdown", resumeOnce, { once: true });
window.addEventListener("keydown", resumeOnce, { once: true });

// Expose the master gain so the DJ module can hang the music graph off it.
export function getAudioContext(): AudioContext { return ac(); }
export function getMasterGain(): GainNode { ac(); return masterGain!; }
