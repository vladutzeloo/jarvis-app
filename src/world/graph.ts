// JARVIS — 3D currency graph.
//
// One line per currency, traced left→right over the rate history. Each line
// sits at its own depth so the cluster reads as a layered chart from the
// camera angle. We allocate the geometries once and mutate the position
// buffer in-place each frame; the only allocation per update is a min/max
// scan on the history buffer.

import * as THREE from "three";
import { getFinance, getHistoryLength } from "./finance";

const GRAPH_WIDTH = 6;
const GRAPH_HEIGHT = 2.4;
const GRAPH_DEPTH = 3;

export interface GraphHandle {
  group: THREE.Group;
  step: () => void;
  dispose: () => void;
}

/**
 * Build the floating 3D currency graph next to the vault. `position` is the
 * group origin in scene space (the bottom-left-front corner of the chart).
 */
export function buildCurrencyGraph(scene: THREE.Scene, position: THREE.Vector3): GraphHandle {
  const group = new THREE.Group();
  group.position.copy(position);
  scene.add(group);

  // ─── Frame ────────────────────────────────────────────────────────────
  const frameMat = new THREE.LineBasicMaterial({
    color: 0x5cd9ff, transparent: true, opacity: 0.32,
  });
  const frameGeom = new THREE.BufferGeometry().setFromPoints([
    // back face rectangle
    new THREE.Vector3(0, 0, 0), new THREE.Vector3(GRAPH_WIDTH, 0, 0),
    new THREE.Vector3(GRAPH_WIDTH, 0, 0), new THREE.Vector3(GRAPH_WIDTH, GRAPH_HEIGHT, 0),
    new THREE.Vector3(GRAPH_WIDTH, GRAPH_HEIGHT, 0), new THREE.Vector3(0, GRAPH_HEIGHT, 0),
    new THREE.Vector3(0, GRAPH_HEIGHT, 0), new THREE.Vector3(0, 0, 0),
    // floor depth lines
    new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 0, -GRAPH_DEPTH),
    new THREE.Vector3(GRAPH_WIDTH, 0, 0), new THREE.Vector3(GRAPH_WIDTH, 0, -GRAPH_DEPTH),
    new THREE.Vector3(0, 0, -GRAPH_DEPTH), new THREE.Vector3(GRAPH_WIDTH, 0, -GRAPH_DEPTH),
    // back-top echoes
    new THREE.Vector3(0, GRAPH_HEIGHT, 0), new THREE.Vector3(0, GRAPH_HEIGHT, -GRAPH_DEPTH),
    new THREE.Vector3(GRAPH_WIDTH, GRAPH_HEIGHT, 0), new THREE.Vector3(GRAPH_WIDTH, GRAPH_HEIGHT, -GRAPH_DEPTH),
  ]);
  const frame = new THREE.LineSegments(frameGeom, frameMat);
  group.add(frame);

  // Title sprite (canvas-textured)
  const titleCanvas = document.createElement("canvas");
  titleCanvas.width = 256; titleCanvas.height = 64;
  const titleCtx = titleCanvas.getContext("2d")!;
  titleCtx.fillStyle = "#5cd9ff";
  titleCtx.font = "bold 28px monospace";
  titleCtx.fillText("CURRENCY MARKET · LIVE", 8, 38);
  const titleTex = new THREE.CanvasTexture(titleCanvas);
  titleTex.colorSpace = THREE.SRGBColorSpace;
  const titleMat = new THREE.MeshBasicMaterial({ map: titleTex, transparent: true });
  const titleGeom = new THREE.PlaneGeometry(2.4, 0.6);
  const titleMesh = new THREE.Mesh(titleGeom, titleMat);
  titleMesh.position.set(GRAPH_WIDTH / 2, GRAPH_HEIGHT + 0.5, 0);
  group.add(titleMesh);

  // ─── Per-currency lines ───────────────────────────────────────────────
  interface Line {
    code: string;
    geom: THREE.BufferGeometry;
    mat: THREE.LineBasicMaterial;
    line: THREE.Line;
    positions: Float32Array;
  }

  const HISTORY = getHistoryLength();
  const finance = getFinance();
  const lines: Line[] = [];

  finance.rates.forEach((rate, i) => {
    const z = -(i / Math.max(1, finance.rates.length - 1)) * GRAPH_DEPTH;
    const positions = new Float32Array(HISTORY * 3);
    const geom = new THREE.BufferGeometry();
    geom.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    const mat = new THREE.LineBasicMaterial({
      color: rate.color,
      transparent: true,
      opacity: 0.92,
    });
    const line = new THREE.Line(geom, mat);
    line.position.z = z;
    group.add(line);

    // Per-currency end-of-line label sprite — tiny code marker (e.g. "BTC")
    const labelCanvas = document.createElement("canvas");
    labelCanvas.width = 96; labelCanvas.height = 32;
    const lc = labelCanvas.getContext("2d")!;
    lc.fillStyle = `#${rate.color.toString(16).padStart(6, "0")}`;
    lc.font = "bold 18px monospace";
    lc.fillText(rate.code, 4, 22);
    const tex = new THREE.CanvasTexture(labelCanvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    const lblMat = new THREE.MeshBasicMaterial({ map: tex, transparent: true });
    const lblGeom = new THREE.PlaneGeometry(0.9, 0.3);
    const lblMesh = new THREE.Mesh(lblGeom, lblMat);
    lblMesh.position.set(GRAPH_WIDTH + 0.55, 0, z);
    group.add(lblMesh);

    lines.push({ code: rate.code, geom, mat, line, positions });
  });

  function step(): void {
    const fin = getFinance();
    for (const ln of lines) {
      const r = fin.rates.find(x => x.code === ln.code);
      if (!r) continue;
      const hist = r.history;
      // Compute min/max over this currency's history so each line uses its
      // own scale; otherwise BTC (~65k) would flatten USD (~1) into the floor.
      let min = Infinity;
      let max = -Infinity;
      for (let i = 0; i < hist.length; i++) {
        const v = hist[i];
        if (v < min) min = v;
        if (v > max) max = v;
      }
      const range = max - min || Math.max(1e-6, Math.abs(max));
      const last = hist.length;
      for (let j = 0; j < last; j++) {
        const v = hist[j] ?? min;
        const x = (j / Math.max(1, last - 1)) * GRAPH_WIDTH;
        const y = ((v - min) / range) * GRAPH_HEIGHT;
        ln.positions[j * 3 + 0] = x;
        ln.positions[j * 3 + 1] = y;
        ln.positions[j * 3 + 2] = 0;
      }
      ln.geom.attributes.position.needsUpdate = true;
    }
  }

  step();

  function dispose(): void {
    scene.remove(group);
    frameGeom.dispose();
    frameMat.dispose();
    titleGeom.dispose();
    titleMat.dispose();
    titleTex.dispose();
    for (const ln of lines) {
      ln.geom.dispose();
      ln.mat.dispose();
    }
  }

  return { group, step, dispose };
}
