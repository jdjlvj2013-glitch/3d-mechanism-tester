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

// Round-ish through/blind holes (pin holes, pivot bores, rod guides): empty voxels enclosed radially within ~6 mm,
// grouped per axis. Local coordinates. Computed lazily (only when a small/holed part has to be placed).
function findHoles(G) {
  const { nx, ny, nz, occ, r } = G, st = [1, nx, nx * ny], dims = [nx, ny, nz], R = Math.max(2, Math.ceil(6 / r)), out = [];
  for (let a = 0; a < 3; a++) {
    const [b, c] = [0, 1, 2].filter((q) => q !== a), ok = new Uint8Array(occ.length);
    const hit = (i, co, ax, sgn) => { for (let k = 1; k <= R; k++) { const v = co[ax] + sgn * k; if (v < 0 || v >= dims[ax]) return false; if (occ[i + sgn * k * st[ax]]) return true; } return false; };
    for (let z = 0; z < nz; z++) for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++) {
      const i = x + y * nx + z * nx * ny; if (occ[i]) continue; const co = [x, y, z];
      if (hit(i, co, b, -1) && hit(i, co, b, 1) && hit(i, co, c, -1) && hit(i, co, c, 1)) ok[i] = 1;
    }
    const seen = new Uint8Array(occ.length), q = new Int32Array(occ.length);
    for (let s0 = 0; s0 < ok.length; s0++) {
      if (!ok[s0] || seen[s0]) continue; let h = 0, t = 0; q[t++] = s0; seen[s0] = 1; const mn = [1e9, 1e9, 1e9], mx = [-1, -1, -1];
      while (h < t) {
        const i = q[h++], co = [i % nx, ((i / nx) | 0) % ny, (i / (nx * ny)) | 0];
        for (let k = 0; k < 3; k++) { mn[k] = Math.min(mn[k], co[k]); mx[k] = Math.max(mx[k], co[k]); }
        for (let k = 0; k < 3; k++) for (const d of [-1, 1]) { const cc = co[k] + d; if (cc < 0 || cc >= dims[k]) continue; const j = i + d * st[k]; if (ok[j] && !seen[j]) { seen[j] = 1; q[t++] = j; } }
      }
      const eb = (mx[b] - mn[b] + 1) * r, ec = (mx[c] - mn[c] + 1) * r, L = (mx[a] - mn[a] + 1) * r;
      if (t < 4 || eb > 13 || ec > 13 || Math.max(eb, ec) > 1.6 * Math.min(eb, ec) + 2 * r || L < 1.5 * r) continue;
      const lo = V(...mn.map((v, k) => G.o.getComponent(k) + v * r)), hi = V(...mx.map((v, k) => G.o.getComponent(k) + (v + 1) * r));
      out.push({ a, d: (eb + ec) / 2, len: L, center: lo.clone().add(hi).multiplyScalar(0.5), lo: lo.getComponent(a), hi: hi.getComponent(a) });
    }
  }
  return out.sort((x, y) => y.len - x.len).slice(0, 24);
}
// Elongated part (rod / push button): longest local axis and the shaft's cross-section (middle 40-60% slab) centre + size.
function rodOf(G) {
  if ('rod' in G) return G.rod;
  const { nx, ny, nz, occ, r } = G, dims = [nx, ny, nz], sz = G.bb.getSize(V()).toArray(), idx = [0, 1, 2].sort((a, b) => sz[b] - sz[a]), a = idx[0];
  G.rod = null; if (sz[a] < 2.5 * sz[idx[1]] && sz[a] < 40) return null;
  const lo = Math.floor(dims[a] * 0.4), hi = Math.ceil(dims[a] * 0.6), mn = [1e9, 1e9, 1e9], mx = [-1e9, -1e9, -1e9];
  for (let z = 0; z < nz; z++) for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++) {
    const c = [x, y, z]; if (c[a] < lo || c[a] > hi || !occ[x + nx * (y + ny * z)]) continue;
    for (let k = 0; k < 3; k++) { mn[k] = Math.min(mn[k], c[k]); mx[k] = Math.max(mx[k], c[k] + 1); }
  }
  if (mn[0] > mx[0]) return null;
  const center = V(...[0, 1, 2].map((k) => G.o.getComponent(k) + (mn[k] + mx[k]) / 2 * r)); center.setComponent(a, G.bb.getCenter(V()).getComponent(a));
  const w = Math.max(...[0, 1, 2].filter((k) => k !== a).map((k) => (mx[k] - mn[k]) * r));
  return (G.rod = w < 14 ? { a, center, w } : null);
}
const holesOf = (G) => (G.holes ||= findHoles(G));
const worldHoles = (P) => holesOf(P.G).map((h) => {
  const c = h.center.clone().applyMatrix4(P.M), ax = worldAxis(P.M, { a: h.a, s: 1 }), lo = c.clone(), hi = c.clone();
  lo.setComponent(h.a, h.lo); hi.setComponent(h.a, h.hi); lo.applyMatrix4(P.M); hi.applyMatrix4(P.M);
  return { a: ax.a, d: h.d, center: c, lo: Math.min(lo.getComponent(ax.a), hi.getComponent(ax.a)), hi: Math.max(lo.getComponent(ax.a), hi.getComponent(ax.a)) };
});

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
  // mounting face = side opposite the base's main cavity opening (e.g. back of a drawer housing)
  const mc = placed[0].G.cavities[0], od = mc?.open[0] && worldAxis(placed[0].M, mc.open[0]), back = od && { a: od.a, s: -od.s };
  for (const R of ROTATIONS_24) {
    const rb = A.G.bb.clone().applyMatrix4(R), rs = rb.getSize(V());
    const push = (target, bonus = 0, face = null, hole = false) => out.push(Object.assign(new THREE.Matrix4().makeTranslation(target.x - rb.min.x, target.y - rb.min.y, target.z - rb.min.z)
      .multiply(R), { bonus, face, hole }));
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
    // small parts (pins, studs, rods) centred in holes of placed parts; parts with their own holes aligned hole-to-hole
    const big = Math.max(rs.x, rs.y, rs.z), small = big < 25;
    const WH = placed.flatMap((P) => worldHoles(P));
    for (const h of WH) {
      const [b, c2] = [0, 1, 2].filter((q) => q !== h.a);
      if (small) {
        if (rs.getComponent(b) > h.d + 4 && rs.getComponent(c2) > h.d + 4) continue;
        const sz = rs.getComponent(h.a);
        // coaxial holes (e.g. both bosses of a pivot, across parts): span them all
        const co = WH.filter((g) => g.a === h.a && Math.abs(g.center.getComponent(b) - h.center.getComponent(b)) < 1 && Math.abs(g.center.getComponent(c2) - h.center.getComponent(c2)) < 1);
        const slo = Math.min(...co.map((g) => g.lo)), shi = Math.max(...co.map((g) => g.hi));
        for (const t of [slo, shi - sz, (slo + shi - sz) / 2, slo - 1.5, shi - sz + 1.5, h.lo - sz / 2, h.lo, h.hi - sz, (h.lo + h.hi - sz) / 2, h.hi - sz / 2, h.lo - sz + 1, h.hi - 1]) {
          const tg = V(); tg.setComponent(b, h.center.getComponent(b) - rs.getComponent(b) / 2); tg.setComponent(c2, h.center.getComponent(c2) - rs.getComponent(c2) / 2); tg.setComponent(h.a, t);
          push(tg, 0.15, null, true);
        }
      } else if (rodOf(A.G) && rodOf(A.G).w <= h.d + 2) {
        // rod / push button shaft through a guide hole (spanning coaxial guides)
        const rod = A.G.rod, ax = worldAxis(R, { a: rod.a, s: 1 }).a; if (ax !== h.a) continue;
        const rc = rod.center.clone().applyMatrix4(R), len = rs.getComponent(h.a);
        const co = WH.filter((g) => g.a === h.a && Math.abs(g.center.getComponent(b) - h.center.getComponent(b)) < 1 && Math.abs(g.center.getComponent(c2) - h.center.getComponent(c2)) < 1);
        const slo = Math.min(...co.map((g) => g.lo)), shi = Math.max(...co.map((g) => g.hi)), bonus = 0.3 * Math.min(co.length, 3);
        for (const d of [-10, -5, 0, 5, 10]) for (const endLo of [shi + d - len, slo - d]) {
          const tg = h.center.clone(); tg.setComponent(h.a, endLo + len / 2); const c0 = rc.clone(); c0.setComponent(h.a, rb.min.getComponent(h.a) + len / 2);
          out.push(Object.assign(new THREE.Matrix4().makeTranslation(tg.x - c0.x, tg.y - c0.y, tg.z - c0.z).multiply(R), { bonus, hole: true, holeAxis: h.a }));
        }
      } else for (const hA of holesOf(A.G).slice(0, 8)) {
        if (Math.abs(hA.d - h.d) > 2.5) continue;
        const ca = hA.center.clone().applyMatrix4(R), ax = worldAxis(R, { a: hA.a, s: 1 }).a; if (ax !== h.a) continue;
        const half = (hA.hi - hA.lo) / 2, nco = WH.filter((g) => g.a === h.a && Math.abs(g.center.getComponent(b) - h.center.getComponent(b)) < 1 && Math.abs(g.center.getComponent(c2) - h.center.getComponent(c2)) < 1 && g.lo < h.hi + 15 && g.hi > h.lo - 15).length;
        for (const along of [h.center.getComponent(h.a), h.lo - half, h.hi + half]) {
          const tg = h.center.clone(); tg.setComponent(h.a, along);
          out.push(Object.assign(new THREE.Matrix4().makeTranslation(tg.x - ca.x, tg.y - ca.y, tg.z - ca.z).multiply(R), { bonus: 0.3 * Math.min(nco, 3), hole: true }));
        }
      }
    }
    // against faces of the current assembly
    for (let a = 0; a < 3; a++) for (const side of [-1, 1]) {
      const per = [0, 1, 2].map((b) => {
        const lo = asmBox.min.getComponent(b), hi = asmBox.max.getComponent(b), sz = rs.getComponent(b);
        if (b === a) return [side < 0 ? lo - sz - clr : hi + clr];
        return [lo, hi - sz, (lo + hi - sz) / 2];
      });
      const bonus = back && back.a === a && back.s === side ? 0.15 : 0;
      for (const x of per[0]) for (const y of per[1]) for (const z of per[2]) push(V(x, y, z), bonus, { a, side, sz: rs.getComponent(a), flat: rs.getComponent(a) <= Math.min(rs.x, rs.y, rs.z) + 1e-6 });
    }
  }
  return out;
}
function worldAxis(M, d) {
  const v = V(...[0, 1, 2].map((a) => (a === d.a ? d.s : 0))).transformDirection(M);
  const a = [0, 1, 2].reduce((b, i) => (Math.abs(v.getComponent(i)) > Math.abs(v.getComponent(b)) ? i : b), 0);
  return { a, s: Math.sign(v.getComponent(a)) };
}
function refine(A, M, placed, axes = [0, 1, 2]) {
  let best = M.clone(), bs = score(A, best, placed).s; const st = A.G.r;
  for (let it = 0; it < 4; it++) {
    let improved = false;
    for (const a of axes) for (const d of [-2 * st, -st, st, 2 * st]) {
      const t = V(); t.setComponent(a, d); const C = new THREE.Matrix4().makeTranslation(t.x, t.y, t.z).multiply(best);
      const s = score(A, C, placed).s; if (s > bs + 0.005) { bs = s; best = C; improved = true; }
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

  // pass 1: keep every part that already sits plausibly in the assembly (shared CAD coordinates), per part.
  // Tried with opts.poses and with raw STL coordinates (identity); the variant keeping more parts wins.
  const reasons = {}, why = {};
  const tryKeep = (rel) => {
    P.forEach((p) => { p.M = rel[p.id]; });
    const kept = [base], rej = {}; let changed = true;
    while (changed) {
      changed = false;
      for (const p of P) {
        if (kept.includes(p)) continue;
        const bb = worldBox(p), near = kept.filter((q) => bb.clone().expandByScalar(1).intersectsBox(worldBox(q)));
        if (!near.length) { rej[p.id] = 'not touching the assembly (gap > 1 mm)'; continue; }
        const sc = score(p, p.M, kept);
        const nested = near.some((q) => worldBox(q).expandByScalar(1).containsBox(bb));
        if (sc.of > 0.03) { const w = Object.entries(sc.perOther).sort((x, y) => y[1].o - x[1].o)[0]; rej[p.id] = `overlaps ${w[0]} (${(sc.of * 100).toFixed(1)}% of its volume)`; continue; }
        if (sc.cf < 0.01 && !nested) { rej[p.id] = 'bbox touches but no surface within ~1 mm'; continue; }
        kept.push(p); delete rej[p.id]; changed = true;
      }
    }
    return { kept, rej };
  };
  let keep = { kept: [base], rej: {} }, frame = 'opts.poses';
  if (opts.trustInPlace !== false && P.length > 1) {
    const variants = [['opts.poses', Object.fromEntries(P.map((p) => [p.id, baseInv.clone().multiply(p.given)]))]];
    if (P.some((p) => !p.given.equals(new THREE.Matrix4()))) variants.push(['raw STL coordinates', Object.fromEntries(P.map((p) => [p.id, new THREE.Matrix4()]))]);
    let bestRel = null;
    for (const [name, rel] of variants) { const k = tryKeep(rel); if (k.kept.length > keep.kept.length || !bestRel) { keep = k; frame = name; bestRel = rel; } }
    P.forEach((p) => { p.M = bestRel[p.id]; });
  } else P.forEach((p) => { p.M = baseInv.clone().multiply(p.given); });
  const inPlace = keep.kept.length === P.length;
  for (const p of keep.kept) { p.conf = p === base ? 1 : 0.9; reasons[p.id] = p === base ? `base (${opts.base ? 'user-specified' : 'largest volume'})` : `kept: already fits the assembly in ${frame}`; }
  for (const [id, r] of Object.entries(keep.rej)) why[id] = r;
  if (!inPlace) {
    // pass 2: feature/fit search for the rest, largest first
    const placed = [...keep.kept]; let k = 0;
    for (const A of byVol.filter((p) => !placed.includes(p))) {
      const asm = new THREE.Box3(); placed.forEach((q) => asm.union(worldBox(q))); const bv = (b) => { const z = b.getSize(V()); return z.x * z.y * z.z; }, av = bv(asm);
      // flush with the assembly outline is preferred (small penalty for growing the overall bounding box)
      const sc = (M, bonus, face = true) => { const s = score(A, M, placed); s.s += (bonus && s.cf > 0.05 ? bonus : 0) - (face ? 0.1 : 0) * (bv(asm.clone().union(A.G.bb.clone().applyMatrix4(M))) - av) / av; return s; };
      const all = candidates(A, placed, clearance).map((C) => ({ M: C, s: sc(C, C.bonus, !!C.face), face: C.face, bonus: C.bonus, hole: C.hole, holeAxis: C.holeAxis }));
      all.sort((x, y) => y.s.s - x.s.s); let best = all[0] || null;
      // mating faces with tongues/dovetails: slide face candidates into the assembly while contact grows and overlap stays tiny
      for (const c of [...all.filter((c) => c.face).slice(0, 12), ...all.filter((c) => c.face && c.face.flat && c.bonus).slice(0, 24)]) {
        const step = A.G.r / 2, n = Math.ceil(Math.min(0.4 * c.face.sz, 15) / step);
        for (let k = 1; k <= n; k++) {
          const d = V(); d.setComponent(c.face.a, -c.face.side * k * step);
          const M = new THREE.Matrix4().makeTranslation(d.x, d.y, d.z).multiply(c.M), s = sc(M, c.bonus);
          if (s.of > c.s.of + 0.005) break;
          if (s.s > best.s.s + 0.005) best = { M, s };
        }
      }
      if (best && best.s.cf > 0.02 && best.s.of < 0.05) {
        A.M = best.hole ? (best.holeAxis !== undefined ? refine(A, best.M, placed, [best.holeAxis]) : best.M) : refine(A, best.M, placed);
        const s = score(A, A.M, placed); // hole-aligned: keep the axis exact
        A.conf = +Math.max(0.05, Math.min(0.95, s.cf * 2 - s.of * 10)).toFixed(2);
        reasons[A.id] = `${why[A.id] ? 'pass 1: ' + why[A.id] + '; ' : ''}best of ${ROTATIONS_24.length} rotations × cavity/face alignments: contact ${(s.cf * 100).toFixed(0)}% of surface, overlap ${(s.of * 100).toFixed(1)}%`;
        placed.push(A);
      } else { A.M = A.M || new THREE.Matrix4(); A.conf = 0; A.unmatched = true; reasons[A.id] = `${why[A.id] ? 'pass 1: ' + why[A.id] + '; ' : ''}no fitting placement found; left in place`; }
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
    trav.sort((x, y) => y.t - x.t); let best = trav[0];
    const inside = mate ? (() => { const i = wb.clone().intersect(worldBox(mate)); return i.isEmpty() ? 0 : i.getSize(V()).toArray().reduce((m, v) => m * v, 1) / (size.x * size.y * size.z); })() : 0;
    // a rod/button that only escapes backwards out of its hole moves along its bounded direction (stopped by the first part
    // it hits, e.g. the lever); a drawer (mostly inside a cavity) keeps the pull-out direction and may also push in a bit.
    let back = 0;
    { const opp = trav.find((x) => x.a === best.a && x.s !== best.s);
      if (best.t >= best.ext * 1.2 && opp && opp.t >= 2 && opp.t < opp.ext) { const onlyMate = mate ? travel(p, P, opp.d, opp.ext * 1.2 + 2, new Set(P.filter((q) => q !== mate).map((q) => q.id))) : opp.t;
        if (inside > 0.5 && onlyMate <= opp.t + 1) back = +opp.t.toFixed(1); else { best = opp; best.stop = onlyMate > opp.t + 1; } } }
    const perp = trav.filter((x) => x.a !== best.a);
    const escapes = best.t >= best.ext * 1.2;
    // hinge (checked first) about a pin passing through this part
    let hinge = null;
    for (const q of P) {
      if (q === p || q === base) continue; const pa = pinAxis(q); if (!pa) continue;
      const sc = score(q, q.M, [p]); if (!sc.perOther[p.id] || sc.perOther[p.id].c < 3) continue;
      if (!wb.containsPoint(pa.center) && !wb.clone().expandByScalar(2).containsPoint(pa.center)) continue;
      const axis = V(); axis.setComponent(pa.a, 1); const sk = new Set([...skip, q.id]);
      let plus = swing(p, P, axis, pa.center, 1, sk), minus = swing(p, P, axis, pa.center, -1, sk), drv = '';
      if (Math.max(plus, minus) < 6) { // blocked by a push rod/button that drives it: swing ignoring rods
        const rods = P.filter((r2) => r2 !== p && r2 !== base && rodOf(r2.G)).map((r2) => r2.id);
        if (rods.length) { const sk2 = new Set([...sk, ...rods]); plus = swing(p, P, axis, pa.center, 1, sk2); minus = swing(p, P, axis, pa.center, -1, sk2); drv = ` (driven by ${rods.join('/')})`; }
      }
      const m = Math.max(plus, minus); if (m < 6 && !(wb.containsPoint(pa.center) && m > 0)) continue;
      const sgn = plus >= minus ? 1 : -1;
      hinge = { type: 'hinge', axis: axis.toArray(), origin: pa.center.toArray().map((v) => +v.toFixed(2)), range: [0, sgn * m], confidence: 0.6,
        reason: `pin-in-hole: ${q.id} (axis ${AX[pa.a]}) passes through; free swing ${plus}° / −${minus}°${drv}`,
        note: `${pretty(p.id)}: swings ${m}° about ${q.id} (${AX[pa.a]} axis)` };
      break;
    }
    J[p.id] = null;
    if (!hinge && best.t >= 2 && perp.every((x) => x.t < 0.5 * best.t || (x.t < best.ext * 1.2 && x.t <= 6)) && (inside > 0.5 || !escapes)) {
      let depth = best.t;
      if (escapes && mate) { const i = wb.clone().intersect(worldBox(mate)); depth = i.getSize(V()).getComponent(best.a); }
      depth = +Math.min(depth, best.t).toFixed(1);
      J[p.id] = { type: 'slider', axis: best.d.toArray(), range: [back ? -back : 0, depth], confidence: +(inside > 0.5 ? 0.8 : 0.6).toFixed(2),
        reason: inside > 0.5 ? `box in cavity of ${mate.id}, open toward ${dirName(best)}; other directions blocked` : `bounded travel ${depth} mm along ${dirName(best)}`,
        note: `${pretty(p.id)}: ${best.stop ? "pushes" : "slides"} ${depth} mm ${inside > 0.5 && !best.stop ? "out" : ""} along ${dirName(best)}${best.stop ? " (stops at first contact with another part)" : ""}${back ? ` (pushes ${back} mm in)` : ''}`.replace('  ', ' ') };
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
  return { poses, joints, guesses, mode: inPlace ? 'in-place' : keep.kept.length > 1 ? 'mixed' : 'search', kept: keep.kept.map((p) => p.id), pass1: { frame, rejected: why }, base: base.id, collisions: cp.collisions.map(({ a, b }) => ({ a, b })), timeMs: Date.now() - t0 };
}

