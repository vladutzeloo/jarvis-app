import type { Api } from "../api.ts";

type PillState = "ok" | "warn" | "err" | "unknown";

function setPill(el: HTMLElement, state: PillState, label: string) {
  el.className = `pill pill-${state}`;
  el.textContent = label;
}

export function mountTopbar(api: Api, getPollMs: () => number) {
  const server = document.getElementById("server-pill")!;
  const ollama = document.getElementById("ollama-pill")!;
  let timer: number | undefined;

  async function tick() {
    if (timer != null) {
      window.clearTimeout(timer);
      timer = undefined;
    }
    try {
      const r = await api.health();
      setPill(server, r.trim() === "ok" ? "ok" : "warn", `server ${r.trim()}`);
    } catch {
      setPill(server, "err", "server down");
    }

    try {
      const o = await api.ollamaHealth();
      if (o.ok) {
        const count = o.models?.length ?? 0;
        setPill(ollama, "ok", `ollama · ${count}`);
      } else {
        setPill(ollama, "warn", "ollama off");
      }
    } catch {
      setPill(ollama, "err", "ollama err");
    }

    timer = window.setTimeout(tick, Math.max(3000, getPollMs() * 2));
  }

  tick();

  return {
    refresh: tick,
    stop() {
      if (timer != null) window.clearTimeout(timer);
    },
  };
}
