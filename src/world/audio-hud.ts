// JARVIS — Audio controls overlay for the World tab.
//
// Glass-morphism card in the top-right corner with:
//   • Master SFX volume slider (0–100%) — drives the Web Audio master gain.
//   • Music volume slider (0–100%)     — drives the DJ <audio> element.
//   • Mute toggle for SFX.
// State is persisted through sfx.ts / dj.ts which each write localStorage.

import { setMuted, isMuted, setVolume, getVolume } from "./sfx";
import { setMusicVolume, getMusicVolume } from "./dj";

export function initAudioHud(): void {
  const container = document.getElementById("world-audio-hud");
  if (!container) return;

  const sfxPct   = Math.round(getVolume() * 100);
  const musPct   = Math.round(getMusicVolume() * 100);

  container.innerHTML = `
    <div class="wah-title">
      <span>AUDIO</span>
      <button class="wah-mute" data-mute title="Mute / unmute SFX">
        ${isMuted() ? "🔇" : "🔊"}
      </button>
    </div>
    <div class="wah-row">
      <span class="wah-label">SFX</span>
      <input class="wah-slider" data-sfx-slider type="range" min="0" max="100" step="1" value="${sfxPct}">
      <span class="wah-val" data-sfx-val>${sfxPct}</span>
    </div>
    <div class="wah-row">
      <span class="wah-label">MUS</span>
      <input class="wah-slider" data-mus-slider type="range" min="0" max="100" step="1" value="${musPct}">
      <span class="wah-val" data-mus-val>${musPct}</span>
    </div>
  `;

  const muteBtn   = container.querySelector<HTMLButtonElement>("[data-mute]")!;
  const sfxSlider = container.querySelector<HTMLInputElement>("[data-sfx-slider]")!;
  const sfxVal    = container.querySelector<HTMLElement>("[data-sfx-val]")!;
  const musSlider = container.querySelector<HTMLInputElement>("[data-mus-slider]")!;
  const musVal    = container.querySelector<HTMLElement>("[data-mus-val]")!;

  muteBtn.addEventListener("click", () => {
    const nowMuted = !isMuted();
    setMuted(nowMuted);
    muteBtn.textContent = nowMuted ? "🔇" : "🔊";
  });

  sfxSlider.addEventListener("input", () => {
    const v = parseInt(sfxSlider.value, 10);
    setVolume(v / 100);
    sfxVal.textContent = String(v);
  });

  musSlider.addEventListener("input", () => {
    const v = parseInt(musSlider.value, 10);
    setMusicVolume(v / 100);
    musVal.textContent = String(v);
  });
}
