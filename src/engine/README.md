# Motion + collision engine (`src/engine/`)
ES modules, three.js + three-mesh-bvh. Units: **mm**. Works in browser (Vite) and Node.

```js
import { checkPose, solveJoints, sweep, loadSTL } from './engine/index.js';
import { presets } from './engine/presets/index.js';
```

## loadSTL(urlOrArrayBuffer) -> Promise<THREE.BufferGeometry>
URL (fetch) or ArrayBuffer; in Node a file path also works.

## checkPose(parts, poses, { tolerance=0.5, ignorePairs=[], maxPoints=20 })
- `parts`: `[{ id, geometry }]`; `poses`: `{ id: THREE.Matrix4 | number[16] (column-major) }` (missing = identity).
- Returns `{ collisions: [{a,b,points:[[x,y,z],...]}], nearMisses: [{a,b,minGap,points:[pA,pB]}] }` in world mm.
- Collision = surfaces intersect (`MeshBVH.intersectsGeometry`; points from triangle-triangle intersection segments).
  Near miss = no intersection and `closestPointToGeometry` gap < tolerance. Note: a part fully *inside* another without surface crossing is not reported.
- `ignorePairs: [['a','b'], ...]` (order-free) skips intentional contacts.

## solveJoints(joints, t) -> { partId: THREE.Matrix4 }
Joint: `{ type:'fixed'|'slider'|'hinge'|'path', part, parent?, axis:[x,y,z], origin:[x,y,z], range:[min,max], keyframes?, offset? }`
- `t` number 0..1 for all joints, or `{ partId: 0..1 }` per joint.
- slider: translate `value` mm along axis; hinge: rotate `value` degrees about axis through origin.
  Value = lerp(range, t), or from `keyframes: [{t, value}]` (piecewise linear) -> sequencing (e.g. hold, move, hold).
- path: `keyframes: [{t, value:{pos:[x,y,z], angle:deg}}]` -> rotate `angle` about axis through `origin`, then translate `pos` (compound slide-then-rotate).
- fixed: static `offset` matrix (16 numbers or Matrix4).
- Several joints on one part compose in listed order (each later one applied in world frame). `parent` makes the part's pose relative to the parent part's world pose.

## sweep(parts, joints, { steps=20, tolerance, ignorePairs }) -> [{ t, poses, collisions, nearMisses }]

## sweepAsync(parts, joints, opts, onProgress?) -> Promise<steps>
Runs in a module Web Worker (`sweep.worker.js`) in the browser, so the UI doesn't freeze. Elsewhere it falls back to a chunked loop on the main thread.
`onProgress(done, total, step)` is called after each step. Poses in the results are 16-number arrays, not Matrix4.
Cancel with `opts.signal` (an AbortSignal). On abort the worker is terminated and the promise rejects with `DOMException` named `'AbortError'`. The non-worker fallback checks the signal between steps. A signal that is already aborted rejects straight away.
```js
const ac = new AbortController();
sweepAsync(parts, joints, { steps: 40, tolerance: 0.3, signal: ac.signal }, (d, n) => setProgress(d / n))
  .catch((e) => { if (e.name !== 'AbortError') throw e; });
ac.abort(); // e.g. when the user changes the preset
```

## classify(result, expected) -> result with `expected: reason|false` on every collision and near miss
A hit counts as expected when all its points fall inside the `expected` boxes for that same pair. Use this to colour hits (amber = expected, red = real). The test uses the same function.

## Performance
Each geometry's BVH is cached and attached as `geometry.boundsTree`, so pair queries are BVH-vs-BVH. A world-AABB prefilter (expanded by `tolerance`) skips far-apart pairs. All 3 presets at 41 steps take about 6 s in Node (it was about 35 s).

## Presets (`presets/`)
`{ id, name, base:'/models/', parts:[{id,file}], joints, ignorePairs, expected:[{a,b,box:[[min],[max]],reason}] }`.
`expected` = designed contact regions (flex latch bump, heart-cam follower, leaf springs, lever kick, pin-in-groove);
a collision whose points all fall in a matching box should be shown as "expected" (amber) rather than error. STLs in `public/models/`.
- v1 button latch: drawer slides out 0..80 mm (-Y).
- v2 push-open: latched(-1.2) -> overtravel(+3) -> latched -> eject(-10) -> out(-80).
- v3 tilt-out: t 0..0.3 button 4.6 mm + lever 12.8° + drawer kick 10 mm/0.8 mm lift; t 0.3..1 tilt 0..40° about rear pin.

## Test
`npm test` (= `node src/engine/engine.test.js`). Defaults to 41 steps (steps=40) and 0.3 mm tolerance, the same as the UI. Override with env `STEPS` / `TOL`.
The test fails on any collision or near miss (gap < tolerance) that isn't covered by the preset's `expected` boxes.
