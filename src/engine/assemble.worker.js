// Module worker for autoAssembleAsync. In: {parts:[{id, position, index?}], opts}. Out: progress | done | error.
import * as THREE from 'three';
import { autoAssemble } from './assemble.js';
self.onmessage = async ({ data }) => {
  try {
    const parts = data.parts.map((p) => { const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.BufferAttribute(p.position, 3)); if (p.index) g.setIndex(new THREE.BufferAttribute(p.index, 1)); p.position = p.index = null; return { id: p.id, geometry: g }; });
    const result = await autoAssemble(parts, { ...data.opts, onProgress: (done, total, msg) => self.postMessage({ type: 'progress', done, total, msg }) });
    self.postMessage({ type: 'done', result });
  } catch (e) { self.postMessage({ type: 'error', message: String(e?.stack || e) }); }
};
