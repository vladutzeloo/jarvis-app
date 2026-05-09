import type { Api, SystemStats } from "../api.ts";
import { escapeHtml } from "../escape.ts";

function gauge(label: string, percent: number | undefined, detail = ""): string {
  const p = Math.max(0, Math.min(100, Number(percent ?? 0)));
  const cls = p >= 90 ? "err" : p >= 75 ? "warn" : "";
  const detailHtml = detail ? ` · ${escapeHtml(detail)}` : "";
  return `
    <div class="gauge">
      <div class="gauge-row"><span>${escapeHtml(label)}</span><b>${p.toFixed(0)}%${detailHtml}</b></div>
      <div class="gauge-bar"><div class="gauge-fill ${cls}" style="width:${p}%"></div></div>
    </div>
  `;
}

function render(stats: SystemStats): string {
  const cpu = stats.cpu?.percent;
  const ram = stats.ram?.percent;
  const ramDetail = stats.ram?.used_gb != null && stats.ram?.total_gb != null
    ? `${stats.ram.used_gb.toFixed(1)} / ${stats.ram.total_gb.toFixed(1)} GB`
    : "";
  const gpu = stats.gpu?.utilization;
  const vram = stats.vram?.percent;
  const vramDetail = stats.vram?.used_gb != null && stats.vram?.total_gb != null
    ? `${stats.vram.used_gb.toFixed(1)} / ${stats.vram.total_gb.toFixed(1)} GB`
    : "";

  const running = stats.ollama?.running ?? [];
  const ollamaList = running.length
    ? `<div class="kv-list">${running
        .map((m) => `<div><span>${escapeHtml(m.name)}</span><b>${m.size_vram_gb?.toFixed(1) ?? "?"} GB</b></div>`)
        .join("")}</div>`
    : `<div class="muted">no ollama models loaded</div>`;

  return `
    ${gauge("CPU", cpu)}
    ${gauge("RAM", ram, ramDetail)}
    ${gauge("GPU", gpu, stats.gpu?.name ?? "")}
    ${gauge("VRAM", vram, vramDetail)}
    <div class="section-label">ollama</div>
    ${ollamaList}
  `;
}

export function mountSystem(api: Api, getPollMs: () => number) {
  const root = document.getElementById("system-body")!;
  let timer: number | undefined;
  let aborter: AbortController | undefined;

  async function tick() {
    if (timer != null) {
      window.clearTimeout(timer);
      timer = undefined;
    }
    aborter?.abort();
    const local = new AbortController();
    aborter = local;
    try {
      const s = await api.systemStats(local.signal);
      if (local.signal.aborted) return;
      root.innerHTML = render(s);
    } catch (e: unknown) {
      if (local.signal.aborted) return;
      if ((e as { name?: string }).name === "AbortError") return;
      root.innerHTML = `<div class="muted">stats unavailable: ${escapeHtml(
        (e as Error).message ?? e,
      )}</div>`;
    } finally {
      if (!local.signal.aborted) {
        timer = window.setTimeout(tick, getPollMs());
      }
    }
  }

  tick();

  return {
    refresh: tick,
    stop() {
      aborter?.abort();
      if (timer != null) window.clearTimeout(timer);
    },
  };
}
