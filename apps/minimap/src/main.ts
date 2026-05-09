import { Api } from "./api.ts";
import { loadSettings } from "./settings.ts";
import { mountSystem } from "./panels/system.ts";
import { mountJobs } from "./panels/jobs.ts";
import { mountLog } from "./panels/log.ts";
import { mountChat } from "./panels/chat.ts";
import { mountTopbar } from "./panels/topbar.ts";
import { mountSettingsDrawer } from "./panels/settings-drawer.ts";

const initial = loadSettings();
const api = new Api(initial.serverUrl);

const settings = mountSettingsDrawer({
  onChange: (s) => {
    api.setBase(s.serverUrl);
    topbar.refresh();
    system.refresh();
    jobs.refresh();
    log.pushEvent(`settings updated · server=${s.serverUrl}`);
  },
});

const log = mountLog(api);
const seenJobs = new Set<string>();

const jobs = mountJobs(api, () => settings.get().pollMs, {
  onAttach: (id, label) => log.attach(id, label),
  onJobs: (list) => {
    if (!settings.get().followLogs) return;
    for (const job of list) {
      if (job.running && !seenJobs.has(job.id)) {
        seenJobs.add(job.id);
        log.attach(job.id, `ruflo:${job.id.slice(0, 6)}`);
      }
    }
  },
});

const system = mountSystem(api, () => settings.get().pollMs);
const topbar = mountTopbar(api, () => settings.get().pollMs);

mountChat(api, () => settings.get());

window.addEventListener("beforeunload", () => {
  log.detachAll();
  system.stop();
  jobs.stop();
  topbar.stop();
});
