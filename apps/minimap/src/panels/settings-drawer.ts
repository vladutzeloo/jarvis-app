import { loadSettings, saveSettings, type Settings } from "../settings.ts";

interface DrawerHandlers {
  onChange: (s: Settings) => void;
}

export function mountSettingsDrawer(handlers: DrawerHandlers) {
  const drawer = document.getElementById("settings-drawer")!;
  const toggle = document.getElementById("settings-toggle")!;
  const close = document.getElementById("settings-close")!;

  const serverInput = document.getElementById("setting-server") as HTMLInputElement;
  const modelInput = document.getElementById("setting-model") as HTMLInputElement;
  const pollInput = document.getElementById("setting-poll") as HTMLInputElement;
  const followInput = document.getElementById("setting-followlogs") as HTMLInputElement;
  const orcEnabledInput = document.getElementById("setting-orc-enabled") as HTMLInputElement | null;
  const orcModelInput = document.getElementById("setting-orc-model") as HTMLInputElement | null;
  const orcIntervalInput = document.getElementById("setting-orc-interval") as HTMLInputElement | null;
  const saveBtn = document.getElementById("setting-save")!;
  const status = document.getElementById("setting-status")!;

  let current: Settings = loadSettings();

  function syncInputs() {
    serverInput.value = current.serverUrl;
    modelInput.value = current.ollamaModel;
    pollInput.value = String(current.pollMs);
    followInput.checked = current.followLogs;
    if (orcEnabledInput) orcEnabledInput.checked = current.orcEnabled;
    if (orcModelInput) orcModelInput.value = current.orcModel;
    if (orcIntervalInput) orcIntervalInput.value = String(current.orcIntervalS);
  }

  syncInputs();

  toggle.addEventListener("click", () => {
    drawer.classList.toggle("hidden");
  });
  close.addEventListener("click", () => {
    drawer.classList.add("hidden");
  });

  saveBtn.addEventListener("click", () => {
    const next: Settings = {
      serverUrl: serverInput.value.trim().replace(/\/$/, "") || current.serverUrl,
      ollamaModel: modelInput.value.trim() || current.ollamaModel,
      pollMs: Math.max(500, Number(pollInput.value) || current.pollMs),
      followLogs: followInput.checked,
      orcEnabled: orcEnabledInput ? orcEnabledInput.checked : current.orcEnabled,
      orcModel: orcModelInput?.value.trim() || current.orcModel,
      orcIntervalS: Math.max(
        30,
        Number(orcIntervalInput?.value) || current.orcIntervalS,
      ),
    };
    current = next;
    saveSettings(next);
    status.textContent = `saved at ${new Date().toLocaleTimeString()}`;
    handlers.onChange(next);
  });

  return {
    get(): Settings {
      return current;
    },
  };
}
