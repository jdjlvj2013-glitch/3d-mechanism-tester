// node tests-ui/gram-presets.mjs  (vite preview on :4179)
import puppeteer from 'puppeteer-core';
const b = await puppeteer.launch({ executablePath: '/usr/bin/google-chrome', protocolTimeout: 600000, args: ['--no-sandbox','--use-gl=swiftshader','--enable-unsafe-swiftshader'], defaultViewport:{width:1440,height:860}});
const p = await b.newPage(); p.on('pageerror',e=>console.log('ERR',e.message)); p.on('dialog',d=>{console.log('DIALOG',d.message());d.dismiss()});
await p.goto('http://localhost:4179/',{waitUntil:'networkidle0'});
const n = await p.evaluate(()=>window.__mechTester.listPresets().gram.length);
for (let i=0;i<n;i++) {
  const r = await p.evaluate(async(i)=>{const a=window.__mechTester;const pr=a.listPresets().gram[i];const t0=performance.now();await a.openPreset(pr);
    const at=(t)=>{a.setT(t);const r=a.state.lastResult;return {t,collisions:r.collisions.map(c=>c.a+'-'+c.b),near:r.nearMisses.map(c=>`${c.a}-${c.b}:${c.minGap.toFixed(2)}`),panel:document.querySelector('[data-s=now]').innerText}};
    const s0=at(0), s5=at(0.5); let frames=0, prog=0; const fr=()=>{frames++; if(a.state.sweepBusy) requestAnimationFrame(fr)}; a.runSweep(); requestAnimationFrame(fr);
    while(!a.state.sweepResult) { await new Promise(r=>setTimeout(r,200)); const v=document.querySelector('[data-s=sweep] progress')?.value; if(v>prog) prog=v; }
    return {name:pr.name,parts:a.state.parts.map(p=>p.id),s0,s5,sweep:a.state.sweepResult,sweepText:document.querySelector('[data-s=sweep]').innerText,ms:Math.round(performance.now()-t0),sweepMs:a.state.sweepResult.ms,framesDuringSweep:frames,sawProgress:prog};},i);
  console.log(JSON.stringify(r,null,1)); await p.screenshot({path:`/workspace/3d-test-app/screenshots/gram-${i+1}.png`});
}
await b.close();
