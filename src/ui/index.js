// UI entry: export mount(rootEl). Owned by the UI agent. Engine access only via ./engine.js.
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { ThreeMFLoader } from 'three/examples/jsm/loaders/3MFLoader.js';
import { checkPose, solveJoints, sweepAsync, classify, loadSTL, engineInfo, toXYZ, autoAssemble, stubAutoAssemble } from './engine.js';
import { listPresets } from './presets.js';
import './style.css';

const COLORS = ['#8fb3ff', '#ffb36b', '#9be38f', '#d79bff', '#6be0e0', '#ff8fc8', '#e0d36b'];
const PRINTERS = [[0.2, 'Fine / well-tuned printer (0.2 mm)'], [0.3, 'Typical printer (0.3 mm)'], [0.4, 'Loose / first prints (0.4 mm)']];
const HELP = `<b>How to use</b><ol style="padding-left:18px;margin:4px 0">
<li><b>Add parts</b>: drag STL/3MF files in, or click “Open files”. Sizes are in millimetres.</li>
<li><b>Mark what stays put</b>: tick “Fixed” for the frame/slot (e.g. the Skadis housing).</li>
<li><b>Add a motion</b>: pick the part that moves, choose “Slides” (drawer) or “Swings” (hinge), the direction, and how far.</li>
<li><b>Drag the Motion slider</b> or press ▶ to watch it move.</li>
<li><b>Red</b> = parts would crash into each other. <b>Yellow</b> = gap smaller than your printer can reliably make (may fuse or stick).</li>
<li><b>Blue</b> = expected contact the design intends (latch bump, spring, cam follower) — fine.</li>
<li>Press <b>“Check full motion”</b> to find the tightest spot over the whole movement.</li></ol>
<b>Known limit:</b> a part sitting completely inside another (no surfaces crossing) is not flagged yet — check that parts look right in the 3D view.`;

export function mount(root) {
  root.innerHTML = '';
  const S = { parts: [], joints: [], ignorePairs: [], expected: [], tolerance: 0.3, t: 0, playing: false, dir: 1, sweepResult: null, lastResult: null };
  const el = (h) => { const d = document.createElement('div'); d.innerHTML = h.trim(); return d.firstChild; };
  const app = el(`<div class="mt">
   <aside class="l">
     <div class="row"><b style="font-size:16px">Mechanism Tester</b></div>
     <div class="row"><button data-a="open">Open files</button><button class="sec" data-a="home">Samples</button><button data-a="auto" title="Guess how the parts fit together">Auto-assemble</button></div>
     <div data-s="auto"></div>
     <div class="row"><button class="sec" data-a="save">Save project</button><button class="sec" data-a="load">Load project</button></div>
     <input type="file" multiple hidden data-f="parts"><input type="file" accept=".json,application/json,*/*" hidden data-f="proj">
     <h2>Parts</h2><div data-s="parts"><div class="hint">No parts yet.</div></div>
     <h2>Motions (joints)</h2><div data-s="joints"></div><button data-a="addj">+ Add motion</button>
     <h2>Help</h2><div class="hint" data-s="help">${HELP}</div>
   </aside>
   <div class="view"><div class="bar">
     <button data-a="play" title="Play / pause">▶</button>
     <button class="sec" data-a="turnx" title="Turn the view 90° about X (display only)">Turn 90°</button><button class="sec small" data-a="turnz" title="Turn the view 90° about Z (display only)">⟳Z</button>
     <span>Motion</span><input type="range" min="0" max="1000" value="0" data-s="slider"><span data-s="tval" style="min-width:150px">0%</span></div>
   </div>
   <aside class="r">
     <h2>Printer gap (tolerance)</h2>
     <div class="row"><input type="number" step="0.05" min="0" value="0.3" data-s="tol"> mm</div>
     <div class="row"><select data-s="preset"><option value="">Printer presets…</option>${PRINTERS.map(([v, n]) => `<option value="${v}">${n}</option>`).join('')}</select></div>
     <div class="hint">Gaps smaller than this are flagged yellow.</div>
     <h2>Right now</h2><div data-s="now" class="hint">Add parts to start.</div>
     <h2>Whole motion</h2><button data-a="sweep">Check full motion</button><div data-s="sweep" class="hint"></div>
     <h2>Engine</h2><div class="hint" data-s="eng"></div>
   </aside></div>`);
  root.appendChild(app);
  const q = (s) => app.querySelector(s);
  const view = q('.view');
  q('[data-s=eng]').innerHTML = Object.entries(engineInfo).map(([k, v]) => `${k}: <span class="${v === 'engine' ? 'ok' : 'warn'}">${v === 'engine' ? "Gram's engine" : 'temporary stub'}</span>`).join('<br>');

  // ---------- 3D ----------
  const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
  renderer.setPixelRatio(window.devicePixelRatio);
  view.prepend(renderer.domElement);
  const scene = new THREE.Scene(); scene.background = new THREE.Color('#202428');
  const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 20000); camera.up.set(0, 0, 1); camera.position.set(150, -200, 150);
  const controls = new OrbitControls(camera, renderer.domElement);
  scene.add(new THREE.HemisphereLight(0xffffff, 0x444455, 1.6));
  const dl = new THREE.DirectionalLight(0xffffff, 1.4); dl.position.set(100, -150, 250); scene.add(dl);
  const grid = new THREE.GridHelper(400, 40, 0x556677, 0x333a40); grid.rotation.x = Math.PI / 2; scene.add(grid);
  scene.add(new THREE.AxesHelper(60));
  // display-only root: all part meshes + markers live here; rotating it never touches poses or collision checks; grid stays in scene
  const world = new THREE.Group(); world.name = 'viewRoot'; scene.add(world);
  const markers = new THREE.Group(); world.add(markers);
  function setView(v = {}) {
    S.view = { rx: ((Math.round(+v.rx || 0) % 4) + 4) % 4, rz: ((Math.round(+v.rz || 0) % 4) + 4) % 4 };
    world.rotation.set(0, 0, 0); world.rotateZ(S.view.rz * Math.PI / 2); world.rotateX(-S.view.rx * Math.PI / 2) /* -90° per press: face-up print layout (+Z back) -> standing, backplate at +Y rear */; world.position.set(0, 0, 0); world.updateMatrixWorld(true);
    if (S.view.rx || S.view.rz) { const bb = new THREE.Box3(); S.parts.forEach(p => p.mesh && bb.expandByObject(p.mesh)); if (!bb.isEmpty()) { world.position.z = -bb.min.z; world.updateMatrixWorld(true); } } // sit on the grid
    const bx = q('[data-a=turnx]'); if (bx) bx.textContent = `Turn 90° (X ${S.view.rx * 90}°)`;
    const bz = q('[data-a=turnz]'); if (bz) bz.textContent = `⟳Z ${S.view.rz * 90}°`;
    frame();
  }
  const resize = () => { const w = view.clientWidth, h = view.clientHeight; renderer.setSize(w, h); camera.aspect = w / h; camera.updateProjectionMatrix(); };
  new ResizeObserver(resize).observe(view); resize();
  let last = performance.now();
  renderer.setAnimationLoop((now) => {
    const dt = (now - last) / 1000; last = now;
    if (S.playing) { let t = S.t + S.dir * dt / 3; if (t >= 1) { t = 1; S.dir = -1; } if (t <= 0) { t = 0; S.dir = 1; } setT(t); }
    controls.update(); renderer.render(scene, camera);
  });
  function frame() {
    const box = new THREE.Box3(); S.parts.forEach(p => p.visible && box.expandByObject(p.mesh));
    if (box.isEmpty()) return;
    const c = box.getCenter(new THREE.Vector3()), r = box.getSize(new THREE.Vector3()).length() || 100;
    controls.target.copy(c); camera.position.copy(c).add(new THREE.Vector3(0.8, -1.2, 0.9).multiplyScalar(r)); camera.near = r / 1000; camera.far = r * 100; camera.updateProjectionMatrix();
  }

  // ---------- parts ----------
  let uid = 0;
  function addPart(name, geometry, opts = {}) {
    geometry.computeBoundingBox();
    const id = opts.id || name.replace(/\.\w+$/, '') + (S.parts.some(p => p.id === name.replace(/\.\w+$/, '')) ? '_' + (++uid) : '');
    const color = opts.color || COLORS[S.parts.length % COLORS.length];
    const mat = new THREE.MeshStandardMaterial({ color, metalness: 0.05, roughness: 0.7, transparent: true, opacity: 0.85 });
    const mesh = new THREE.Mesh(geometry, mat); mesh.matrixAutoUpdate = false; world.add(mesh);
    const p = { id, name: opts.name || name, file: opts.file || name, color, visible: true, fixed: opts.fixed ?? S.parts.length === 0, geometry, mesh };
    S.parts.push(p); return p;
  }
  async function loadFile(name, buf, opts = {}) {
    if (/\.3mf$/i.test(name)) {
      const group = new ThreeMFLoader().parse(buf); group.updateMatrixWorld(true);
      const out = []; let k = 0;
      group.traverse(o => { if (o.isMesh) { const g = o.geometry.clone().applyMatrix4(o.matrixWorld); g.computeVertexNormals(); let nm = ''; for (let q = o; q && q !== group && !nm; q = q.parent) nm = (q.name || '').trim(); const key = k++ ? `${name}#${k}` : name; out.push(addPart(key, g, { ...opts, file: name, name: opts.name || (nm && !/^(mesh|object|build|openscad_model)?[\s_]*\d*$/i.test(nm) ? nm : (() => { g.computeBoundingBox(); const z = g.boundingBox.getSize(new THREE.Vector3()); return `Part ${k} (${[z.x, z.y, z.z].map(v => Math.round(v)).join('×')} mm)`; })()) })); } });
      return out;
    }
    return [addPart(name, await loadSTL(buf), opts)];
  }
  async function addFiles(files) {
    for (const f of files) { try { await loadFile(f.name, await f.arrayBuffer()); } catch (e) { alert(`Couldn't read ${f.name}: ${e.message}`); } }
    hideStart(); renderAll(); frame();
  }
  function removePart(p) { world.remove(p.mesh); S.parts = S.parts.filter(x => x !== p); S.joints = S.joints.filter(j => j.part !== p.id); renderAll(); }

  function renderParts() {
    const box = q('[data-s=parts]'); box.innerHTML = S.parts.length ? '' : '<div class="hint">No parts yet. Drag STL/3MF files onto the window.</div>';
    for (const p of S.parts) {
      const sz = p.geometry.boundingBox.getSize(new THREE.Vector3());
      const c = el(`<div class="card"><div class="row"><input type="color" class="swatch" value="${p.color}"><input value="${p.name}" style="flex:1"><button class="sec" title="Remove">✕</button></div>
        <div class="row"><label><input type="checkbox" ${p.visible ? 'checked' : ''}> Show</label><label><input type="checkbox" ${p.fixed ? 'checked' : ''}> Fixed (doesn't move)</label></div>
        <div class="hint">${sz.x.toFixed(1)} × ${sz.y.toFixed(1)} × ${sz.z.toFixed(1)} mm · ${p.file}</div></div>`);
      const [col, nm, rm] = c.querySelectorAll('input[type=color],input:not([type]),button');
      const [vis, fix] = c.querySelectorAll('input[type=checkbox]');
      col.oninput = () => { p.color = col.value; p.mesh.material.color.set(p.color); update(); };
      nm.onchange = () => { p.name = nm.value; renderJoints(); update(); };
      rm.onclick = () => removePart(p);
      vis.onchange = () => { p.visible = vis.checked; p.mesh.visible = p.visible; update(); };
      fix.onchange = () => { p.fixed = fix.checked; if (p.fixed) S.joints = S.joints.filter(j => j.part !== p.id || j.type === 'fixed'); renderJoints(); update(); };
      box.appendChild(c);
    }
  }

  // ---------- joints (Gram's format: {id, part, type:'slider'|'hinge'|'fixed', axis, origin, range}) ----------
  const AX = { X: [1, 0, 0], Y: [0, 1, 0], Z: [0, 0, 1], '-X': [-1, 0, 0], '-Y': [0, -1, 0], '-Z': [0, 0, -1] };
  const axName = (a) => Object.keys(AX).find(k => AX[k].every((v, i) => Math.abs(v - (a?.[i] ?? 0)) < 1e-9)) || 'custom';
  function renderJoints() {
    const box = q('[data-s=joints]'); box.innerHTML = S.joints.length ? '' : '<div class="hint">Nothing moves yet. Add a motion for the drawer or lever.</div>';
    S.joints.forEach((j, idx) => {
      const unit = j.type === 'hinge' ? '°' : 'mm';
      const c = el(`<div class="card">
        <div class="row">Part <select data-k="part">${S.parts.map(p => `<option value="${p.id}" ${p.id === j.part ? 'selected' : ''}>${p.name}</option>`).join('')}</select><button class="sec" data-k="rm">✕</button></div>
        <div class="row">Type <select data-k="type"><option value="slider">Slides (like a drawer)</option><option value="hinge">Swings (like a hinge)</option><option value="fixed">Doesn't move</option>${j.type === 'path' ? '<option value="path">Follows a path (slide + tilt)</option>' : ''}</select></div>
        ${j.type === 'path' ? '<div class="hint">Slides out, then tilts. The path was worked out by Auto-assemble.</div>' : j.type === 'fixed' ? (j.offset ? '<div class="hint">Placement offset from preset.</div>' : '') : `<div class="row">${j.type === 'hinge' ? 'Turns around' : 'Direction'} <select data-k="ax">${Object.keys(AX).map(k => `<option>${k}</option>`).join('')}<option>custom</option></select>
          <span data-k="cust">${[0, 1, 2].map(i => `<input type="number" step="0.1" data-ax="${i}" value="${j.axis[i]}">`).join('')}</span></div>
        ${j.type === 'hinge' ? `<div class="row">Hinge pin at (mm) ${[0, 1, 2].map(i => `<input type="number" step="0.5" data-o="${i}" value="${(j.origin || [0, 0, 0])[i]}">`).join('')}</div>` : ''}
        <div class="row">From <input type="number" data-r="0" value="${j.range[0]}"> to <input type="number" data-r="1" value="${j.range[1]}"> ${unit}</div>`}
        ${j.keyframes ? '<div class="hint">Uses keyframes from preset.</div>' : ''}</div>`);
      const g = (k) => c.querySelector(`[data-k=${k}]`);
      g('part').onchange = (e) => { j.part = e.target.value; update(); };
      g('rm').onclick = () => { S.joints.splice(idx, 1); renderJoints(); update(); };
      g('type').value = j.type; g('type').onchange = (e) => { j.type = e.target.value; j.range = j.type === 'hinge' ? [0, 90] : j.type === 'slider' ? [0, 50] : [0, 0]; j.origin ||= [0, 0, 0]; renderJoints(); update(); };
      if (g('ax')) {
        const nm = axName(j.axis); g('ax').value = nm; g('cust').style.display = nm === 'custom' ? '' : 'none';
        g('ax').onchange = (e) => { if (AX[e.target.value]) j.axis = [...AX[e.target.value]]; renderJoints(); update(); };
        c.querySelectorAll('[data-ax]').forEach(i => i.onchange = () => { j.axis[+i.dataset.ax] = +i.value; update(); });
        c.querySelectorAll('[data-o]').forEach(i => i.onchange = () => { j.origin[+i.dataset.o] = +i.value; update(); });
        c.querySelectorAll('[data-r]').forEach(i => i.onchange = () => { j.range[+i.dataset.r] = +i.value; delete j.keyframes; update(); });
      }
      box.appendChild(c);
    });
  }
  function addJoint() {
    const mover = S.parts.find(p => !p.fixed) || S.parts[1] || S.parts[0];
    if (!mover) return alert('Add some parts first.');
    S.joints.push({ id: 'j' + Date.now(), part: mover.id, type: 'slider', axis: [0, -1, 0], origin: [0, 0, 0], range: [0, 50] });
    mover.fixed = false; renderAll();
  }

  // ---------- evaluation ----------
  const pairName = (a, b) => `${S.parts.find(p => p.id === a)?.name || a} ↔ ${S.parts.find(p => p.id === b)?.name || b}`;
  const activeParts = () => S.parts.filter(p => p.visible).map(p => ({ id: p.id, geometry: p.geometry }));
  const engineJoints = () => S.joints.filter(j => j.type === 'fixed' || S.parts.some(p => p.id === j.part && !p.fixed));
  const movingJoints = () => engineJoints().filter(j => j.type !== 'fixed');
  // expected contact = matches a preset 'expected' entry (pair + all points inside its box)
  const isExpected = (c) => !!c.expected;
  const reasonOf = (c) => (typeof c.expected === 'string' && c.expected) || 'designed contact';
  function jv(j, t) {
    const k = j.keyframes; if (!k?.length || typeof k[0].value !== 'number') return j.range[0] + (j.range[1] - j.range[0]) * t;
    if (t <= k[0].t) return k[0].value; for (let i = 1; i < k.length; i++) if (t <= k[i].t) { const s = (t - k[i - 1].t) / (k[i].t - k[i - 1].t || 1); return k[i - 1].value + (k[i].value - k[i - 1].value) * s; }
    return k[k.length - 1].value;
  }
  function motionLabel(t) {
    const js = movingJoints(); if (!js.length) return `${Math.round(t * 100)}%`;
    return `${Math.round(t * 100)}% · ` + js.map(j => j.type === 'fixed' || j.type === 'path' ? '' : `${jv(j, t).toFixed(1)}${j.type === 'hinge' ? '°' : ' mm'}`).filter(Boolean).join(', ');
  }
  function setT(t) { S.t = t; q('[data-s=slider]').value = Math.round(t * 1000); update(); }
  const markerGeo = new THREE.SphereGeometry(1, 12, 8);
  function update() {
    q('[data-s=tval]').textContent = motionLabel(S.t);
    let poses = {};
    try { poses = solveJoints(engineJoints(), S.t) || {}; } catch (e) { console.warn(e); }
    const I = new THREE.Matrix4();
    for (const p of S.parts) { const m = poses[p.id]; p.mesh.matrix.copy(m ? (m.isMatrix4 ? m : new THREE.Matrix4().fromArray(m)) : I); p.mesh.matrixWorldNeedsUpdate = true; p.mesh.material.emissive.set(0x000000); }
    markers.clear();
    const now = q('[data-s=now]');
    if (S.parts.length < 2) { now.innerHTML = 'Add at least two parts to check how they fit.'; S.lastResult = null; return; }
    let r;
    try { r = classify(checkPose(activeParts(), poses, { tolerance: S.tolerance, ignorePairs: S.ignorePairs }), S.expected); } catch (e) { now.innerHTML = `<span class="bad">Engine error: ${e.message}</span>`; return; }
    S.lastResult = r;
    const size = Math.max(0.6, (new THREE.Box3().setFromObject(scene).getSize(new THREE.Vector3()).length() || 100) / 250);
    const mark = (list, color) => list.forEach(c => {
      for (const id of [c.a, c.b]) { const p = S.parts.find(x => x.id === id); if (p && p.mesh.material.emissive.getHex() !== 0xaa0000) p.mesh.material.emissive.set(color === 0xff3030 ? 0xaa0000 : color === 0x4aa3ff ? 0x002a66 : 0x806000); }
      (c.points || []).slice(0, 40).forEach(pt => { const m = new THREE.Mesh(markerGeo, new THREE.MeshBasicMaterial({ color, depthTest: false })); m.renderOrder = 9; m.scale.setScalar(size); m.position.set(...toXYZ(pt)); markers.add(m); });
    });
    const expC = [...r.collisions, ...r.nearMisses].filter(isExpected);
    const col = r.collisions.filter(c => !isExpected(c)), near = r.nearMisses.filter(c => !isExpected(c));
    mark(expC, 0x4aa3ff); mark(near, 0xffd23f); mark(col, 0xff3030);
    const lines = [
      ...col.map(c => `<div class="bad">✖ ${pairName(c.a, c.b)}: <b>crash / overlap</b></div>`),
      ...near.map(c => `<div class="warn">⚠ ${pairName(c.a, c.b)}: gap ${c.minGap.toFixed(2)} mm (below ${S.tolerance} mm)</div>`),
    ];
    expC.forEach(c => lines.push(`<div style="color:#6fb6ff">● ${pairName(c.a, c.b)}: expected contact — ${reasonOf(c)}</div>`));
    S.ignorePairs.forEach(([a, b]) => lines.push(`<div class="hint">○ ${pairName(a, b)}: not checked (touch by design)</div>`));
    const flagged = new Set([...r.collisions, ...r.nearMisses].map(c => c.a + '|' + c.b));
    (r.pairs || []).filter(p => !flagged.has(p.a + '|' + p.b)).forEach(p => lines.push(`<div class="ok">✔ ${pairName(p.a, p.b)}: gap ${isFinite(p.minGap) ? p.minGap.toFixed(2) : '—'} mm</div>`));
    if (!col.length && !near.length) lines.unshift(`<div class="ok"><b>All clear</b> at this position (every gap ≥ ${S.tolerance} mm).</div>`);
    now.innerHTML = lines.join('');
  }
  let sweepRun = 0;
  async function runSweep() {
    const out = q('[data-s=sweep]');
    if (S.parts.length < 2) { out.textContent = 'Add at least two parts.'; return; }
    if (!movingJoints().length) { out.textContent = 'Add a motion first, then check.'; return; }
    S.sweepAbort?.abort(); const run = ++sweepRun; S.sweepResult = null; S.sweepBusy = true; S.sweepProgressCount = 0;
    const ac = new AbortController(); S.sweepAbort = ac;
    out.innerHTML = `<div class="row"><progress max="1" value="0" style="flex:1"></progress><button class="sec" data-k="cancel">Cancel</button></div><div class="hint" data-k="pt">Starting…</div>`;
    const bar = out.querySelector('progress'), pt = out.querySelector('[data-k=pt]');
    out.querySelector('[data-k=cancel]').onclick = () => ac.abort();
    const t0 = performance.now(); let res;
    try {
      res = await sweepAsync(activeParts(), engineJoints(), { steps: 40, tolerance: S.tolerance, ignorePairs: S.ignorePairs, signal: ac.signal },
        (done, total) => { S.sweepProgressCount++; if (run === sweepRun) { bar.value = done / total; pt.textContent = `Checked ${done} of ${total} positions…`; } });
    } catch (e) {
      if (run !== sweepRun) return;
      S.sweepBusy = false;
      if (e?.name === 'AbortError') { S.sweepResult = { status: 'cancelled' }; out.innerHTML = '<div class="hint">Check cancelled.</div>'; }
      else out.innerHTML = `<span class="bad">Engine error: ${e.message}</span>`;
      return;
    }
    if (run !== sweepRun) return; // cancelled
    S.sweepBusy = false;
    res = res.map(s => { const c = classify(s, S.expected); return { ...c, expectedHits: [...c.collisions, ...c.nearMisses].filter(isExpected), collisions: c.collisions.filter(h => !isExpected(h)), nearMisses: c.nearMisses.filter(h => !isExpected(h)) }; });
    let worst = null;
    for (const s of res) for (const n of s.nearMisses) if (!worst || n.minGap < worst.gap) worst = { gap: n.minGap, t: s.t, a: n.a, b: n.b };
    const crash = res.filter(s => s.collisions.length); let html = '';
    if (crash.length) {
      const ranges = []; let st = null, prev = null;
      for (const s of res) { const c = s.collisions.length > 0; if (c && st == null) st = s.t; if (!c && st != null) { ranges.push([st, prev]); st = null; } prev = s.t; }
      if (st != null) ranges.push([st, prev]);
      const c0 = crash[0];
      html += `<div class="bad"><b>✖ Parts crash</b> (${pairName(c0.collisions[0].a, c0.collisions[0].b)})<br>${ranges.map(([a, b]) => `from ${motionLabel(a)} to ${motionLabel(b)}`).join('<br>')}</div><button class="sec" data-t="${c0.t}">Show first crash</button>`;
      S.sweepResult = { status: 'collision', t: c0.t, ranges };
    } else if (worst) {
      html += `<div class="warn"><b>⚠ Tight spot:</b> ${pairName(worst.a, worst.b)} gap ${worst.gap.toFixed(2)} mm at ${motionLabel(worst.t)}</div><button class="sec" data-t="${worst.t}">Show tightest spot</button>`;
      S.sweepResult = { status: 'near', t: worst.t, gap: worst.gap, pair: [worst.a, worst.b] };
    } else { html += `<div class="ok"><b>✔ Moves freely</b> through the whole range with ≥ ${S.tolerance} mm gap.</div>`; S.sweepResult = { status: 'ok' }; }
    const ex = res.filter(s => s.expectedHits.length);
    if (ex.length) html += `<div style="color:#6fb6ff">● Expected contacts seen at ${ex.length} positions (${[...new Set(ex.flatMap(s => s.expectedHits.map(reasonOf)))].join('; ')})</div>`;
    const ms = Math.round(performance.now() - t0); S.sweepResult.ms = ms;
    html += `<div class="hint">${res.length} positions checked in ${(ms / 1000).toFixed(1)} s.</div>`;
    out.innerHTML = html; out.querySelectorAll('[data-t]').forEach(b => b.onclick = () => { S.playing = false; q('[data-a=play]').textContent = '▶'; setT(+b.dataset.t); });
  }
  // ---------- auto-assemble (review: each guess applied as a fixed-offset pose joint or a motion joint) ----------
  const lvl = (c) => (c >= 0.75 ? 'high' : c >= 0.4 ? 'medium' : 'low');
  const esc = (t) => String(t).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  let autoRun = 0;
  function autoRebuild() {
    const A = S.auto; if (!A) return;
    const live = A.items.filter(i => i.status !== 'undone'), mine = new Set(A.items.map(i => i.joint));
    const posed = new Set(live.filter(i => i.kind === 'pose').map(i => i.part));
    const extra = S.joints.filter(j => !A.snapshot.includes(j) && !mine.has(j));
    S.joints = [...A.snapshot.filter(j => !(posed.has(j.part) && j.type === 'fixed')), ...live.map(i => i.joint), ...extra];
    for (const p of S.parts) p.fixed = A.fixed[p.id] ?? p.fixed;
    live.filter(i => i.kind === 'joint' && i.joint.type !== 'fixed').forEach(i => { const p = S.parts.find(x => x.id === i.part); if (p) p.fixed = false; });
    renderAll(); renderAuto();
  }
  function renderAuto() {
    const box = q('[data-s=auto]'), A = S.auto;
    if (!A) { box.innerHTML = ''; return; }
    const pn = (id) => esc(S.parts.find(p => p.id === id)?.name || id);
    box.innerHTML = `<div class="card auto"><div class="row"><b style="flex:1">Auto-assemble guesses</b><span class="badge">${A.source === 'engine' ? "Gram's engine" : 'stub'}</span></div>
      ${S.autoResult?.mode ? `<div class="hint">${S.autoResult.mode === 'in-place' ? 'Parts were already in place; motions guessed.' : 'Parts placed by fit search.'} ${(S.autoResult.ms / 1000).toFixed(1)} s</div>` : ''}
      ${A.items.length ? '' : '<div class="hint">No guesses returned.</div>'}
      ${A.items.map((it, k) => `<div class="auto-item ${it.status}" data-i="${k}"><div class="row"><b>${pn(it.part)}</b><span class="hint">${it.kind === 'pose' ? 'position' : esc(it.joint.type)}</span>
        <span class="conf ${lvl(it.confidence)}" title="${Math.round(it.confidence * 100)}%">${lvl(it.confidence)}</span></div>
        <div class="hint">${esc(it.reason)}</div>
        <div class="row">${it.status === 'undone' ? '<span class="hint">Undone</span><button class="sec" data-k="redo">Re-apply</button>'
          : it.status === 'accepted' ? '<span class="ok">✔ Accepted</span><button class="sec" data-k="undo">Undo</button>'
          : '<button data-k="acc">Accept</button><button class="sec" data-k="undo">Undo</button>'}</div></div>`).join('')}
      <div class="row"><button data-k="accall">Accept all</button><button class="sec" data-k="undoall">Undo all</button></div></div>`;
    box.querySelectorAll('.auto-item').forEach(d => { const it = A.items[+d.dataset.i];
      d.querySelectorAll('[data-k]').forEach(b => b.onclick = () => { it.status = b.dataset.k === 'acc' ? 'accepted' : b.dataset.k === 'undo' ? 'undone' : 'pending'; autoRebuild(); }); });
    box.querySelector('[data-k=accall]').onclick = () => { A.items.forEach(i => i.status !== 'undone' && (i.status = 'accepted')); S.auto = null; renderAuto(); };
    box.querySelector('[data-k=undoall]').onclick = () => { A.items.forEach(i => (i.status = 'undone')); autoRebuild(); S.joints = [...A.snapshot]; S.parts.forEach(p => { if (A.namesBefore?.[p.id] != null) p.name = A.namesBefore[p.id]; if (A.fixed && p.id in A.fixed) p.fixed = A.fixed[p.id]; }); if (S.auto?.expBefore) S.expected = S.auto.expBefore; S.auto = null; renderAll(); renderAuto(); };
  }
  async function runAuto(impl) {
    if (!S.parts.length) return alert('Add some parts first.');
    if (S.auto) S.auto.items.forEach(i => i.status === 'pending' && (i.status = 'accepted'));
    const run = ++autoRun, btn = q('[data-a=auto]'), box = q('[data-s=auto]');
    btn.disabled = true; S.autoBusy = true; S.autoProgress = [];
    const ac = new AbortController(); S.autoAbort = ac; const t0 = performance.now();
    box.innerHTML = '<div class="card"><div class="row"><span class="spin"></span><span data-k="ap" style="flex:1">Working out how the parts fit…</span><button class="sec" data-k="acancel">Cancel</button></div><progress max="1" value="0" style="width:100%"></progress></div>';
    box.querySelector('[data-k=acancel]').onclick = () => ac.abort();
    let res;
    try {
      const parts = S.parts.map(p => ({ id: p.id, name: p.name, geometry: p.geometry }));
      const poses = Object.fromEntries(S.parts.map(p => [p.id, p.mesh.matrix.toArray()]));
      res = await autoAssemble(parts, { poses, clearance: S.tolerance, signal: ac.signal, onProgress: (d, t, msg) => {
        if (run !== autoRun) return; S.autoProgress.push([d, t, Math.round(performance.now() - t0)]);
        const e = box.querySelector('[data-k=ap]'), pg = box.querySelector('progress');
        if (e) e.textContent = `Working out how the parts fit… ${d}/${t}${msg ? ' · ' + msg : ''}`; if (pg) pg.value = t ? d / t : 0; } }, ...(impl ? [impl] : []));
    } catch (e) {
      if (run === autoRun) box.innerHTML = e?.name === 'AbortError' ? '<div class="hint">Auto-assemble cancelled. Nothing was changed.</div>' : `<div class="bad">Auto-assemble failed: ${esc(e?.message || (e?.type ? `worker ${e.type}${e.filename ? " in " + e.filename : ""} (the engine worker crashed — try again)` : String(e)))}</div>`;
      S.autoResult = { status: e?.name === 'AbortError' ? 'cancelled' : 'error', ms: Math.round(performance.now() - t0) }; return;
    } finally { btn.disabled = false; S.autoBusy = false; }
    if (run !== autoRun) return;
    S.autoResult = { status: 'ok', ms: Math.round(performance.now() - t0), mode: res.mode };
    const namesBefore = Object.fromEntries(S.parts.map(p => [p.id, p.name]));
    { const seen = {}; const roleOf = new Map(res.poses.filter(p => p.role).map(p => [p.id, p.role]));
      for (const pt of S.parts) { const r = roleOf.get(pt.id); if (!r || !/^Part \d+ \(|#\d+$|\.3mf$/i.test(pt.name)) continue;
        const nm = r[0].toUpperCase() + r.slice(1); seen[nm] = (seen[nm] || 0) + 1; pt.name = seen[nm] > 1 ? `${nm} ${seen[nm]}` : nm; }
      if (Object.keys(seen).length) renderAll(); }
    // engine gives each part a fixed joint with offset (= its pose, maybe relative to a parent); use it as the pose item
    const placeJ = new Map(res.joints.filter(j => j.type === 'fixed' && j.offset).map(j => [j.part, j]));
    const strip = (j) => (({ confidence, reason, ...r }) => ({ ...r, auto: true }))(j);
    const items = [
      ...res.poses.map(p => { const pj = placeJ.get(p.id);
        return { kind: 'pose', part: p.id, confidence: p.confidence, reason: (pj?.parent && pj.reason) || p.reason, status: 'pending',
          joint: pj ? { axis: [1, 0, 0], origin: [0, 0, 0], range: [0, 0], ...strip(pj) } : { id: 'autopose_' + p.id, type: 'fixed', part: p.id, offset: p.matrix.toArray(), axis: [1, 0, 0], origin: [0, 0, 0], range: [0, 0], auto: true } }; }),
      ...res.joints.filter(j => !(j.type === 'fixed' && j.offset && res.poses.some(p => p.id === j.part))).map(j => ({ kind: 'joint', part: j.part, confidence: j.confidence, reason: j.reason, status: 'pending', joint: strip(j) })),
    ];
    const expBefore = [...S.expected]; if (res.expected?.length) S.expected = [...S.expected, ...res.expected];
    S.auto = { source: res.source, expBefore, snapshot: [...S.joints], namesBefore, fixed: Object.fromEntries(S.parts.map(p => [p.id, p.fixed])), items };
    S.lastAuto = res; autoRebuild(); frame();
  }
  function renderAll() { renderParts(); renderJoints(); S.sweepAbort?.abort(); sweepRun++; S.sweepResult = null; q('[data-s=sweep]').innerHTML = ''; update(); }

  // ---------- project save/load ----------
  function saveProject() {
    const data = { app: '3d-mechanism-tester', version: 1, settings: { tolerance: S.tolerance, t: S.t, view: S.view },
      parts: S.parts.map(({ id, name, file, color, visible, fixed }) => ({ id, name, file, color, visible, fixed })), joints: S.joints, ignorePairs: S.ignorePairs, expected: S.expected };
    const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' })); a.download = 'mechanism-project.json'; a.click();
  }
  function applyProject(d) {
    S.ignorePairs = d.ignorePairs || []; S.expected = d.expected || [];
    S.joints = (d.joints || []).map(j => ({ origin: [0, 0, 0], axis: [1, 0, 0], range: [0, 0], ...j }));
    if (d.settings?.tolerance != null) setTol(d.settings.tolerance);
    if (d.settings?.view) setView(d.settings.view);
    const used = new Set();
    for (const sp of d.parts || []) { const p = S.parts.find(x => x.id === sp.id && !used.has(x)) || S.parts.find(x => x.file === sp.file && !used.has(x)); if (!p) continue; used.add(p);
      Object.assign(p, { id: sp.id || p.id, name: sp.name || p.name, fixed: !!sp.fixed, visible: sp.visible !== false });
      if (sp.color) { p.color = sp.color; p.mesh.material.color.set(sp.color); } p.mesh.visible = p.visible; }
    renderAll(); setT(d.settings?.t || 0);
  }
  async function loadProjectFile(file) {
    const d = JSON.parse(await file.text());
    const missing = (d.parts || []).filter(sp => !S.parts.some(p => p.file === sp.file || p.id === sp.id));
    if (missing.length) alert(`This project uses these part files:\n${missing.map(m => m.file).join('\n')}\n\nOpen them (Open files) and load the project again to restore their settings.`);
    applyProject(d);
  }
  async function openPreset(pr) {
    S.parts.forEach(p => world.remove(p.mesh)); S.parts = []; S.joints = []; S.ignorePairs = []; S.expected = [];
    const fails = [];
    for (const sp of pr.parts) {
      try { const r = await fetch(sp.url); if (!r.ok) throw new Error(r.status); await loadFile(sp.file || sp.url, await r.arrayBuffer(), { id: sp.id, name: sp.name, color: sp.color, fixed: sp.fixed }); }
      catch (e) { fails.push(`${sp.file} (${e.message})`); }
    }
    hideStart(); applyProject({ joints: pr.joints, settings: pr.settings, ignorePairs: pr.ignorePairs, expected: pr.expected, parts: pr.parts.map(p => ({ ...p, color: p.color })) }); frame();
    if (fails.length) alert('Some part files could not be loaded:\n' + fails.join('\n'));
  }

  // ---------- tolerance ----------
  function setTol(v) { S.tolerance = Math.max(0, +v || 0); q('[data-s=tol]').value = S.tolerance; update(); }
  q('[data-s=tol]').onchange = (e) => setTol(e.target.value);
  q('[data-s=preset]').onchange = (e) => { if (e.target.value) setTol(e.target.value); e.target.value = ''; };

  // ---------- start screen ----------
  const start = el(`<div class="start"><div class="box"><h1 style="margin:0 0 4px">Test your 3D-print mechanism</h1>
    <div class="hint">Check drawers, hinges and levers fit and move before you print. No CAD needed.</div>
    <div class="drop">Drop STL or 3MF files here<br><button data-a="open2">…or choose files</button></div>
    <h2 style="text-align:left">Samples — open one and press ▶</h2><div class="presets" data-s="presets"></div>
    <button class="sec" data-a="close">Start empty</button></div></div>`);
  view.appendChild(start);
  function hideStart() { start.style.display = 'none'; }
  function showStart() {
    const { gram, samples } = listPresets(); const box = start.querySelector('[data-s=presets]'); box.innerHTML = '';
    const all = [...gram, ...samples];
    if (!gram.length) box.appendChild(el(`<div class="hint">No ready-made drawer presets found yet (src/engine/presets/ is empty). Load your own files above.</div>`));
    all.forEach(pr => { const c = el(`<div class="card"><b>${pr.name}</b><span class="badge">${pr.source}</span><span class="badge">${pr.parts.length} parts</span><div class="hint">${pr.description}</div></div>`); c.onclick = () => openPreset(pr); box.appendChild(c); });
    start.style.display = '';
  }
  showStart();

  // ---------- wiring ----------
  const fParts = q('[data-f=parts]'), fProj = q('[data-f=proj]');
  fParts.onchange = () => { const fs = [...fParts.files].filter(f => /\.(stl|3mf)$/i.test(f.name)); if (fs.length) addFiles(fs); else if (fParts.files.length) alert('Please pick .stl or .3mf files.'); fParts.value = ''; };
  fProj.onchange = () => { if (fProj.files[0]) loadProjectFile(fProj.files[0]); fProj.value = ''; };
  const actions = { open: () => fParts.click(), open2: () => fParts.click(), home: showStart, close: hideStart, save: saveProject, load: () => fProj.click(), addj: addJoint, sweep: runSweep, auto: () => runAuto(),
    turnx: () => setView({ ...S.view, rx: S.view.rx + 1 }), turnz: () => setView({ ...S.view, rz: S.view.rz + 1 }),
    play: () => { S.playing = !S.playing; q('[data-a=play]').textContent = S.playing ? '⏸' : '▶'; } };
  app.addEventListener('click', (e) => { const a = e.target.closest('[data-a]')?.dataset.a; if (a && actions[a]) actions[a](); });
  q('[data-s=slider]').oninput = (e) => { S.t = e.target.value / 1000; update(); };
  const drop = start.querySelector('.drop');
  app.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('over'); });
  app.addEventListener('dragleave', () => drop.classList.remove('over'));
  app.addEventListener('drop', (e) => { e.preventDefault(); drop.classList.remove('over'); const fs = [...e.dataTransfer.files].filter(f => /\.(stl|3mf)$/i.test(f.name)); if (fs.length) addFiles(fs); else if (e.dataTransfer.files[0]?.name.endsWith('.json')) loadProjectFile(e.dataTransfer.files[0]); });

  setView({});
  // test hook (used by headless tests)
  const api = { state: S, async addBuffer(name, buf) { await loadFile(name, buf); hideStart(); renderAll(); frame(); }, applyProject, setT, setTol, runSweep, listPresets, openPreset, frame, update, runAuto, stubAutoAssemble, setView, world, poses: () => Object.fromEntries(S.parts.map(p => [p.id, p.mesh.matrix.toArray()])) };
  window.__mechTester = api;
  return api;
}
export default mount;
