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

export type OrcPhase = "idle" | "walking" | "thinking";
export type OrcWaypoint = "system" | "jobs" | "log" | "chat";

export interface OrcCurrent {
  id: string;
  prompt: string;
  partial: string;
}

export interface OrcRecent {
  id: string;
  task_id: string;
  prompt: string;
  answer: string;
  error: string | null;
  model: string;
  started_at: number;
  finished_at: number;
}

export interface OrcState {
  enabled: boolean;
  model: string;
  interval_s: number;
  phase: OrcPhase;
  waypoint: OrcWaypoint;
  next_waypoint: OrcWaypoint;
  phase_started_at: number;
  phase_age_s: number;
  seconds_until_next: number;
  tasks_total: number;
  current: OrcCurrent | null;
  unread: number;
  recent: OrcRecent[];
}

export interface OrcTask {
  id: string;
  prompt: string;
  added_at: number;
}

export interface OrcConfig {
  enabled?: boolean;
  model?: string;
  interval_s?: number;
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

  orcState(signal?: AbortSignal): Promise<OrcState> {
    return this.getJson<OrcState>("/orc/state", signal);
  }

  orcTasks(signal?: AbortSignal): Promise<OrcTask[]> {
    return this.getJson<OrcTask[]>("/orc/tasks", signal);
  }

  async orcAddTask(prompt: string): Promise<OrcTask> {
    const r = await fetch(this.url("/orc/tasks"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt }),
    });
    if (!r.ok) throw new Error(`/orc/tasks -> ${r.status}`);
    return r.json() as Promise<OrcTask>;
  }

  async orcDeleteTask(id: string): Promise<boolean> {
    const r = await fetch(this.url(`/orc/tasks/${encodeURIComponent(id)}`), {
      method: "DELETE",
    });
    if (!r.ok && r.status !== 404) throw new Error(`/orc/tasks delete -> ${r.status}`);
    const j = (await r.json()) as { deleted?: boolean };
    return Boolean(j.deleted);
  }

  async orcRunNow(): Promise<boolean> {
    const r = await fetch(this.url("/orc/run-now"), { method: "POST" });
    if (!r.ok) throw new Error(`/orc/run-now -> ${r.status}`);
    const j = (await r.json()) as { started?: boolean };
    return Boolean(j.started);
  }

  async orcConfig(cfg: OrcConfig): Promise<OrcConfig> {
    const r = await fetch(this.url("/orc/config"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(cfg),
    });
    if (!r.ok) throw new Error(`/orc/config -> ${r.status}`);
    return r.json() as Promise<OrcConfig>;
  }

  async orcAck(): Promise<number> {
    const r = await fetch(this.url("/orc/ack"), { method: "POST" });
    if (!r.ok) throw new Error(`/orc/ack -> ${r.status}`);
    const j = (await r.json()) as { cleared?: number };
    return Number(j.cleared ?? 0);
  }
}
