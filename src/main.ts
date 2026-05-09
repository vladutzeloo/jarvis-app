// JARVIS — local chat + workspace + brain. Tabbed UI with voice I/O + gestures.
//
// This module is just the boot sequence: it imports every feature module in
// the order their side-effects depend on, then kicks off async background
// work (model discovery, vault indexing). Each feature module owns its own
// DOM queries and state.

import "./tabs";
import "./gamify/xp";
// triggers must register *before* chat.ts so our send-click listener fires
// before chat's clears the input value (event listeners run in attach order).
import "./gamify/triggers";
import "./cockpit/cockpit";
import "./brain/brain";
import "./brain/viz";
import "./voice/call";
import "./voice/tts";
import "./settings/settings";
import "./chat/models";
import "./chat/research";
import "./chat/chat";
import "./voice/stt";
import "./workspace/workspace";
import "./agents/agents";
import "./vinted/vinted";
import "./gestures/gestures";
import "./gamify/hub";

import { ensureModelsLoaded } from "./chat/models";
import { getVaultPath, indexVault } from "./brain/brain";
import { refreshBrainViz } from "./brain/viz";

ensureModelsLoaded();
if (getVaultPath()) indexVault().then(refreshBrainViz).catch(() => {});
