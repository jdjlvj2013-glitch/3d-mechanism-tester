// Run: node src/engine/engine.test.js   (plain node, exits non-zero on failure)
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { checkPose, solveJoints, sweep, sweepAsync, loadSTL, classify, autoAssemble, autoAssembleAsync, THREE } from './index.js';
import { presets } from './presets/index.js';
const root = fileURLToPath(new URL('../../public', import.meta.url));

// unit sanity: two cubes
const box = new THREE.BoxGeometry(10, 10, 10);
const P = [{ id: 'a', geometry: box }, { id: 'b', geometry: box }];
assert.equal(checkPose(P, { a: new THREE.Matrix4(), b: new THREE.Matrix4().makeTranslation(9, 0, 0) }).collisions.length, 1);
const nm = checkPose(P, { a: [1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1], b: new THREE.Matrix4().makeTranslation(10.3, 0, 0) }, { tolerance: 0.5 });
assert.equal(nm.collisions.length, 0); assert.ok(Math.abs(nm.nearMisses[0].minGap - 0.3) < 1e-3);
assert.equal(checkPose(P, { b: new THREE.Matrix4().makeTranslation(9, 0, 0) }, { ignorePairs: [['b', 'a']] }).collisions.length, 0);
const h = solveJoints([{ type: 'hinge', part: 'a', axis: [0, 0, 1], origin: [1, 0, 0], range: [0, 90] }], 1);
const p = new THREE.Vector3(2, 0, 0).applyMatrix4(h.a); assert.ok(p.distanceTo(new THREE.Vector3(1, 1, 0)) < 1e-6);
// sweepAsync + AbortSignal (Node fallback path)
{
  const J = [{ type: 'slider', part: 'b', axis: [1, 0, 0], range: [20, 9] }];
  const full = await sweepAsync(P, J, { steps: 4 });
  assert.equal(full.length, 5); assert.equal(full[4].collisions.length, 1);
  const ac = new AbortController(); let seen = 0;
  await assert.rejects(sweepAsync(P, J, { steps: 50, signal: ac.signal }, (d) => { seen = d; if (d === 2) ac.abort(); }),
    (e) => e.name === 'AbortError');
  assert.equal(seen, 2);
  const pre = new AbortController(); pre.abort();
  await assert.rejects(sweepAsync(P, J, { signal: pre.signal }), (e) => e.name === 'AbortError');
}
// autoAssemble smoke (contract only; accuracy is reported by assemble.test.js)
{
  const v1p = presets.find((p) => p.id === 'v1'), T = solveJoints(v1p.joints, 0);
  const parts = await Promise.all(v1p.parts.map(async (p) => ({ id: p.id, geometry: await loadSTL(root + '/models/' + p.file) })));
  let prog = 0; const r = await autoAssemble(parts, { poses: T, onProgress: () => prog++ });
  assert.equal(r.mode, 'in-place'); assert.ok(prog > 0);
  assert.equal(r.poses.length, 3); r.poses.forEach((p) => { assert.equal(p.matrix.length, 16); assert.ok(p.confidence >= 0 && p.confidence <= 1); assert.ok(p.note); });
  const sl = r.joints.find((j) => j.part === 'drawer' && j.type === 'slider'); assert.ok(sl, 'drawer slider inferred');
  assert.ok(Math.abs(sl.axis[1] + 1) < 1e-6 && sl.range[1] > 50);
  const w = solveJoints(r.joints, 1); assert.ok(w.drawer.elements[13] < -50); // joints usable by solveJoints
  const ac = new AbortController(); ac.abort();
  await assert.rejects(autoAssemble(parts, { signal: ac.signal }), (e) => e.name === 'AbortError');
  const ac2 = new AbortController();
  await assert.rejects(autoAssemble(parts, { signal: ac2.signal, onProgress: () => ac2.abort() }), (e) => e.name === 'AbortError');
}
// UI-style autoAssemble call (as src/ui does): raw STLs, id = file name, identity poses, clearance 0.3, async
if (existsSync(root + '/models/v1_housing.stl')) {
  const ids = ['v1_housing', 'v1_drawer', 'v1_backplate'], parts = [], poses = {};
  for (const id of ids) { parts.push({ id, geometry: await loadSTL(root + '/models/' + id + '.stl') }); poses[id] = new THREE.Matrix4().toArray(); }
  const r = await autoAssembleAsync(parts, { poses, tolerance: 0.3, clearance: 0.3, onProgress: () => {} });
  assert.ok(['in-place', 'mixed', 'search'].includes(r.mode) && r.pass1 && r.pass1.rejected, 'mode/pass1 reported');
  assert.equal(r.mode, 'mixed'); assert.ok(r.pass1.rejected.v1_backplate, 'pass-1 rejection reason given');
  const M = new THREE.Matrix4().fromArray(r.poses.find((q) => q.id === 'v1_backplate').matrix);
  assert.ok(Math.abs(new THREE.Vector3().setFromMatrixPosition(M).y - 94.61) < 1.5, 'v1 backplate placed on the housing');
}
console.log('unit checks OK');

const inBox = (pt, [mn, mx]) => pt.every((v, i) => v >= mn[i] && v <= mx[i]);
for (const pr of presets) {
  const parts = [];
  let missing = false;
  for (const p of pr.parts) {
    const f = root + pr.base + p.file;
    if (!existsSync(f)) { missing = true; break; }
    parts.push({ id: p.id, geometry: await loadSTL(f) });
  }
  if (missing) { console.log(`\n[${pr.id}] SKIP: STLs missing (TODO)`); continue; }
  const res = sweep(parts, pr.joints, { steps: Number(process.env.STEPS || 40), tolerance: Number(process.env.TOL || 0.3), ignorePairs: pr.ignorePairs });
  console.log(`\n[${pr.id}] ${pr.name}: ${res.length} steps`);
  const unexpected = [];
  for (const raw of res) {
    const r = classify(raw, pr.expected);
    const line = [];
    for (const c of r.collisions) {
      line.push(`${c.expected ? 'expected' : 'COLLISION'} ${c.a}/${c.b}${c.expected ? '' : ' @' + JSON.stringify(c.points[0])}`);
      if (!c.expected) unexpected.push({ t: r.t, kind: 'collision', ...c });
    }
    for (const n of r.nearMisses) {
      line.push(`${n.expected ? 'near(exp)' : 'NEAR'} ${n.a}/${n.b} gap=${n.minGap}${n.expected ? '' : ' @' + JSON.stringify(n.points)}`);
      if (!n.expected) unexpected.push({ t: r.t, kind: 'nearMiss', ...n });
    }
    console.log(`  t=${r.t.toFixed(3)} ${line.join('; ') || 'clear'}`);
  }
  console.log(`  -> unexpected collisions/near misses: ${unexpected.length}`);
  pr.unexpected = unexpected;
}
for (const pr of presets) assert.equal((pr.unexpected || []).length, 0, pr.id + ' has unexpected collisions or near misses: ' + JSON.stringify(pr.unexpected.slice(0, 3).map((u) => [u.t, u.kind, u.a, u.b])));
console.log('\nPASS');
