// Auto-assemble UI test: node tests-ui/autoassemble-test.mjs  (needs `npx vite build && npx vite preview --port 4179` running, puppeteer-core, google-chrome)
// Part A (stub, phone): v3 parts, review panel renders, Undo all restores poses; mock guess proves undo + joint editor.
// Part B (Gram's real engine via worker), at phone 390x844 and desktop 1440x860, for v1, v2, v3 parts from public/models:
//   Engine panel says engine; press Auto-assemble; UI stays responsive (rAF gaps) with progress updates; panel shows engine notes;
//   joints land in the editor; Play moves parts; Undo all restores; Cancel aborts (worker terminated); no console/worker errors.
import puppeteer from 'puppeteer-core';
const URL = process.env.URL || 'http://localhost:4179/';
const SETS = {
  v1: ['v1_housing.stl', 'v1_drawer.stl', 'v1_backplate.stl'],
  v2: ['v2_housing.stl', 'v2_drawer.stl', 'v2_backplate.stl'],
  v3: ['v3_housing.stl', 'v3_drawer.stl', 'v3_backplate.stl', 'v3_lever.stl', 'v3_button.stl', 'v3_pin_drawer.stl', 'v3_pin_pivot.stl'],
};
const VIEWS = { phone: { width: 390, height: 844, isMobile: true, deviceScaleFactor: 2 }, desktop: { width: 1440, height: 860 } };
const b = await puppeteer.launch({ executablePath: '/usr/bin/google-chrome', args: ['--no-sandbox', '--use-gl=swiftshader', '--enable-unsafe-swiftshader'] });
const errors = [];
const same = (x, y) => Object.keys(x).every(k => x[k].every((v, i) => Math.abs(v - y[k][i]) < 1e-6));
async function open(view) {
  const p = await b.newPage(); await p.setViewport(VIEWS[view]);
  p.on('pageerror', e => errors.push(`${view} pageerror: ${e.message}`));
  p.on('console', m => { if (m.type() === 'error' && !/WebGL|GPU stall|swiftshader/i.test(m.text())) errors.push(`${view} console: ${m.text()}`); });
  await p.evaluateOnNewDocument(() => {
    const W = window.Worker; window.__workers = [];
    window.Worker = class extends W { constructor(u, o) { super(u, o); const rec = { url: String(u), terminated: false, errors: [], msgsAfterTerminate: 0 }; window.__workers.push(rec); this.__rec = rec;
      this.addEventListener('error', e => rec.errors.push(e.message || 'worker error')); this.addEventListener('messageerror', () => rec.errors.push('messageerror'));
      this.addEventListener('message', ({ data }) => { if (rec.terminated) rec.msgsAfterTerminate++; if (data?.type === 'error') rec.errors.push(data.message); }); }
      terminate() { this.__rec.terminated = true; super.terminate(); } };
  });
  await p.goto(URL, { waitUntil: 'networkidle0' }); await p.waitForFunction(() => window.__mechTester);
  return p;
}
const load = (p, files) => p.evaluate(async (files) => { const a = window.__mechTester;
  for (const f of files) await a.addBuffer(f, await (await fetch('/models/' + f)).arrayBuffer()); return a.poses(); }, files);
const results = {}; let allOk = true;
const check = (name, ok, info) => { results[name] = { ok, ...info }; if (!ok) allOk = false; console.log((ok ? 'PASS ' : 'FAIL ') + name, JSON.stringify(info)); };

// ---------- Part A: stub ----------
{
  const p = await open('phone'); const before = await load(p, SETS.v3);
  const panel = await p.evaluate(async () => { const a = window.__mechTester; await a.runAuto(a.stubAutoAssemble);
    return { items: document.querySelectorAll('[data-s=auto] .auto-item').length, text: document.querySelector('[data-s=auto]').innerText }; });
  await p.evaluate(() => [...document.querySelectorAll('[data-s=auto] button')].find(x => x.textContent === 'Undo all').click());
  const after = await p.evaluate(() => window.__mechTester.poses());
  const mock = await p.evaluate(async () => { const a = window.__mechTester;
    await a.runAuto(async () => ({ poses: [{ id: 'v3_drawer', position: [0, -20, 5], rotation: [0, 0, 0], confidence: 0.9, reason: 'pin fits this hole' }],
      joints: [{ part: 'v3_drawer', type: 'slider', axis: [0, -1, 0], range: [0, 40], confidence: 0.3, reason: 'drawer slides out of housing' }] }));
    const moved = a.poses().v3_drawer[13], editorCards = document.querySelectorAll('[data-s=joints] .card').length;
    [...document.querySelectorAll('[data-s=auto] button')].find(x => x.textContent === 'Undo all').click();
    return { moved, editorCards, restored: a.poses(), jointsLeft: a.state.joints.length }; });
  check('stub: panel + Undo all', panel.items === 7 && panel.text.includes('parts already positioned') && same(before, after)
    && mock.moved === -20 && mock.editorCards === 2 && same(before, mock.restored) && mock.jointsLeft === 0, { items: panel.items, mock: { moved: mock.moved, editorCards: mock.editorCards } });
  await p.close();
}

// ---------- Part B: Gram's engine ----------
for (const view of Object.keys(VIEWS)) for (const [set, files] of Object.entries(SETS)) {
  const p = await open(view);
  const eng = await p.evaluate(() => document.querySelector('[data-s=eng]').innerText);
  const before = await load(p, files);
  // responsiveness probe: rAF gaps while the job runs
  await p.evaluate(() => { window.__gaps = []; let last = performance.now(); const f = (n) => { window.__gaps.push(n - last); last = n; if (window.__probe) requestAnimationFrame(f); }; window.__probe = true; requestAnimationFrame(f); });
  await p.click('[data-a=auto]');
  await p.waitForSelector('[data-s=auto] .auto-item, [data-s=auto] .bad', { timeout: 60000 });
  const run = await p.evaluate(() => { window.__probe = false; const a = window.__mechTester, S = a.state, g = window.__gaps.slice(1);
    const items = S.auto?.items || [];
    return { result: S.autoResult, progress: S.autoProgress.length, maxFrameGapMs: Math.round(Math.max(...g)), frames: g.length,
      panelText: document.querySelector('[data-s=auto]').innerText, items: items.length,
      itemReasons: items.map(i => i.reason), rawNotes: [...(S.lastAuto?.poses || []), ...(S.lastAuto?.joints || [])].map(x => x.reason),
      motions: S.joints.filter(j => j.type === 'slider' || j.type === 'hinge').map(j => `${j.part}:${j.type}[${j.range}]`),
      editorCards: document.querySelectorAll('[data-s=joints] .card').length, joints: S.joints.length }; });
  if (set === 'v3') { await p.evaluate(() => document.querySelector('[data-s=auto]').scrollIntoView()); await p.screenshot({ path: `screenshots/autoassemble-${view}.png` }); if (view === 'phone') await p.screenshot({ path: 'screenshots/autoassemble.png' }); }
  // Play
  const play = await p.evaluate(async () => { const a = window.__mechTester; const p0 = a.poses(); document.querySelector('[data-a=play]').click();
    await new Promise(r => setTimeout(r, 1200)); const t = a.state.t, p1 = a.poses(); document.querySelector('[data-a=play]').click();
    const movedParts = Object.keys(p0).filter(k => p0[k].some((v, i) => Math.abs(v - p1[k][i]) > 1e-6)); return { t: +t.toFixed(3), movedParts }; });
  // Undo all
  await p.evaluate(() => { window.__mechTester.setT(0); [...document.querySelectorAll('[data-s=auto] button')].find(x => x.textContent === 'Undo all').click(); });
  const undo = await p.evaluate(() => ({ poses: window.__mechTester.poses(), joints: window.__mechTester.state.joints.length, panel: document.querySelector('[data-s=auto]').innerHTML }));
  // Cancel: start again, cancel at first progress
  const cancel = await p.evaluate(async () => { const a = window.__mechTester; const n0 = window.__workers.length; a.state.autoProgress = [];
    document.querySelector('[data-a=auto]').click();
    while (!(a.state.autoProgress || []).length && a.state.autoBusy !== false) await new Promise(r => setTimeout(r, 5));
    document.querySelector('[data-k=acancel]')?.click(); const at = a.state.autoProgress.length;
    await new Promise(r => setTimeout(r, 1500));
    const w = window.__workers.slice(n0);
    return { status: a.state.autoResult?.status, progressAtCancel: at, progressAfter: a.state.autoProgress.length, text: document.querySelector('[data-s=auto]').innerText, poses: a.poses(), joints: a.state.joints.length,
      workers: w.map(x => ({ terminated: x.terminated, msgsAfterTerminate: x.msgsAfterTerminate })) }; });
  const workerErrs = await p.evaluate(() => window.__workers.flatMap(w => w.errors));
  const key = `${view} ${set}`;
  check(`${key}: engine panel says autoAssemble: engine`, /autoAssemble: Gram's engine/.test(eng), {});
  check(`${key}: runs without freezing`, run.result?.status === 'ok' && run.progress >= files.length && run.maxFrameGapMs < 500,
    { ms: run.result?.ms, mode: run.result?.mode, progressEvents: run.progress, maxFrameGapMs: run.maxFrameGapMs, frames: run.frames });
  check(`${key}: panel shows Gram's notes`, run.items >= files.length && run.itemReasons.every(r => r && r !== 'no reason given' && run.panelText.includes(r)), { items: run.items, notes: run.itemReasons });
  check(`${key}: joints in editor`, run.joints > 0 && run.editorCards === run.joints, { joints: run.joints, editorCards: run.editorCards, motions: run.motions });
  check(`${key}: Play moves parts`, run.motions.length === 0 ? null : play.t > 0 && play.movedParts.length > 0, { ...play, note: run.motions.length ? '' : 'no motion joints guessed' });
  check(`${key}: Undo all restores`, same(before, undo.poses) && undo.joints === 0 && undo.panel === '', {});
  check(`${key}: Cancel`, cancel.status === 'cancelled' && cancel.text.includes('cancelled') && cancel.progressAfter === cancel.progressAtCancel && same(before, cancel.poses) && cancel.joints === 0
    && cancel.workers.length === 1 && cancel.workers[0].terminated && cancel.workers[0].msgsAfterTerminate === 0, { status: cancel.status, progressAtCancel: cancel.progressAtCancel, workers: cancel.workers });
  check(`${key}: no worker errors`, workerErrs.length === 0, { workerErrs });
  await p.close();
}

// ---------- Part C: single print-layout 3MFs + v3 STLs: Accept all, role names, path joint, button direction ----------
const fsx = await import('fs');
const CASES = {
  'v3 3MF': ['/workspace/skadis_drawer/v3_tilt_out/print_layout.3mf'],
  'v2 3MF': ['/workspace/skadis_drawer/v2_push_open/print_layout.3mf'],
  'v1 3MF': ['/workspace/skadis_drawer/print_layout.3mf'],
  'v3 STLs': SETS.v3.map(f => 'public/models/' + f),
  'v3 unnamed 3MF': ['tests-ui/fixtures/v3_unnamed.3mf'],
};
for (const view of Object.keys(VIEWS)) for (const [name, files] of Object.entries(CASES)) {
  const p = await open(view);
  const bufs = files.map(f => [f.split('/').pop(), fsx.readFileSync(f).toString('base64')]);
  const r = await p.evaluate(async (bufs) => { const a = window.__mechTester, S = a.state;
    for (const [n, b64] of bufs) await a.addBuffer(n, Uint8Array.from(atob(b64), c => c.charCodeAt(0)).buffer);
    const names0 = S.parts.map(x => x.name);
    await a.runAuto(); if (!S.auto) return { err: document.querySelector('[data-s=auto]').innerText };
    const roles = Object.fromEntries(S.lastAuto.poses.map(x => [x.id, x.role]));
    [...document.querySelectorAll('[data-s=auto] button')].find(x => x.textContent === 'Accept all').click();
    const M = (arr) => new (S.parts[0].mesh.matrix.constructor)().fromArray(arr);
    const center = (id, poses) => { const pt = S.parts.find(x => x.id === id); pt.geometry.computeBoundingBox(); const c = pt.geometry.boundingBox.getCenter(new (pt.mesh.position.constructor)()); return c.applyMatrix4(M(poses[id])); };
    const slider = document.querySelector('[data-s=slider]'), slide = (v) => { slider.value = v; slider.dispatchEvent(new Event('input', { bubbles: true })); };
    slide(0); const p0 = a.poses(); slide(500); const pm = a.poses(); slide(1000); const p1 = a.poses(); const label1 = document.querySelector('[data-s=tval]').textContent;
    const byRole = (r) => Object.keys(roles).filter(k => roles[k] === r);
    const drawer = byRole('drawer')[0], button = byRole('button')[0], lever = byRole('lever')[0], base = byRole('base')[0];
    const pathJ = S.joints.find(j => j.type === 'path');
    let tilt = null, drawerMove = null;
    if (drawer) { const rel = M(p0[drawer]).invert().multiply(M(p1[drawer])).elements;
      tilt = +(Math.acos(Math.min(1, Math.max(-1, (rel[0] + rel[5] + rel[10] - 1) / 2))) * 180 / Math.PI).toFixed(1);
      drawerMove = +center(drawer, p0).distanceTo(center(drawer, p1)).toFixed(1); }
    let btn = null;
    if (button) { const bJ = S.joints.find(j => j.part === button && j.type === 'slider');
      const d = (pose, other) => +center(button, pose).distanceTo(center(other, pose)).toFixed(2);
      btn = { joint: bJ && { axis: bJ.axis, range: bJ.range }, moved: +center(button, p0).distanceTo(center(button, p1)).toFixed(2),
        toBase: [d(p0, base), d(p1, base)], toLever: lever ? [d(p0, lever), d(p1, lever)] : null }; }
    const pathCard = pathJ ? [...document.querySelectorAll('[data-s=joints] .card')].find(c => c.querySelector('[data-k=type]')?.value === 'path') : null;
    return { names0, names: S.parts.map(x => x.name), roles: S.parts.map(x => roles[x.id]), joints: S.joints.filter(j => j.type !== 'fixed').map(j => `${S.parts.find(x => x.id === j.part)?.name}:${j.type}`),
      pathJ: pathJ && { part: pathJ.part, kf: pathJ.keyframes?.length }, pathCard: pathCard && pathCard.innerText.replace(/\s+/g, ' '), midDiffers: drawer ? pm[drawer].some((v, i) => Math.abs(v - p0[drawer][i]) > 1e-6) : null,
      tilt, drawerMove, btn, label1, editorCards: document.querySelectorAll('[data-s=joints] .card').length, jointCount: S.joints.length, ms: S.autoResult.ms, panelOpen: !!S.auto };
  }, bufs);
  const key = `${view} ${name}`;
  if (r.err) { check(`${key}: auto-assemble ran`, false, r); await p.close(); continue; }
  const v3 = name.startsWith('v3');
  if (v3) { await p.evaluate(() => document.querySelector('[data-s=joints]').scrollIntoView()); await p.screenshot({ path: `screenshots/autoassemble-${name.replace(/\W+/g, '_')}-${view}-t1.png` }); }
  console.log('INFO', key, JSON.stringify({ motions: r.joints, ms: r.ms }));
  // (1) role names: unnamed parts renamed from roles; named objects / file names are kept
  const unnamed = r.names0.some(n => /^Part \d+ \(|#\d+$|\.3mf$/i.test(n));
  const expectRole = (n, role) => !role || role === 'part' || new RegExp('^' + (role === 'base' ? '(Base|Housing)' : role[0].toUpperCase() + role.slice(1)) + '( \\d+)?$').test(n);
  check(`${key}: (1) names from roles`, unnamed ? r.names.every((n, i) => expectRole(n, r.roles[i])) && (r.roles.filter(x => x === 'pin').length < 2 || r.names.includes('Pin 2')) : r.names.join() === r.names0.join(),
    { before: r.names0, after: r.names, roles: r.roles, mode: unnamed ? 'unnamed→renamed' : 'named→kept' });
  check(`${key}: Accept all closes panel, joints in editor`, !r.panelOpen && r.editorCards === r.jointCount && r.jointCount > 0, { cards: r.editorCards, joints: r.jointCount });
  if (v3) {
    check(`${key}: (2) drawer path joint moves + tilts 0→1`, !!r.pathJ && r.pathJ.kf >= 2 && r.midDiffers && r.drawerMove > 5 && r.tilt >= 10, { path: r.pathJ, drawerMove: r.drawerMove, tiltDeg: r.tilt, label1: r.label1 });
    check(`${key}: (2) path editor card renders`, !!r.pathCard && /Follows a path/.test(r.pathCard) && /Slides out, then tilts/.test(r.pathCard), { card: r.pathCard.slice(-120) });
    const b = r.btn;
    check(`${key}: (3) button presses in`, !!b?.joint && b.moved > 0.5 && b.toBase[1] < b.toBase[0] && (!b.toLever || b.toLever[1] <= b.toLever[0] + 0.01), b || {});
  }
  await p.close();
}

// ---------- Part D: 'Turn 90°' display-only view rotation (v3 print-layout 3MF lies face-up; one press stands it up) ----------
for (const view of Object.keys(VIEWS)) {
  const p = await open(view);
  const b64 = fsx.readFileSync('/workspace/skadis_drawer/v3_tilt_out/print_layout.3mf').toString('base64');
  const before = await p.evaluate(async (b64) => { const a = window.__mechTester, S = a.state;
    await a.addBuffer('print_layout.3mf', Uint8Array.from(atob(b64), c => c.charCodeAt(0)).buffer);
    await a.runAuto(); [...document.querySelectorAll('[data-s=auto] button')].find(x => x.textContent === 'Accept all').click(); a.setT(0); a.frame();
    window.scrollTo(0, 0); return { poses: a.poses(), result: JSON.stringify(S.lastResult) }; }, b64);
  await new Promise(r => setTimeout(r, 300)); await p.screenshot({ path: `screenshots/turn90-before-${view}.png` });
  const geo = () => p.evaluate(() => { const a = window.__mechTester, S = a.state; a.world.updateMatrixWorld(true);
    const wc = (name) => { const pt = S.parts.find(x => x.name === name); pt.geometry.computeBoundingBox(); return pt.geometry.boundingBox.getCenter(new (pt.mesh.position.constructor)()).applyMatrix4(pt.mesh.matrixWorld).toArray().map(v => +v.toFixed(1)); };
    const grid = a.world.parent.children.find(o => o.type === 'GridHelper');
    return { housing: wc('housing'), backplate: wc('backplate'), button: wc('button'), drawer: wc('drawer'), view: S.view, gridRot: grid.rotation.toArray().slice(0, 3), poses: a.poses(), result: JSON.stringify(S.lastResult),
      label: document.querySelector('[data-a=turnx]').textContent }; });
  const g0 = await geo();
  await p.click('[data-a=turnx]'); await new Promise(r => setTimeout(r, 300));
  const g1 = await geo(); await p.screenshot({ path: `screenshots/turn90-after-${view}.png` });
  // save project: capture the blob instead of downloading
  const saved = await p.evaluate(async () => { let blob; const o = URL.createObjectURL; URL.createObjectURL = (b) => { blob = b; return 'blob:x'; };
    const A = HTMLAnchorElement.prototype.click; HTMLAnchorElement.prototype.click = function () {};
    document.querySelector('[data-a=save]').click(); URL.createObjectURL = o; HTMLAnchorElement.prototype.click = A; return JSON.parse(await blob.text()).settings.view; });
  const cyc = await p.evaluate(() => { const out = []; for (let i = 0; i < 4; i++) { document.querySelector('[data-a=turnx]').click(); out.push(window.__mechTester.state.view.rx); }
    document.querySelector('[data-a=turnz]').click(); const rz = window.__mechTester.state.view.rz;
    window.__mechTester.applyProject({ ...{ joints: window.__mechTester.state.joints }, settings: { view: { rx: 1, rz: 0 } } }); return { rx: out, rz, afterLoad: window.__mechTester.state.view }; });
  const key = `${view} Turn 90°`;
  // NOTE: Gram's auto-assemble already returns this file upright (backplate +Y rear, button +Z top), so we assert the rotation is an exact +90° about X
  const rx = (v) => [v[0], v[2], -v[1]]; const dz = g1.housing[2] - rx(g0.housing)[2]; g1.dz = dz; ["housing","backplate","button","drawer"].forEach(n => g1[n] = [g1[n][0], g1[n][1], +(g1[n][2] - dz).toFixed(1)]); const near = (u, v) => u.every((x, i) => Math.abs(x - v[i]) < 0.2);
  check(`${key}: one press = 90° about X of every part; face-up result -> backplate at rear`, ['housing', 'backplate', 'button', 'drawer'].every(n => near(rx(g0[n]), g1[n])) && (!(g0.backplate[2] > g0.housing[2] + 20) || g1.backplate[1] > g1.housing[1] + 20),
    { before: { housing: g0.housing, backplate: g0.backplate, button: g0.button }, after: { housing: g1.housing, backplate: g1.backplate, button: g1.button }, label: g1.label });
  check(`${key}: display only (poses, collision result, grid unchanged)`, same(before.poses, g1.poses) && before.result === g1.result && g0.gridRot.join() === g1.gridRot.join(), { gridRot: g1.gridRot });
  check(`${key}: cycles 0/90/180/270, Z button, saved + loaded with project`, cyc.rx.join() === '2,3,0,1' && cyc.rz === 1 && saved?.rx === 1 && cyc.afterLoad.rx === 1 && cyc.afterLoad.rz === 0, { cyc, saved });
  await p.close();
}
check('no console / page errors', errors.length === 0, { errors });
console.log(allOk ? 'PASS' : 'FAIL'); await b.close(); process.exit(allOk ? 0 : 1);
