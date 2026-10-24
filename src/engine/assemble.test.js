// Accuracy report for autoAssemble (not part of `npm test`; always exits 0 unless it crashes).
// Run: node src/engine/assemble.test.js [seed]
// Modes: ui = exactly what src/ui runAuto sends after dropping the preset's STL files (one part per file, id = file name
// without extension, poses = mesh.matrix.toArray() = identity, clearance = tolerance 0.3, via autoAssembleAsync);
// in-place = truth poses; scrambled = random rotation + ±200 mm. Identical-geometry parts (pins) may swap holes: counted correct.
import { fileURLToPath } from 'node:url';
import { loadSTL, solveJoints, autoAssemble, autoAssembleAsync, ROTATIONS_24, THREE } from './index.js';
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
  const all = [];
  for (const p of pr.parts) all.push({ id: p.id, file: p.file, geometry: (cache[p.file] ||= await loadSTL(root + p.file)) });
  const truth = solveJoints(pr.joints, 0); const T = (id) => truth[id] || new THREE.Matrix4();
  const uiParts = [...new Map(all.map((p) => [p.file, { id: p.file.replace(/\.\w+$/, ''), file: p.file, geometry: p.geometry }])).values()];
  for (const mode of ['ui', 'in-place', 'scrambled']) {
    const parts = mode === 'ui' ? uiParts : all;
    const poses = {};
    for (const p of parts) poses[p.id] = mode === 'ui' ? new THREE.Matrix4().toArray() : mode === 'in-place' ? T(p.id) : new THREE.Matrix4().makeTranslation((rnd() - 0.5) * 400, (rnd() - 0.5) * 400, (rnd() - 0.5) * 400).multiply(ROTATIONS_24[Math.floor(rnd() * 24)]).multiply(T(p.id));
    const res = mode === 'ui' ? await autoAssembleAsync(parts.map(({ id, geometry }) => ({ id, name: id, geometry })), { poses, clearance: 0.3, onProgress: () => {} }) : await autoAssemble(parts, { poses });
    const tid = (id) => all.find((q) => q.file === parts.find((p) => p.id === id).file).id; // preset id of the same file
    const W = Object.fromEntries(res.poses.map((p) => [p.id, new THREE.Matrix4().fromArray(p.matrix)]));
    const bInv = W[res.base].clone().invert(), tInv = T(tid(res.base)).clone().invert();
    let ok = 0, jok = 0; const rows = [];
    for (const p of parts) {
      const a = placed(p.geometry, bInv.clone().multiply(W[p.id]));
      let err = Infinity, tq = null; // identical geometry (same file) => any instance's slot is correct
      for (const q of all.filter((q) => q.file === p.file)) { const b = placed(p.geometry, tInv.clone().multiply(T(q.id))); const e = Math.max(a.c.distanceTo(b.c), a.bb.min.distanceTo(b.bb.min), a.bb.max.distanceTo(b.bb.max)); if (e < err) { err = e; tq = q.id; } }
      const g = res.guesses.find((x) => x.part === p.id), tt = truthType(pr, tq);
      const jt = g.joint.startsWith('fixed(parent') ? 'fixed(parent)' : g.joint;
      const good = err <= 1.5, jgood = jt === tt; ok += good; jok += jgood;
      rows.push(`  ${good ? '✔' : '✘'} ${p.id.padEnd(10)} err ${err.toFixed(2).padStart(7)} mm  conf ${String(g.poseConfidence).padEnd(4)} joint ${jgood ? '✔' : '✘'} ${jt.padEnd(13)} (true ${tt})  ${g.note}`);
    }
    const line = `${pr.id} ${mode.padEnd(9)} mode=${res.mode.padEnd(8)} poses ${ok}/${parts.length}  joints ${jok}/${parts.length}  ${res.timeMs} ms  collisions:${res.collisions.length}`;
    console.log(line + '\n' + rows.join('\n') + (Object.keys(res.pass1?.rejected || {}).length ? '\n  pass1 rejected: ' + JSON.stringify(res.pass1.rejected) : '')); summary.push(line);
    for (const j of res.joints.filter((j) => j.type !== 'fixed')) console.log(`    joint ${j.part} ${j.type} axis ${JSON.stringify(j.axis.map((v) => +v.toFixed(3)))} range ${JSON.stringify(j.range)}`);
  }
}
console.log('\nSUMMARY\n' + summary.join('\n'));
