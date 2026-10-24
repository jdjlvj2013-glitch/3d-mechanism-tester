// Motion + collision engine. Units: mm. ES module; works in browser and Node.
// Core lives in core.js / assemble.js (imported by workers); this file adds the Worker-backed async APIs.
import * as THREE from 'three';
import { checkPose, solveJoints } from './core.js';
import { autoAssemble, abortErr as aaAbort } from './assemble.js';
export * from './core.js';
export { autoAssemble, ROTATIONS_24 } from './assemble.js';
const toMat = (m) => (m instanceof THREE.Matrix4 ? m.clone() : m ? new THREE.Matrix4().fromArray(m) : new THREE.Matrix4());

// ---------- async sweep (Web Worker in browser, chunked fallback elsewhere) ----------
/**
 * sweepAsync(parts, joints, opts, onProgress?) -> Promise<results like sweep()>
 * Poses in results are 16-number arrays (structured-clone friendly). onProgress(doneSteps, totalSteps, stepResult).
 * opts.signal (AbortSignal): on abort the Worker is terminated and the promise rejects with DOMException 'AbortError'.
 */
export function sweepAsync(parts, joints, opts = {}, onProgress) {
  const steps = opts.steps ?? 20;
  const { signal, ...wopts } = opts; // AbortSignal is not cloneable; keep it on this side
  const abortErr = () => (typeof DOMException !== 'undefined' ? new DOMException('Sweep aborted', 'AbortError') : Object.assign(new Error('Sweep aborted'), { name: 'AbortError' }));
  if (signal?.aborted) return Promise.reject(abortErr());
  if (typeof Worker !== 'undefined' && typeof window !== 'undefined') {
    return new Promise((resolve, reject) => {
      const w = new Worker(new URL('./sweep.worker.js', import.meta.url), { type: 'module' });
      const payload = parts.map((p) => {
        const g = p.geometry.index ? p.geometry.toNonIndexed() : p.geometry;
        return { id: p.id, position: new Float32Array(g.attributes.position.array) };
      });
      w.onmessage = ({ data }) => {
        if (data.type === 'progress') onProgress?.(data.done, steps + 1, data.step);
        else if (data.type === 'done') { w.terminate(); resolve(data.results); }
        else if (data.type === 'error') { w.terminate(); reject(new Error(data.message)); }
      };
      w.onerror = (e) => { w.terminate(); reject(e); };
      signal?.addEventListener('abort', () => { w.terminate(); reject(abortErr()); }, { once: true });
      w.postMessage({ parts: payload, joints, opts: wopts }, payload.map((p) => p.position.buffer));
    });
  }
  return (async () => {
    const out = [];
    for (let i = 0; i <= steps; i++) {
      if (signal?.aborted) throw abortErr();
      const t = i / steps, poses = solveJoints(joints, t);
      const step = { t, poses: Object.fromEntries(Object.entries(poses).map(([k, m]) => [k, m.toArray()])), ...checkPose(parts, poses, wopts) };
      out.push(step); onProgress?.(i + 1, steps + 1, step);
      await new Promise((r) => setTimeout(r, 0));
    }
    return out;
  })();
}

/** Same as autoAssemble but runs in a Web Worker in the browser (Node: falls back to autoAssemble). */
export function autoAssembleAsync(parts, opts = {}) {
  const { signal, onProgress, ...wopts } = opts;
  if (signal?.aborted) return Promise.reject(aaAbort());
  if (!(typeof Worker !== 'undefined' && typeof window !== 'undefined')) return autoAssemble(parts, opts);
  return new Promise((resolve, reject) => {
    const w = new Worker(new URL('./assemble.worker.js', import.meta.url), { type: 'module' });
    const payload = parts.map((p) => { const g = p.geometry.index ? p.geometry.toNonIndexed() : p.geometry; return { id: p.id, position: new Float32Array(g.attributes.position.array) }; });
    const ser = { ...wopts, poses: wopts.poses && Object.fromEntries(Object.entries(wopts.poses).map(([k, m]) => [k, toMat(m).toArray()])) };
    w.onmessage = ({ data }) => {
      if (data.type === 'progress') onProgress?.(data.done, data.total, data.msg);
      else if (data.type === 'done') { w.terminate(); resolve(data.result); }
      else if (data.type === 'error') { w.terminate(); reject(new Error(data.message)); }
    };
    w.onerror = (e) => { w.terminate(); reject(e); };
    signal?.addEventListener('abort', () => { w.terminate(); reject(aaAbort()); }, { once: true });
    w.postMessage({ parts: payload, opts: ser }, payload.map((p) => p.position.buffer));
  });
}
