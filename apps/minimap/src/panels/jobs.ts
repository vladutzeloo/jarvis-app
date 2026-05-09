import type { Api, RufloJob, VintedBot } from "../api.ts";
import { escapeHtml } from "../escape.ts";

interface Handlers {
  onAttach: (jobId: string, label: string) => void;
  onJobs?: (jobs: RufloJob[]) => void;
}

function fmtArgv(argv: string[]): string {
  return argv.join(" ").replace(/\s+/g, " ").trim() || "(no argv)";
}

function renderJobs(jobs: RufloJob[]): string {
  if (!jobs.length) return `<div class="muted">no ruflo jobs</div>`;
  return jobs
    .map((j) => {
      const dot = j.running ? "live" : "idle";
      const label = escapeHtml(fmtArgv(j.argv));
      const meta = j.running
        ? "running"
        : `exit ${escapeHtml(j.exit_code ?? "?")}`;
      const attach = j.running
        ? `<button class="entity-attach" data-attach="${escapeHtml(j.id)}">attach</button>`
        : "";
      return `
        <div class="entity">
          <span class="entity-dot ${dot}"></span>
          <span class="entity-name" title="${label}">${label}</span>
          <span class="entity-meta">${meta}</span>
          ${attach}
        </div>`;
    })
    .join("");
}

function renderBots(bots: VintedBot[]): string {
  if (!bots.length) return `<div class="muted">no vinted bots</div>`;
  return bots
    .map((b) => {
      const name = escapeHtml(b.name);
      const tail = [b.category, b.query]
        .filter(Boolean)
        .map(escapeHtml)
        .join(" · ");
      return `
        <div class="entity">
          <span class="entity-dot idle"></span>
          <span class="entity-name" title="${name}">${name}</span>
          <span class="entity-meta">${tail || "—"}</span>
        </div>`;
    })
    .join("");
}

export function mountJobs(api: Api, getPollMs: () => number, handlers: Handlers) {
  const root = document.getElementById("jobs-body")!;
  let timer: number | undefined;
  let aborter: AbortController | undefined;

  root.addEventListener("click", (ev) => {
    const target = ev.target as HTMLElement;
    if (!target.matches("[data-attach]")) return;
    const id = target.getAttribute("data-attach");
    if (!id) return;
    handlers.onAttach(id, `ruflo:${id.slice(0, 6)}`);
  });

  async function tick() {
    aborter?.abort();
    aborter = new AbortController();
    try {
      const [jobs, bots] = await Promise.all([
        api.rufloJobs(aborter.signal).catch(() => [] as RufloJob[]),
        api.vintedBots(aborter.signal).catch(() => [] as VintedBot[]),
      ]);
      root.innerHTML = `
        <div class="section-label">ruflo jobs</div>
        ${renderJobs(jobs)}
        <div class="section-label">vinted bots</div>
        ${renderBots(bots)}
      `;
      handlers.onJobs?.(jobs);
    } catch (e: unknown) {
      if ((e as { name?: string }).name === "AbortError") return;
      root.innerHTML = `<div class="muted">jobs unavailable</div>`;
    } finally {
      timer = window.setTimeout(tick, getPollMs());
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
