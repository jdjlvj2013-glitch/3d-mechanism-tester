// Module worker: runs sweep off the main thread. Message in: {parts:[{id, position:Float32Array}], joints, opts}.
import * as THREE from 'three';
import { checkPose, solveJoints } from './core.js';
self.onmessage = ({ data }) => {
  try {
    const parts = data.parts.map((p) => {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(p.position, 3));
      return { id: p.id, geometry: g };
    });
    const steps = data.opts?.steps ?? 20, results = [];
    for (let i = 0; i <= steps; i++) {
      const t = i / steps, poses = solveJoints(data.joints, t);
      const step = { t, poses: Object.fromEntries(Object.entries(poses).map(([k, m]) => [k, m.toArray()])), ...checkPose(parts, poses, data.opts) };
      results.push(step);
      self.postMessage({ type: 'progress', done: i + 1, step });
    }
    self.postMessage({ type: 'done', results });
  } catch (e) { self.postMessage({ type: 'error', message: String(e?.stack || e) }); }
};
