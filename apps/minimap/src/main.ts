import { Api } from "./api.ts";
import { loadSettings, type Settings } from "./settings.ts";
import { mountSystem } from "./panels/system.ts";
import { mountJobs } from "./panels/jobs.ts";
import { mountLog } from "./panels/log.ts";
import { mountChat } from "./panels/chat.ts";
import { mountTopbar } from "./panels/topbar.ts";
import { mountSettingsDrawer } from "./panels/settings-drawer.ts";
import { mountWorld } from "./panels/world.ts";

const initial = loadSettings();
const api = new Api(initial.serverUrl);

// Push the persisted orc config to the server on boot so a fresh tab and the
// runner stay in sync. Errors here are non-fatal — server may still be coming
// up — and the world panel will retry config pushes on every save.
function pushOrcConfig(s: Settings) {
  void api
    .orcConfig({
      enabled: s.orcEnabled,
      model: s.orcModel,
      interval_s: s.orcIntervalS,
    })
    .catch(() => {});
}

const settings = mountSettingsDrawer({
  onChange: (s) => {
    api.setBase(s.serverUrl);
    topbar.refresh();
    system.refresh();
    jobs.refresh();
    world.refresh();
    pushOrcConfig(s);
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
const world = mountWorld(api, () => settings.get().pollMs);

mountChat(api, () => settings.get());

pushOrcConfig(settings.get());

window.addEventListener("beforeunload", () => {
  log.detachAll();
  system.stop();
  jobs.stop();
  topbar.stop();
  world.stop();
});
