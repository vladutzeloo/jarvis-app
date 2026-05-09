// World tab — a small 3D playground. An Obsidian-purple "brain" hovers in
// the middle of a dark void surrounded by orbiting memory nodes; a ring of
// NPC pawns stand at the edge of the holodeck. The camera orbits with mouse
// drag (left button) or pinch (touch).
//
// Click priority on pointer-up:
//   1. NPC pawn   → launches that pawn's external app
//   2. The brain  → launches Obsidian (obsidian:// → fallback obsidian.md)
//   3. Empty space → fires a cyan projectile at the brain (existing game)
// Hits on the brain make it bloom + bump a score counter, miss projectiles
// fade out at range.

import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import {
  createLoop,
  fitRenderer,
  isViewActive,
  makeRenderer,
  observeResize,
  onViewChange,
} from "../three/engine";
import { createNPCs, DEFAULT_NPCS, launchNPC } from "./npcs";
import { openUrl } from "@tauri-apps/plugin-opener";
import { buildVault, setVaultHover } from "./vault";
import { buildCurrencyGraph } from "./graph";
import { initDJ } from "./dj";
import { initLibrarian } from "./librarian";
import { stepFinanceSim } from "./finance";
import { sfx } from "./sfx";

const VIEW_NAME = "world";

interface Projectile {
  mesh: THREE.Mesh;
  velocity: THREE.Vector3;
  life: number;
}

let started = false;

export function initWorld(): void {
  if (started) return;
  started = true;

  const view = document.querySelector<HTMLElement>(`.view[data-view="${VIEW_NAME}"]`);
  const canvas = document.getElementById("world-canvas") as HTMLCanvasElement | null;
  const scoreEl = document.getElementById("world-score");
  const hintEl = document.getElementById("world-hint");
  if (!view || !canvas) return;

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x05080d);
  scene.fog = new THREE.FogExp2(0x05080d, 0.04);

  const camera = new THREE.PerspectiveCamera(55, 1, 0.1, 200);
  camera.position.set(0, 2.5, 8);

  const renderer = makeRenderer(canvas);
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.1;

  const controls = new OrbitControls(camera, canvas);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.minDistance = 4;
  controls.maxDistance = 22;
  controls.target.set(0, 0, 0);

  // Lights — cyan key + violet rim now that the centerpiece is Obsidian-purple
  scene.add(new THREE.AmbientLight(0x252238, 0.6));
  const key = new THREE.PointLight(0x5cd9ff, 1.2, 30, 1.4);
  key.position.set(4, 6, 4);
  scene.add(key);
  const rim = new THREE.PointLight(0x9b6dff, 0.9, 25, 1.6);
  rim.position.set(-5, -2, -3);
  scene.add(rim);

  // Floor grid for a "holodeck" feel
  const grid = new THREE.GridHelper(40, 40, 0x5cd9ff, 0x14304a);
  (grid.material as THREE.Material & { transparent: boolean; opacity: number }).transparent = true;
  (grid.material as THREE.Material & { opacity: number }).opacity = 0.25;
  grid.position.y = -2;
  scene.add(grid);

  // ─── Obsidian brain — the centerpiece. ──────────────────────────────────
  //
  // A glowing violet TorusKnot inside a wireframe icosahedron (Obsidian's
  // logo is an icosahedron-shaped gem) with a cloud of "memory nodes"
  // orbiting around it on tilted rings, evoking the Obsidian graph view.
  // Clicking anywhere on the brain volume launches Obsidian.

  const BRAIN_PURPLE = 0x9b6dff;
  const BRAIN_DEEP = 0x4c1d95;
  const BRAIN_LIGHT = 0xc4b5fd;

  const coreGroup = new THREE.Group();
  scene.add(coreGroup);

  const knotGeom = new THREE.TorusKnotGeometry(0.9, 0.28, 220, 32);
  const knotMat = new THREE.MeshStandardMaterial({
    color: BRAIN_PURPLE,
    emissive: BRAIN_DEEP,
    emissiveIntensity: 0.6,
    metalness: 0.85,
    roughness: 0.18,
  });
  const knot = new THREE.Mesh(knotGeom, knotMat);
  coreGroup.add(knot);

  const cageGeom = new THREE.IcosahedronGeometry(1.85, 1);
  const cageMat = new THREE.MeshBasicMaterial({
    color: BRAIN_PURPLE,
    wireframe: true,
    transparent: true,
    opacity: 0.45,
  });
  const cage = new THREE.Mesh(cageGeom, cageMat);
  coreGroup.add(cage);

  // Memory nodes — sit on their own group at world origin so they don't
  // inherit the cage/knot spin; we orbit them manually each frame for the
  // "knowledge graph" vibe.
  const memoryGroup = new THREE.Group();
  scene.add(memoryGroup);

  const NODE_COUNT = 16;
  const memoryNodeGeom = new THREE.SphereGeometry(0.07, 10, 10);
  const memoryNodeMat = new THREE.MeshBasicMaterial({ color: BRAIN_LIGHT });

  interface MemoryNode {
    mesh: THREE.Mesh;
    angle: number;
    radius: number;
    tiltY: number;
    tiltX: number;
    speed: number;
  }
  const memoryNodes: MemoryNode[] = [];
  for (let i = 0; i < NODE_COUNT; i++) {
    const mesh = new THREE.Mesh(memoryNodeGeom, memoryNodeMat);
    memoryGroup.add(mesh);
    memoryNodes.push({
      mesh,
      angle: (i / NODE_COUNT) * Math.PI * 2 + Math.random() * 0.4,
      radius: 2.25 + Math.random() * 0.35,
      tiltY: (Math.random() - 0.5) * 0.9,
      tiltX: (Math.random() - 0.5) * 0.5,
      speed: 0.06 + Math.random() * 0.16,
    });
  }

  // Thin connector lines from nodes back toward the core — keeps redrawing
  // them per frame would be expensive, so we just animate the nodes and
  // let the visual graph emerge from their motion. (If we want lines later,
  // add a single LineSegments with positions updated in-place.)

  // Click hit sphere — the central brain has a sphere-shaped hit area
  // slightly larger than the cage so aim feels generous. Used for both
  // projectile collision and brain-click detection.
  const HIT_RADIUS = 2.0;
  const brainHitSphere = new THREE.Sphere(new THREE.Vector3(0, 0, 0), HIT_RADIUS);

  let brainHover = 0; // 0..1 envelope, lerped each frame

  // ─── Money vault + currency graph + DJ + Librarian ────────────────────
  // The vault lives on the left of the holodeck; the 3D currency graph
  // floats just above and behind it. The DJ joins the NPC ring as the 8th
  // pawn — its `onClick` opens the music dock instead of launching a URL.
  // The Librarian is the 9th: its `onClick` opens an NVIDIA-backed console
  // grounded in the user's local Obsidian vault.
  const vaultHandle = buildVault(scene);
  const graphHandle = buildCurrencyGraph(scene, new THREE.Vector3(-7.2, 0.5, -3.3));
  const djHandle = initDJ();
  const librarianHandle = initLibrarian();

  // NPC launchers — 7 default pawns + DJ + Librarian. createNPCs lays them
  // out evenly on a ring so the spacing stays balanced.
  const npcsHandle = createNPCs(scene, camera, canvas, [
    ...DEFAULT_NPCS,
    djHandle.npcConfig,
    librarianHandle.npcConfig,
  ]);
  // Decorate the librarian's pawn with an open book so on the map they're
  // visibly reading. Done post-createNPCs because the visual hangs off the
  // NPC's group (createNPCs builds every body from shared geometry).
  librarianHandle.attachVisual(npcsHandle.npcs);

  // Projectile pool
  const projectiles: Projectile[] = [];
  const projGeom = new THREE.SphereGeometry(0.07, 12, 12);
  const projMat = new THREE.MeshBasicMaterial({ color: 0xa8efff });

  let score = 0;
  let bloom = 0;

  // Reusable raycaster for both fire-projectile and brain hit-test paths.
  const sharedRaycaster = new THREE.Raycaster();
  const sharedNdc = new THREE.Vector2();

  function setRayFromPointer(ev: PointerEvent) {
    const rect = canvas!.getBoundingClientRect();
    sharedNdc.set(
      ((ev.clientX - rect.left) / rect.width) * 2 - 1,
      -((ev.clientY - rect.top) / rect.height) * 2 + 1,
    );
    sharedRaycaster.setFromCamera(sharedNdc, camera);
  }

  function rayHitsBrain(ev: PointerEvent): boolean {
    setRayFromPointer(ev);
    return sharedRaycaster.ray.intersectsSphere(brainHitSphere);
  }

  function rayHitsVault(ev: PointerEvent): boolean {
    setRayFromPointer(ev);
    return vaultHandle.rayHits(sharedRaycaster);
  }

  function fireFromPointer(ev: PointerEvent) {
    if (ev.button !== undefined && ev.button !== 0) return;
    setRayFromPointer(ev);
    const dir = sharedRaycaster.ray.direction.clone().normalize();
    const origin = camera.position.clone().add(dir.clone().multiplyScalar(0.6));
    const m = new THREE.Mesh(projGeom, projMat);
    m.position.copy(origin);
    scene.add(m);
    projectiles.push({ mesh: m, velocity: dir.multiplyScalar(28), life: 1.6 });
    if (hintEl) hintEl.classList.add("dimmed");
  }

  /**
   * Launch the Obsidian desktop app, falling back to the website if the
   * `obsidian://` URI scheme isn't registered. Surfaces a brief flash on
   * the brain so the click is never silent.
   */
  async function launchObsidian() {
    bloom = Math.max(bloom, 0.7);
    sfx.launch();
    try {
      await openUrl("obsidian://");
    } catch {
      try {
        await openUrl("https://obsidian.md");
      } catch (err2) {
        console.warn("[world] obsidian launch failed:", err2);
      }
    }
  }

  // Drag-vs-click discrimination so OrbitControls drags don't fire shots.
  let downAt = 0;
  let downX = 0;
  let downY = 0;
  const onDown = (ev: PointerEvent) => {
    downAt = performance.now();
    downX = ev.clientX;
    downY = ev.clientY;
  };
  const onUp = (ev: PointerEvent) => {
    const dt = performance.now() - downAt;
    const dx = ev.clientX - downX;
    const dy = ev.clientY - downY;
    if (dt >= 250 || Math.hypot(dx, dy) >= 6) return;
    // Click priority: NPC > brain > vault > empty space (fire). Each
    // launcher returns early so a click never both launches AND fires.
    const npcHit = npcsHandle.raycastNPC(ev);
    if (npcHit) {
      sfx.click();
      void launchNPC(npcHit);
      return;
    }
    if (rayHitsBrain(ev)) {
      void launchObsidian();
      return;
    }
    if (rayHitsVault(ev)) {
      vaultHandle.openHud();
      return;
    }
    fireFromPointer(ev);
    sfx.click();
  };
  // Hover detection: cheap raycast against NPC groups + brain + vault.
  // Cursor priority follows the click priority above so the user can tell
  // what's about to happen.
  let brainHovered = false;
  let lastNpcHover: ReturnType<typeof npcsHandle.raycastNPC> = null;
  const onMove = (ev: PointerEvent) => {
    const npc = npcsHandle.raycastNPC(ev);
    npcsHandle.setHover(npc);
    if (npc !== lastNpcHover) {
      if (npc) sfx.hover();
      lastNpcHover = npc;
    }
    if (npc) {
      brainHovered = false;
      setVaultHover(vaultHandle, false);
      canvas!.style.cursor = "pointer";
      return;
    }
    brainHovered = rayHitsBrain(ev);
    if (brainHovered) {
      setVaultHover(vaultHandle, false);
      canvas!.style.cursor = "pointer";
      return;
    }
    const vaultHovered = rayHitsVault(ev);
    setVaultHover(vaultHandle, vaultHovered);
    canvas!.style.cursor = vaultHovered ? "pointer" : "crosshair";
  };
  canvas.addEventListener("pointerdown", onDown);
  canvas.addEventListener("pointerup", onUp);
  canvas.addEventListener("pointermove", onMove);

  function setScore(n: number) {
    score = n;
    if (scoreEl) scoreEl.textContent = String(n);
  }

  const fit = () => fitRenderer(renderer, camera, view);
  fit();
  const stopResize = observeResize(view, fit);

  const tmp = new THREE.Vector3();
  const loop = createLoop(dt => {
    coreGroup.rotation.y += dt * 0.4;
    coreGroup.rotation.x += dt * 0.15;
    cage.rotation.y -= dt * 0.6;

    bloom = Math.max(0, bloom - dt * 2.4);
    // Hover envelope — eases up to 1 while the cursor is over the brain,
    // back to 0 otherwise. Adds a subtle pulse so the user can confirm
    // the central object is interactive before clicking.
    const brainHoverTarget = brainHovered ? 1 : 0;
    brainHover += (brainHoverTarget - brainHover) * Math.min(1, dt * 8);

    knotMat.emissiveIntensity = 0.6 + bloom * 1.6 + brainHover * 0.5;
    cageMat.opacity = 0.45 + bloom * 0.45 + brainHover * 0.2;

    // Orbit the memory nodes around the brain. Each one has its own tilt
    // and speed so the cloud feels like a real graph rather than a ring.
    for (let i = 0; i < memoryNodes.length; i++) {
      const n = memoryNodes[i];
      n.angle += dt * n.speed;
      const x = Math.cos(n.angle) * n.radius;
      const z = Math.sin(n.angle) * n.radius;
      // tiltY pushes the orbit plane up/down per node; tiltX rolls it
      n.mesh.position.set(
        x,
        Math.sin(n.angle) * n.tiltY * n.radius * 0.4 + n.tiltX * 0.5,
        z,
      );
    }
    // Slow drift on the whole memory cloud so it feels independent of the
    // knot's rotation.
    memoryGroup.rotation.y += dt * 0.05;

    for (let i = projectiles.length - 1; i >= 0; i--) {
      const p = projectiles[i];
      p.mesh.position.addScaledVector(p.velocity, dt);
      p.life -= dt;
      tmp.copy(p.mesh.position);
      if (tmp.length() < HIT_RADIUS) {
        bloom = 1;
        setScore(score + 1);
        sfx.hit();
        scene.remove(p.mesh);
        projectiles.splice(i, 1);
        continue;
      }
      if (p.life <= 0 || p.mesh.position.length() > 60) {
        scene.remove(p.mesh);
        projectiles.splice(i, 1);
      }
    }

    // NPCs idle-bob and re-project their HTML labels each frame so they
    // track the orbiting camera.
    npcsHandle.step(dt);

    // Vault dial spin + on-vault screen pulse; currency rates random-walk
    // and re-feed the 3D graph; DJ dock visualizer reads from the audio
    // analyser.
    vaultHandle.step(dt);
    stepFinanceSim(performance.now());
    graphHandle.step();
    djHandle.step();
    librarianHandle.step(dt);

    controls.update();
    renderer.render(scene, camera);
  }, {
    isVisible: () => isViewActive(VIEW_NAME),
  });

  // Start only when the World tab is active; pause when it isn't.
  const stopViewObs = onViewChange(() => {
    if (isViewActive(VIEW_NAME)) {
      fit();
      loop.start();
    } else {
      loop.stop();
    }
  });
  if (isViewActive(VIEW_NAME)) loop.start();

  (window as any).__jarvisWorld = {
    dispose() {
      loop.dispose();
      stopResize();
      stopViewObs();
      canvas!.removeEventListener("pointerdown", onDown);
      canvas!.removeEventListener("pointerup", onUp);
      canvas!.removeEventListener("pointermove", onMove);
      // Tear the librarian's book off the NPC group BEFORE npcsHandle.dispose
      // removes the parent group from the scene — the order matters because
      // npcsHandle.dispose() doesn't know about externally-attached children.
      librarianHandle.dispose();
      npcsHandle.dispose();
      vaultHandle.dispose();
      graphHandle.dispose();
      djHandle.dispose();
      controls.dispose();
      knotGeom.dispose();
      knotMat.dispose();
      cageGeom.dispose();
      cageMat.dispose();
      memoryNodeGeom.dispose();
      memoryNodeMat.dispose();
      projGeom.dispose();
      projMat.dispose();
      renderer.dispose();
    },
  };
}
