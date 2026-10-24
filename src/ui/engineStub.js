// ============================================================================
// TEMPORARY ENGINE STUB (owned by UI). Replace by Gram's src/engine.
// Same signatures as the engine contract:
//   checkPose(parts, poses, { tolerance }) -> { collisions, nearMisses, pairs }
//   solveJoints(joints, t) -> { [partId]: Matrix4 }   (t in 0..1)
// Uses three-mesh-bvh for real triangle-level checks (not just boxes).
// ============================================================================
import * as THREE from 'three';
import { MeshBVH } from 'three-mesh-bvh';

const bvhCache = new WeakMap();
function bvhOf(g) {
  let b = bvhCache.get(g);
  if (!b) { b = new MeshBVH(g); bvhCache.set(g, b); }
  return b;
}

export function checkPose(parts, poses, { tolerance = 0.3 } = {}) {
  const collisions = [], nearMisses = [], pairs = [];
  const I = new THREE.Matrix4();
  const world = parts.map(p => {
    const m = poses[p.id] || I;
    p.geometry.computeBoundingBox();
    return { p, m, box: p.geometry.boundingBox.clone().applyMatrix4(m) };
  });
  for (let i = 0; i < world.length; i++) for (let j = i + 1; j < world.length; j++) {
    const A = world[i], B = world[j];
    const boxGap = A.box.distanceToPoint(B.box.clampPoint(A.box.getCenter(new THREE.Vector3()), new THREE.Vector3()));
    const exp = A.box.clone().expandByScalar(tolerance);
    if (!exp.intersectsBox(B.box)) { pairs.push({ a: A.p.id, b: B.p.id, minGap: boxGap, collide: false }); continue; }
    const bvh = bvhOf(A.p.geometry);
    const bToA = A.m.clone().invert().multiply(B.m);
    const hit = bvh.intersectsGeometry(B.p.geometry, bToA);
    const t1 = { point: new THREE.Vector3(), distance: 0 }, t2 = { point: new THREE.Vector3(), distance: 0 };
    const r = bvh.closestPointToGeometry(B.p.geometry, bToA, t1, t2, 0, Infinity);
    const gap = hit ? 0 : (r ? t1.distance : Infinity);
    const pts = r ? [t1.point.clone().applyMatrix4(A.m)] : [];
    if (hit) collisions.push({ a: A.p.id, b: B.p.id, points: pts });
    else if (gap < tolerance) nearMisses.push({ a: A.p.id, b: B.p.id, minGap: gap, points: pts });
    pairs.push({ a: A.p.id, b: B.p.id, minGap: gap, collide: hit });
  }
  return { collisions, nearMisses, pairs };
}

// joint (same format as Gram's engine): { id, part, type:'slider'|'hinge'|'fixed', axis:[x,y,z], origin:[x,y,z], range:[min,max] }
export function solveJoints(joints, t) {
  const poses = {};
  for (const j of joints) {
    const m = new THREE.Matrix4();
    const ax = new THREE.Vector3(...(j.axis || [1, 0, 0])).normalize();
    const [mn, mx] = j.range || [0, 0]; const v = mn + (mx - mn) * t;
    if (j.type === 'slider') m.makeTranslation(ax.x * v, ax.y * v, ax.z * v);
    else if (j.type === 'hinge') {
      const p = new THREE.Vector3(...(j.origin || [0, 0, 0]));
      m.makeTranslation(p.x, p.y, p.z)
        .multiply(new THREE.Matrix4().makeRotationAxis(ax, THREE.MathUtils.degToRad(v)))
        .multiply(new THREE.Matrix4().makeTranslation(-p.x, -p.y, -p.z));
    }
    poses[j.part] = (poses[j.part] || new THREE.Matrix4()).premultiply(m);
  }
  return poses;
}
export function sweep(parts, joints, opts = {}) {
  const { steps = 20 } = opts; const out = [];
  for (let i = 0; i <= steps; i++) { const t = i / steps, poses = solveJoints(joints, t); out.push({ t, poses, ...checkPose(parts, poses, opts) }); }
  return out;
}
