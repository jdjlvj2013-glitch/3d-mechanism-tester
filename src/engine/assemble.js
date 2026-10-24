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
  G.corePts = toP(corePts); G.surfPts = toP(surf); G.volume = nOcc * r ** 3; delete G.core; // only the sampled points are needed (saves memory)
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
/** number of points (flat xyz array) that land in a set cell of grid G's array arr after transform m (inlined for speed). */
function countIn(pts, m, G, arr) {
  const e = m.elements, ir = 1 / G.r, nx = G.nx, ny = G.ny, nz = G.nz, nxy = nx * ny;
  const a0 = e[0] * ir, a1 = e[4] * ir, a2 = e[8] * ir, a3 = (e[12] - G.o.x) * ir;
  const b0 = e[1] * ir, b1 = e[5] * ir, b2 = e[9] * ir, b3 = (e[13] - G.o.y) * ir;
  const c0 = e[2] * ir, c1 = e[6] * ir, c2 = e[10] * ir, c3 = (e[14] - G.o.z) * ir;
  let n = 0;
  for (let i = 0; i < pts.length; i += 3) {
    const px = pts[i], py = pts[i + 1], pz = pts[i + 2];
    const x = Math.floor(a0 * px + a1 * py + a2 * pz + a3); if (x < 0 || x >= nx) continue;
    const y = Math.floor(b0 * px + b1 * py + b2 * pz + b3); if (y < 0 || y >= ny) continue;
    const z = Math.floor(c0 * px + c1 * py + c2 * pz + c3); if (z < 0 || z >= nz) continue;
    if (arr[x + nx * y + nxy * z]) n++;
  }
  return n;
}
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
    o = countIn(cp, _m, B.G, B.G.occ); c = countIn(sp, _m, B.G, B.G.near);
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
// rigid group (part + its fasteners) motion: max travel / swing until any member overlaps a non-member
function groupHit(G, T, all, skip, tol = 0.01) { return G.some((m) => { if (m._of0 === undefined) m._of0 = score(m, m.M, all, skip).of; return score(m, T.clone().multiply(m.M), all, skip).of > m._of0 + tol; }); }
function groupTravel(G, all, d, maxT, skip, step = 1, T0 = new THREE.Matrix4()) {
  let t = 0; while (t + step <= maxT && !groupHit(G, new THREE.Matrix4().makeTranslation(d.x * (t + step), d.y * (t + step), d.z * (t + step)).multiply(T0), all, skip)) t += step; return t;
}
function groupSwing(G, all, axis, o, sign, skip, T0, maxA = 60, step = 2, pa = 0) {
  // pins in curved grooves: at each step allow the group to shift up to 1.5 mm perpendicular to the pin axis to stay clear
  let a = 0, sh = V(); const rot = (x, d) => new THREE.Matrix4().makeTranslation(d.x, d.y, d.z).multiply(new THREE.Matrix4().makeTranslation(o.x, o.y, o.z)).multiply(new THREE.Matrix4().makeRotationAxis(axis, THREE.MathUtils.degToRad(sign * x))).multiply(new THREE.Matrix4().makeTranslation(-o.x, -o.y, -o.z)).multiply(T0);
  const [b, c] = [0, 1, 2].filter((q) => q !== pa), offs = [[0, 0]]; for (const r of [0.5, 1, 1.5]) for (const [u, v] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]]) offs.push([u * r, v * r]);
  while (a + step <= maxA) { let ok = null;
    for (const [u, v] of offs) { const d = sh.clone(); d.setComponent(b, d.getComponent(b) + u); d.setComponent(c, d.getComponent(c) + v); if (!groupHit(G, rot(a + step, d), all, skip)) { ok = d; break; } }
    if (!ok) break; sh = ok; a += step; }
  return { a, sh };
}
function swing(P, all, axis, origin, sign, skip, step = 2) {
  let ang = 0;
  while (ang < 90) {
    const a = ang + step, R = new THREE.Matrix4().makeRotationAxis(axis, THREE.MathUtils.degToRad(sign * a));
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


// ---------- group placement (part + its fasteners) ----------
const maxDim = (q) => { const z = q.G.bb.getSize(V()); return Math.max(z.x, z.y, z.z); };
const pinVal = (s) => s.cf - 25 * s.of;
function groupPlace(A, placed, best, all, byVol, clr) {
  if (maxDim(A) < 25 || !holesOf(A.G).length) return null;
  const sig = (q) => q.G.bb.getSize(V()).toArray().sort((a, b) => a - b).map((v) => v.toFixed(1)).join(',') + '|' + Math.round(q.G.volume);
  const sets = {}; for (const q of byVol) if (q !== A && !placed.includes(q) && maxDim(q) < 25) (sets[sig(q)] ||= []).push(q);
  const A0 = { id: A.id, G: A.G, M: new THREE.Matrix4() }, att = [];
  for (const S of Object.values(sets).filter((x) => x.length >= 2)) {
    const p0 = S[0], ctr = p0.G.bb.getCenter(V());
    const cs = candidates(p0, [A0], clr).filter((c) => c.hole).map((M) => ({ M, s: score(p0, M, [A0]), c: ctr.clone().applyMatrix4(M) })).filter((c) => c.s.of < 0.02 && c.s.cf > 0.15);
    const holes = [];
    for (const h of holesOf(A.G)) {
      const [b, c2] = [0, 1, 2].filter((q) => q !== h.a);
      const vs = cs.filter((c) => Math.hypot(c.c.getComponent(b) - h.center.getComponent(b), c.c.getComponent(c2) - h.center.getComponent(c2)) < 1.5 && Math.abs(c.c.getComponent(h.a) - h.center.getComponent(h.a)) < 8)
        .sort((x, y) => y.s.s - x.s.s).filter((c, i, arr) => arr.findIndex((d) => d.c.distanceTo(c.c) < 0.5) === i).slice(0, 3);
      if (vs.length && holes.every((o) => o.h.center.distanceTo(h.center) > 3)) holes.push({ h, vs });
    }
    if (holes.length < 2) continue;
    holes.sort((x, y) => y.vs[0].s.s - x.vs[0].s.s);
    // copies may sit elsewhere on a plate: map each copy onto S[0]'s local frame (same orientation, translated)
    const sz0 = p0.G.bb.getSize(V());
    S.filter((q) => q.G.bb.getSize(V()).distanceTo(sz0) < 0.1).forEach((q, i) => { if (!holes[i]) return; const t = p0.G.bb.min.clone().sub(q.G.bb.min), Tq = new THREE.Matrix4().makeTranslation(t.x, t.y, t.z);
      att.push({ S: q, h: holes[i].h, vars: holes[i].vs.map((v) => ({ ...v, M: v.M.clone().multiply(Tq) })) }); });
  }
  if (!att.length) return null;
  const others = placed, tmp = new THREE.Matrix4();
  const pinsAt = (M, early = false) => { let t = 0; const ch = []; for (const a of att) { let bv = -Infinity, bvv = null; for (const v of a.vars) { const s = pinVal(score(a.S, tmp.copy(M).multiply(v.M), others)); if (s > bv) { bv = s; bvv = v; } } if (early && bv < -0.05) return { t: -1, ch }; t += bv; ch.push(bvv); } return { t: t / att.length, ch }; };
  const asm = new THREE.Box3(); others.forEach((q) => asm.union(worldBox(q)));
  const vol = (b) => { if (b.isEmpty()) return 0; const z = b.getSize(V()); return z.x * z.y * z.z; };
  // prefer the closed / pushed-in end of a slide path: penalise the share of A sticking out of the assembly
  const outOf = (M) => { const b = A.G.bb.clone().applyMatrix4(M); return 1 - vol(b.clone().intersect(asm)) / (vol(b) || 1); };
  const total = (M, pv) => { const s = score(A, M, others); return { tot: pinVal(s) + pv - 2 * outOf(M), s }; };
  // start poses: distinct top candidates of A
  const starts = [];
  for (const c of [best, ...all]) { if (starts.length >= 5) break; if (c.s.of > 0.05) continue;
    if (starts.every((o) => { const e = o.M.elements, f = c.M.elements; return Math.max(...[0, 1, 2, 4, 5, 6, 8, 9, 10].map((i) => Math.abs(e[i] - f[i]))) > 0.1 || Math.hypot(e[12] - f[12], e[13] - f[13], e[14] - f[14]) > 14; })) starts.push(c); }
  let top = null; const step = Math.max(1, A.G.r);
  for (const st of starts) {
    const pa = worldAxis(st.M, { a: att[0].h.a, s: 1 }).a, [b, c2] = [0, 1, 2].filter((q) => q !== pa), cand = [];
    const fs = 1; // coarse pass; groove clearances are a few tenths of a mm, so accept near-misses here
    for (let i = -14; i <= 14; i++) for (let j = -14; j <= 14; j++) {
      const d = V(); d.setComponent(b, i * fs); d.setComponent(c2, j * fs);
      const M = new THREE.Matrix4().makeTranslation(d.x, d.y, d.z).multiply(st.M), pv = pinsAt(M, true);
      if (pv.t > -0.5) cand.push({ M, pv: pv.t, key: pv.t - 2 * outOf(M) });
    }
    cand.sort((x, y) => y.key - x.key);
    // coarse grid hits -> fine neighbourhood (pin axis +-0.4, plane +-0.5)
    const fine = [];
    for (const c of cand.slice(0, 40)) for (const w of [-0.4, 0, 0.4]) for (const i of [-0.5, 0, 0.5]) for (const j of [-0.5, 0, 0.5]) {
      const d = V(); d.setComponent(pa, w); d.setComponent(b, i); d.setComponent(c2, j);
      const M = new THREE.Matrix4().makeTranslation(d.x, d.y, d.z).multiply(c.M), pv = pinsAt(M, true);
      if (pv.t > 0) fine.push({ M, pv: pv.t, key: pv.t - 2 * outOf(M) });
    }
    fine.sort((x, y) => y.key - x.key);
    for (const c of fine.slice(0, 60)) { const r = total(c.M, c.pv); if (r.s.of < 0.05 && (!top || r.tot > top.tot + 1e-4)) top = { M: c.M, tot: r.tot, s: r.s }; }
  }
  if (!top) return null;
  // local refinement of the whole group
  for (let it = 0; it < 6; it++) { let imp = false;
    for (let a = 0; a < 3; a++) for (const d of [-step, -step / 2, step / 2, step]) {
      const t = V(); t.setComponent(a, d); const M = new THREE.Matrix4().makeTranslation(t.x, t.y, t.z).multiply(top.M), pv = pinsAt(M).t, r = total(M, pv);
      if (r.s.of < 0.05 && r.tot > top.tot + 0.002) { top = { M, tot: r.tot, s: r.s }; imp = true; } }
    if (!imp) break; }
  const base0 = total(best.M, pinsAt(best.M).t);
  if (top.tot <= base0.tot + 1e-4 && pinsAt(best.M).t <= 0) return null;
  if (base0.tot >= top.tot) top = { M: best.M, tot: base0.tot, s: base0.s };
  const ch = pinsAt(top.M).ch; att.forEach((a, i) => { a.v = ch[i]; });
  return { best: { M: top.M, s: top.s, group: true }, att };
}

// ---------- main ----------
// print-plate layout (e.g. a slicer 3MF): every part lies on z=0 in its given pose and the XY footprints are disjoint.
// Such coordinates say nothing about the assembly, so pass 1 (keep in place) is skipped.
export function isPlateLayout(parts, poses = {}) {
  if (parts.length < 2) return false;
  const bbs = parts.map((p) => { if (!p.geometry.boundingBox) p.geometry.computeBoundingBox(); const b = p.geometry.boundingBox.clone(); return poses?.[p.id] ? b.applyMatrix4(toMat(poses[p.id])) : b; });
  if (!bbs.every((b) => Math.abs(b.min.z) < 0.5)) return false;
  for (let i = 0; i < bbs.length; i++) for (let j = i + 1; j < bbs.length; j++) {
    const a = bbs[i], b = bbs[j];
    if (a.min.x < b.max.x - 0.01 && b.min.x < a.max.x - 0.01 && a.min.y < b.max.y - 0.01 && b.min.y < a.max.y - 0.01) return false;
  }
  return true;
}

// ---------- hinge linkages (four-bar / parallelogram: mount + 2..4 links + carried part + pins) ----------
// All geometry here is analytic (hole axes refined on the mesh), not voxel-scored: links are long thin bars with a round
// hole at each end, the mount has ≥ 2 coaxial pivot-hole pairs plus screw holes on its desk face, the carried part (cup
// ring) has a matching pair of pivot pairs, pins are small round parts with a head.
const unitAx = (a, s = 1) => { const v = V(); v.setComponent(a, s); return v; };
const snapAxis = (v) => { let a = 0; for (let k = 1; k < 3; k++) if (Math.abs(v.getComponent(k)) > Math.abs(v.getComponent(a))) a = k; return unitAx(a, Math.sign(v.getComponent(a)) || 1); };
/** least-squares circle through the mesh vertices on a hole wall (local coords); teardrop tips are rejected by radius. */
function refineHole(g, h) {
  const pos = g.attributes.position, [b, c] = [0, 1, 2].filter((q) => q !== h.a), cb = h.center.getComponent(b), cc = h.center.getComponent(c), R0 = h.d / 2 + 1.2;
  let pts = [];
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getComponent(i, b), y = pos.getComponent(i, c), z = pos.getComponent(i, h.a);
    if (z < h.lo - 1 || z > h.hi + 1 || Math.hypot(x - cb, y - cc) > R0) continue; pts.push([x, y, z]);
  }
  if (pts.length < 6) return { ...h, cb, cc, rad: h.d / 2, alo: h.lo, ahi: h.hi };
  let cx = cb, cy = cc, rad = h.d / 2;
  for (let it = 0; it < 4; it++) {
    let Sx = 0, Sy = 0, Sxx = 0, Syy = 0, Sxy = 0, Sxz = 0, Syz = 0, Sz = 0, n = pts.length;
    for (const [x0, y0] of pts) { const x = x0 - cb, y = y0 - cc, z = x * x + y * y; Sx += x; Sy += y; Sxx += x * x; Syy += y * y; Sxy += x * y; Sxz += x * z; Syz += y * z; Sz += z; }
    const A = new THREE.Matrix3().set(Sxx, Sxy, Sx, Sxy, Syy, Sy, Sx, Sy, n), r = V(-Sxz, -Syz, -Sz).applyMatrix3(A.invert());
    cx = cb - r.x / 2; cy = cc - r.y / 2; rad = Math.sqrt(Math.max(0, r.x * r.x / 4 + r.y * r.y / 4 - r.z));
    const d = pts.map(([x, y]) => Math.hypot(x - cx, y - cy)), med = [...d].sort((p, q) => p - q)[d.length >> 1];
    const keep = pts.filter((_, i) => Math.abs(d[i] - med) < 0.3 && d[i] <= med + 0.3); if (keep.length < 6) break; pts = keep;
  }
  let alo = Infinity, ahi = -Infinity; for (const p of pts) { alo = Math.min(alo, p[2]); ahi = Math.max(ahi, p[2]); }
  const center = V(); center.setComponent(b, cx); center.setComponent(c, cy); center.setComponent(h.a, (alo + ahi) / 2);
  return { a: h.a, d: 2 * rad, rad, center, alo, ahi };
}
const roundHoles = (p, dmin = 3.5, dmax = 8) => (p.G.rholes ||= holesOf(p.G).filter((h) => h.d >= dmin && h.d <= dmax).map((h) => refineHole(p.geometry, h)));
/** coaxial pairs (same axis, same in-plane centre, ≥ 20 mm apart along it) -> [{a, h:[lo, hi], c}] (c = in-plane centre). */
function pivotPairs(p) {
  const hs = roundHoles(p), out = [];
  for (let i = 0; i < hs.length; i++) for (let j = i + 1; j < hs.length; j++) {
    const x = hs[i], y = hs[j]; if (x.a !== y.a) continue;
    const d = x.center.clone().sub(y.center); const ax = Math.abs(d.getComponent(x.a)); d.setComponent(x.a, 0);
    if (d.length() < 1.2 && ax > 20) out.push({ a: x.a, h: x.center.getComponent(x.a) < y.center.getComponent(x.a) ? [x, y] : [y, x], c: x.center.clone().add(y.center).multiplyScalar(0.5) });
  }
  return out;
}
function linkageInfo(P) {
  const dims = (p) => p.G.bb.getSize(V()).toArray();
  const links = [], pins = [];
  for (const p of P) {
    const s = dims(p), o = [0, 1, 2].sort((a, b) => s[b] - s[a]);
    if (s[o[0]] > 40 && s[o[0]] > 4 * s[o[1]] && s[o[2]] < 0.8 * s[o[1]]) {
      const hs = roundHoles(p, 2, 8).filter((h) => h.a === o[2]), big = hs.filter((h) => h.d >= 3.5);
      let best = null; for (const x of big) for (const y of big) { const L = x.center.distanceTo(y.center); if (x !== y && L > 0.7 * s[o[0]] && (!best || L > best.L)) best = { x, y, L }; }
      if (best) { const small = hs.filter((h) => h.d < 3.5 || (h !== best.x && h !== best.y && h.d < 0.7 * best.x.d));
        // mount end = the end nearer a detent hole (link_a); otherwise the first
        let [g, f] = [best.x, best.y]; if (small.length && small[0].center.distanceTo(f.center) < small[0].center.distanceTo(g.center)) [g, f] = [f, g];
        links.push({ p, a: o[2], long: o[0], g, f, L: best.L, t: s[o[2]], detent: small.length > 0 }); continue; }
    }
    if (s[o[0]] < 25 && s[o[0]] >= 1.2 * s[o[1]] && Math.abs(s[o[1]] - s[o[2]]) < 0.15 * s[o[1]]) pins.push(p);
  }
  if (links.length < 2) return null;
  const others = P.filter((p) => !links.some((l) => l.p === p) && !pins.includes(p));
  const cand = others.map((p) => ({ p, pp: pivotPairs(p) })).filter((x) => x.pp.length >= 2);
  if (cand.length < 2) return null;
  // mount = the pivoted part with screw holes on one face (fewest perpendicular holes, ≥ 2); carried part = the other
  const perp = (x) => roundHoles(x.p).filter((h) => h.a !== x.pp[0].a).length;
  cand.sort((x, y) => { const a = perp(x), b = perp(y); return (a >= 2 ? a : 1e9) - (b >= 2 ? b : 1e9) || y.p.G.volume - x.p.G.volume; });
  const M = cand[0], R = cand.find((x) => x !== M && x.pp.some((q) => q.a === x.pp[0].a));
  const ax = M.pp[0].a, piv = M.pp.filter((q) => q.a === ax).slice(0, 2);
  // desk face: outward normal of the bbox face carrying the screw holes; else the face farthest from the pivots
  const bb = M.p.G.bb, scr = roundHoles(M.p).filter((h) => h.a !== ax);
  let up = null;
  for (const h of scr) { const lo = h.alo - bb.min.getComponent(h.a) < 1.5, hi = bb.max.getComponent(h.a) - h.ahi < 1.5; if (lo !== hi) { up = unitAx(h.a, lo ? -1 : 1); break; } }
  if (!up) { const pc = piv[0].c.clone().add(piv[1].c).multiplyScalar(0.5); let bd = -1;
    for (let a = 0; a < 3; a++) if (a !== ax) for (const sg of [1, -1]) { const d = sg > 0 ? bb.max.getComponent(a) - pc.getComponent(a) : pc.getComponent(a) - bb.min.getComponent(a); if (d > bd) { bd = d; up = unitAx(a, sg); } } }
  // A = pivot farther from the desk (front/lower, carries the detent link), B = the other
  piv.sort((x, y) => x.c.dot(up) - y.c.dot(up));
  const [A, B] = piv, e = unitAx(ax), AB = B.c.clone().sub(A.c); AB.setComponent(ax, 0);
  let u = AB.clone().addScaledVector(up, -AB.dot(up)); u = u.lengthSq() > 1 ? snapAxis(u) : snapAxis(V().crossVectors(up, e));
  return { mount: M.p, ring: R?.p || null, ringPairs: R?.pp || [], links, pins, ax, e, up, u, A, B,
    ids: new Set([M.p, R?.p, ...links.map((l) => l.p), ...pins].filter(Boolean).map((p) => p.id)) };
}
/** place links (folded, parallel to the desk face, toward the upper pivot), carried part and pins in the mount's frame. */
function linkagePlace(LK, clr, reasons) {
  const { e, ax, up, u, A, B, mount } = LK, gap = clr + 0.1, placed = [];
  mount.M = mount.M || new THREE.Matrix4();
  const rotFor = (pairs) => ROTATIONS_24.find((R) => pairs.every(([l, w]) => l.clone().applyMatrix4(R).distanceTo(w) < 1e-6));
  const sideFace = (h, s) => (s < 0 ? h.ahi : h.alo); // lug face toward the mount centre (s = -1 left lug, +1 right lug)
  const lugIn = { A: [sideFace(A.h[0], -1), sideFace(A.h[1], 1)], B: [sideFace(B.h[0], -1), sideFace(B.h[1], 1)] };
  const Lavg = LK.links.reduce((s, l) => s + l.L, 0) / LK.links.length;
  // links: detent links on A, the rest on B, left then right
  const slots = []; const la = LK.links.filter((l) => l.detent), lb = LK.links.filter((l) => !l.detent);
  const [qa, qb] = la.length && lb.length ? [la, lb] : [LK.links.slice(0, Math.ceil(LK.links.length / 2)), LK.links.slice(Math.ceil(LK.links.length / 2))];
  for (const [list, pv, key] of [[qa, A, 'A'], [qb, B, 'B']]) list.slice(0, 2).forEach((l, i) => slots.push({ l, pv, key, side: i ? 1 : -1 }));
  for (const s of slots) {
    const { l, pv, side } = s, dl = l.f.center.clone().sub(l.g.center); dl.setComponent(l.a, 0);
    const R = rotFor([[unitAx(l.a), e], [snapAxis(dl), u]]) || rotFor([[unitAx(l.a, -1), e], [snapAxis(dl), u]]);
    const inner = lugIn[s.key][side < 0 ? 0 : 1], dir = -side, cAx = inner + dir * (gap + l.t / 2);
    const g = l.g.center.clone().applyMatrix4(R), lc = l.p.G.bb.getCenter(V()).applyMatrix4(R);
    const t = pv.c.clone().sub(g); t.setComponent(ax, cAx - lc.getComponent(ax));
    l.p.M = new THREE.Matrix4().makeTranslation(t.x, t.y, t.z).multiply(R); l.p.conf = 0.8; placed.push(l.p);
    s.outer = inner + dir * gap - (dir > 0 ? 0 : 0); s.linkOuter = inner + dir * gap; s.linkInner = inner + dir * (gap + l.t);
    reasons[l.p.id] = `hinge link (${l.L.toFixed(1)} mm between holes${l.detent ? ', detent hole' : ''}) on ${s.key === 'A' ? 'front/lower' : 'rear/upper'} pivot of ${mount.id}, ${side < 0 ? 'left' : 'right'} lug inner face, folded flat`;
  }
  // carried part: its two pivot pairs = A + L·u and B + L·u (parallelogram), level, opening toward the desk
  const ring = LK.ring, Ap = A.c.clone().addScaledVector(u, Lavg), Bp = B.c.clone().addScaledVector(u, Lavg);
  if (ring) {
    const rp = LK.ringPairs.filter((q) => q.a === LK.ringPairs[0].a).slice(0, 2), want = B.c.clone().sub(A.c); want.setComponent(ax, 0);
    const open = ring.G.cavities[0]?.open || [], ctr = ring.G.bb.getCenter(V());
    let best = null;
    for (const R of ROTATIONS_24) {
      if (Math.abs(unitAx(rp[0].a).applyMatrix4(R).dot(e)) < 0.99) continue;
      for (const [p0, p1] of [[rp[0], rp[1]], [rp[1], rp[0]]]) {
        const v = p1.c.clone().sub(p0.c).applyMatrix4(R); v.setComponent(ax, 0); const err = v.distanceTo(want); if (err > 3) continue;
        const up2 = open.some((o) => unitAx(o.a, o.s).applyMatrix4(R).dot(up) > 0.9) ? 0 : 1;
        const c0 = p0.c.clone().applyMatrix4(R), t = Ap.clone().sub(c0), cR = ctr.clone().applyMatrix4(R);
        t.setComponent(ax, (A.c.getComponent(ax)) - cR.getComponent(ax) + 0); // centred between the lugs (symmetric)
        const M = new THREE.Matrix4().makeTranslation(t.x, t.y, t.z).multiply(R), k = up2 * 10 + err;
        if (!best || k < best.k) best = { M, k, p0 };
      }
    }
    if (best) { ring.M = best.M; ring.conf = 0.8; placed.push(ring);
      // re-centre on the mount's lug mid-plane (pivot pair mid-points along the axis)
      const mid = (A.h[0].center.getComponent(ax) + A.h[1].center.getComponent(ax)) / 2, rc = best.p0.c.clone().applyMatrix4(best.M).getComponent(ax);
      const shift = mid - rc; ring.M.premultiply(new THREE.Matrix4().makeTranslation(...e.clone().multiplyScalar(shift).toArray()));
      reasons[ring.id] = `carried by the links (parallelogram: its pivot pairs sit ${Lavg.toFixed(1)} mm from the mount pivots), kept level, opening toward the desk face`; }
  }
  // pins: ground pivots first (head on the lug's outer face), then coupler pivots (head on the link's outer face)
  const pinSlots = [];
  for (const s of slots) pinSlots.push({ c: s.pv.c, side: s.side, outer: s.pv.h[s.side < 0 ? 0 : 1][s.side < 0 ? 'alo' : 'ahi'], kind: 'ground', key: s.key, link: s.l });
  for (const s of slots) pinSlots.push({ c: s.key === 'A' ? Ap : Bp, side: s.side, outer: s.linkOuter, kind: 'coupler', key: s.key, link: s.l });
  LK.pins.forEach((p, i) => {
    const s = pinSlots[i]; if (!s) return;
    const sz = p.G.bb.getSize(V()).toArray(), k = [0, 1, 2].sort((a, b) => sz[b] - sz[a])[0], { nx, ny, nz, occ } = p.G, dimk = [nx, ny, nz][k];
    const slab = (from, to) => { let n = 0; for (let z = 0; z < nz; z++) for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++) { const c = [x, y, z][k]; if (c >= from && c < to && occ[x + nx * (y + ny * z)]) n++; } return n; };
    const hs = slab(0, Math.ceil(dimk * 0.2)) >= slab(Math.floor(dimk * 0.8), dimk) ? -1 : 1; // head at -k or +k end
    const outward = unitAx(ax, s.side < 0 ? -1 : 1), R = rotFor([[unitAx(k, hs), outward]]);
    const ctr = p.G.bb.getCenter(V()).applyMatrix4(R), hb = p.G.bb.clone().applyMatrix4(R), headEnd = s.side < 0 ? hb.min.getComponent(ax) : hb.max.getComponent(ax), headLen = 0;
    const t = s.c.clone().sub(ctr); t.setComponent(ax, (s.outer + (s.side < 0 ? -1 : 1) * pinHead(p, k)) - headEnd + headLen);
    p.M = new THREE.Matrix4().makeTranslation(t.x, t.y, t.z).multiply(R); p.conf = 0.8; placed.push(p); s.pin = p;
    reasons[p.id] = `pin in the ${s.kind === 'ground' ? (s.key === 'A' ? 'front/lower' : 'rear/upper') + ' mount pivot' : 'coupler pivot (' + (s.key === 'A' ? 'front' : 'rear') + ')'} on the ${s.side < 0 ? 'left' : 'right'}, head outside`;
  });
  LK.pinSlots = pinSlots; LK.slots = slots; LK.Ap = Ap; LK.Bp = Bp; LK.Lavg = Lavg;
  return placed;
}
/** head thickness of a pin (mm): length of the wide end along its long axis k. */
function pinHead(p, k) {
  const { nx, ny, nz, occ, r } = p.G, dims = [nx, ny, nz], sl = [];
  for (let i = 0; i < dims[k]; i++) sl.push(0);
  for (let z = 0; z < nz; z++) for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++) if (occ[x + nx * (y + ny * z)]) sl[[x, y, z][k]]++;
  const nz2 = sl.filter((v) => v > 0), mx = Math.max(...nz2), mn = Math.min(...nz2.slice(Math.floor(nz2.length * 0.3), Math.ceil(nz2.length * 0.7)));
  const thr = (mx + mn) / 2; let h0 = 0, h1 = 0; const f = sl.findIndex((v) => v > 0), l = sl.length - 1 - [...sl].reverse().findIndex((v) => v > 0);
  for (let i = f; i <= l && sl[i] > thr; i++) h0++; for (let i = l; i >= f && sl[i] > thr; i--) h1++;
  return Math.max(h0, h1) * r;
}
/** hinge joints from the current poses (works for searched and in-place inputs): links swing about their mount pivot
 * from folded (parallel to the desk face) to hanging (−up); the carried part and its pins translate on the circle
 * (coupled: counter-rotation about the coupler pivot, then rotation with the link about the ground pivot). */
function linkageJoints(LK, P) {
  const { e, ax, up, mount } = LK, J = {}, wc = (p, h) => h.center.clone().applyMatrix4(p.M), inPl = (v) => { const w = v.clone(); w.setComponent(ax, 0); return w; };
  const piv = [LK.A, LK.B].map((q) => q.c);
  let ground = null, couplerAt = null, swing = 0;
  for (const l of LK.links) {
    let g = wc(l.p, l.g), f = wc(l.p, l.f);
    const dg = (x) => Math.min(...piv.map((c) => inPl(x).distanceTo(inPl(c))));
    if (dg(f) < dg(g)) [g, f] = [f, g]; if (dg(g) > 2) continue;
    const pv = piv.reduce((b, c) => (inPl(g).distanceTo(inPl(c)) < inPl(g).distanceTo(inPl(b)) ? c : b));
    const ud = inPl(f).sub(inPl(pv)).normalize(), down = up.clone().negate();
    const sg = V().crossVectors(e, ud).dot(down) >= 0 ? 1 : -1, ang = +(Math.acos(Math.max(-1, Math.min(1, ud.dot(down)))) * 180 / Math.PI).toFixed(1);
    J[l.p.id] = { type: 'hinge', axis: e.toArray(), origin: pv.toArray(), range: [0, sg * ang], confidence: 0.8,
      reason: `link: hole at each end, one on the ${pv === LK.A.c ? 'front/lower' : 'rear/upper'} pivot of ${mount.id}; swings ${ang}° from folded to hanging down`,
      note: `${pretty(l.p.id)}: swings ${ang}° down about the mount pivot` };
    if (pv === LK.A.c || !ground) { ground = pv; couplerAt = f; swing = sg * ang; }
  }
  if (!ground) return J;
  const cpl = LK.links.flatMap((l) => [wc(l.p, l.g), wc(l.p, l.f)]).filter((x) => Math.min(...piv.map((c) => inPl(x).distanceTo(inPl(c)))) > 2);
  const carried = [LK.ring, ...LK.pins.filter((p) => { const c = p.G.bb.getCenter(V()).applyMatrix4(p.M); return cpl.some((q) => inPl(c).distanceTo(inPl(q)) < 2); })].filter(Boolean);
  const cAp = inPl(couplerAt); cAp.setComponent(ax, ground.getComponent(ax));
  for (const p of carried) {
    J[p.id] = { type: 'hinge', axis: e.toArray(), origin: cAp.toArray(), range: [0, -swing], confidence: 0.7,
      chain: [{ axis: e.toArray(), origin: ground.toArray(), range: [0, swing] }],
      reason: `${p === LK.ring ? 'carried by the links (parallelogram four-bar)' : 'pin in the carried part'}: moves on a ${LK.Lavg?.toFixed?.(0) ?? ''} mm circle and stays level (counter-rotation about the coupler pivot + swing about the mount pivot)`,
      note: `${pretty(p.id)}: swings down ${Math.abs(swing)}° with the links, staying level` };
  }
  for (const p of LK.pins) if (!J[p.id]) J[p.id] = { type: 'fixed', confidence: 0.7, reason: `pin pressed into a ${mount.id} pivot`, note: `${pretty(p.id)}: pressed into ${mount.id}` };
  return J;
}

/**
 * autoAssemble(parts, opts) -> Promise<{ poses, joints, guesses, mode, collisions, timeMs }>
 * parts: [{id, geometry}] ; opts: {poses?, base?, clearance=0.3, onProgress?(done,total,msg), signal?, trustInPlace=true}
 * result.layout = 'plate' when the input is a print-plate layout (pass 1 skipped, everything searched)
 */
export async function autoAssemble(parts, opts = {}) {
  const t0 = Date.now(), { signal, onProgress, clearance = 0.3 } = opts;
  const tick = async (done, total, msg) => { onProgress?.(done, total, msg); await new Promise((r) => setTimeout(r, 0)); if (signal?.aborted) throw abortErr(); };
  if (signal?.aborted) throw abortErr();
  const P = parts.map((p) => ({ id: p.id, geometry: p.geometry, given: toMat(opts.poses?.[p.id]) }));
  for (let i = 0; i < P.length; i++) { P[i].G = buildGrid(P[i].geometry); await tick(i + 1, P.length * 3, `analysed ${P[i].id}`); }
  const byVol = [...P].sort((a, b) => b.G.volume - a.G.volume);
  const LK = opts.linkage === false ? null : linkageInfo(P); // hinge linkage (mount + links + carried part + pins)?
  const base = P.find((p) => p.id === opts.base) || LK?.mount || byVol[0];
  let baseW = base.given.clone(); const baseInv = baseW.clone().invert();

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
  const plate = isPlateLayout(parts, opts.poses);
  if (plate) P.forEach((p) => { if (p !== base) why[p.id] = 'print-plate layout: position ignored'; });
  if (opts.trustInPlace !== false && P.length > 1 && !plate) {
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
    // linkage: links / carried part / pins placed analytically on the mount's pivot holes; pass 2 handles the rest
    const pre = LK && base === LK.mount ? linkagePlace(LK, clearance, reasons) : [];
    // pass 2: feature/fit search for the rest, largest first
    const placed = [...new Set([...keep.kept, ...pre])]; let k = 0;
    for (const A of byVol.filter((p) => !placed.includes(p))) {
      if (placed.includes(A)) continue; // already placed as part of a group
      const asm = new THREE.Box3(); placed.forEach((q) => asm.union(worldBox(q))); const bv = (b) => { const z = b.getSize(V()); return z.x * z.y * z.z; }, av = bv(asm);
      // flush with the assembly outline is preferred (small penalty for growing the overall bounding box)
      const sc = (M, bonus, face = true) => { const s = score(A, M, placed); s.s += (bonus && s.cf > 0.05 ? bonus : 0) - (face ? 0.1 : 0) * (bv(asm.clone().union(A.G.bb.clone().applyMatrix4(M))) - av) / av; return s; };
      const all = candidates(A, placed, clearance).map((C) => ({ M: C, s: sc(C, C.bonus, !!C.face), face: C.face, bonus: C.bonus, hole: C.hole, holeAxis: C.holeAxis }));
      all.sort((x, y) => y.s.s - x.s.s); let best = all[0] || null;
      // mating faces with tongues/dovetails: slide face candidates into the assembly while contact grows and overlap stays tiny
      for (const c of [...all.filter((c) => c.face).slice(0, 12), ...all.filter((c) => c.face && c.face.flat && c.s.of < 0.01).slice(0, 160)]) {
        const step = A.G.r / 2, n = Math.ceil(Math.min(0.4 * c.face.sz, 15) / step);
        for (let k = 1; k <= n; k++) {
          const d = V(); d.setComponent(c.face.a, -c.face.side * k * step);
          const M = new THREE.Matrix4().makeTranslation(d.x, d.y, d.z).multiply(c.M), s = sc(M, c.bonus);
          if (s.of > c.s.of + 0.005) break;
          if (s.s > best.s.s + 0.005) best = { M, s };
        }
      }
      // group placement: identical small fasteners (≥ 2 copies) that fit A's own holes are attached to A first, then A + pins
      // is positioned as one rigid group (e.g. a drawer hanging on pins in housing grooves: the pins must not hit walls)
      const grp = opts.group !== false && best ? groupPlace(A, placed, best, all, byVol, clearance) : null;
      if (grp) best = grp.best;
      if (best && best.s.cf > 0.02 && best.s.of < 0.05) {
        if (grp) { A.M = best.M; for (const a of grp.att) { a.S.M = best.M.clone().multiply(a.v.M); const s = score(a.S, a.S.M, [...placed, A]);
          a.S.conf = +Math.max(0.05, Math.min(0.95, s.cf * 2 - s.of * 10)).toFixed(2);
          reasons[a.S.id] = `${why[a.S.id] ? 'pass 1: ' + why[a.S.id] + '; ' : ''}placed with ${A.id} as a group: fastener in its hole, contact ${(s.cf * 100).toFixed(0)}%, overlap ${(s.of * 100).toFixed(1)}%`; } }
        else A.M = best.hole ? (best.holeAxis !== undefined ? refine(A, best.M, placed, [best.holeAxis]) : best.M) : refine(A, best.M, placed);
        const s = score(A, A.M, placed); // hole-aligned: keep the axis exact
        A.conf = +Math.max(0.05, Math.min(0.95, s.cf * 2 - s.of * 10)).toFixed(2);
        reasons[A.id] = `${why[A.id] ? 'pass 1: ' + why[A.id] + '; ' : ''}best of ${ROTATIONS_24.length} rotations × cavity/face alignments: contact ${(s.cf * 100).toFixed(0)}% of surface, overlap ${(s.of * 100).toFixed(1)}%`;
        placed.push(A); if (grp) { for (const a of grp.att) placed.push(a.S); reasons[A.id] += `; positioned together with ${grp.att.length} fasteners (${grp.att.map((a) => a.S.id).join(', ')})`; }
      } else { A.M = A.M || new THREE.Matrix4(); A.conf = 0; A.unmatched = true; reasons[A.id] = `${why[A.id] ? 'pass 1: ' + why[A.id] + '; ' : ''}no fitting placement found; left in place`; }
      await tick(P.length + ++k, P.length * 3, `placed ${A.id}`);
    }
  }

  // collision-aware refine: placements come from a ~0.4–1 mm voxel score, so neighbours often interpenetrate by a
  // fraction of a mm (checkPose counts any triangle crossing). Nudge each searched part (largest first) by ≤1.5 mm
  // along the base axes to reduce the number of parts it intersects, keeping ≥60 % of its contact.
  if (!inPlace && opts.refine !== false) {
    const keptSet = new Set(keep.kept.map((q) => q.id)), bvhOf = (q) => q.geometry.boundsTree || (q.geometry.boundsTree = new MeshBVH(q.geometry));
    const hits = (p, M) => { const bb = p.G.bb.clone().applyMatrix4(M); let n = 0;
      for (const q of P) { if (q === p || q.unmatched || !bb.intersectsBox(worldBox(q))) continue;
        if (bvhOf(q).intersectsGeometry(p.geometry, q.M.clone().invert().multiply(M))) n++; } return n; };
    const order = P.filter((p) => p !== base && !p.unmatched && !keptSet.has(p.id) && !LK?.ids.has(p.id) && !pinAxis(p) && !(worldBox(p).getSize(V()).toArray().every((v) => v < 25) && p.G.volume < 0.01 * base.G.volume)) // pins / small fasteners: press fits, reported in result.expected.sort((a, b) => b.G.volume - a.G.volume);
    let moved = 0;
    for (const p of order) {
      let n0 = hits(p, p.M); if (!n0) continue;
      const cf0 = score(p, p.M, P.filter((q) => q !== p)).cf, M0 = p.M.clone(), off = V();
      for (const st of [1, 0.5, 0.25]) {
        let improved = true;
        while (improved && n0) { improved = false;
          for (let a = 0; a < 3 && !improved; a++) for (const sg of [1, -1]) {
            const d = off.clone(); d.setComponent(a, d.getComponent(a) + sg * st); if (d.length() > 1.5) continue;
            const M = new THREE.Matrix4().makeTranslation(d.x, d.y, d.z).multiply(M0), n = hits(p, M); if (n >= n0) continue;
            if (score(p, M, P.filter((q) => q !== p)).cf < 0.6 * cf0) continue;
            off.copy(d); p.M = M; n0 = n; improved = true; break; }
        }
      }
      if (off.lengthSq()) { moved++; reasons[p.id] += `; refined by [${off.toArray().map((v) => +v.toFixed(2))}] mm to clear neighbours`; }
    }
  }

  for (const p of P) {
    const s = score(p, p.M, P.filter((q) => q !== p));
    p.matedTo = Object.entries(s.perOther).sort((a, b) => b[1].c - a[1].c).find(([, v]) => v.c > 0)?.[0] ?? null;
  }
  // joint inference
  const J = {};
  const childrenOf = (p) => new Set(P.filter((q) => q.matedTo === p.id && q.G.volume < p.G.volume).map((q) => q.id));
  let k2 = 0; const pinParent = {};
  for (const p of P) {
    if (p !== base && LK?.ids.has(p.id)) { J[p.id] = { type: 'fixed', confidence: 0.5, reason: 'linkage' }; continue; }
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
    // push button / rod sticking out of the housing: it moves INTO the housing (toward the base centre), and its range is the
    // travel until it hits the housing itself (parts it drives, e.g. a lever, move out of the way), capped for small parts
    let push = null;
    const out0 = trav[0];
    if (rodOf(p.G) && out0.t >= out0.ext * 1.2) { const c = worldBox(base).getCenter(V()).sub(wb.getCenter(V()));
      const inn = trav.find((x) => x.a === out0.a && x.s !== out0.s);
      if (inn && inn.d.dot(c) > 0) { const t = travel(p, P, inn.d, inn.ext * 1.2 + 2, new Set(P.filter((q) => q !== base).map((q) => q.id)));
        const cap = Math.min(5, 0.25 * inn.ext); /* button-sized travel */ if (t >= 1) push = { d: inn, t: +Math.min(t, cap).toFixed(1), blocked: +inn.t.toFixed(1) }; } }
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
      // driven by a push rod (button): press the rod to its stop and find the smallest swing (either way) that clears it,
      // without hitting the base -> that is the lever's travel to its first contact and the direction the rod drives it
      let drivenBy = null;
      for (const r2 of P) { if (r2 === p || r2 === base || r2 === q || !rodOf(r2.G)) continue; const s2 = score(r2, r2.M, [p]); if (!worldBox(r2).expandByScalar(1).intersectsBox(wb)) continue;
        const rb = worldBox(r2), c = worldBox(base).getCenter(V()).sub(rb.getCenter(V())), sz = rb.getSize(V()).toArray(), ra = sz.indexOf(Math.max(...sz));
        const d = V(); d.setComponent(ra, Math.sign(c.getComponent(ra)) || 1); const ext = sz[ra];
        const t = Math.min(travel(r2, P, d, ext * 1.2 + 2, new Set(P.filter((o) => o !== base).map((o) => o.id))), 5, 0.25 * ext); if (t < 1) continue;
        const save = r2.M.clone(); r2.M = new THREE.Matrix4().makeTranslation(d.x * t, d.y * t, d.z * t).multiply(save);
        const onlyBaseRod = new Set(P.filter((o) => o !== base && o !== r2).map((o) => o.id)), clear = (sg) => { for (let a = 0.5; a <= 45; a += 0.5) {
          const R = new THREE.Matrix4().makeRotationAxis(axis, THREE.MathUtils.degToRad(sg * a)), o = pa.center;
          const M = new THREE.Matrix4().makeTranslation(o.x, o.y, o.z).multiply(R).multiply(new THREE.Matrix4().makeTranslation(-o.x, -o.y, -o.z)).multiply(p.M);
          const sc2 = score(p, M, P, onlyBaseRod); if (sc2.of <= 0.01) return a; if ((sc2.perOther[base.id]?.o || 0) > 0 && a > 4) return null; } return null; };
        const ap = clear(1), am = clear(-1); r2.M = save;
        const cands = [[1, ap], [-1, am]].filter((x) => x[1] != null).sort((x, y) => x[1] - y[1]);
        if (cands.length) { drivenBy = { r: r2, sg: cands[0][0], a: cands[0][1], t: +t.toFixed(1) }; break; } }
      // a lever that kicks a part with a slot path: it swings until it meets that part at the end of its slide (coupled stop)
      if (drivenBy) { const kicked = P.filter((o) => J[o.id]?.type === 'path');
        if (kicked.length) { const saved = [];
          for (const o of kicked) { const pos = J[o.id].keyframes[1].value.pos, T = new THREE.Matrix4().makeTranslation(...pos);
            for (const m of [o, ...Object.keys(pinParent).filter((id) => pinParent[id] === o.id).map((id) => P.find((x) => x.id === id))]) { saved.push([m, m.M.clone()]); m.M = T.clone().multiply(m.M); } }
          const keep = new Set([base.id, ...saved.map(([m]) => m.id)]), a2 = swing(p, P, axis, pa.center, drivenBy.sg, new Set(P.filter((o) => !keep.has(o.id)).map((o) => o.id)), 0.5);
          for (const [m, M] of saved) m.M = M;
          if (a2 > drivenBy.a) { drivenBy.a = a2; drivenBy.kick = kicked.map((o) => o.id).join('/'); } } }
      if (drivenBy) { if (drivenBy.sg > 0) plus = drivenBy.a; else minus = drivenBy.a; drv = ` (driven by ${drivenBy.r.id}, pressed ${drivenBy.t} mm; swings ${drivenBy.a}°${drivenBy.kick ? ` until it meets ${drivenBy.kick} at the end of its slide` : ' to clear it'})`; }
      const m = Math.max(plus, minus); if (m < 6 && !(wb.containsPoint(pa.center) && m > 0)) continue;
      const sgn = drivenBy ? drivenBy.sg : plus >= minus ? 1 : -1, m2 = drivenBy ? drivenBy.a : m;
      hinge = { type: 'hinge', axis: axis.toArray(), origin: pa.center.toArray().map((v) => +v.toFixed(2)), range: [0, sgn * m2], confidence: 0.6,
        reason: `pin-in-hole: ${q.id} (axis ${AX[pa.a]}) passes through; free swing ${plus}° / −${minus}°${drv}`,
        note: `${pretty(p.id)}: swings ${m2}° about ${q.id} (${AX[pa.a]} axis)` };
      break;
    }
    J[p.id] = null;
    if (!hinge && push) J[p.id] = { type: 'slider', axis: push.d.d.toArray(), range: [0, push.t], confidence: 0.7,
      reason: `push rod: escapes ${dirName(out0)} (out of the housing), so it is pressed ${dirName(push.d)} into ${base.id}; stops after ${push.t} mm against ${base.id}${push.blocked < push.t ? ` (drives the part it touches after ${push.blocked} mm)` : ''}`,
      note: `${pretty(p.id)}: pushes ${push.t} mm in along ${dirName(push.d)}` };
    // part hanging on ≥ 2 pins of its own (pins inside its bbox, along one axis): try the slot path the pins allow, i.e.
    // slide out until the pins stop in their grooves, then tilt about the pin that stays put (e.g. v3 tilt-out drawer)
    if (!J[p.id] && !hinge && !rodOf(p.G)) {
      const pins = P.filter((q) => q !== p && q !== base && Math.max(...worldBox(q).getSize(V()).toArray()) < 25 && q.G.volume < 0.05 * p.G.volume && wb.clone().expandByScalar(2).containsPoint(worldBox(q).getCenter(V())) && score(q, q.M, [p]).perOther[p.id]?.c > 0);
      // pin axis: the axis along which every pin sits at one of the part's side faces
      const side = (a) => pins.reduce((m, q) => { const c = worldBox(q).getCenter(V()).getComponent(a); return Math.max(m, Math.min(Math.abs(c - wb.min.getComponent(a)), Math.abs(c - wb.max.getComponent(a)))); }, 0);
      const pa = pins.length >= 1 ? [0, 1, 2].sort((a, b) => side(a) - side(b))[0] : -1;
      if (pa >= 0 && side(pa) < 8) {
        const G = [p, ...pins], gs = new Set(G.map((q) => q.id)), sk2 = new Set(P.filter((q) => q !== base && J[q.id]?.type !== 'fixed').map((q) => q.id).concat([...gs])), pc = (q) => worldBox(q).getCenter(V()); let path = null;
        for (const x of trav) { if (x.a === pa) continue;
          const t1 = groupTravel(G, P, x.d, Math.min(30, x.ext * 0.5), gs, 0.5); if (t1 < 2) continue;
          const T1 = new THREE.Matrix4().makeTranslation(x.d.x * t1, x.d.y * t1, x.d.z * t1), ax = V(); ax.setComponent(pa, 1);
          for (const q of pins) { const o = pc(q).add(x.d.clone().multiplyScalar(t1));
            for (const sg of [1, -1]) { const sw = groupSwing(G, P, ax, o, sg, sk2, T1, 60, 2, pa), a = sw.a; if (a >= 10 && (!path || a > path.a || (a === path.a && sw.sh.length() < path.sh.length()))) path = { x, t1, q, o: pc(q), sg, a, ax, sh: sw.sh }; } } }
        if (path) { const { x, t1, q, o, sg, a, ax, sh } = path, pos = x.d.clone().multiplyScalar(t1).toArray().map((v) => +v.toFixed(2)), pos2 = x.d.clone().multiplyScalar(t1).add(sh).toArray().map((v) => +v.toFixed(2));
          J[p.id] = { type: 'path', axis: ax.toArray(), origin: o.toArray().map((v) => +v.toFixed(2)), range: [0, 1], confidence: 0.55,
            keyframes: [{ t: 0, value: { pos: [0, 0, 0], angle: 0 } }, { t: 0.3, value: { pos, angle: 0 } }, { t: 1, value: { pos: pos2, angle: sg * a } }],
            reason: `hangs on ${pins.length} pins (${pins.map((r) => r.id).join(', ')}) in grooves of ${base.id}: slides ${t1} mm ${dirName(x)} until the pins stop, then tilts ${a}° about ${q.id}`,
            note: `${pretty(p.id)}: slides ${t1} mm ${dirName(x)}, then tilts ${a}° about its ${q.id} pin` };
          for (const r of pins) pinParent[r.id] = p.id; } } }
    if (!J[p.id] && !hinge && best.t >= 2 && perp.every((x) => x.t < 0.5 * best.t || (x.t < best.ext * 1.2 && x.t <= 6)) && (inside > 0.5 || !escapes)) {
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
  for (const [id, par] of Object.entries(pinParent)) J[id] = { type: 'fixed', parent: par, confidence: 0.6, reason: `pin of ${par}, rides in its groove`, note: `${pretty(id)}: moves with ${par}` };
  for (const p of P) {
    if (J[p.id].type !== 'fixed' || p === base || !p.matedTo) continue;
    const m = P.find((q) => q.id === p.matedTo);
    if (J[m.id].type !== 'fixed' && m.matedTo !== p.id && m.G.volume > p.G.volume) {
      J[p.id] = { type: 'fixed', parent: m.id, confidence: 0.5, reason: `attached to moving ${m.id} (largest contact)`, note: `${pretty(p.id)}: moves with ${m.id}` };
    }
  }

  if (LK && base === LK.mount) Object.assign(J, linkageJoints(LK, P));

  // ---- upright orientation (plate layouts, or opts.orient): one global rotation so the result faces forward like the
  // presets: backplate / back at +Y, drawer pulls out toward −Y (viewer), Z up (SKADIS hooks at the top), lowest point on z=0.
  let orient = null;
  // Always evaluated (deterministic; same result on main thread and in the worker) unless opts.orient === false; for
  // non-plate inputs that are already upright it is a no-op, so re-running on an assembled result keeps it in place.
  if (opts.orient !== false) {
    const snap = (v, not) => { let b = null; for (let a = 0; a < 3; a++) for (const s of [1, -1]) { const d = V(); d.setComponent(a, s); if (not && Math.abs(d.dot(not)) > 0.5) continue; if (!b || d.dot(v) > b.dot(v)) b = d; } return b; };
    const ctr = (q) => worldBox(q).getCenter(V()), bc = ctr(base), bsz0 = worldBox(base).getSize(V()).toArray().sort((a, b) => b - a);
    const bp = P.find((q) => q !== base && !q.unmatched && J[q.id].type === 'fixed' && !J[q.id].parent && (() => { const z = worldBox(q).getSize(V()).toArray().sort((a, b) => b - a); return z[2] < 0.25 * z[1] && z[0] * z[1] > 0.4 * bsz0[0] * bsz0[1]; })());
    const dr = P.find((q) => J[q.id].type === 'path' || (J[q.id].type === 'slider' && !rodOf(q.G)));
    let fwd = null, back = null, up = null, why2 = [];
    const desk = LK && base === LK.mount; // desk-mount linkage: screw face up at z = 0, links fold toward +Y, swing down toward −Y
    if (desk) { back = LK.u.clone(); up = LK.up.clone(); why2.push(`desk mount: screw face of ${base.id} up (against the desk underside), links fold toward the back and swing down toward the viewer`); }
    else if (dr) { const j = J[dr.id];
      if (j.type === 'path') fwd = V(...j.keyframes[1].value.pos);
      else { const r = j.range, t = Math.abs(r[1]) >= Math.abs(r[0]) ? r[1] : r[0]; fwd = V(...j.axis).multiplyScalar(Math.sign(t) || 1); }
      if (fwd.lengthSq() < 1e-9) fwd = null; }
    if (fwd) { back = fwd.clone().negate(); why2.push(`back = opposite of ${dr.id} pull-out`); }
    else if (bp) { back = ctr(bp).sub(bc); why2.push(`back = ${bp.id}`); }
    if (back && back.lengthSq() > 1e-6) {
      back = snap(back);
      const bt = !up && P.find((q) => J[q.id].type === 'slider' && rodOf(q.G));
      if (bt) { const u = ctr(bt).sub(bc); u.addScaledVector(back, -u.dot(back)); if (u.length() > 1) { up = snap(u, back); why2.push(`up = ${bt.id} on top`); } }
      if (!up && bp) { // SKADIS hooks: the rear-most vertices of the backplate sit near its top edge
        const a = bp.geometry.attributes.position, v = V(), pts = []; let mx = -Infinity, mn = Infinity;
        for (let i = 0; i < a.count; i++) { v.fromBufferAttribute(a, i).applyMatrix4(bp.M); const d = v.dot(back); pts.push([d, v.clone()]); mx = Math.max(mx, d); mn = Math.min(mn, d); }
        const m = V(); let n = 0; for (const [d, q] of pts) if (d >= mx - 0.25 * (mx - mn)) { m.add(q); n++; }
        const u = m.divideScalar(n).sub(ctr(bp)); u.addScaledVector(back, -u.dot(back));
        if (u.length() > 0.1 * worldBox(bp).getSize(V()).length()) { up = snap(u, back); why2.push('up = backplate hooks'); } }
      if (!up) { up = snap(V(0, 0, 1), back); why2.push('up = nearest to given +Z'); }
      const x = V().crossVectors(back, up);
      const Gm = new THREE.Matrix4().makeBasis(x, back, up).transpose();
      const bb = new THREE.Box3(); for (const q of P) if (!q.unmatched) bb.union(worldBox(q).applyMatrix4(Gm));
      const c0 = worldBox(base).applyMatrix4(baseW).getCenter(V()), c1 = worldBox(base).applyMatrix4(Gm).getCenter(V());
      const Rg = new THREE.Matrix4().extractRotation(baseW), same = Gm.elements.every((v, i) => Math.abs(v - Rg.elements[i]) < 1e-3);
      if (plate || !same || opts.orient === true) {
        baseW = new THREE.Matrix4().makeTranslation(c0.x - c1.x, c0.y - c1.y, desk ? -bb.max.z : -bb.min.z).multiply(Gm);
        orient = { rotation: Gm.toArray(), reason: why2.join(', ') + (plate ? '' : same ? '' : ' (input was not upright: re-oriented)') };
      } else orient = { rotation: Gm.toArray(), reason: why2.join(', ') + ' (already upright: kept given pose)' };
    }
  }

  // ---- output (world frame = base's given pose, or the upright frame above) ----
  const W = Object.fromEntries(P.map((p) => [p.id, baseW.clone().multiply(p.M)]));
  const R3 = new THREE.Matrix4().extractRotation(baseW);
  const poses = [], joints = [], guesses = [];
  // role per part, from joint type + geometry (for UI labels / colours)
  const bsz = worldBox(base).getSize(V()).toArray().sort((a, b) => b - a);
  const roleOf = (p) => { const j = J[p.id], sz = worldBox(p).getSize(V()).toArray().sort((a, b) => b - a);
    if (p === base) return 'base';
    if (p.unmatched) return 'part';
    if (LK?.ids.has(p.id)) return LK.pins.includes(p) ? 'pin' : p === LK.ring ? 'carrier' : 'link';
    if (j.type === 'path') return 'drawer';
    if (j.type === 'slider') return rodOf(p.G) ? 'button' : 'drawer';
    if (j.type === 'hinge') return 'lever';
    if (pinParent[p.id] || pinAxis(p) || (sz[0] < 25 && p.G.volume < 0.01 * base.G.volume)) return 'pin';
    if (sz[2] < 0.25 * sz[1] && sz[0] * sz[1] > 0.4 * bsz[0] * bsz[1]) return 'backplate';
    return 'part'; };
  const roles = Object.fromEntries(P.map((p) => [p.id, roleOf(p)]));
  for (const p of P) {
    const j = J[p.id], w = W[p.id];
    const note = j.note || (p === base ? `${pretty(p.id)}: base, stays put` : p.unmatched ? `${pretty(p.id)}: could not place (left as is)` : `${pretty(p.id)}: fixed to ${p.matedTo || 'nothing'}`);
    poses.push({ id: p.id, role: roles[p.id], matrix: w.toArray(), confidence: p.conf ?? 0, reason: reasons[p.id], note });
    const offset = j.parent ? W[j.parent].clone().invert().multiply(w) : w;
    joints.push({ part: p.id, type: 'fixed', offset: offset.toArray(), ...(j.parent ? { parent: j.parent } : {}), confidence: p.conf ?? 0, reason: reasons[p.id], note: j.parent ? j.note : note });
    let mj = null;
    if (j.type === 'slider') mj = { part: p.id, type: 'slider', axis: V(...j.axis).transformDirection(R3).toArray().map((v) => +v.toFixed(6)), range: j.range };
    if (j.type === 'path') mj = { part: p.id, type: 'path', axis: V(...j.axis).transformDirection(R3).toArray().map((v) => +v.toFixed(6)), origin: V(...j.origin).applyMatrix4(baseW).toArray(), range: j.range,
      keyframes: j.keyframes.map((k) => ({ t: k.t, value: { pos: V(...k.value.pos).transformDirection(R3).multiplyScalar(V(...k.value.pos).length()).toArray().map((v) => +v.toFixed(3)), angle: k.value.angle } })) };
    if (j.type === 'hinge') mj = { part: p.id, type: 'hinge', axis: V(...j.axis).transformDirection(R3).toArray().map((v) => +v.toFixed(6)), origin: V(...j.origin).applyMatrix4(baseW).toArray(), range: j.range };
    if (mj) joints.push({ ...mj, confidence: j.confidence, reason: j.reason, note: j.note });
    for (const c of j.chain || []) joints.push({ part: p.id, type: 'hinge', axis: V(...c.axis).transformDirection(R3).toArray().map((v) => +v.toFixed(6)), origin: V(...c.origin).applyMatrix4(baseW).toArray(), range: c.range, confidence: j.confidence, reason: j.reason, note: j.note });
    guesses.push({ part: p.id, role: roles[p.id], matedTo: p.matedTo, poseConfidence: p.conf ?? 0, joint: j.parent ? 'fixed(parent ' + j.parent + ')' : j.type, jointConfidence: j.confidence, reason: reasons[p.id] + ' | ' + j.reason, note: j.note || note });
  }
  const cp = checkPose(P, W, { tolerance: 0 });
  // designed contacts (preset `expected` format, world frame of the result): pins pressed into holes, backplate on the
  // base's back face. The UI can pass these to classify(); everything else in `collisions` is a real problem.
  const expected = [];
  for (const { a, b } of cp.collisions) {
    const ra = roles[a], rb = roles[b], why = ra === 'pin' || rb === 'pin' ? `pin ${ra === 'pin' ? pretty(a) : pretty(b)} press-fit in its hole`
      : [ra, rb].includes('base') && [ra, rb].includes('backplate') ? 'backplate mounted flush on the base back (dovetail/press contact)' : null;
    if (!why) continue;
    const pa = P.find((q) => q.id === a), pb = P.find((q) => q.id === b);
    const bx = pa.G.bb.clone().applyMatrix4(W[a]).intersect(pb.G.bb.clone().applyMatrix4(W[b])).expandByScalar(0.5);
    expected.push({ a, b, box: [bx.min.toArray().map((v) => +v.toFixed(2)), bx.max.toArray().map((v) => +v.toFixed(2))], reason: why });
  }
  return { poses, joints, guesses, roles, expected, layout: plate ? 'plate' : 'assembly', orient, mode: inPlace ? 'in-place' : keep.kept.length > 1 ? 'mixed' : 'search', kept: keep.kept.map((p) => p.id), pass1: { frame, rejected: why }, base: base.id, collisions: cp.collisions.map(({ a, b }) => ({ a, b })), timeMs: Date.now() - t0 };
}

