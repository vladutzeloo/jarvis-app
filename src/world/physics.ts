// JARVIS — Rapier3D physics for the World holodeck.
//
// Zero-gravity world (holodeck — nothing falls). Manages:
//   • Projectile dynamic rigid bodies — fired from the camera, positions
//     synced back to Three.js meshes every step.
//   • Brain sensor sphere at the origin — generates a hit when a projectile
//     enters the zone.
//   • NPC sensor spheres — one per pawn, generate NPC hit events on entry.
//
// Usage:
//   await initPhysics();
//   addBrainSensor();
//   addNPCSensor(pos, index);   // once per NPC after createNPCs returns
//   const p = spawnProjectile(mesh, pos, vel, life);
//   projectiles.push(p);
//   // each frame:
//   const hits = stepPhysics(dt, projectiles);
//   // cleanup dead:
//   for reversed splice: removeProjectile(p);

import RAPIER from "@dimforge/rapier3d-compat";
import * as THREE from "three";

export interface PhysicsProjectile {
  rigidBody: RAPIER.RigidBody;
  collider: RAPIER.Collider;
  mesh: THREE.Mesh;
  life: number;
}

export type PhysicsHit =
  | { kind: "brain"; projColliderHandle: number }
  | { kind: "npc";   index: number; projColliderHandle: number };

// ─── module-level singletons ────────────────────────────────────────────────

let R: typeof RAPIER | null = null;
let world: RAPIER.World | null = null;
let queue: RAPIER.EventQueue | null = null;

// Sensor collider handle → what it represents.
const sensorMap = new Map<number, { kind: "brain" } | { kind: "npc"; index: number }>();

// ─── init ───────────────────────────────────────────────────────────────────

export async function initPhysics(): Promise<void> {
  if (R) return;
  await RAPIER.init();
  R = RAPIER;
  world = new RAPIER.World({ x: 0, y: 0, z: 0 });
  queue = new RAPIER.EventQueue(true);
}

export function isPhysicsReady(): boolean {
  return R !== null;
}

// ─── sensor registration ────────────────────────────────────────────────────

/** Sphere sensor at world origin for the Obsidian brain (radius 2.2). */
export function addBrainSensor(): void {
  if (!R || !world) return;
  const desc = R.ColliderDesc.ball(2.2)
    .setSensor(true)
    .setActiveEvents(R.ActiveEvents.COLLISION_EVENTS);
  const col = world.createCollider(desc);
  sensorMap.set(col.handle, { kind: "brain" });
}

/** Sphere sensor for one NPC pawn, offset slightly upward to centre on the body. */
export function addNPCSensor(pos: THREE.Vector3, index: number): void {
  if (!R || !world) return;
  const desc = R.ColliderDesc.ball(0.9)
    .setSensor(true)
    .setActiveEvents(R.ActiveEvents.COLLISION_EVENTS);
  const col = world.createCollider(desc);
  col.setTranslation({ x: pos.x, y: pos.y + 0.3, z: pos.z });
  sensorMap.set(col.handle, { kind: "npc", index });
}

// ─── projectile lifecycle ───────────────────────────────────────────────────

/** Spawn a projectile rigid body and return a handle for tracking. */
export function spawnProjectile(
  mesh: THREE.Mesh,
  pos: THREE.Vector3,
  vel: THREE.Vector3,
  life: number,
): PhysicsProjectile {
  if (!R || !world) throw new Error("physics not initialised");

  const bodyDesc = R.RigidBodyDesc.dynamic()
    .setTranslation(pos.x, pos.y, pos.z)
    .setLinvel(vel.x, vel.y, vel.z)
    .setGravityScale(0)
    .setLinearDamping(0);

  const rigidBody = world.createRigidBody(bodyDesc);

  const colDesc = R.ColliderDesc.ball(0.07)
    .setActiveEvents(R.ActiveEvents.COLLISION_EVENTS);
  const collider = world.createCollider(colDesc, rigidBody);

  return { rigidBody, collider, mesh, life };
}

/** Remove a projectile's rigid body from the physics world. */
export function removeProjectile(p: PhysicsProjectile): void {
  if (!world) return;
  world.removeRigidBody(p.rigidBody); // also removes its collider
}

// ─── step ───────────────────────────────────────────────────────────────────

/**
 * Advance the physics simulation by `dt` seconds, sync mesh positions,
 * decrement projectile lifetimes, and return any collision events fired.
 *
 * Callers should remove projectiles whose `.life <= 0` or whose mesh
 * position is out of range after this call.
 */
export function stepPhysics(
  dt: number,
  projectiles: PhysicsProjectile[],
): PhysicsHit[] {
  if (!world || !queue) return [];

  world.timestep = Math.min(dt, 1 / 30);
  world.step(queue);

  for (const p of projectiles) {
    const t = p.rigidBody.translation();
    p.mesh.position.set(t.x, t.y, t.z);
    p.life -= dt;
  }

  const hits: PhysicsHit[] = [];
  queue.drainCollisionEvents((h1: number, h2: number, started: boolean) => {
    if (!started) return;
    const tag = sensorMap.get(h1) ?? sensorMap.get(h2);
    if (!tag) return;
    const projHandle = sensorMap.has(h1) ? h2 : h1;
    if (tag.kind === "brain") {
      hits.push({ kind: "brain", projColliderHandle: projHandle });
    } else {
      hits.push({ kind: "npc", index: tag.index, projColliderHandle: projHandle });
    }
  });

  return hits;
}
