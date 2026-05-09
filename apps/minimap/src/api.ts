export interface SystemStats {
  cpu?: { percent?: number };
  ram?: { percent?: number; used_gb?: number; total_gb?: number };
  gpu?: { name?: string; utilization?: number; temperature?: number };
  vram?: { percent?: number; used_gb?: number; total_gb?: number };
  ollama?: { running?: Array<{ name: string; size_vram_gb?: number }> };
  [k: string]: unknown;
}

export interface RufloJob {
  id: string;
  argv: string[];
  running: boolean;
  exit_code?: number | null;
  started_at?: number;
  [k: string]: unknown;
}

export interface VintedBot {
  id: string;
  name: string;
  query?: string;
  category?: string;
  [k: string]: unknown;
}

export class Api {
  constructor(private base: string) {}

  setBase(base: string) {
    this.base = base.replace(/\/$/, "");
  }

  url(path: string): string {
    return `${this.base.replace(/\/$/, "")}${path}`;
  }

  private async getJson<T>(path: string, signal?: AbortSignal): Promise<T> {
    const r = await fetch(this.url(path), { signal });
    if (!r.ok) throw new Error(`${path} -> ${r.status}`);
    return r.json() as Promise<T>;
  }

  health(signal?: AbortSignal): Promise<string> {
    return fetch(this.url("/health"), { signal }).then((r) => {
      if (!r.ok) throw new Error(`/health -> ${r.status}`);
      return r.text();
    });
  }

  systemStats(signal?: AbortSignal): Promise<SystemStats> {
    return this.getJson<SystemStats>("/system-stats", signal);
  }

  rufloJobs(signal?: AbortSignal): Promise<RufloJob[]> {
    return this.getJson<RufloJob[]>("/ruflo/jobs", signal);
  }

  vintedBots(signal?: AbortSignal): Promise<VintedBot[]> {
    return this.getJson<VintedBot[]>("/vinted/bots", signal);
  }

  rufloHealth(signal?: AbortSignal): Promise<{ ok: boolean }> {
    return this.getJson<{ ok: boolean }>("/ruflo/health", signal);
  }

  ollamaHealth(signal?: AbortSignal): Promise<{ ok: boolean; models?: string[] }> {
    return this.getJson<{ ok: boolean; models?: string[] }>("/chat/health", signal);
  }

  rufloStreamUrl(jobId: string): string {
    return this.url(`/ruflo/stream/${encodeURIComponent(jobId)}`);
  }

  chatUrl(): string {
    return this.url("/chat");
  }
}
