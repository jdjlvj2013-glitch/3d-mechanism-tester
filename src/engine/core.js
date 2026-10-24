// Engine core (no Worker references, safe to import from workers). Units: mm. ES module; works in browser and Node.
import * as THREE from 'three';
import { MeshBVH, ExtendedTriangle } from 'three-mesh-bvh';
import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js';

// ---------- loading ----------
export async function loadSTL(src) {
  let buf = src;
  if (typeof src === 'string') {
    if (typeof window === 'undefined' && !/^https?:/.test(src)) {
      const fs = await import('node:fs/promises');
      const b = await fs.readFile(src); buf = b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
    } else buf = await (await fetch(src)).arrayBuffer();
  }
  const g = new STLLoader().parse(buf);
  g.computeVertexNormals();
  return g;
}

// ---------- helpers ----------
const toMat = (m) => (m instanceof THREE.Matrix4 ? m.clone() : Array.isArray(m) || ArrayBuffer.isView(m) ? new THREE.Matrix4().fromArray(m) : new THREE.Matrix4());
const v3 = (a) => (a instanceof THREE.Vector3 ? a.clone() : new THREE.Vector3(...(a || [0, 0, 0])));
const bvhCache = new WeakMap();
function getBVH(g) {
  let b = bvhCache.get(g) || g.boundsTree;
  if (!b) { b = new MeshBVH(g); bvhCache.set(g, b); }
  if (!g.boundsTree) g.boundsTree = b; // lets intersectsGeometry/closestPointToGeometry use BVH-vs-BVH
  return b;
}
const pairKey = (a, b) => (a < b ? `${a}|${b}` : `${b}|${a}`);

// ---------- collision ----------
/**
 * checkPose(parts, poses, {tolerance=0.5, ignorePairs=[], maxPoints=20})
 * collisions: surfaces intersect (BVH intersectsGeometry); points are triangle-intersection
 * segment endpoints in world coords. nearMisses: not intersecting but gap < tolerance.
 */
export function checkPose(parts, poses, opts = {}) {
  const { tolerance = 0.5, ignorePairs = [], maxPoints = 20 } = opts;
  const ignore = new Set(ignorePairs.map(([a, b]) => pairKey(a, b)));
  const collisions = [], nearMisses = [];
  const W = {}; const boxes = {};
  for (const p of parts) {
    W[p.id] = toMat(poses?.[p.id]);
    const bb = getBVH(p.geometry).getBoundingBox(new THREE.Box3());
    boxes[p.id] = bb.applyMatrix4(W[p.id]);
  }
  for (let i = 0; i < parts.length; i++) for (let j = i + 1; j < parts.length; j++) {
    const A = parts[i], B = parts[j];
    if (ignore.has(pairKey(A.id, B.id))) continue;
    if (boxes[A.id].clone().expandByScalar(tolerance).intersectsBox(boxes[B.id]) === false) continue;
    const bvhA = getBVH(A.geometry), bvhB = getBVH(B.geometry);
    const invA = W[A.id].clone().invert();
    const rel = invA.clone().multiply(W[B.id]); // B local -> A local
    if (bvhA.intersectsGeometry(B.geometry, rel)) {
      const pts = [];
      const seg = new THREE.Line3();
      const w0 = console.warn; console.warn = () => {}; // silence coplanar-triangle notices
      try { bvhA.bvhcast(bvhB, rel, {
        intersectsTriangles(t1, t2) {
          if (t1.intersectsTriangle(t2, seg)) {
            for (const p of [seg.start, seg.end]) {
              const w = p.clone().applyMatrix4(W[A.id]);
              pts.push([+w.x.toFixed(3), +w.y.toFixed(3), +w.z.toFixed(3)]);
            }
          }
          return pts.length >= maxPoints;
        },
      }); } finally { console.warn = w0; }
      collisions.push({ a: A.id, b: B.id, points: pts });
    } else {
      const t1 = {}, t2 = {};
      const r = bvhA.closestPointToGeometry(B.geometry, rel, t1, t2, 0, tolerance);
      if (r && t1.distance < tolerance) {
        const p1 = t1.point.clone().applyMatrix4(W[A.id]), p2 = t2.point.clone().applyMatrix4(W[B.id]) // target2 is in B-local frame;
        nearMisses.push({ a: A.id, b: B.id, minGap: +t1.distance.toFixed(4), points: [p1.toArray(), p2.toArray()].map((p) => p.map((x) => +x.toFixed(3))) });
      }
    }
  }
  return { collisions, nearMisses };
}

// ---------- kinematics ----------
const lerp = (a, b, s) => a + (b - a) * s;
const clamp01 = (x) => Math.min(1, Math.max(0, x));
/** keyframes: [{t, value}] sorted (value for slider/hinge; for path: value = [x,y,z] or {pos,rot:[axis,deg]}) */
function sampleKeys(keys, t) {
  if (t <= keys[0].t) return keys[0];
  for (let i = 1; i < keys.length; i++) if (t <= keys[i].t) {
    const k0 = keys[i - 1], k1 = keys[i], s = (t - k0.t) / (k1.t - k0.t || 1);
    return { lerp: [k0, k1, s] };
  }
  return keys[keys.length - 1];
}
const mix = (a, b, s) => (typeof a === 'number' ? lerp(a, b, s) : Array.isArray(a) ? a.map((x, i) => lerp(x, b[i], s)) : Object.fromEntries(Object.keys(a).map((k) => [k, mix(a[k], b[k] ?? a[k], s)])));
function keyValue(keys, t) { const r = sampleKeys(keys, t); return r.lerp ? mix(r.lerp[0].value, r.lerp[1].value, r.lerp[2]) : r.value; }

/** Local transform of a joint for its normalized parameter. */
function jointLocal(j, t) {
  const axis = v3(j.axis || [1, 0, 0]).normalize(), origin = v3(j.origin);
  const [mn, mx] = j.range || [0, 0];
  const M = new THREE.Matrix4();
  if (j.type === 'fixed') return j.offset ? toMat(j.offset) : M;
  if (j.type === 'path') {
    // keyframe values: {pos:[x,y,z], angle:deg} with rotation about axis through origin(+pos)
    const v = j.keyframes ? keyValue(j.keyframes, t) : { pos: [0, 0, 0], angle: 0 };
    const pos = v3(v.pos || [0, 0, 0]);
    const R = new THREE.Matrix4().makeRotationAxis(axis, THREE.MathUtils.degToRad(v.angle || 0));
    // rotate about origin, then translate: T(pos) * T(origin) * R * T(-origin)
    return M.makeTranslation(pos.x + origin.x, pos.y + origin.y, pos.z + origin.z).multiply(R).multiply(new THREE.Matrix4().makeTranslation(-origin.x, -origin.y, -origin.z));
  }
  const val = j.keyframes ? keyValue(j.keyframes, t) : lerp(mn, mx, t);
  if (j.type === 'slider') { const d = axis.multiplyScalar(val); return M.makeTranslation(d.x, d.y, d.z); }
  if (j.type === 'hinge') {
    const R = new THREE.Matrix4().makeRotationAxis(axis, THREE.MathUtils.degToRad(val));
    return M.makeTranslation(origin.x, origin.y, origin.z).multiply(R).multiply(new THREE.Matrix4().makeTranslation(-origin.x, -origin.y, -origin.z));
  }
  throw new Error(`unknown joint type ${j.type}`);
}

/**
 * solveJoints(joints, t) -> { partId: THREE.Matrix4 } (world).
 * t: number 0..1 shared by all joints, or { partId: 0..1 } per joint (missing = 0).
 * Joints with same part are composed in listed order (compound motion). parent chains apply parent's world pose.
 */
export function solveJoints(joints, t) {
  const local = {}, parentOf = {};
  for (const j of joints) {
    const tt = clamp01(typeof t === 'number' ? t : (t?.[j.id ?? j.part] ?? t?.[j.part] ?? 0));
    local[j.part] = (local[j.part] || new THREE.Matrix4()).premultiply(jointLocal(j, tt));
    if (j.parent) parentOf[j.part] = j.parent;
  }
  const world = {};
  const resolve = (id, depth = 0) => {
    if (world[id]) return world[id];
    if (depth > 64) throw new Error('joint cycle');
    const L = local[id] || new THREE.Matrix4();
    world[id] = parentOf[id] ? resolve(parentOf[id], depth + 1).clone().multiply(L) : L.clone();
    return world[id];
  };
  for (const id of Object.keys(local)) resolve(id);
  return world;
}

/** sweep(parts, joints, {steps=20, tolerance, ignorePairs}) -> [{t, poses, collisions, nearMisses}] */
export function sweep(parts, joints, opts = {}) {
  const { steps = 20 } = opts; const out = [];
  for (let i = 0; i <= steps; i++) {
    const t = i / steps, poses = solveJoints(joints, t);
    out.push({ t, poses, ...checkPose(parts, poses, opts) });
  }
  return out;
}
export { THREE };

// ---------- expected-contact classification (shared by UI + tests) ----------
const inBox = (pt, [mn, mx]) => pt.every((v, i) => v >= mn[i] && v <= mx[i]);
/** Tag each collision / near miss with `expected: reason|false`. A hit is expected when ALL its points lie in a box of the same pair. */
export function classify(result, expected = []) {
  const tag = (h) => {
    const boxes = expected.filter((e) => [e.a, e.b].sort().join() === [h.a, h.b].sort().join());
    const e = h.points.length ? boxes.find((bx) => h.points.every((p) => inBox(p, bx.box))) || (h.points.every((p) => boxes.some((bx) => inBox(p, bx.box))) && boxes[0]) : null;
    return { ...h, expected: e ? e.reason : false };
  };
  return { ...result, collisions: result.collisions.map(tag), nearMisses: result.nearMisses.map(tag) };
}

