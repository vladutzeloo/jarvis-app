// World tab — clickable NPC launchers.
//
// Each NPC is a small humanoid pawn placed on the holodeck floor around the
// core. Click an NPC to launch its associated app (URL or registered URI
// scheme); HTML labels float above each one and are re-projected from the
// 3D scene every frame so they track the camera + orbit controls.
//
// Known launch targets: claude.ai (web), vscode://, x-github-client://,
// ubuntu.com, perplexity.ai, gemini.google.com, jules.google. Where a URI
// scheme isn't registered on the host, we fall back to the marketing URL so
// the click is never a no-op.

import * as THREE from "three";
import { openUrl } from "@tauri-apps/plugin-opener";

export interface NPCConfig {
  id: string;
  name: string;
  color: number;
  // Primary launch target — a URL or registered URI scheme. Tried first.
  primary: string;
  // Optional fallback (usually a web URL) tried if the primary fails. This
  // covers the case where a custom URI scheme isn't registered on the host.
  fallback?: string;
  // Optional explicit "open with" app name (e.g. 'google-chrome').
  openWith?: string;
  // Pixel-art tag shown beneath the name in the floating label.
  tag: string;
}

export interface NPC {
  cfg: NPCConfig;
  group: THREE.Group;
  body: THREE.Mesh;
  head: THREE.Mesh;
  pedestal: THREE.Mesh;
  antenna: THREE.Mesh;
  label: HTMLDivElement;
  labelStatus: HTMLSpanElement;
  hovered: boolean;
  flashUntil: number;
}

export interface NPCsHandle {
  npcs: NPC[];
  raycastNPC(ev: PointerEvent): NPC | null;
  setHover(npc: NPC | null): void;
  step(dt: number): void;
  dispose(): void;
}

// One source of truth for the NPC roster. Adding another NPC is a single
// row here plus an entry in NPC_RING_RADIUS / FLOOR_Y if you want a layout
// tweak.
const NPC_DATA: NPCConfig[] = [
  { id: "claude",  name: "Claude",         tag: "ANTHROPIC", color: 0xcc785c, primary: "https://claude.ai" },
  { id: "vscode",  name: "VS Code",        tag: "EDITOR",    color: 0x007acc, primary: "vscode://", fallback: "https://code.visualstudio.com" },
  { id: "github",  name: "GitHub Desktop", tag: "REPO SYNC", color: 0xb0b6c0, primary: "x-github-client://", fallback: "https://desktop.github.com" },
  { id: "ubuntu",  name: "Ubuntu",         tag: "DISTRO",    color: 0xe95420, primary: "https://ubuntu.com" },
  { id: "perplex", name: "Perplexity",     tag: "RESEARCH",  color: 0x20808d, primary: "https://www.perplexity.ai" },
  { id: "gemini",  name: "Gemini",         tag: "GOOGLE AI", color: 0x9b72cb, primary: "https://gemini.google.com" },
  { id: "jules",   name: "Jules",          tag: "JULES.GOOGLE", color: 0x4285f4, primary: "https://jules.google", openWith: "google-chrome" },
];

const NPC_RING_RADIUS = 5.5;
const NPC_FLOOR_Y = -1.55;

export function createNPCs(
  scene: THREE.Scene,
  camera: THREE.PerspectiveCamera,
  canvas: HTMLCanvasElement,
): NPCsHandle {
  const labelLayer = document.createElement("div");
  labelLayer.className = "world-npc-labels";
  const pane = canvas.parentElement;
  // pane is .world-pane (positioned). Fall back to body if not found so the
  // labels still get drawn somewhere visible.
  (pane ?? document.body).appendChild(labelLayer);

  // Shared geometry — disposed once on teardown
  const pedGeom = new THREE.CylinderGeometry(0.42, 0.5, 0.1, 24);
  const bodyGeom = new THREE.CylinderGeometry(0.18, 0.24, 0.6, 16);
  const headGeom = new THREE.SphereGeometry(0.16, 18, 18);
  const antGeom = new THREE.SphereGeometry(0.045, 10, 10);

  const npcs: NPC[] = NPC_DATA.map((cfg, i) => {
    // Lay them out on a ring, starting at "12 o'clock" so the first NPC is
    // visible without orbiting.
    const angle = (i / NPC_DATA.length) * Math.PI * 2 - Math.PI / 2;
    const x = Math.cos(angle) * NPC_RING_RADIUS;
    const z = Math.sin(angle) * NPC_RING_RADIUS;

    const group = new THREE.Group();
    group.position.set(x, NPC_FLOOR_Y, z);
    // Face the core
    group.lookAt(0, group.position.y, 0);

    const pedMat = new THREE.MeshStandardMaterial({
      color: 0x14202a, metalness: 0.6, roughness: 0.32,
      emissive: cfg.color, emissiveIntensity: 0.06,
    });
    const pedestal = new THREE.Mesh(pedGeom, pedMat);
    pedestal.position.y = -0.3;
    group.add(pedestal);

    const bodyMat = new THREE.MeshStandardMaterial({
      color: cfg.color,
      emissive: cfg.color,
      emissiveIntensity: 0.4,
      metalness: 0.3,
      roughness: 0.45,
    });
    const body = new THREE.Mesh(bodyGeom, bodyMat);
    body.position.y = 0.05;
    group.add(body);

    const head = new THREE.Mesh(headGeom, bodyMat);
    head.position.y = 0.42;
    group.add(head);

    const antMat = new THREE.MeshBasicMaterial({ color: cfg.color });
    const antenna = new THREE.Mesh(antGeom, antMat);
    antenna.position.y = 0.62;
    group.add(antenna);

    scene.add(group);

    const label = document.createElement("div");
    label.className = "world-npc-label";
    label.innerHTML = `
      <span class="world-npc-name"></span>
      <span class="world-npc-tag"></span>
      <span class="world-npc-status"></span>
    `;
    (label.querySelector(".world-npc-name") as HTMLElement).textContent = cfg.name;
    (label.querySelector(".world-npc-tag") as HTMLElement).textContent = cfg.tag;
    const labelStatus = label.querySelector(".world-npc-status") as HTMLSpanElement;
    labelLayer.appendChild(label);

    return {
      cfg, group, body, head, pedestal, antenna,
      label, labelStatus,
      hovered: false,
      flashUntil: 0,
    };
  });

  const raycaster = new THREE.Raycaster();
  const ndc = new THREE.Vector2();

  function raycastNPC(ev: PointerEvent): NPC | null {
    const rect = canvas.getBoundingClientRect();
    ndc.set(
      ((ev.clientX - rect.left) / rect.width) * 2 - 1,
      -((ev.clientY - rect.top) / rect.height) * 2 + 1,
    );
    raycaster.setFromCamera(ndc, camera);

    let nearest: { npc: NPC; dist: number } | null = null;
    for (const npc of npcs) {
      const hits = raycaster.intersectObject(npc.group, true);
      if (hits.length === 0) continue;
      const d = hits[0].distance;
      if (!nearest || d < nearest.dist) nearest = { npc, dist: d };
    }
    return nearest?.npc ?? null;
  }

  function setHover(target: NPC | null) {
    for (const n of npcs) n.hovered = (n === target);
  }

  // Per-frame projection of label positions and idle bob animation.
  const proj = new THREE.Vector3();

  function step(dt: number) {
    const rect = canvas.getBoundingClientRect();
    const halfW = rect.width / 2;
    const halfH = rect.height / 2;
    const now = performance.now();
    const t = now * 0.001;

    for (let i = 0; i < npcs.length; i++) {
      const npc = npcs[i];

      // Idle bob — subtle, phase-offset per NPC so they don't move in sync
      const phase = t + i * 0.7;
      const bob = Math.sin(phase * 2) * 0.04;
      npc.body.rotation.y = Math.sin(phase) * 0.18;
      npc.head.rotation.y = Math.sin(phase * 1.4) * 0.15;
      npc.body.position.y = 0.05 + bob;
      npc.head.position.y = 0.42 + bob;
      npc.antenna.position.y = 0.62 + bob;

      // Hover scale + flash on launch (flash beats hover)
      const flashing = now < npc.flashUntil;
      const target = flashing ? 1.25 : npc.hovered ? 1.18 : 1.0;
      const eased = npc.group.scale.x + (target - npc.group.scale.x) * Math.min(1, dt * 9);
      npc.group.scale.setScalar(eased);

      // Project the label's world point into screen space.
      proj.copy(npc.group.position);
      proj.y += 1.05; // anchor above the head
      proj.project(camera);
      const x = proj.x * halfW + halfW;
      const y = -proj.y * halfH + halfH;
      const inFront = proj.z < 1;

      npc.label.style.transform = `translate3d(${x}px, ${y}px, 0) translate(-50%, -100%)`;
      npc.label.style.opacity = !inFront ? "0" : npc.hovered || flashing ? "1" : "0.6";
      npc.label.classList.toggle("npc-label-hover", npc.hovered && !flashing);
      npc.label.classList.toggle("npc-label-flash", flashing);
    }
  }

  function dispose() {
    for (const npc of npcs) {
      scene.remove(npc.group);
      // Materials are per-NPC (tinted to brand color); dispose each.
      (npc.body.material as THREE.Material).dispose();
      (npc.pedestal.material as THREE.Material).dispose();
      (npc.antenna.material as THREE.Material).dispose();
      npc.label.remove();
    }
    labelLayer.remove();
    pedGeom.dispose();
    bodyGeom.dispose();
    headGeom.dispose();
    antGeom.dispose();
  }

  return { npcs, raycastNPC, setHover, step, dispose };
}

/**
 * Try to launch an NPC's external app. Returns true on success, false if
 * both the primary and fallback failed. Sets a small status flag on the NPC
 * label that the next animation frame will surface to the user.
 */
export async function launchNPC(npc: NPC): Promise<boolean> {
  npc.flashUntil = performance.now() + 600;

  const setStatus = (text: string, ttl = 1800) => {
    npc.labelStatus.textContent = text;
    if (text) {
      window.setTimeout(() => {
        if (npc.labelStatus.textContent === text) npc.labelStatus.textContent = "";
      }, ttl);
    }
  };

  const tryOpen = (url: string) => openUrl(url, npc.cfg.openWith);

  try {
    await tryOpen(npc.cfg.primary);
    setStatus("OPENED");
    return true;
  } catch (err) {
    if (npc.cfg.fallback) {
      try {
        await tryOpen(npc.cfg.fallback);
        setStatus("WEB");
        return true;
      } catch (err2) {
        console.warn(`[npcs] launch failed for ${npc.cfg.id}:`, err2);
      }
    } else {
      console.warn(`[npcs] launch failed for ${npc.cfg.id}:`, err);
    }
    setStatus("FAILED");
    return false;
  }
}
