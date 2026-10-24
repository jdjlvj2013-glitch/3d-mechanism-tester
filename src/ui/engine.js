// Engine adapter: the ONLY place the UI touches the engine.
// Prefers Gram's src/engine/index.js per function; falls back to ./engineStub.js (temporary).
import * as stub from './engineStub.js';
import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js';
const found = import.meta.glob('../engine/index.js', { eager: true });
const real = Object.values(found)[0] || {};
const pick = (n, fb) => (typeof real[n] === 'function' ? real[n] : fb);
export const engineInfo = Object.fromEntries(['checkPose', 'solveJoints', 'sweep', 'loadSTL'].map(n => [n, typeof real[n] === 'function' ? 'engine' : 'stub']));
export const checkPose = pick('checkPose', stub.checkPose);
export const solveJoints = pick('solveJoints', stub.solveJoints);
export const sweep = pick('sweep', stub.sweep);
export const loadSTL = pick('loadSTL', async (buf) => { const g = new STLLoader().parse(buf); g.computeVertexNormals(); return g; });
// points may be Vector3 or [x,y,z]
export const toXYZ = (p) => (Array.isArray(p) ? p : [p.x, p.y, p.z]);

// classify(result, expected) -> hits tagged `expected: reason|false` (fallback mirrors Gram's rule)
const inBox = (pt, [mn, mx]) => pt.every((v, i) => v >= mn[i] && v <= mx[i]);
export const classify = pick('classify', (result, expected = []) => {
  const tag = (h) => {
    const bx = expected.filter(e => [e.a, e.b].sort().join() === [h.a, h.b].sort().join());
    const pts = (h.points || []).map(toXYZ);
    const e = pts.length ? bx.find(b => pts.every(p => inBox(p, b.box))) : null;
    return { ...h, expected: e ? e.reason : false };
  };
  return { ...result, collisions: result.collisions.map(tag), nearMisses: result.nearMisses.map(tag) };
});
// sweepAsync(parts, joints, opts, onProgress(done,total,step)) -> Promise<steps>
export const sweepAsync = pick('sweepAsync', async (parts, joints, opts = {}, onProgress) => {
  const steps = opts.steps ?? 20, out = [];
  for (let i = 0; i <= steps; i++) {
    const t = i / steps, poses = solveJoints(joints, t), s = { t, poses, ...checkPose(parts, poses, opts) };
    out.push(s); onProgress?.(i + 1, steps + 1, s); await new Promise(r => setTimeout(r, 0));
  }
  return out;
});
engineInfo.classify = typeof real.classify === 'function' ? 'engine' : 'stub';
engineInfo.sweepAsync = typeof real.sweepAsync === 'function' ? 'engine' : 'stub';

// ---------- autoAssemble adapter (defensive; Gram's return shape not final) ----------
// Calls engine autoAssemble(parts, {onProgress, signal}) (sync or async) or the stub, then normalizes to:
//   { source, poses: [{ id, matrix: THREE.Matrix4, confidence 0..1, reason }],
//     joints: [{ id, part, type, axis, origin, range, confidence, reason }] }
// Accepted input: result = { poses|parts: Array | {id: pose}, joints? } or a bare Array of poses.
//   pose: { id|part, matrix (Matrix4 | 16 numbers column-major) | position [x,y,z] + rotation
//           ([x,y,z] Euler radians XYZ | [x,y,z,w] quaternion | Matrix4/16 numbers), confidence, reason|why }
//   joint: { part, type 'slider'|'hinge'|'fixed', axis, origin, range, confidence, reason }
import * as THREE_ from 'three';
// Prefer the Web Worker version (keeps the page responsive); then main-thread engine; then stub.
const fnA = (n) => typeof real[n] === 'function';
engineInfo.autoAssemble = fnA('autoAssembleAsync') || fnA('autoAssemble') ? 'engine' : 'stub';
const rawAuto = fnA('autoAssembleAsync') ? real.autoAssembleAsync : pick('autoAssemble', stub.autoAssemble);
const num = (v, d) => (Number.isFinite(+v) ? +v : d);
const conf = (c) => Math.min(1, Math.max(0, num(c, 0.5)));
const vec3 = (v, d) => { if (!v) return d; const a = Array.isArray(v) ? v : [v.x, v.y, v.z]; return a.length >= 3 && a.slice(0, 3).every(x => Number.isFinite(+x)) ? a.slice(0, 3).map(Number) : d; };
const mat = (m) => { if (!m) return null; if (m.isMatrix4) return m.clone(); const a = m.elements || m; return Array.isArray(a) && a.length === 16 && a.every(x => Number.isFinite(+x)) ? new THREE_.Matrix4().fromArray(a.map(Number)) : null; };
function poseMatrix(p) {
  const m = mat(p.matrix ?? p.pose ?? p.transform); if (m) return m;
  const pos = new THREE_.Vector3(...vec3(p.position ?? p.translation, [0, 0, 0]));
  const r = p.rotation ?? p.quaternion; let q = new THREE_.Quaternion();
  const rm = mat(r);
  if (rm) q.setFromRotationMatrix(rm);
  else if (r?.isQuaternion || (Array.isArray(r) && r.length === 4)) q = r.isQuaternion ? r.clone() : new THREE_.Quaternion(...r.map(Number)).normalize();
  else if (r) q.setFromEuler(new THREE_.Euler(...vec3(r, [0, 0, 0])));
  return new THREE_.Matrix4().compose(pos, q, new THREE_.Vector3(1, 1, 1));
}
export function normalizeAutoAssemble(res, parts = []) {
  const ids = new Set(parts.map(p => p.id));
  let list = Array.isArray(res) ? res : (res?.poses ?? res?.parts ?? res?.placements ?? []);
  if (list && !Array.isArray(list) && typeof list === 'object') list = Object.entries(list).map(([id, v]) => (v?.isMatrix4 || Array.isArray(v) ? { id, matrix: v } : { id, ...v }));
  const poses = (list || []).map(p => ({ id: p?.id ?? p?.part, matrix: poseMatrix(p || {}), role: p?.role ? String(p.role) : '', confidence: conf(p?.confidence ?? p?.score), reason: String(p?.note ?? p?.reason ?? p?.why ?? '') || 'no reason given' }))
    .filter(p => p.id != null && (!ids.size || ids.has(p.id)));
  const joints = (Array.isArray(res?.joints) ? res.joints : []).filter(j => j && j.part != null && (!ids.size || ids.has(j.part))).map((j, i) => {
    const type = ['slider', 'hinge', 'fixed', 'path'].includes(j.type) ? j.type : (/rot|rev|hinge/i.test(j.type) ? 'hinge' : /slid|pris|lin/i.test(j.type) ? 'slider' : 'fixed');
    const rg = Array.isArray(j.range) && j.range.length >= 2 ? [num(j.range[0], 0), num(j.range[1], 0)] : (type === 'hinge' ? [0, 90] : type === 'slider' ? [0, 50] : type === 'path' ? [0, 1] : [0, 0]);
    return { ...j, id: j.id || 'auto' + Date.now() + '_' + i, part: j.part, type, axis: vec3(j.axis, [1, 0, 0]), origin: vec3(j.origin, [0, 0, 0]), range: rg, confidence: conf(j.confidence ?? j.score), reason: String(j.note ?? j.reason ?? j.why ?? '') || 'no reason given' };
  });
  return { source: res?.source || engineInfo.autoAssemble, poses, joints, mode: res?.mode, base: res?.base, timeMs: res?.timeMs, collisions: res?.collisions || [], expected: Array.isArray(res?.expected) ? res.expected : [] };
}
export const stubAutoAssemble = stub.autoAssemble;
export async function autoAssemble(parts, opts = {}, impl = rawAuto) {
  if (opts.signal?.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
  await new Promise(r => setTimeout(r, 0)); // let the spinner paint before a possibly sync engine call
  return normalizeAutoAssemble(await impl(parts, opts), parts);
}
