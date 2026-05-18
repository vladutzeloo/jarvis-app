// JARVIS — 3D money vault.
//
// A chunky safe placed on the holodeck floor with a glowing combination dial
// and a small canvas-textured screen on top. The screen redraws whenever the
// finance state changes, so editing the HUD inputs immediately updates what
// the vault reads. Click the vault → opens an HTML HUD overlay.

import * as THREE from "three";
import {
  getFinance,
  resetCurrentToStarting,
  setCurrent,
  setStarting,
  subscribe as financeSubscribe,
} from "./finance";
import { sfx } from "./sfx";

const VAULT_POSITION = new THREE.Vector3(-7.2, -1.3, 0);
const HIT_RADIUS = 1.6;

export interface VaultHandle {
  group: THREE.Group;
  hitSphere: THREE.Sphere;
  rayHits: (raycaster: THREE.Raycaster) => boolean;
  openHud: () => void;
  closeHud: () => void;
  step: (dt: number) => void;
  dispose: () => void;
}

export function buildVault(scene: THREE.Scene): VaultHandle {
  const group = new THREE.Group();
  group.position.copy(VAULT_POSITION);
  // Face the core
  group.lookAt(0, group.position.y, 0);
  scene.add(group);

  // ─── Body + door ──────────────────────────────────────────────────────
  const wallMat = new THREE.MeshStandardMaterial({
    color: 0x1a2030, metalness: 0.7, roughness: 0.32,
  });
  const doorMat = new THREE.MeshStandardMaterial({
    color: 0x252e42, metalness: 0.85, roughness: 0.22,
  });
  const accentMat = new THREE.MeshStandardMaterial({
    color: 0x5cd9ff, emissive: 0x5cd9ff, emissiveIntensity: 0.6,
    metalness: 0.5, roughness: 0.25,
  });
  const accentDimMat = new THREE.MeshBasicMaterial({
    color: 0x5cd9ff, transparent: true, opacity: 0.4,
  });

  const bodyGeom = new THREE.BoxGeometry(1.7, 1.5, 1.7);
  const body = new THREE.Mesh(bodyGeom, wallMat);
  group.add(body);

  // Recessed front face — door
  const doorGeom = new THREE.BoxGeometry(1.45, 1.25, 0.12);
  const door = new THREE.Mesh(doorGeom, doorMat);
  door.position.z = 0.86;
  group.add(door);

  // Door frame outline (thin emissive cyan piping around the door edge)
  const frameGeom = new THREE.EdgesGeometry(doorGeom);
  const frame = new THREE.LineSegments(frameGeom, accentDimMat);
  frame.position.z = 0.87;
  group.add(frame);

  // Combination dial
  const dialGeom = new THREE.CylinderGeometry(0.24, 0.24, 0.12, 28);
  const dial = new THREE.Mesh(dialGeom, accentMat);
  dial.rotation.x = Math.PI / 2;
  dial.position.set(0, -0.2, 0.96);
  group.add(dial);

  // Tick marks on the dial face (small lines around the rim)
  const tickMat = new THREE.LineBasicMaterial({ color: 0x06090f });
  for (let i = 0; i < 12; i++) {
    const a = (i / 12) * Math.PI * 2;
    const tickGeom = new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(Math.cos(a) * 0.18, Math.sin(a) * 0.18, 0.061),
      new THREE.Vector3(Math.cos(a) * 0.22, Math.sin(a) * 0.22, 0.061),
    ]);
    dial.add(new THREE.Line(tickGeom, tickMat));
  }
  // Center pin
  const pinGeom = new THREE.CylinderGeometry(0.04, 0.04, 0.18, 16);
  const pinMat = new THREE.MeshStandardMaterial({ color: 0x0d1117, metalness: 0.4, roughness: 0.4 });
  const pin = new THREE.Mesh(pinGeom, pinMat);
  pin.rotation.x = Math.PI / 2;
  dial.add(pin);

  // Door handle (a horizontal bar with two end caps)
  const handleGroup = new THREE.Group();
  handleGroup.position.set(0, 0.25, 0.96);
  group.add(handleGroup);
  const handleGeom = new THREE.CylinderGeometry(0.04, 0.04, 0.6, 16);
  const handle = new THREE.Mesh(handleGeom, pinMat);
  handle.rotation.z = Math.PI / 2;
  handleGroup.add(handle);
  const capGeom = new THREE.SphereGeometry(0.06, 12, 12);
  const capL = new THREE.Mesh(capGeom, accentMat);
  capL.position.x = -0.32;
  const capR = new THREE.Mesh(capGeom, accentMat);
  capR.position.x = 0.32;
  handleGroup.add(capL);
  handleGroup.add(capR);

  // Pedestal under the safe
  const pedGeom = new THREE.CylinderGeometry(1.2, 1.3, 0.18, 28);
  const pedMat = new THREE.MeshStandardMaterial({
    color: 0x0d1117, metalness: 0.6, roughness: 0.3,
    emissive: 0x5cd9ff, emissiveIntensity: 0.05,
  });
  const ped = new THREE.Mesh(pedGeom, pedMat);
  ped.position.y = -0.84;
  group.add(ped);

  // ─── On-vault screen — canvas texture ─────────────────────────────────
  const screenCanvas = document.createElement("canvas");
  screenCanvas.width = 512;
  screenCanvas.height = 256;
  const screenTexture = new THREE.CanvasTexture(screenCanvas);
  screenTexture.colorSpace = THREE.SRGBColorSpace;
  const screenMat = new THREE.MeshBasicMaterial({
    map: screenTexture,
    transparent: true,
  });
  const screenGeom = new THREE.PlaneGeometry(1.3, 0.65);
  const screen = new THREE.Mesh(screenGeom, screenMat);
  // Mounted on top of the safe, slightly tilted toward the camera
  screen.rotation.x = -Math.PI / 2.3;
  screen.position.set(0, 0.86, 0.32);
  group.add(screen);

  function redrawScreen(): void {
    const ctx = screenCanvas.getContext("2d");
    if (!ctx) return;
    const W = screenCanvas.width;
    const H = screenCanvas.height;
    const f = getFinance();
    const delta = f.current - f.starting;
    const deltaPct = f.starting > 0 ? (delta / f.starting) * 100 : 0;
    const positive = delta >= 0;

    // Background — dark with subtle scan lines
    ctx.fillStyle = "#06090f";
    ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = "rgba(92, 217, 255, 0.05)";
    for (let y = 0; y < H; y += 4) ctx.fillRect(0, y, W, 1);

    // Border
    ctx.strokeStyle = "rgba(92, 217, 255, 0.5)";
    ctx.lineWidth = 4;
    ctx.strokeRect(2, 2, W - 4, H - 4);

    // Title
    ctx.fillStyle = "#5cd9ff";
    ctx.font = "bold 28px monospace";
    ctx.fillText("MONEY VAULT", 22, 44);

    // Starting label + value
    ctx.fillStyle = "#8b949e";
    ctx.font = "16px monospace";
    ctx.fillText("STARTING", 22, 92);
    ctx.fillStyle = "#e6edf3";
    ctx.font = "bold 26px monospace";
    ctx.fillText(`$${formatMoney(f.starting)}`, 22, 124);

    // Current label + value (color by direction)
    ctx.fillStyle = "#8b949e";
    ctx.font = "16px monospace";
    ctx.fillText("CURRENT", 22, 164);
    ctx.fillStyle = positive ? "#3fb950" : "#f85149";
    ctx.font = "bold 32px monospace";
    ctx.fillText(`$${formatMoney(f.current)}`, 22, 204);

    // Delta on the right
    ctx.fillStyle = positive ? "#3fb950" : "#f85149";
    ctx.font = "bold 28px monospace";
    const deltaStr = `${positive ? "+" : "-"}${Math.abs(deltaPct).toFixed(2)}%`;
    const dw = ctx.measureText(deltaStr).width;
    ctx.fillText(deltaStr, W - dw - 22, 204);
    ctx.font = "12px monospace";
    ctx.fillStyle = "#8b949e";
    ctx.fillText(positive ? "▲ GAIN" : "▼ LOSS", W - 86, 220);

    screenTexture.needsUpdate = true;
  }
  redrawScreen();
  const stopFinanceSub = financeSubscribe(redrawScreen);

  // ─── Hit detection ────────────────────────────────────────────────────
  const hitSphere = new THREE.Sphere(group.position.clone(), HIT_RADIUS);

  function rayHits(raycaster: THREE.Raycaster): boolean {
    return raycaster.ray.intersectsSphere(hitSphere);
  }

  // ─── Hover envelope + dial spin ───────────────────────────────────────
  let hoverTarget = 0;
  function step(dt: number): void {
    // Dial slowly turns to feel "alive"
    dial.rotation.z -= dt * 0.4;
    // Pedestal emissive pulse drifts
    pedMat.emissiveIntensity = 0.05 + Math.sin(performance.now() * 0.002) * 0.03;
    // Apply hover envelope to the door frame opacity
    accentDimMat.opacity = 0.4 + hoverTarget * 0.5;
  }

  function setHover(on: boolean): void {
    hoverTarget = on ? 1 : 0;
  }

  // ─── HUD overlay ──────────────────────────────────────────────────────
  // The HTML root lives in index.html as #vault-hud. We render its body
  // here so the markup is colocated with the logic that drives it.

  const hudRoot = document.getElementById("vault-hud") as HTMLElement | null;
  let hudOpen = false;
  let hudUnsub: (() => void) | null = null;

  function buildHud(): void {
    if (!hudRoot) return;
    hudRoot.innerHTML = `
      <div class="vault-hud-backdrop" data-close></div>
      <div class="vault-hud-panel" role="dialog" aria-modal="true" aria-label="Money vault">
        <div class="vault-hud-header">
          <div class="vault-hud-title">MONEY VAULT</div>
          <button class="vault-hud-close" type="button" data-close title="Close" aria-label="Close">×</button>
        </div>
        <div class="vault-hud-body">
          <label class="vault-hud-row">
            <span class="vault-hud-label">STARTING ($)</span>
            <input id="vault-input-starting" type="number" inputmode="decimal" min="0" step="1" />
          </label>
          <label class="vault-hud-row">
            <span class="vault-hud-label">CURRENT ($)</span>
            <input id="vault-input-current" type="number" inputmode="decimal" min="0" step="0.01" />
          </label>
          <div class="vault-hud-summary">
            <div class="vault-hud-summary-cell">
              <span class="vault-hud-summary-label">DELTA</span>
              <span class="vault-hud-summary-value" data-delta>—</span>
            </div>
            <div class="vault-hud-summary-cell">
              <span class="vault-hud-summary-label">DELTA %</span>
              <span class="vault-hud-summary-value" data-delta-pct>—</span>
            </div>
          </div>
          <div class="vault-hud-actions">
            <button id="vault-action-reset" type="button" class="ghost">Reset to starting</button>
          </div>
          <div class="vault-hud-rates">
            <div class="vault-hud-rates-title">SIMULATED MARKET</div>
            <ul class="vault-hud-rates-list" id="vault-rates"></ul>
            <div class="vault-hud-rates-hint">
              These rates random-walk for the 3D graph; they don't change your money.
            </div>
          </div>
        </div>
      </div>
    `;

    const startEl = hudRoot.querySelector<HTMLInputElement>("#vault-input-starting")!;
    const curEl   = hudRoot.querySelector<HTMLInputElement>("#vault-input-current")!;
    const resetEl = hudRoot.querySelector<HTMLButtonElement>("#vault-action-reset")!;

    startEl.addEventListener("input", () => {
      const v = parseFloat(startEl.value);
      if (Number.isFinite(v)) setStarting(v);
    });
    curEl.addEventListener("input", () => {
      const v = parseFloat(curEl.value);
      if (Number.isFinite(v)) {
        setCurrent(v);
        sfx.cash();
      }
    });
    resetEl.addEventListener("click", () => {
      resetCurrentToStarting();
      sfx.click();
    });

    for (const el of hudRoot.querySelectorAll<HTMLElement>("[data-close]")) {
      el.addEventListener("click", () => closeHud());
    }
  }

  function refreshHud(): void {
    if (!hudRoot || !hudOpen) return;
    const f = getFinance();
    const startEl = hudRoot.querySelector<HTMLInputElement>("#vault-input-starting");
    const curEl   = hudRoot.querySelector<HTMLInputElement>("#vault-input-current");
    if (startEl && document.activeElement !== startEl) startEl.value = String(f.starting);
    if (curEl   && document.activeElement !== curEl)   curEl.value   = String(f.current);

    const delta = f.current - f.starting;
    const deltaPct = f.starting > 0 ? (delta / f.starting) * 100 : 0;
    const sign = delta >= 0 ? "+" : "-";
    const deltaEl = hudRoot.querySelector<HTMLElement>("[data-delta]");
    const pctEl = hudRoot.querySelector<HTMLElement>("[data-delta-pct]");
    if (deltaEl) {
      deltaEl.textContent = `${sign}$${formatMoney(Math.abs(delta))}`;
      deltaEl.classList.toggle("positive", delta >= 0);
      deltaEl.classList.toggle("negative", delta < 0);
    }
    if (pctEl) {
      pctEl.textContent = `${sign}${Math.abs(deltaPct).toFixed(2)}%`;
      pctEl.classList.toggle("positive", delta >= 0);
      pctEl.classList.toggle("negative", delta < 0);
    }

    const ratesUl = hudRoot.querySelector<HTMLUListElement>("#vault-rates");
    if (ratesUl) {
      ratesUl.innerHTML = f.rates.map(r => {
        const recent = r.history.slice(-5);
        const prev = recent[0] ?? r.price;
        const change = r.price - prev;
        const changePct = prev > 0 ? (change / prev) * 100 : 0;
        const up = change >= 0;
        const swatch = `#${r.color.toString(16).padStart(6, "0")}`;
        return `
          <li class="vault-hud-rate ${up ? "up" : "down"}">
            <span class="vault-hud-rate-swatch" style="background:${swatch}"></span>
            <span class="vault-hud-rate-code">${r.code}</span>
            <span class="vault-hud-rate-price">$${formatMoney(r.price)}</span>
            <span class="vault-hud-rate-change">${up ? "▲" : "▼"} ${Math.abs(changePct).toFixed(2)}%</span>
          </li>
        `;
      }).join("");
    }
  }

  function openHud(): void {
    if (!hudRoot) return;
    if (!hudOpen) {
      buildHud();
      hudOpen = true;
      hudRoot.classList.remove("hidden");
      hudUnsub = financeSubscribe(refreshHud);
      sfx.vault();
    }
    refreshHud();
  }

  function closeHud(): void {
    if (!hudRoot) return;
    hudOpen = false;
    hudRoot.classList.add("hidden");
    if (hudUnsub) { hudUnsub(); hudUnsub = null; }
    sfx.click();
  }

  // Expose hover-effect setter for world.ts; we don't add our own
  // pointermove listener — that's owned by world.ts so it can dispatch
  // hover among NPCs, the brain, and the vault from a single raycast.
  (group as unknown as { __setHover: (on: boolean) => void }).__setHover = setHover;

  function dispose(): void {
    closeHud();
    stopFinanceSub();
    scene.remove(group);
    bodyGeom.dispose();
    doorGeom.dispose();
    dialGeom.dispose();
    pinGeom.dispose();
    handleGeom.dispose();
    capGeom.dispose();
    pedGeom.dispose();
    screenGeom.dispose();
    frameGeom.dispose();
    wallMat.dispose();
    doorMat.dispose();
    accentMat.dispose();
    accentDimMat.dispose();
    pinMat.dispose();
    pedMat.dispose();
    screenMat.dispose();
    screenTexture.dispose();
    tickMat.dispose();
  }

  return {
    group,
    hitSphere,
    rayHits,
    openHud,
    closeHud,
    step,
    dispose,
  };
}

export function setVaultHover(handle: VaultHandle, on: boolean): void {
  const fn = (handle.group as unknown as { __setHover?: (on: boolean) => void }).__setHover;
  if (fn) fn(on);
}

function formatMoney(n: number): string {
  // 1234.56 → "1,234.56"; large numbers compress.
  if (Math.abs(n) >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
  if (Math.abs(n) >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
  return n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
