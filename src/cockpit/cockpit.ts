// Cockpit HUD bar — polls the local stats endpoint for CPU/RAM/GPU/VRAM/temp/
// power, drives the animated background fans, and tracks token counters that
// chat increments during streaming.

import { PIPER_BASE } from "../types";

const STORAGE_TOKENS_TOTAL = "jarvis.tokens.total";

const cockpit = document.getElementById("cockpit") as HTMLElement;

let tokensSession = 0;
let tokensTotal = parseInt(localStorage.getItem(STORAGE_TOKENS_TOTAL) || "0", 10) || 0;

function setCell(key: string, value: string, fillPct?: number, alarm?: boolean) {
  const cell = cockpit?.querySelector(`.cockpit-cell[data-key="${key}"]`);
  if (!cell) return;
  const valEl = cell.querySelector(".cockpit-value") as HTMLElement | null;
  const fillEl = cell.querySelector(".cockpit-bar-fill") as HTMLElement | null;
  if (valEl) valEl.textContent = value;
  if (fillEl && typeof fillPct === "number") {
    fillEl.style.width = `${Math.min(100, Math.max(0, fillPct))}%`;
  }
  if (alarm !== undefined) cell.classList.toggle("alarm", alarm);
}

function fmtMB(mb: number): string {
  if (mb >= 1024) return `${(mb / 1024).toFixed(1)}G`;
  return `${Math.round(mb)}M`;
}

function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return `${n}`;
}

export function updateTokenCells() {
  setCell("tokens-session", `${fmtTokens(tokensSession)} tok`);
  setCell("tokens-total", `${fmtTokens(tokensTotal)} tok`);
}

export function bumpTokens(n = 1) {
  tokensSession += n;
  tokensTotal += n;
}

export function persistTokenTotal() {
  localStorage.setItem(STORAGE_TOKENS_TOTAL, String(tokensTotal));
}

updateTokenCells();

// Map a 0-100 percentage to a CSS animation duration string.
// 0% → 30s (basically idle), 100% → 0.45s (raging).
function fanDurationForPct(pct: number): string {
  const p = Math.max(0, Math.min(100, pct)) / 100;
  const dur = 0.45 + 30 * Math.pow(1 - p, 1.6);
  return `${dur.toFixed(2)}s`;
}

function fanRpmForPct(pct: number): number {
  return Math.round(Math.max(0, Math.min(100, pct)) * 35);
}

let _bgLoadSmoothed = 0;

function applyBackgroundLoad(utilPct: number) {
  // 1st-order low-pass: blend toward target so the background doesn't jitter
  // every poll cycle.
  const target = Math.max(0, Math.min(100, utilPct));
  _bgLoadSmoothed = _bgLoadSmoothed * 0.7 + target * 0.3;
  const u = _bgLoadSmoothed / 100;

  const root = document.documentElement.style;
  root.setProperty("--bg-bright", (0.85 + u * 0.55).toFixed(3));
  root.setProperty("--bg-sat", (0.9 + u * 0.8).toFixed(3));
  root.setProperty("--bg-node-dur", `${(5 - u * 4.1).toFixed(2)}s`);
  root.setProperty("--bg-throb", (0.04 + u * 0.14).toFixed(3));
}

function applyFanSpeeds(a: number, b: number, c: number, gpuFanIsReal: boolean) {
  document.documentElement.style.setProperty("--fan-1-dur", fanDurationForPct(a));
  document.documentElement.style.setProperty("--fan-2-dur", fanDurationForPct(b));
  document.documentElement.style.setProperty("--fan-3-dur", fanDurationForPct(c));

  const labels = [
    { sel: ".bg-circuit .fan-1 text", text: gpuFanIsReal ? `FAN A · ${fanRpmForPct(a)} RPM` : `GPU LOAD · ${a.toFixed(0)}%` },
    { sel: ".bg-circuit .fan-2 text", text: `CPU · ${b.toFixed(0)}%` },
    { sel: ".bg-circuit .fan-3 text", text: gpuFanIsReal ? `FAN C · ${fanRpmForPct(c)} RPM` : `GPU TEMP · ${c.toFixed(0)}` },
  ];
  for (const { sel, text } of labels) {
    const el = document.querySelector(sel) as SVGTextElement | null;
    if (el) el.textContent = text;
  }
}

async function pollSystemStats() {
  try {
    const res = await fetch(`${PIPER_BASE}/system-stats`, { signal: AbortSignal.timeout(1500) });
    if (!res.ok) throw new Error(String(res.status));
    const s = await res.json();

    setCell("cpu", `${s.cpu_percent.toFixed(0)}%`, s.cpu_percent, s.cpu_percent > 85);

    const memPct = s.mem_percent;
    setCell(
      "ram",
      `${(s.mem_used_bytes / 1_073_741_824).toFixed(1)}/${(s.mem_total_bytes / 1_073_741_824).toFixed(0)}G`,
      memPct,
      memPct > 90,
    );

    if (s.gpu) {
      setCell("gpu", `${s.gpu.util_pct.toFixed(0)}%`, s.gpu.util_pct, s.gpu.util_pct > 95);
      const vramPct = (s.gpu.mem_used_mb / s.gpu.mem_total_mb) * 100;
      setCell("vram", `${fmtMB(s.gpu.mem_used_mb)}/${fmtMB(s.gpu.mem_total_mb)}`, vramPct, vramPct > 92);
      setCell("temp", `${s.gpu.temp_c.toFixed(0)}°C`, undefined, s.gpu.temp_c > 82);
      if (s.gpu.power_w !== null && s.gpu.power_w !== undefined) {
        const pwr = s.gpu.power_w;
        const lim = s.gpu.power_limit_w || 0;
        setCell("power", lim ? `${pwr.toFixed(0)}/${lim.toFixed(0)}W` : `${pwr.toFixed(0)}W`);
      }

      // Drive the background fans from real metrics. fan_pct comes from
      // nvidia-smi when supported; on most laptops it's null, so we fall back
      // to a temp-derived proxy (hotter = faster).
      const tempProxy = Math.max(0, Math.min(100, ((s.gpu.temp_c - 35) / (90 - 35)) * 100));
      const realFan = s.gpu.fan_pct;
      const fanA = realFan != null ? realFan : Math.max(s.gpu.util_pct, tempProxy);
      const fanB = s.cpu_percent;
      const fanC = realFan != null ? realFan : tempProxy;
      applyFanSpeeds(fanA, fanB, fanC, realFan != null);
      applyBackgroundLoad(s.gpu.util_pct);
    } else {
      setCell("gpu", "n/a", 0);
      setCell("vram", "n/a", 0);
      setCell("temp", "n/a");
      setCell("power", "n/a");
      applyFanSpeeds(0, s.cpu_percent || 0, 0, false);
    }

    if (s.ollama && s.ollama.length > 0) {
      const m = s.ollama[0];
      const sizeG = m.size_vram ? (m.size_vram / 1_073_741_824).toFixed(1) : "—";
      setCell("loaded", `${m.name.split(":")[0]} · ${sizeG}G`);
    } else {
      setCell("loaded", "idle");
    }
  } catch {
    setCell("cpu", "—");
    setCell("ram", "—");
    setCell("gpu", "—");
    setCell("vram", "—");
    setCell("temp", "—");
    setCell("power", "—");
    setCell("loaded", "tts server offline");
  }
}

setInterval(pollSystemStats, 1500);
pollSystemStats();
