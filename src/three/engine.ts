// Shared three.js helpers: a render loop with built-in pause-on-hidden so we
// don't burn the dGPU when a tab/window isn't visible, plus a DPR cap to keep
// 4K-ish displays from rendering at native resolution. Each 3D surface owns
// its own scene/camera/renderer; this module just standardises lifecycle.

import * as THREE from "three";

export const MAX_DPR = 1.5;

export interface LoopHandle {
  start(): void;
  stop(): void;
  dispose(): void;
}

type Frame = (dt: number, t: number) => void;

interface LoopOpts {
  isVisible?: () => boolean;
  onResume?: () => void;
}

export function createLoop(frame: Frame, opts: LoopOpts = {}): LoopHandle {
  let raf = 0;
  let last = 0;
  let running = false;
  let disposed = false;

  const tick = (now: number) => {
    if (!running) return;
    const dt = last ? (now - last) / 1000 : 0;
    last = now;
    frame(dt, now / 1000);
    raf = requestAnimationFrame(tick);
  };

  const start = () => {
    if (disposed || running) return;
    if (opts.isVisible && !opts.isVisible()) return;
    running = true;
    last = 0;
    opts.onResume?.();
    raf = requestAnimationFrame(tick);
  };

  const stop = () => {
    running = false;
    if (raf) cancelAnimationFrame(raf);
    raf = 0;
  };

  const onVis = () => {
    if (document.hidden) stop();
    else if (opts.isVisible?.() ?? true) start();
  };
  document.addEventListener("visibilitychange", onVis);

  return {
    start,
    stop,
    dispose() {
      disposed = true;
      stop();
      document.removeEventListener("visibilitychange", onVis);
    },
  };
}

export function makeRenderer(canvas: HTMLCanvasElement, alpha = false): THREE.WebGLRenderer {
  const r = new THREE.WebGLRenderer({
    canvas,
    alpha,
    antialias: true,
    powerPreference: "high-performance",
  });
  r.setPixelRatio(Math.min(window.devicePixelRatio, MAX_DPR));
  r.outputColorSpace = THREE.SRGBColorSpace;
  return r;
}

export function fitRenderer(
  renderer: THREE.WebGLRenderer,
  camera: THREE.PerspectiveCamera,
  el: HTMLElement,
): void {
  const w = el.clientWidth || window.innerWidth;
  const h = el.clientHeight || window.innerHeight;
  if (w === 0 || h === 0) return;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}

export function observeResize(el: HTMLElement, cb: () => void): () => void {
  // ResizeObserver alone covers element-level changes (sidebar collapse, tab
  // switch) and window resizes, so a separate window listener would just
  // double-fire the callback.
  const ro = new ResizeObserver(cb);
  ro.observe(el);
  return () => ro.disconnect();
}

export function isViewActive(viewName: string): boolean {
  const v = document.querySelector<HTMLElement>(`.view[data-view="${viewName}"]`);
  return !!v && v.classList.contains("active");
}

export function onViewChange(cb: () => void): () => void {
  const obs = new MutationObserver(cb);
  document.querySelectorAll<HTMLElement>(".view").forEach(v =>
    obs.observe(v, { attributes: true, attributeFilter: ["class"] }),
  );
  return () => obs.disconnect();
}
