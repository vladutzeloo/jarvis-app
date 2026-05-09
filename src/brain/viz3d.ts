// Brain viz — 3D mode. A glowing core surrounded by orbiting nodes, one per
// vault doc. The same hooks the SVG version uses are mirrored here so search
// hits and chat-busy "firing" pulses light up nodes in 3D too. Toggle wires
// up via #brain-viz-mode in the brain header.
//
// Sits on top of the existing SVG viz inside .brain-viz; we hide whichever
// surface isn't active by toggling the .viz3d-on class on .brain-viz.

import * as THREE from "three";
import { getVaultIndex, setVizHooks } from "./brain";
import type { SearchHit } from "../types";
import {
  createLoop,
  fitRenderer,
  isViewActive,
  makeRenderer,
  observeResize,
  onViewChange,
} from "../three/engine";
import { createBloomComposer } from "../three/post";

const VIEW_NAME = "brain";

interface Node3D {
  mesh: THREE.Mesh;
  base: THREE.Vector3;
  axis: THREE.Vector3;
  speed: number;
  docIndex: number;
  matched: boolean;
  fireUntil: number;
}

let started = false;

export function initBrainViz3D(): void {
  if (started) return;
  started = true;

  const container = document.querySelector<HTMLElement>(".brain-viz");
  const canvas = document.getElementById("brain-viz-3d") as HTMLCanvasElement | null;
  const toggle = document.getElementById("brain-viz-mode") as HTMLButtonElement | null;
  const svg = document.querySelector<SVGElement>(".brain-viz-svg");
  const statActive = document.getElementById("brain-stat-active");
  if (!container || !canvas || !toggle || !svg) return;

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(55, 1, 0.1, 100);
  camera.position.set(0, 0.6, 5.4);
  camera.lookAt(0, 0, 0);

  const renderer = makeRenderer(canvas, true);
  renderer.setClearColor(0x000000, 0);

  // HDR bloom on the core, halo, and matched/firing nodes. We push the
  // intensity above the base level whenever nodes are firing so the viz
  // visibly "lights up" while the chat is busy or during search highlights.
  const post = createBloomComposer(renderer, scene, camera, {
    intensity: 0.7,
    luminanceThreshold: 0.45,
    luminanceSmoothing: 0.2,
  });
  const BLOOM_BASE = 0.7;
  const BLOOM_PER_FIRE = 0.09;
  const BLOOM_MAX = 1.6;

  // Core glow: bright sphere + soft sprite halo
  const coreMat = new THREE.MeshBasicMaterial({ color: 0x5cd9ff });
  const core = new THREE.Mesh(new THREE.SphereGeometry(0.18, 24, 24), coreMat);
  scene.add(core);

  const haloMat = new THREE.MeshBasicMaterial({
    color: 0x5cd9ff,
    transparent: true,
    opacity: 0.18,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  });
  const halo = new THREE.Mesh(new THREE.SphereGeometry(0.5, 24, 24), haloMat);
  scene.add(halo);

  // Orbital rings
  const ringMat = new THREE.LineBasicMaterial({ color: 0x5cd9ff, transparent: true, opacity: 0.18 });
  const ringRadii = [1.1, 1.6, 2.1, 2.55];
  for (const r of ringRadii) {
    const pts: THREE.Vector3[] = [];
    for (let i = 0; i <= 96; i++) {
      const a = (i / 96) * Math.PI * 2;
      pts.push(new THREE.Vector3(Math.cos(a) * r, 0, Math.sin(a) * r));
    }
    const g = new THREE.BufferGeometry().setFromPoints(pts);
    const ring = new THREE.LineLoop(g, ringMat);
    ring.rotation.x = (Math.random() - 0.5) * 0.4;
    ring.rotation.z = (Math.random() - 0.5) * 0.4;
    scene.add(ring);
  }

  // Node pool
  const nodeGeom = new THREE.SphereGeometry(0.045, 12, 12);
  const dimMat = new THREE.MeshBasicMaterial({ color: 0x5cd9ff, transparent: true, opacity: 0.55 });
  const hotMat = new THREE.MeshBasicMaterial({ color: 0xa8efff });
  const nodes: Node3D[] = [];

  function clearNodes() {
    // nodeGeom + materials are shared across rebuilds; only the meshes are
    // per-build and they hold no GPU resources of their own.
    for (const n of nodes) scene.remove(n.mesh);
    nodes.length = 0;
  }

  function rebuildNodes(count: number) {
    clearNodes();
    if (count <= 0) return;
    const caps = [10, 18, 28, 36];
    let placed = 0;
    for (let r = 0; r < ringRadii.length && placed < count; r++) {
      const remainingCap = caps.slice(r).reduce((a, b) => a + b, 0);
      const want = Math.min(caps[r], Math.ceil(((count - placed) / remainingCap) * caps[r]));
      const onRing = Math.max(1, want);
      const phase = Math.random() * Math.PI * 2;
      const tilt = (Math.random() - 0.5) * 0.5;
      for (let i = 0; i < onRing && placed < count; i++) {
        const a = phase + (i / onRing) * Math.PI * 2;
        const radius = ringRadii[r] + (Math.random() - 0.5) * 0.08;
        const base = new THREE.Vector3(
          Math.cos(a) * radius,
          Math.sin(a) * tilt * 0.6,
          Math.sin(a) * radius,
        );
        const m = new THREE.Mesh(nodeGeom, dimMat);
        m.position.copy(base);
        scene.add(m);
        nodes.push({
          mesh: m,
          base,
          axis: new THREE.Vector3(0, 1, 0).applyAxisAngle(
            new THREE.Vector3(1, 0, 0),
            tilt * 0.8,
          ),
          speed: 0.12 + Math.random() * 0.18,
          docIndex: placed,
          matched: false,
          fireUntil: 0,
        });
        placed++;
      }
    }
  }

  function setMatched(active: Set<number>) {
    let count = 0;
    for (const n of nodes) {
      const on = active.has(n.docIndex);
      n.matched = on;
      n.mesh.material = on ? hotMat : dimMat;
      if (on) count++;
    }
    if (statActive) statActive.textContent = String(count);
  }

  function fireRandom() {
    if (!nodes.length) return;
    const n = nodes[(Math.random() * nodes.length) | 0];
    n.fireUntil = performance.now() + 700;
  }

  let pulseInterval = 480;
  let pulseTimer: number | undefined;
  function startPulse() {
    if (pulseTimer) clearInterval(pulseTimer);
    pulseTimer = window.setInterval(fireRandom, pulseInterval);
  }
  startPulse();

  const headerEl = document.querySelector("header");
  let headerObserver: MutationObserver | null = null;
  if (headerEl) {
    headerObserver = new MutationObserver(() => {
      const busy = headerEl.classList.contains("busy");
      pulseInterval = busy ? 130 : 480;
      startPulse();
    });
    headerObserver.observe(headerEl, { attributes: true, attributeFilter: ["class"] });
  }

  const fit = () => {
    fitRenderer(renderer, camera, container);
    post.setSize(container.clientWidth, container.clientHeight);
  };
  const loop = createLoop((dt, t) => {
    halo.scale.setScalar(1 + Math.sin(t * 1.6) * 0.06);
    coreMat.color.setHSL(0.54, 0.9, 0.6 + Math.sin(t * 2.2) * 0.05);

    let liveCount = 0;
    const now = performance.now();
    for (const n of nodes) {
      n.base.applyAxisAngle(n.axis, dt * n.speed);
      n.mesh.position.copy(n.base);
      const firing = now < n.fireUntil;
      if (firing || n.matched) liveCount++;
      const target = n.matched || firing ? 1.6 : 1.0;
      n.mesh.scale.lerp(new THREE.Vector3(target, target, target), 0.18);
    }

    // Bloom intensity follows live nodes, smoothed so it feels organic
    // rather than stepping each frame.
    const wantedIntensity = Math.min(BLOOM_MAX, BLOOM_BASE + liveCount * BLOOM_PER_FIRE);
    post.bloom.intensity += (wantedIntensity - post.bloom.intensity) * Math.min(1, dt * 6);

    post.composer.render(dt);
  }, {
    isVisible: () => isViewActive(VIEW_NAME) && container.classList.contains("viz3d-on"),
  });

  function applyMode(on: boolean) {
    container!.classList.toggle("viz3d-on", on);
    toggle!.textContent = on ? "2D" : "3D";
    toggle!.title = on ? "Switch to 2D viz" : "Switch to 3D viz";
    if (on) {
      fit();
      loop.start();
      // refresh from current vault
      const idx = getVaultIndex();
      rebuildNodes(idx ? idx.length : 0);
    } else {
      loop.stop();
    }
  }

  toggle.addEventListener("click", () => {
    applyMode(!container.classList.contains("viz3d-on"));
  });

  const stopResize = observeResize(container, fit);
  const stopViewObs = onViewChange(() => {
    if (isViewActive(VIEW_NAME) && container.classList.contains("viz3d-on")) {
      fit();
      loop.start();
    } else {
      loop.stop();
    }
  });

  // Hook into the same vault notifications the SVG viz uses. The SVG viz also
  // registers via setVizHooks; we wrap its hooks so both stay in sync.
  setVizHooks({
    onIndexReady: () => {
      if (container.classList.contains("viz3d-on")) {
        const idx = getVaultIndex();
        rebuildNodes(idx ? idx.length : 0);
      }
    },
    onSearchHits: (hits: SearchHit[]) => {
      const idx = getVaultIndex();
      if (!idx) return;
      const matchedPaths = new Set(hits.map(h => h.doc.path));
      const indices = new Set<number>();
      for (let i = 0; i < idx.length; i++) {
        if (matchedPaths.has(idx[i].path)) indices.add(i);
      }
      setMatched(indices);
    },
    onClearHighlights: () => setMatched(new Set()),
  });

  (window as any).__jarvisBrain3D = {
    dispose() {
      loop.dispose();
      stopResize();
      stopViewObs();
      headerObserver?.disconnect();
      if (pulseTimer !== undefined) clearInterval(pulseTimer);
      clearNodes();
      nodeGeom.dispose();
      dimMat.dispose();
      hotMat.dispose();
      coreMat.dispose();
      haloMat.dispose();
      ringMat.dispose();
      post.dispose();
      renderer.dispose();
    },
  };
}
