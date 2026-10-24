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
