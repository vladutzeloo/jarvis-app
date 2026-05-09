// JARVIS — money vault state.
//
// Two distinct concepts share this module:
//
// 1. The user's money (starting + current). Both numbers are user-edited via
//    the vault HUD; they do NOT change automatically. We persist them so a
//    reload preserves the value.
//
// 2. Currency rates (USD / EUR / GBP / JPY / BTC / ETH). These random-walk
//    over time, purely to give the 3D graph something interesting to draw.
//    They are not connected to the user's money at all — the graph is
//    cosmetic, the vault numbers are authoritative for "what's in my safe".

const STORAGE_KEY = "jarvis.finance.v1";
const HISTORY_LEN = 64;
const TICK_INTERVAL_MS = 250;

export interface CurrencyRate {
  code: string;
  price: number;          // current (simulated) price in USD per unit
  basePrice: number;      // mean-reversion target
  history: number[];      // most recent N samples; oldest first
  color: number;          // hex color for the graph line
}

export interface FinanceState {
  starting: number;       // user-edited starting amount (USD)
  current: number;        // user-edited current amount (USD)
  rates: CurrencyRate[];
}

// One-shot defaults. basePrice / color stay constant; price + history evolve.
const RATE_SEEDS: Array<Omit<CurrencyRate, "history">> = [
  { code: "USD", price: 1.0,    basePrice: 1.0,    color: 0x5cd9ff },
  { code: "EUR", price: 1.08,   basePrice: 1.08,   color: 0x4285f4 },
  { code: "GBP", price: 1.26,   basePrice: 1.26,   color: 0xff8c00 },
  { code: "JPY", price: 0.0067, basePrice: 0.0067, color: 0xff2bd6 },
  { code: "BTC", price: 65000,  basePrice: 65000,  color: 0xf7931a },
  { code: "ETH", price: 3500,   basePrice: 3500,   color: 0x9b6dff },
];

function freshState(): FinanceState {
  return {
    starting: 1000,
    current: 1000,
    rates: RATE_SEEDS.map(s => ({
      ...s,
      history: Array(HISTORY_LEN).fill(s.price),
    })),
  };
}

function loadState(): FinanceState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return freshState();
    const parsed = JSON.parse(raw) as Partial<FinanceState>;
    const fresh = freshState();
    // Merge: keep fresh defaults for anything missing. Reseed any rate that
    // got persisted with a too-short history so the graph isn't jumpy.
    const merged: FinanceState = {
      starting: typeof parsed.starting === "number" ? parsed.starting : fresh.starting,
      current:  typeof parsed.current  === "number" ? parsed.current  : fresh.current,
      rates: fresh.rates.map(seed => {
        const persisted = parsed.rates?.find(r => r.code === seed.code);
        if (!persisted) return seed;
        const history = Array.isArray(persisted.history) && persisted.history.length === HISTORY_LEN
          ? persisted.history
          : Array(HISTORY_LEN).fill(persisted.price ?? seed.price);
        return {
          ...seed,
          price: typeof persisted.price === "number" ? persisted.price : seed.price,
          history,
        };
      }),
    };
    return merged;
  } catch {
    return freshState();
  }
}

let state: FinanceState = loadState();

function persist(): void {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); }
  catch { /* quota / private mode */ }
}

const subscribers: Array<() => void> = [];
function notify(): void {
  for (const fn of subscribers) fn();
}

export function subscribe(fn: () => void): () => void {
  subscribers.push(fn);
  return () => {
    const i = subscribers.indexOf(fn);
    if (i >= 0) subscribers.splice(i, 1);
  };
}

export function getFinance(): FinanceState { return state; }

export function getHistoryLength(): number { return HISTORY_LEN; }

export function setStarting(amount: number): void {
  state.starting = clampMoney(amount);
  persist();
  notify();
}

export function setCurrent(amount: number): void {
  state.current = clampMoney(amount);
  persist();
  notify();
}

export function resetCurrentToStarting(): void {
  state.current = state.starting;
  persist();
  notify();
}

function clampMoney(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(1e12, n));
}

// ─── Rate simulation ──────────────────────────────────────────────────────
//
// A small mean-reverting random walk. We deliberately update at a fixed
// 4 Hz rather than every frame so the graph is smooth-but-readable, and
// so a user pinned to a 144 Hz monitor doesn't see absurd volatility.

let lastTick = 0;
let persistAcc = 0;

export function stepFinanceSim(now: number): void {
  if (lastTick === 0) lastTick = now;
  const dt = now - lastTick;
  if (dt < TICK_INTERVAL_MS) return;
  lastTick = now;

  for (const r of state.rates) {
    // Pull toward basePrice by 0.04 % each tick, plus 0.4 % gaussian noise.
    const reversion = (r.basePrice - r.price) * 0.0004;
    const noise = (Math.random() - 0.5) * r.price * 0.008;
    r.price = clampMoney(r.price + reversion + noise);
    r.history.push(r.price);
    if (r.history.length > HISTORY_LEN) r.history.shift();
  }

  // Persist rates ~once every 5 s; user-money is persisted on every edit.
  persistAcc += dt;
  if (persistAcc > 5000) {
    persistAcc = 0;
    persist();
  }

  notify();
}
