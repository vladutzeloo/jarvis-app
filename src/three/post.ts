// Postprocessing helper — wraps EffectComposer + RenderPass + EffectPass(Bloom)
// so each 3D surface can drop in a tuned HDR bloom in two lines:
//
//   const post = createBloomComposer(renderer, scene, camera, { intensity: 1 });
//   const fit = () => { fitRenderer(...); post.setSize(w, h); };
//   ...
//   post.composer.render(dt);   // instead of renderer.render(scene, camera)
//
// Uses a HalfFloat framebuffer so emissive materials / additively-blended
// sprites can push pixels above 1.0 and have the bloom actually catch them.
// The composer's mipmap-blur pipeline is cheap enough for 60fps on integrated
// GPUs; we cap pixel ratio in makeRenderer to keep the bandwidth budget sane.

import * as THREE from "three";
import {
  BloomEffect,
  EffectComposer,
  EffectPass,
  KernelSize,
  RenderPass,
} from "postprocessing";

export interface BloomOpts {
  intensity?: number;
  luminanceThreshold?: number;
  luminanceSmoothing?: number;
  kernelSize?: KernelSize;
  mipmapBlur?: boolean;
}

export interface BloomComposer {
  composer: EffectComposer;
  bloom: BloomEffect;
  setSize(w: number, h: number): void;
  dispose(): void;
}

export function createBloomComposer(
  renderer: THREE.WebGLRenderer,
  scene: THREE.Scene,
  camera: THREE.Camera,
  opts: BloomOpts = {},
): BloomComposer {
  const composer = new EffectComposer(renderer, {
    frameBufferType: THREE.HalfFloatType,
  });
  composer.addPass(new RenderPass(scene, camera));

  const bloom = new BloomEffect({
    intensity: opts.intensity ?? 1.0,
    luminanceThreshold: opts.luminanceThreshold ?? 0.55,
    luminanceSmoothing: opts.luminanceSmoothing ?? 0.2,
    kernelSize: opts.kernelSize ?? KernelSize.MEDIUM,
    mipmapBlur: opts.mipmapBlur ?? true,
  });
  composer.addPass(new EffectPass(camera, bloom));

  return {
    composer,
    bloom,
    setSize(w, h) {
      // EffectComposer guards against zero, but we belt-and-brace it here so
      // a hidden tab doesn't end up with a 0×0 framebuffer that throws on
      // resume.
      const cw = Math.max(1, w | 0);
      const ch = Math.max(1, h | 0);
      composer.setSize(cw, ch);
    },
    dispose() {
      // EffectComposer.dispose disposes the passes (incl. their effects and
      // the internal render targets) but NOT the WebGLRenderer — callers
      // dispose the renderer separately.
      composer.dispose();
    },
  };
}
