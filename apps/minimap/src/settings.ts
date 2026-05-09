export interface Settings {
  serverUrl: string;
  ollamaModel: string;
  pollMs: number;
  followLogs: boolean;
}

const KEY = "jarvis-minimap.settings";

const DEFAULTS: Settings = {
  serverUrl: "http://localhost:5500",
  ollamaModel: "llama3.2",
  pollMs: 2000,
  followLogs: true,
};

export function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return { ...DEFAULTS };
    const parsed = JSON.parse(raw) as Partial<Settings>;
    return { ...DEFAULTS, ...parsed };
  } catch {
    return { ...DEFAULTS };
  }
}

export function saveSettings(s: Settings): void {
  localStorage.setItem(KEY, JSON.stringify(s));
}
