// Accuracy report for autoAssemble (not part of `npm test`; always exits 0 unless it crashes).
// Run: node src/engine/assemble.test.js [seed]
// Modes: ui = exactly what src/ui runAuto sends after dropping the preset's STL files (one part per file, id = file name
// without extension, poses = mesh.matrix.toArray() = identity, clearance = tolerance 0.3, via autoAssembleAsync);
// in-place = truth poses; scrambled = random rotation + ±200 mm. Identical-geometry parts (pins) may swap holes: counted correct.
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { ThreeMFLoader } from 'three/examples/jsm/loaders/3MFLoader.js';
import { loadSTL, solveJoints, autoAssemble, autoAssembleAsync, isPlateLayout, ROTATIONS_24, THREE } from './index.js';
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

// ---------- print-plate 3MF (public/models/vN_print_layout.3mf): loaded exactly like src/ui/index.js loadFile ----------
// Each plate part is matched to its preset STL (vertex hash) to get the truth; poses compared in the base part's frame.
// Pose tolerance TOL = 2 mm (voxel scoring resolution ~1 mm). Not part of `npm test`.
function installDOMParser() {
  if (globalThis.DOMParser) return;
  class El {
    constructor(name, attrs, parent) { this.nodeName = name; this.localName = name.replace(/^.*:/, ''); this._a = attrs; this.children = []; this.parentNode = parent; this.text = ''; }
    getAttribute(k) { return k in this._a ? this._a[k] : null; }
    hasAttribute(k) { return k in this._a; }
    get attributes() { return Object.entries(this._a).map(([name, value]) => ({ name, value, nodeName: name, nodeValue: value })); }
    get textContent() { return this.text + this.children.map((c) => c.textContent).join(''); }
    *_desc() { for (const c of this.children) { yield c; yield* c._desc(); } }
    querySelectorAll(sel) {
      const parts = sel.trim().split(/\s+/); let set = [this];
      for (const p of parts) { const out = new Set(); for (const n of set) for (const d of n._desc()) if (d.nodeName === p || d.localName === p) out.add(d); set = [...out]; }
      return set;
    }
    querySelector(sel) { return this.querySelectorAll(sel)[0] || null; }
  }
  globalThis.DOMParser = class {
    parseFromString(s) {
      const doc = new El('#document', {}, null); let cur = doc;
      const re = /<\?[\s\S]*?\?>|<!--[\s\S]*?-->|<!\[CDATA\[([\s\S]*?)\]\]>|<(\/?)([\w:.-]+)((?:\s+[\w:.-]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>|([^<]+)/g;
      const ent = (t) => t.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
      let m;
      while ((m = re.exec(s))) {
        if (m[1] !== undefined) { cur.text += m[1]; continue; }
        if (m[6] !== undefined) { cur.text += ent(m[6]); continue; }
        if (!m[3]) continue;
        if (m[2]) { cur = cur.parentNode || doc; continue; }
        const attrs = {}; const ar = /([\w:.-]+)\s*=\s*("([^"]*)"|'([^']*)')/g; let a;
        while ((a = ar.exec(m[4]))) attrs[a[1]] = ent(a[3] ?? a[4]);
        const el = new El(m[3], attrs, cur); cur.children.push(el);
        if (!m[5]) cur = el;
      }
      doc.documentElement = doc.children[0]; return doc;
    }
  };
}

installDOMParser();
const TOL = 2.0, plateSummary = []; let plateFail = 0;
// exactly like src/ui/index.js loadFile + addPart
function load3MF(name, buf) {
  const group = new ThreeMFLoader().parse(buf); group.updateMatrixWorld(true);
  const out = [], ids = []; let k = 0;
  group.traverse((o) => { if (o.isMesh) { const g = o.geometry.clone().applyMatrix4(o.matrixWorld); g.computeVertexNormals(); g.computeBoundingBox();
    const key = k++ ? `${name}#${k}` : name; let id = key.replace(/\.\w+$/, ''); if (ids.includes(id)) id += '_' + k; ids.push(id); out.push({ id, name: key, geometry: g }); } });
  return out;
}
for (const v of ['v1', 'v2', 'v3']) {
  const pr = presets.find((p) => p.id === v), truth = solveJoints(pr.joints, 0);
  const b = readFileSync(root + v + '_print_layout.3mf'); const parts = load3MF('print_layout.3mf', b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
  const stl = {}; for (const p of pr.parts) stl[p.file] ||= await loadSTL(root + p.file);
  // match each plate part to a preset file + plate transform Mp (plate = Mp * stl)
  for (const p of parts) {
    const pp = p.geometry.attributes.position, bbP = p.geometry.boundingBox;
    let best = null;
    const key = (x, y, z) => `${Math.round(x * 10)},${Math.round(y * 10)},${Math.round(z * 10)}`, hs = new Set();
    for (let i = 0; i < pp.count; i++) hs.add(key(pp.getX(i), pp.getY(i), pp.getZ(i)));
    for (const [file, g] of Object.entries(stl)) { g.computeBoundingBox();
      for (const R of ROTATIONS_24) { const bb = g.boundingBox.clone().applyMatrix4(R); if (bb.getSize(new THREE.Vector3()).distanceTo(bbP.getSize(new THREE.Vector3())) > 0.05) continue;
        const t = bbP.min.clone().sub(bb.min); const Mp = new THREE.Matrix4().makeTranslation(t.x, t.y, t.z).multiply(R);
        let hit = 0, n = 0; const v3 = new THREE.Vector3(); const ga = g.attributes.position;
        for (let i = 0; i < ga.count; i += 5) { v3.fromBufferAttribute(ga, i).applyMatrix4(Mp); n++; if ([[0,0,0]].some(() => hs.has(key(v3.x, v3.y, v3.z)) || hs.has(key(v3.x + 0.04, v3.y + 0.04, v3.z + 0.04)) || hs.has(key(v3.x - 0.04, v3.y - 0.04, v3.z - 0.04)))) hit++; }
        const e = 1 - hit / n; if (e < 0.1 && (!best || e < best.e)) best = { file, Mp, e }; } }
    p.file = best?.file; if (!best) throw new Error('no match for ' + p.id); p.Mp = best?.Mp;
  }
  const poses = Object.fromEntries(parts.map((p) => [p.id, new THREE.Matrix4().toArray()]));
  const t0 = Date.now();
  const res = await autoAssembleAsync(parts.map(({ id, name, geometry }) => ({ id, name, geometry })), { poses, clearance: 0.3, onProgress: () => {} });
  const W = Object.fromEntries(res.poses.map((q) => [q.id, new THREE.Matrix4().fromArray(q.matrix)]));
  const baseP = parts.find((p) => p.id === res.base), slotsOf = (f) => pr.parts.filter((q) => q.file === f).map((q) => q.id);
  const bInv = W[res.base].clone().invert();
  const tBase = (truth[slotsOf(baseP.file)[0]] || new THREE.Matrix4()).clone().multiply(baseP.Mp.clone().invert()), tInv = tBase.clone().invert();
  let ok = 0, jok = 0; const rows = [];
  for (const p of parts) {
    const pl = (M) => { const bb = p.geometry.boundingBox.clone().applyMatrix4(M); return { bb, c: bb.getCenter(new THREE.Vector3()) }; };
    const a = pl(bInv.clone().multiply(W[p.id])); let err = Infinity, slot;
    for (const sid of slotsOf(p.file)) { const bm = pl(tInv.clone().multiply(truth[sid] || new THREE.Matrix4()).multiply(p.Mp.clone().invert())); const e = Math.max(a.c.distanceTo(bm.c), a.bb.min.distanceTo(bm.bb.min), a.bb.max.distanceTo(bm.bb.max)); if (e < err) { err = e; slot = sid; p.d = a.c.clone().sub(bm.c).toArray().map((x) => +x.toFixed(1)); } }
    const g = res.guesses.find((x) => x.part === p.id), good = err <= TOL, jgood = (g.joint.startsWith('fixed(parent') ? 'fixed(parent)' : g.joint) === truthType(pr, slot); ok += good; jok += jgood;
    rows.push(`  ${good ? '✔' : '✘'} ${p.id.padEnd(24)} ${p.file.padEnd(18)} slot ${slot.padEnd(9)} err ${err.toFixed(2).padStart(7)} d ${JSON.stringify(p.d)} joint ${jgood ? '✔' : '✘'} ${g.joint} (true ${truthType(pr, slot)})  | ${g.reason.slice(0, 140)}`);
  }
  const line = `${v} plate    layout=${res.layout} mode=${res.mode.padEnd(6)} poses ${ok}/${parts.length}  joints ${jok}/${parts.length}  ${Date.now() - t0} ms  collisions:${res.collisions.length}`;
  console.log(line + '\n' + rows.join('\n')); plateSummary.push(line);
  if (res.layout !== 'plate' || !isPlateLayout(parts)) { console.log('  ✘ print-plate layout not detected'); plateFail++; }
}
console.log('\nPLATE SUMMARY\n' + plateSummary.join('\n') + (plateFail ? `\n${plateFail} plate layout(s) not detected` : ''));
