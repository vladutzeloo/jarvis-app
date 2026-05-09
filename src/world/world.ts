// World tab — a small 3D playground. A glowing wireframe core hovers in the
// middle of a dark void; the camera orbits with mouse drag (left button) or
// pinch (touch). Click anywhere to fire a cyan projectile from the camera
// toward the click. Hits make the core bloom + bump a score counter, miss
// projectiles fade out at range.

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
import { createNPCs, launchNPC } from "./npcs";

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

  // Lights
  scene.add(new THREE.AmbientLight(0x223344, 0.6));
  const key = new THREE.PointLight(0x5cd9ff, 1.4, 30, 1.4);
  key.position.set(4, 6, 4);
  scene.add(key);
  const rim = new THREE.PointLight(0x3b82f6, 0.7, 25, 1.6);
  rim.position.set(-5, -2, -3);
  scene.add(rim);

  // Floor grid for a "holodeck" feel
  const grid = new THREE.GridHelper(40, 40, 0x5cd9ff, 0x14304a);
  (grid.material as THREE.Material & { transparent: boolean; opacity: number }).transparent = true;
  (grid.material as THREE.Material & { opacity: number }).opacity = 0.25;
  grid.position.y = -2;
  scene.add(grid);

  // Core: knot inside a wireframe icosahedron
  const coreGroup = new THREE.Group();
  scene.add(coreGroup);

  const knotGeom = new THREE.TorusKnotGeometry(0.9, 0.28, 220, 32);
  const knotMat = new THREE.MeshStandardMaterial({
    color: 0x5cd9ff,
    emissive: 0x0a3a52,
    emissiveIntensity: 0.6,
    metalness: 0.85,
    roughness: 0.18,
  });
  const knot = new THREE.Mesh(knotGeom, knotMat);
  coreGroup.add(knot);

  const cageGeom = new THREE.IcosahedronGeometry(1.85, 1);
  const cageMat = new THREE.MeshBasicMaterial({
    color: 0x5cd9ff,
    wireframe: true,
    transparent: true,
    opacity: 0.35,
  });
  const cage = new THREE.Mesh(cageGeom, cageMat);
  coreGroup.add(cage);

  // Hit sphere (slightly larger than the cage so aim feels generous)
  const HIT_RADIUS = 2.0;

  // NPC launchers — pawns around the core that open external apps when
  // clicked. They share the scene's lights and don't need their own loop.
  const npcsHandle = createNPCs(scene, camera, canvas);

  // Projectile pool
  const projectiles: Projectile[] = [];
  const projGeom = new THREE.SphereGeometry(0.07, 12, 12);
  const projMat = new THREE.MeshBasicMaterial({ color: 0xa8efff });

  let score = 0;
  let bloom = 0;

  function fireFromPointer(ev: PointerEvent) {
    if (ev.button !== undefined && ev.button !== 0) return;
    const rect = canvas!.getBoundingClientRect();
    const ndc = new THREE.Vector2(
      ((ev.clientX - rect.left) / rect.width) * 2 - 1,
      -((ev.clientY - rect.top) / rect.height) * 2 + 1,
    );
    const ray = new THREE.Raycaster();
    ray.setFromCamera(ndc, camera);
    const dir = ray.ray.direction.clone().normalize();
    const origin = camera.position.clone().add(dir.clone().multiplyScalar(0.6));
    const m = new THREE.Mesh(projGeom, projMat);
    m.position.copy(origin);
    scene.add(m);
    projectiles.push({ mesh: m, velocity: dir.multiplyScalar(28), life: 1.6 });
    if (hintEl) hintEl.classList.add("dimmed");
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
    // NPC click takes precedence over firing — clicking a pawn launches its
    // app instead of shooting a projectile through it.
    const hit = npcsHandle.raycastNPC(ev);
    if (hit) {
      void launchNPC(hit);
      return;
    }
    fireFromPointer(ev);
  };
  // Hover detection: cheap raycast against the 7 NPC groups every move.
  const onMove = (ev: PointerEvent) => {
    const npc = npcsHandle.raycastNPC(ev);
    npcsHandle.setHover(npc);
    canvas!.style.cursor = npc ? "pointer" : "crosshair";
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
    knotMat.emissiveIntensity = 0.6 + bloom * 1.6;
    cageMat.opacity = 0.35 + bloom * 0.5;

    for (let i = projectiles.length - 1; i >= 0; i--) {
      const p = projectiles[i];
      p.mesh.position.addScaledVector(p.velocity, dt);
      p.life -= dt;
      tmp.copy(p.mesh.position);
      if (tmp.length() < HIT_RADIUS) {
        bloom = 1;
        setScore(score + 1);
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
      npcsHandle.dispose();
      controls.dispose();
      knotGeom.dispose();
      knotMat.dispose();
      cageGeom.dispose();
      cageMat.dispose();
      projGeom.dispose();
      projMat.dispose();
      renderer.dispose();
    },
  };
}
