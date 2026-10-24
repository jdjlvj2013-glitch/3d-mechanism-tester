// autoAssemble: heuristic part placement + joint inference. Units mm. See README "autoAssemble".
import * as THREE from 'three';
import { MeshBVH } from 'three-mesh-bvh';
import { checkPose } from './core.js';

const V = (x = 0, y = 0, z = 0) => new THREE.Vector3(x, y, z);
const toMat = (m) => (m instanceof THREE.Matrix4 ? m.clone() : m ? new THREE.Matrix4().fromArray(m) : new THREE.Matrix4());
export const abortErr = () => (typeof DOMException !== 'undefined' ? new DOMException('autoAssemble aborted', 'AbortError') : Object.assign(new Error('autoAssemble aborted'), { name: 'AbortError' }));
const AX = ['X', 'Y', 'Z'];
const dirName = (d) => (d.s < 0 ? '−' : '+') + AX[d.a];
const pretty = (id) => id.charAt(0).toUpperCase() + id.slice(1).replace(/_/g, ' ');

/** The 24 proper axis-aligned rotations. */
export const ROTATIONS_24 = (() => {
  const out = [], perms = [[0, 1, 2], [0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0]];
  for (const p of perms) for (let s = 0; s < 8; s++) {
    const sg = [s & 1 ? -1 : 1, s & 2 ? -1 : 1, s & 4 ? -1 : 1], e = new Array(9).fill(0);
    for (let r = 0; r < 3; r++) e[r * 3 + p[r]] = sg[r];
    const m = new THREE.Matrix3().set(...e);
    if (m.determinant() > 0) out.push(new THREE.Matrix4().setFromMatrix3(m));
  }
  return out;
})();

// ---------- per-part solid voxel grid (raycast parity along Z) ----------
function buildGrid(g) {
  const bvh = g.boundsTree || (g.boundsTree = new MeshBVH(g));
  const bb = bvh.getBoundingBox(new THREE.Box3()), size = bb.getSize(V());
  const r = Math.max(0.4, Math.max(size.x, size.y, size.z) / 128);
  const o = bb.min.clone().subScalar(r);
  const nx = Math.ceil(size.x / r) + 3, ny = Math.ceil(size.y / r) + 3, nz = Math.ceil(size.z / r) + 3;
  const occ = new Uint8Array(nx * ny * nz), ray = new THREE.Ray(V(), V(0, 0, 1));
  for (let ix = 0; ix < nx; ix++) for (let iy = 0; iy < ny; iy++) {
    ray.origin.set(o.x + (ix + 0.5) * r + 1.3e-4, o.y + (iy + 0.5) * r + 1.7e-4, o.z - 1);
    const hits = bvh.raycast(ray, THREE.DoubleSide).map((h) => h.point.z).sort((a, b) => a - b);
    const zs = []; for (const z of hits) if (!zs.length || z - zs[zs.length - 1] > 1e-5) zs.push(z);
    for (let k = 0; k + 1 < zs.length; k += 2) {
      const a = Math.max(0, Math.ceil((zs[k] - o.z) / r - 0.5)), b = Math.min(nz - 1, Math.floor((zs[k + 1] - o.z) / r - 0.5));
      for (let iz = a; iz <= b; iz++) occ[ix + nx * (iy + ny * iz)] = 1;
    }
  }
  const G = { r, o, nx, ny, nz, occ, bb };
  const at = (x, y, z) => x >= 0 && y >= 0 && z >= 0 && x < nx && y < ny && z < nz && occ[x + nx * (y + ny * z)];
  // core = eroded solid (falls back to solid for thin parts); near = solid dilated by ~1 mm
  const core = new Uint8Array(occ.length), surf = [], corePts = [];
  let nOcc = 0, nCore = 0;
  for (let z = 0; z < nz; z++) for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++) {
    const i = x + nx * (y + ny * z); if (!occ[i]) continue; nOcc++;
    const inner = at(x + 1, y, z) && at(x - 1, y, z) && at(x, y + 1, z) && at(x, y - 1, z) && at(x, y, z + 1) && at(x, y, z - 1);
    if (inner) { core[i] = 1; nCore++; } else surf.push([x, y, z]);
  }
  const useCore = nCore > 0.3 * nOcc;
  G.core = useCore ? core : occ;
  for (let z = 0; z < nz; z++) for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++) if (G.core[x + nx * (y + ny * z)]) corePts.push([x, y, z]);
  const k = Math.max(1, Math.ceil(1.0 / r)); let near = occ.slice();
  for (let ax = 0; ax < 3; ax++) {
    const nn = near.slice(), st = [1, nx, nx * ny][ax], dim = [nx, ny, nz][ax];
    for (let z = 0; z < nz; z++) for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++) {
      const i = x + nx * (y + ny * z); if (!near[i]) continue; const c = [x, y, z][ax];
      for (let d = -k; d <= k; d++) { const cc = c + d; if (cc >= 0 && cc < dim) nn[i + d * st] = 1; }
    }
    near = nn;
  }
  G.near = near;
  const toP = (a) => { const step = Math.max(1, Math.floor(a.length / 2500)); const out = new Float32Array(Math.ceil(a.length / step) * 3); let j = 0;
    for (let i = 0; i < a.length; i += step) { out[j++] = o.x + (a[i][0] + 0.5) * r; out[j++] = o.y + (a[i][1] + 0.5) * r; out[j++] = o.z + (a[i][2] + 0.5) * r; } return out.subarray(0, j); };
  G.corePts = toP(corePts); G.surfPts = toP(surf); G.volume = nOcc * r ** 3;
  G.lookup = (arr, p) => { const x = Math.floor((p.x - o.x) / r), y = Math.floor((p.y - o.y) / r), z = Math.floor((p.z - o.z) / r);
    return x >= 0 && y >= 0 && z >= 0 && x < nx && y < ny && z < nz && arr[x + nx * (y + ny * z)]; };
  G.cavities = findCavities(G);
  return G;
}

// Empty voxels enclosed on >=5 sides (pocket) or 4 sides with an opposite open pair (tunnel/slot) -> components.
function findCavities(G) {
  const { nx, ny, nz, occ } = G, n = occ.length, st = [1, nx, nx * ny], dims = [nx, ny, nz];
  const blk = new Uint8Array(n); // bit 2a = blocked in -a, bit 2a+1 = blocked in +a
  for (let a = 0; a < 3; a++) {
    const [b, c] = [0, 1, 2].filter((q) => q !== a);
    for (let ib = 0; ib < dims[b]; ib++) for (let ic = 0; ic < dims[c]; ic++) {
      const base = ib * st[b] + ic * st[c]; let seen = false;
      for (let ia = 0; ia < dims[a]; ia++) { const i = base + ia * st[a]; if (occ[i]) seen = true; else if (seen) blk[i] |= 1 << (2 * a); }
      seen = false;
      for (let ia = dims[a] - 1; ia >= 0; ia--) { const i = base + ia * st[a]; if (occ[i]) seen = true; else if (seen) blk[i] |= 1 << (2 * a + 1); }
    }
  }
  const pc = (m) => { let c = 0; while (m) { c += m & 1; m >>= 1; } return c; };
  const ok = new Uint8Array(n);
  for (let i = 0; i < n; i++) if (!occ[i]) { const b = blk[i], c = pc(b); if (c >= 5 || (c === 4 && [0, 1, 2].some((a) => ((b >> (2 * a)) & 3) === 0))) ok[i] = 1; }
  const comps = [], seen = new Uint8Array(n), q = new Int32Array(n);
  for (let s = 0; s < n; s++) {
    if (!ok[s] || seen[s]) continue;
    let h = 0, t = 0; q[t++] = s; seen[s] = 1; const mn = [1e9, 1e9, 1e9], mx = [-1, -1, -1], open = [0, 0, 0, 0, 0, 0];
    while (h < t) {
      const i = q[h++], x = i % nx, y = ((i / nx) | 0) % ny, z = (i / (nx * ny)) | 0, c = [x, y, z];
      for (let a = 0; a < 3; a++) { mn[a] = Math.min(mn[a], c[a]); mx[a] = Math.max(mx[a], c[a]); for (let k = 0; k < 2; k++) if (!(blk[i] >> (2 * a + k) & 1)) open[2 * a + k]++; }
      for (let a = 0; a < 3; a++) for (const d of [-1, 1]) { const cc = c[a] + d; if (cc < 0 || cc >= dims[a]) continue; const j = i + d * st[a]; if (ok[j] && !seen[j]) { seen[j] = 1; q[t++] = j; } }
    }
    if (t < 8) continue;
    const dirs = []; open.forEach((v, k) => { if (v > 0.3 * t) dirs.push({ a: k >> 1, s: k & 1 ? 1 : -1 }); });
    comps.push({ count: t, min: V(...mn.map((v, a) => G.o.getComponent(a) + v * G.r)), max: V(...mx.map((v, a) => G.o.getComponent(a) + (v + 1) * G.r)), open: dirs });
  }
  return comps.sort((a, b) => b.count - a.count).slice(0, 12);
}

// ---------- scoring ----------
const _p = V(), _m = new THREE.Matrix4();
/** overlap = core pts of A inside core of others; contact = surface pts of A within ~1 mm of others. M: rel poses. */
function score(A, MA, others, skip) {
  let over = 0, cont = 0; const perOther = {};
  const bbA = A.G.bb.clone().applyMatrix4(MA).expandByScalar(1.5);
  for (const B of others) {
    if (B === A || skip?.has(B.id)) continue;
    if (!bbA.intersectsBox(B.G.bb.clone().applyMatrix4(B.M))) continue;
    _m.copy(B.M).invert().multiply(MA); let o = 0, c = 0;
    const cp = A.G.corePts, sp = A.G.surfPts;
    for (let i = 0; i < cp.length; i += 3) { _p.set(cp[i], cp[i + 1], cp[i + 2]).applyMatrix4(_m); if (B.G.lookup(B.G.occ, _p)) o++; }
    for (let i = 0; i < sp.length; i += 3) { _p.set(sp[i], sp[i + 1], sp[i + 2]).applyMatrix4(_m); if (B.G.lookup(B.G.near, _p)) c++; }
    over += o; cont += c; perOther[B.id] = { o, c };
  }
  const of = over / (A.G.corePts.length / 3 || 1), cf = cont / (A.G.surfPts.length / 3 || 1);
  return { of, cf, s: cf - 25 * of, perOther };
}
const worldBox = (P) => P.G.bb.clone().applyMatrix4(P.M);

// ---------- candidate placements ----------
function candidates(A, placed, clr) {
  const out = [];
  const asmBox = new THREE.Box3(); placed.forEach((P) => asmBox.union(worldBox(P)));
  for (const R of ROTATIONS_24) {
    const rb = A.G.bb.clone().applyMatrix4(R), rs = rb.getSize(V());
    const push = (target) => out.push(new THREE.Matrix4().makeTranslation(target.x - rb.min.x, target.y - rb.min.y, target.z - rb.min.z).multiply(R));
    const opts = (lo, hi, sz) => [lo + clr, hi - clr - sz, (lo + hi - sz) / 2];
    // into cavities of placed parts
    for (const P of placed) for (const c of P.G.cavities) {
      const cb = new THREE.Box3(c.min, c.max).applyMatrix4(P.M), cs = cb.getSize(V());
      const openAx = new Set(c.open.map((d) => worldAxis(P.M, d).a));
      let fits = true; for (let a = 0; a < 3; a++) if (!openAx.has(a) && rs.getComponent(a) > cs.getComponent(a) + 4 * A.G.r) fits = false;
      if (!fits) continue;
      const per = [0, 1, 2].map((a) => {
        const lo = cb.min.getComponent(a), hi = cb.max.getComponent(a), sz = rs.getComponent(a);
        const o = opts(lo, hi, sz);
        for (const d of c.open.map((d) => worldAxis(P.M, d)).filter((d) => d.a === a)) o.push(d.s < 0 ? hi - clr - sz : lo + clr); // flush to closed end
        return [...new Set(o.map((v) => +v.toFixed(3)))];
      });
      for (const x of per[0]) for (const y of per[1]) for (const z of per[2]) push(V(x, y, z));
    }
    // against faces of the current assembly
    for (let a = 0; a < 3; a++) for (const side of [-1, 1]) {
      const per = [0, 1, 2].map((b) => {
        const lo = asmBox.min.getComponent(b), hi = asmBox.max.getComponent(b), sz = rs.getComponent(b);
        if (b === a) return [side < 0 ? lo - sz - clr : hi + clr];
        return [lo, hi - sz, (lo + hi - sz) / 2];
      });
      for (const x of per[0]) for (const y of per[1]) for (const z of per[2]) push(V(x, y, z));
    }
  }
  return out;
}
function worldAxis(M, d) {
  const v = V(...[0, 1, 2].map((a) => (a === d.a ? d.s : 0))).transformDirection(M);
  const a = [0, 1, 2].reduce((b, i) => (Math.abs(v.getComponent(i)) > Math.abs(v.getComponent(b)) ? i : b), 0);
  return { a, s: Math.sign(v.getComponent(a)) };
}
function refine(A, M, placed) {
  let best = M.clone(), bs = score(A, best, placed).s; const st = A.G.r;
  for (let it = 0; it < 4; it++) {
    let improved = false;
    for (let a = 0; a < 3; a++) for (const d of [-2 * st, -st, st, 2 * st]) {
      const t = V(); t.setComponent(a, d); const C = new THREE.Matrix4().makeTranslation(t.x, t.y, t.z).multiply(best);
      const s = score(A, C, placed).s; if (s > bs + 1e-4) { bs = s; best = C; improved = true; }
    }
    if (!improved) break;
  }
  return best;
}

// ---------- motion probing ----------
function travel(P, all, dirV, maxT, skip) {
  const step = Math.max(P.G.r, 1); let t = 0;
  while (t + step <= maxT) {
    const M = new THREE.Matrix4().makeTranslation(dirV.x * (t + step), dirV.y * (t + step), dirV.z * (t + step)).multiply(P.M);
    if (score(P, M, all, skip).of > 0.01) break; t += step;
  }
  return t;
}
function swing(P, all, axis, origin, sign, skip) {
  let ang = 0;
  while (ang < 90) {
    const a = ang + 2, R = new THREE.Matrix4().makeRotationAxis(axis, THREE.MathUtils.degToRad(sign * a));
    const M = new THREE.Matrix4().makeTranslation(origin.x, origin.y, origin.z).multiply(R).multiply(new THREE.Matrix4().makeTranslation(-origin.x, -origin.y, -origin.z)).multiply(P.M);
    if (score(P, M, all, skip).of > 0.01) break; ang = a;
  }
  return ang;
}
function pinAxis(P) { // elongated, round-ish bbox -> pin along long axis (world)
  const s = worldBox(P).getSize(V()).toArray(), idx = [0, 1, 2].sort((a, b) => s[a] - s[b]);
  const [a, b, c] = idx.map((i) => s[i]);
  return c >= 1.8 * b && b / a < 1.5 && b < 15 ? { a: idx[2], center: worldBox(P).getCenter(V()) } : null;
}

// ---------- main ----------
/**
 * autoAssemble(parts, opts) -> Promise<{ poses, joints, guesses, mode, collisions, timeMs }>
 * parts: [{id, geometry}] ; opts: {poses?, base?, clearance=0.3, onProgress?(done,total,msg), signal?, trustInPlace=true}
 */
export async function autoAssemble(parts, opts = {}) {
  const t0 = Date.now(), { signal, onProgress, clearance = 0.3 } = opts;
  const tick = async (done, total, msg) => { onProgress?.(done, total, msg); await new Promise((r) => setTimeout(r, 0)); if (signal?.aborted) throw abortErr(); };
  if (signal?.aborted) throw abortErr();
  const P = parts.map((p) => ({ id: p.id, geometry: p.geometry, given: toMat(opts.poses?.[p.id]) }));
  for (let i = 0; i < P.length; i++) { P[i].G = buildGrid(P[i].geometry); await tick(i + 1, P.length * 3, `analysed ${P[i].id}`); }
  const byVol = [...P].sort((a, b) => b.G.volume - a.G.volume);
  const base = P.find((p) => p.id === opts.base) || byVol[0];
  const baseW = base.given.clone(), baseInv = baseW.clone().invert();

  // pass 1: already assembled? (shared coordinates: boxes touch/nest, no big overlaps)
  P.forEach((p) => { p.M = baseInv.clone().multiply(p.given); });
  let inPlace = opts.trustInPlace !== false && P.length > 1;
  const reasons = {};
  if (inPlace) for (const p of P) {
    const others = P.filter((q) => q !== p), bb = worldBox(p).expandByScalar(2);
    if (!others.some((q) => bb.intersectsBox(worldBox(q)))) { inPlace = false; break; }
    if (score(p, p.M, others).of > 0.03) { inPlace = false; break; }
  }
  if (inPlace) {
    const raw = checkPose(P, Object.fromEntries(P.map((p) => [p.id, p.M])), { tolerance: 0 });
    for (const p of P) { p.conf = 0.9; reasons[p.id] = 'kept: parts already in a plausible assembled arrangement (shared coordinates)'; }
    P.rawCollisions = raw.collisions.length;
  } else {
    // pass 2: feature/fit search, largest first
    base.M = new THREE.Matrix4(); base.conf = 1; reasons[base.id] = 'base (largest volume)' + (opts.base ? ' / user-specified' : '');
    const placed = [base]; let k = 0;
    for (const A of byVol.filter((p) => p !== base)) {
      let best = null;
      for (const C of candidates(A, placed, clearance)) {
        const s = score(A, C, placed); if (!best || s.s > best.s.s) best = { M: C, s };
      }
      if (best && best.s.cf > 0.02 && best.s.of < 0.05) {
        A.M = refine(A, best.M, placed); const s = score(A, A.M, placed);
        A.conf = +Math.max(0.05, Math.min(0.95, s.cf * 2 - s.of * 10)).toFixed(2);
        reasons[A.id] = `best of ${ROTATIONS_24.length} rotations × cavity/face alignments: contact ${(s.cf * 100).toFixed(0)}% of surface, overlap ${(s.of * 100).toFixed(1)}%`;
        placed.push(A);
      } else { A.M = A.M || new THREE.Matrix4(); A.conf = 0; A.unmatched = true; reasons[A.id] = 'no fitting placement found; left in place'; }
      await tick(P.length + ++k, P.length * 3, `placed ${A.id}`);
    }
  }

  // matedTo = neighbour with most contact
  for (const p of P) {
    const s = score(p, p.M, P.filter((q) => q !== p));
    p.matedTo = Object.entries(s.perOther).sort((a, b) => b[1].c - a[1].c).find(([, v]) => v.c > 0)?.[0] ?? null;
  }
  // joint inference
  const J = {};
  const childrenOf = (p) => new Set(P.filter((q) => q.matedTo === p.id && q.G.volume < p.G.volume).map((q) => q.id));
  let k2 = 0;
  for (const p of P) {
    if (p !== base && p.matedTo && (pinAxis(p) || (p.G.volume < 0.01 * base.G.volume && Math.max(...worldBox(p).getSize(V()).toArray()) < 12))) { J[p.id] = { type: 'fixed', confidence: 0.5, reason: `pin/fastener-sized part seated in ${p.matedTo}` }; continue; }
    if (p === base || p.unmatched) { J[p.id] = { type: 'fixed', confidence: p === base ? 1 : 0, reason: p === base ? 'base' : 'unmatched' }; continue; }
    const skip = childrenOf(p), wb = worldBox(p), size = wb.getSize(V());
    const mate = P.find((q) => q.id === p.matedTo);
    const trav = [];
    for (let a = 0; a < 3; a++) for (const s of [-1, 1]) {
      const d = V(); d.setComponent(a, s); const ext = size.getComponent(a);
      trav.push({ a, s, d, ext, t: travel(p, P, d, ext * 1.2 + 2, skip) });
    }
    trav.sort((x, y) => y.t - x.t); const best = trav[0];
    const perp = trav.filter((x) => x.a !== best.a);
    const inside = mate ? (() => { const i = wb.clone().intersect(worldBox(mate)); return i.isEmpty() ? 0 : i.getSize(V()).toArray().reduce((m, v) => m * v, 1) / (size.x * size.y * size.z); })() : 0;
    const escapes = best.t >= best.ext * 1.2;
    // hinge (checked first) about a pin passing through this part
    let hinge = null;
    for (const q of P) {
      if (q === p || q === base) continue; const pa = pinAxis(q); if (!pa) continue;
      const sc = score(q, q.M, [p]); if (!sc.perOther[p.id] || sc.perOther[p.id].c < 3) continue;
      if (!wb.containsPoint(pa.center) && !wb.clone().expandByScalar(2).containsPoint(pa.center)) continue;
      const axis = V(); axis.setComponent(pa.a, 1); const sk = new Set([...skip, q.id]);
      const plus = swing(p, P, axis, pa.center, 1, sk), minus = swing(p, P, axis, pa.center, -1, sk);
      const m = Math.max(plus, minus); if (m < 6) continue;
      const sgn = plus >= minus ? 1 : -1;
      hinge = { type: 'hinge', axis: axis.toArray(), origin: pa.center.toArray().map((v) => +v.toFixed(2)), range: [0, sgn * m], confidence: 0.6,
        reason: `pin-in-hole: ${q.id} (axis ${AX[pa.a]}) passes through; free swing ${plus}° / −${minus}°`,
        note: `${pretty(p.id)}: swings ${m}° about ${q.id} (${AX[pa.a]} axis)` };
      break;
    }
    J[p.id] = null;
    if (!hinge && best.t >= 2 && perp.every((x) => x.t < 0.5 * best.t) && (inside > 0.5 || !escapes)) {
      let depth = best.t;
      if (escapes && mate) { const i = wb.clone().intersect(worldBox(mate)); depth = i.getSize(V()).getComponent(best.a); }
      depth = +Math.min(depth, best.t).toFixed(1);
      J[p.id] = { type: 'slider', axis: best.d.toArray(), range: [0, depth], confidence: +(inside > 0.5 ? 0.8 : 0.6).toFixed(2),
        reason: inside > 0.5 ? `box in cavity of ${mate.id}, open toward ${dirName(best)}; other directions blocked` : `bounded travel ${depth} mm along ${dirName(best)}`,
        note: `${pretty(p.id)}: slides ${depth} mm ${inside > 0.5 ? 'out' : ''} along ${dirName(best)}`.replace('  ', ' ') };
    }
    if (!J[p.id]) J[p.id] = hinge || { type: 'fixed', confidence: 0.5, reason: mate ? `flat-face / fitted contact with ${mate.id}, no free motion` : 'no contacts' };
    await tick(P.length * 2 + ++k2, P.length * 3, `joints ${p.id}`);
  }
  // small parts riding on a moving part -> parent it
  for (const p of P) {
    if (J[p.id].type !== 'fixed' || p === base || !p.matedTo) continue;
    const m = P.find((q) => q.id === p.matedTo);
    if (J[m.id].type !== 'fixed' && m.matedTo !== p.id && m.G.volume > p.G.volume) {
      J[p.id] = { type: 'fixed', parent: m.id, confidence: 0.5, reason: `attached to moving ${m.id} (largest contact)`, note: `${pretty(p.id)}: moves with ${m.id}` };
    }
  }

  // ---- output (world frame = base's given pose) ----
  const W = Object.fromEntries(P.map((p) => [p.id, baseW.clone().multiply(p.M)]));
  const R3 = new THREE.Matrix4().extractRotation(baseW);
  const poses = [], joints = [], guesses = [];
  for (const p of P) {
    const j = J[p.id], w = W[p.id];
    const note = j.note || (p === base ? `${pretty(p.id)}: base, stays put` : p.unmatched ? `${pretty(p.id)}: could not place (left as is)` : `${pretty(p.id)}: fixed to ${p.matedTo || 'nothing'}`);
    poses.push({ id: p.id, matrix: w.toArray(), confidence: p.conf ?? 0, reason: reasons[p.id], note });
    const offset = j.parent ? W[j.parent].clone().invert().multiply(w) : w;
    joints.push({ part: p.id, type: 'fixed', offset: offset.toArray(), ...(j.parent ? { parent: j.parent } : {}), confidence: p.conf ?? 0, reason: reasons[p.id], note: j.parent ? j.note : note });
    let mj = null;
    if (j.type === 'slider') mj = { part: p.id, type: 'slider', axis: V(...j.axis).transformDirection(R3).toArray().map((v) => +v.toFixed(6)), range: j.range };
    if (j.type === 'hinge') mj = { part: p.id, type: 'hinge', axis: V(...j.axis).transformDirection(R3).toArray().map((v) => +v.toFixed(6)), origin: V(...j.origin).applyMatrix4(baseW).toArray(), range: j.range };
    if (mj) joints.push({ ...mj, confidence: j.confidence, reason: j.reason, note: j.note });
    guesses.push({ part: p.id, matedTo: p.matedTo, poseConfidence: p.conf ?? 0, joint: j.parent ? 'fixed(parent ' + j.parent + ')' : j.type, jointConfidence: j.confidence, reason: reasons[p.id] + ' | ' + j.reason, note: j.note || note });
  }
  const cp = checkPose(P, W, { tolerance: 0 });
  return { poses, joints, guesses, mode: inPlace ? 'in-place' : 'search', base: base.id, collisions: cp.collisions.map(({ a, b }) => ({ a, b })), timeMs: Date.now() - t0 };
}

