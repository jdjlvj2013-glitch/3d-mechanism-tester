// Verifies Cancel aborts Gram's sweep worker on v3: worker.terminate() called, no progress afterwards.
import puppeteer from 'puppeteer-core';
const b = await puppeteer.launch({ executablePath: '/usr/bin/google-chrome', args: ['--no-sandbox','--use-gl=swiftshader','--enable-unsafe-swiftshader'], defaultViewport:{width:1440,height:860}});
const p = await b.newPage();
await p.evaluateOnNewDocument(() => {
  const W = window.Worker; window.__workers = [];
  window.Worker = class extends W { constructor(...a) { super(...a); const rec = { terminated: false, msgsAfterTerminate: 0 }; window.__workers.push(rec);
    this.addEventListener('message', () => { if (rec.terminated) rec.msgsAfterTerminate++; }); this.__rec = rec; }
    terminate() { this.__rec.terminated = true; super.terminate(); } };
});
await p.goto('http://localhost:4179/',{waitUntil:'networkidle0'});
const r = await p.evaluate(async()=>{const a=window.__mechTester;await a.openPreset(a.listPresets().gram[2]);a.runSweep();
  while ((a.state.sweepProgressCount||0) < 3) await new Promise(r=>setTimeout(r,50));
  document.querySelector('[data-k=cancel]').click(); const atCancel=a.state.sweepProgressCount;
  await new Promise(r=>setTimeout(r,6000));
  return {progressAtCancel:atCancel, progressAfter6s:a.state.sweepProgressCount, status:a.state.sweepResult?.status, text:document.querySelector('[data-s=sweep]').innerText, workers:window.__workers};});
console.log(JSON.stringify(r));
const ok = r.status==='cancelled' && r.progressAfter6s===r.progressAtCancel && r.workers.length===1 && r.workers[0].terminated && r.workers[0].msgsAfterTerminate===0 && r.text.includes('Check cancelled.');
console.log(ok?'PASS':'FAIL'); await b.close(); process.exit(ok?0:1);
