// Ambient 3D layer — a slow-drifting starfield + soft particle nebula behind
// the SVG circuit board. Sits at z-index 0 (same as .bg-circuit) but appears
// earlier in the DOM so the SVG draws on top, blending the cyan HUD with a
// hint of depth. Pauses when the document is hidden or when JARVIS_AMBIENT_3D
// is disabled in localStorage.

import * as THREE from "three";
import { createLoop, fitRenderer, makeRenderer, observeResize } from "./engine";

const STORAGE_KEY = "jarvis.ambient3d.enabled";

function readEnabled(): boolean {
  const v = localStorage.getItem(STORAGE_KEY);
  return v === null ? true : v === "1";
}

function writeEnabled(on: boolean): void {
  localStorage.setItem(STORAGE_KEY, on ? "1" : "0");
}

let started = false;

export function initAmbient3D(): void {
  if (started) return;
  started = true;

  const canvas = document.getElementById("ambient-canvas") as HTMLCanvasElement | null;
  if (!canvas) return;

  if (!readEnabled()) {
    canvas.classList.add("hidden");
    return;
  }

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(60, 1, 0.1, 100);
  camera.position.set(0, 0, 12);

  const renderer = makeRenderer(canvas, true);
  renderer.setClearColor(0x000000, 0);

  const STAR_COUNT = 600;
  const positions = new Float32Array(STAR_COUNT * 3);
  const sizes = new Float32Array(STAR_COUNT);
  for (let i = 0; i < STAR_COUNT; i++) {
    const r = 6 + Math.random() * 18;
    const theta = Math.random() * Math.PI * 2;
    const phi = Math.acos(2 * Math.random() - 1);
    positions[i * 3] = r * Math.sin(phi) * Math.cos(theta);
    positions[i * 3 + 1] = r * Math.sin(phi) * Math.sin(theta);
    positions[i * 3 + 2] = r * Math.cos(phi);
    sizes[i] = Math.random() * 0.06 + 0.015;
  }

  const geom = new THREE.BufferGeometry();
  geom.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geom.setAttribute("size", new THREE.BufferAttribute(sizes, 1));

  const mat = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    uniforms: {
      uTime: { value: 0 },
      uColor: { value: new THREE.Color(0x5cd9ff) },
    },
    vertexShader: `
      attribute float size;
      uniform float uTime;
      varying float vAlpha;
      void main() {
        vec3 p = position;
        float twinkle = 0.5 + 0.5 * sin(uTime * 0.6 + p.x * 1.3 + p.y * 0.7);
        vAlpha = 0.25 + 0.55 * twinkle;
        vec4 mv = modelViewMatrix * vec4(p, 1.0);
        gl_PointSize = size * (300.0 / -mv.z);
        gl_Position = projectionMatrix * mv;
      }
    `,
    fragmentShader: `
      uniform vec3 uColor;
      varying float vAlpha;
      void main() {
        vec2 d = gl_PointCoord - 0.5;
        float r = length(d);
        if (r > 0.5) discard;
        float a = smoothstep(0.5, 0.0, r) * vAlpha;
        gl_FragColor = vec4(uColor, a);
      }
    `,
  });

  const stars = new THREE.Points(geom, mat);
  scene.add(stars);

  const fit = () => fitRenderer(renderer, camera, document.documentElement);
  fit();
  const stopResize = observeResize(document.documentElement, fit);

  const loop = createLoop((dt, t) => {
    mat.uniforms.uTime.value = t;
    stars.rotation.y += dt * 0.015;
    stars.rotation.x += dt * 0.005;
    renderer.render(scene, camera);
  });

  loop.start();

  (window as any).__jarvisAmbient = {
    toggle() {
      const on = !readEnabled();
      writeEnabled(on);
      if (on) {
        canvas.classList.remove("hidden");
        loop.start();
      } else {
        loop.stop();
        canvas.classList.add("hidden");
      }
      return on;
    },
    dispose() {
      loop.dispose();
      stopResize();
      geom.dispose();
      mat.dispose();
      renderer.dispose();
    },
  };
}
