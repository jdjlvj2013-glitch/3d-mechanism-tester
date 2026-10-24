// Headless UI test: node tests-ui/ui-test.mjs  (needs `npx vite preview --port 4179` running, puppeteer-core, google-chrome)
import puppeteer from 'puppeteer-core';
const URL = process.env.URL || 'http://localhost:4179/';
const b = await puppeteer.launch({ executablePath: '/usr/bin/google-chrome', args: ['--no-sandbox', '--use-gl=swiftshader', '--enable-unsafe-swiftshader'], defaultViewport: { width: 1440, height: 860 } });
const p = await b.newPage(); p.on('pageerror', e => console.log('PAGEERROR', e.message));
await p.goto(URL, { waitUntil: 'networkidle0' });
await p.waitForFunction(() => window.__mechTester);
await p.screenshot({ path: 'screenshots/1-start-screen.png' });
const presets = await p.evaluate(() => { const r = window.__mechTester.listPresets(); return [...r.gram, ...r.samples].map(x => x.source + ': ' + x.name); });
console.log('presets:', presets);
const results = {};
for (const name of ['Test: drawer with 0.2 mm clearance', 'Test: drawer too wide (interference)']) {
  const r = await p.evaluate(async (name) => {
    const api = window.__mechTester; const l = api.listPresets(); const pr = [...l.gram, ...l.samples].find(x => x.name === name);
    await api.openPreset(pr); api.setT(0.3); const now = api.state.lastResult;
    await api.runSweep();
    return { collisions: now.collisions.length, near: now.nearMisses.map(n => +n.minGap.toFixed(3)), sweep: api.state.sweepResult };
  }, name);
  results[name] = r; console.log(name, JSON.stringify(r));
  await p.screenshot({ path: `screenshots/${name.includes('wide') ? '3-interference-red' : '2-clearance-yellow'}.png` });
}
const ok = results['Test: drawer with 0.2 mm clearance'].collisions === 0 && results['Test: drawer with 0.2 mm clearance'].sweep.status === 'near'
  && results['Test: drawer too wide (interference)'].collisions > 0 && results['Test: drawer too wide (interference)'].sweep.status === 'collision';
console.log(ok ? 'PASS' : 'FAIL'); await b.close(); process.exit(ok ? 0 : 1);
