import type { Api } from "../api.ts";

const MAX_LINES = 500;

export interface LogPanel {
  attach(jobId: string, label: string): void;
  detachAll(): void;
  pushEvent(line: string): void;
}

interface Stream {
  source: EventSource;
  jobId: string;
  label: string;
}

function ts(): string {
  const d = new Date();
  return d.toTimeString().slice(0, 8);
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

export function mountLog(api: Api): LogPanel {
  const root = document.getElementById("log-body")!;
  const streams = new Map<string, Stream>();
  let cleared = false;

  function ensureCleared() {
    if (cleared) return;
    root.innerHTML = "";
    cleared = true;
  }

  function append(html: string) {
    ensureCleared();
    const wasNearBottom =
      root.scrollHeight - root.scrollTop - root.clientHeight < 40;
    root.insertAdjacentHTML("beforeend", html);
    while (root.children.length > MAX_LINES) {
      root.removeChild(root.firstElementChild!);
    }
    if (wasNearBottom) root.scrollTop = root.scrollHeight;
  }

  function pushLine(kind: "stdout" | "stderr" | "event", src: string, text: string) {
    append(
      `<div class="log-line ${kind}"><span class="ts">${ts()}</span><span class="src">${escapeHtml(src)}</span>${escapeHtml(text)}</div>`,
    );
  }

  function attach(jobId: string, label: string) {
    if (streams.has(jobId)) return;
    const url = api.rufloStreamUrl(jobId);
    const es = new EventSource(url);
    const stream: Stream = { source: es, jobId, label };
    streams.set(jobId, stream);
    pushLine("event", label, "« attached »");
    es.onmessage = (ev) => {
      try {
        const payload = JSON.parse(ev.data) as {
          type?: string;
          line?: string;
          message?: string;
        };
        if (payload.type === "stdout" && payload.line) {
          pushLine("stdout", label, payload.line);
        } else if (payload.type === "stderr" && payload.line) {
          pushLine("stderr", label, payload.line);
        } else if (payload.type === "done") {
          pushLine("event", label, `« done »`);
          es.close();
          streams.delete(jobId);
        } else if (payload.type === "error") {
          pushLine("stderr", label, `error: ${payload.message ?? ""}`);
        }
      } catch {
        pushLine("stdout", label, ev.data);
      }
    };
    es.onerror = () => {
      pushLine("event", label, "« stream closed »");
      es.close();
      streams.delete(jobId);
    };
  }

  function detachAll() {
    for (const s of streams.values()) s.source.close();
    streams.clear();
  }

  function pushEvent(line: string) {
    pushLine("event", "minimap", line);
  }

  return { attach, detachAll, pushEvent };
}
