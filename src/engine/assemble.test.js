// Accuracy report for autoAssemble (not part of `npm test`; always exits 0 unless it crashes).
// Run: node src/engine/assemble.test.js [seed]
import { fileURLToPath } from 'node:url';
import { loadSTL, solveJoints, autoAssemble, ROTATIONS_24, THREE } from './index.js';
import { presets } from './presets/index.js';
const root = fileURLToPath(new URL('../../public/models/', import.meta.url));
let seed = +(process.argv[2] || 7); const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);

const cache = {};
const truthType = (pr, id) => { const js = pr.joints.filter((j) => j.part === id); const m = js.find((j) => j.type !== 'fixed'); return m ? m.type : js.some((j) => j.parent) ? 'fixed(parent)' : 'fixed'; };
function placed(g, M) { // world bbox + centroid (symmetry-tolerant pose comparison)
  const bb = new THREE.Box3().setFromBufferAttribute(g.attributes.position).applyMatrix4(M);
  return { bb, c: bb.getCenter(new THREE.Vector3()) };
}
const summary = [];
for (const pr of presets) {
  const parts = [];
  for (const p of pr.parts) parts.push({ id: p.id, geometry: (cache[p.file] ||= await loadSTL(root + p.file)) });
  const truth = solveJoints(pr.joints, 0); const T = (id) => truth[id] || new THREE.Matrix4();
  for (const mode of ['in-place', 'scrambled']) {
    const poses = {};
    for (const p of parts) poses[p.id] = mode === 'in-place' ? T(p.id) : new THREE.Matrix4().makeTranslation((rnd() - 0.5) * 400, (rnd() - 0.5) * 400, (rnd() - 0.5) * 400).multiply(ROTATIONS_24[Math.floor(rnd() * 24)]).multiply(T(p.id));
    const res = await autoAssemble(parts, { poses });
    const W = Object.fromEntries(res.poses.map((p) => [p.id, new THREE.Matrix4().fromArray(p.matrix)]));
    const bInv = W[res.base].clone().invert(), tInv = T(res.base).clone().invert();
    let ok = 0, jok = 0; const rows = [];
    for (const p of parts) {
      const a = placed(p.geometry, bInv.clone().multiply(W[p.id])), b = placed(p.geometry, tInv.clone().multiply(T(p.id)));
      const err = Math.max(a.c.distanceTo(b.c), a.bb.min.distanceTo(b.bb.min), a.bb.max.distanceTo(b.bb.max));
      const g = res.guesses.find((x) => x.part === p.id), tt = truthType(pr, p.id);
      const jt = g.joint.startsWith('fixed(parent') ? 'fixed(parent)' : g.joint;
      const good = err <= 1.5, jgood = jt === tt; ok += good; jok += jgood;
      rows.push(`  ${good ? '✔' : '✘'} ${p.id.padEnd(10)} err ${err.toFixed(2).padStart(7)} mm  conf ${String(g.poseConfidence).padEnd(4)} joint ${jgood ? '✔' : '✘'} ${jt.padEnd(13)} (true ${tt})  ${g.note}`);
    }
    const line = `${pr.id} ${mode.padEnd(9)} mode=${res.mode.padEnd(8)} poses ${ok}/${parts.length}  joints ${jok}/${parts.length}  ${res.timeMs} ms  collisions:${res.collisions.length}`;
    console.log(line + '\n' + rows.join('\n')); summary.push(line);
    for (const j of res.joints.filter((j) => j.type !== 'fixed')) console.log(`    joint ${j.part} ${j.type} axis ${JSON.stringify(j.axis.map((v) => +v.toFixed(3)))} range ${JSON.stringify(j.range)}`);
  }
}
console.log('\nSUMMARY\n' + summary.join('\n'));
