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
check('no console / page errors', errors.length === 0, { errors });
console.log(allOk ? 'PASS' : 'FAIL'); await b.close(); process.exit(allOk ? 0 : 1);
