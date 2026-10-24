// Auto-assemble UI test: node tests-ui/autoassemble-test.mjs  (needs `npx vite preview --port 4179` running, puppeteer-core, google-chrome)
// Loads the v3 drawer parts from public/models, presses Auto-assemble (stub), checks the review panel, then Undo all restores poses.
// Also runs a mock guess that moves a part + adds a joint to prove Undo all really restores and joints reach the editor.
import puppeteer from 'puppeteer-core';
const URL = process.env.URL || 'http://localhost:4179/';
const b = await puppeteer.launch({ executablePath: '/usr/bin/google-chrome', args: ['--no-sandbox', '--use-gl=swiftshader', '--enable-unsafe-swiftshader'], defaultViewport: { width: 390, height: 844, isMobile: true, deviceScaleFactor: 2 } });
const p = await b.newPage(); p.on('pageerror', e => console.log('PAGEERROR', e.message));
await p.goto(URL, { waitUntil: 'networkidle0' });
await p.waitForFunction(() => window.__mechTester);
const FILES = ['v3_housing.stl', 'v3_drawer.stl', 'v3_backplate.stl', 'v3_lever.stl', 'v3_button.stl', 'v3_pin_drawer.stl', 'v3_pin_pivot.stl'];
const before = await p.evaluate(async (files) => { const a = window.__mechTester;
  for (const f of files) await a.addBuffer(f, await (await fetch('/models/' + f)).arrayBuffer());
  return a.poses(); }, FILES);
await p.click('[data-a=auto]');
const spinnerSeen = await p.evaluate(() => !!document.querySelector('[data-s=auto] .spin') || window.__mechTester.state.autoBusy);
await p.waitForSelector('[data-s=auto] .auto-item');
const panel = await p.evaluate(() => ({ items: document.querySelectorAll('[data-s=auto] .auto-item').length, text: document.querySelector('[data-s=auto]').innerText,
  badges: [...document.querySelectorAll('[data-s=auto] .conf')].map(e => e.textContent), accept: document.querySelectorAll('[data-s=auto] [data-k=acc]').length }));
await p.evaluate(() => document.querySelector('[data-s=auto]').scrollIntoView());
await p.screenshot({ path: 'screenshots/autoassemble.png' });
await p.evaluate(() => [...document.querySelectorAll('[data-s=auto] button')].find(x => x.textContent === 'Undo all').click());
const afterStub = await p.evaluate(() => ({ poses: window.__mechTester.poses(), panel: document.querySelector('[data-s=auto]').innerHTML }));
// mock engine guess: move drawer, add a slider joint for it
const mock = await p.evaluate(async () => { const a = window.__mechTester;
  await a.runAuto(async (parts) => ({ poses: [{ id: 'v3_drawer', position: [0, -20, 5], rotation: [0, 0, 0], confidence: 0.9, reason: 'pin fits this hole' }],
    joints: [{ part: 'v3_drawer', type: 'slider', axis: [0, -1, 0], range: [0, 40], confidence: 0.3, reason: 'drawer slides out of housing' }] }));
  const moved = a.poses().v3_drawer[13]; const editorCards = document.querySelectorAll('[data-s=joints] .card').length;
  const badges = [...document.querySelectorAll('[data-s=auto] .conf')].map(e => e.textContent);
  [...document.querySelectorAll('[data-s=auto] button')].find(x => x.textContent === 'Undo all').click();
  return { moved, editorCards, badges, restored: a.poses(), jointsLeft: a.state.joints.length }; });
const same = (x, y) => Object.keys(x).every(k => x[k].every((v, i) => Math.abs(v - y[k][i]) < 1e-9));
const r = { panel, spinnerSeen, stubRestored: same(before, afterStub.poses), panelClosed: afterStub.panel === '', mock: { ...mock, restored: same(before, mock.restored) } };
console.log(JSON.stringify(r));
const ok = panel.items === FILES.length && panel.text.includes('parts already positioned') && panel.badges.every(x => x === 'high') && panel.accept === FILES.length && panel.text.includes('Undo all')
  && r.stubRestored && r.panelClosed && mock.moved === -20 && mock.editorCards === 2 && mock.badges.join() === 'high,low' && r.mock.restored && mock.jointsLeft === 0;
console.log(ok ? 'PASS' : 'FAIL'); await b.close(); process.exit(ok ? 0 : 1);
