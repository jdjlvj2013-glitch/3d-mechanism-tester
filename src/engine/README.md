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

## autoAssemble (heuristic auto-placement + joint inference)

```js
import { autoAssemble, autoAssembleAsync } from './src/engine/index.js';
const r = await autoAssemble(parts, { poses, base, clearance: 0.3, onProgress, signal });
// autoAssembleAsync(parts, opts): same result, runs in a module Worker in the browser (Node: same as autoAssemble)
```
- `parts`: `[{id, geometry}]`. `opts.poses`: current poses `{id: Matrix4|16 numbers}` (missing = identity). `opts.base`: the part id to keep fixed; by default the part with the largest volume. `opts.clearance`: the gap left when a part is seated into a cavity (default 0.3 mm). `opts.trustInPlace=false` skips pass 1.
- `onProgress(done, total, message)`. `signal`: an AbortSignal, checked between parts. The promise rejects with `AbortError`, and the Worker is terminated.
- Returns:
  - `poses: [{id, matrix (16 numbers, column-major), confidence 0..1, reason, note}]`, in the base part's frame as given.
  - `joints: [{part, type: 'fixed'|'slider'|'hinge', offset?, parent?, axis?, origin?, range?, confidence, reason, note}]`. These feed straight into `solveJoints`. Each part gets a `fixed` joint whose `offset` is its pose (relative to `parent` when it rides on a moving part), followed by its motion joint in world axes. Slider ranges are in mm and hinge ranges in degrees.
  - `guesses: [{part, matedTo, poseConfidence, joint, jointConfidence, reason, note}]`, `mode: 'in-place'|'mixed'|'search'`, `kept` (ids kept by pass 1), `pass1: {frame: 'poses'|'raw', rejected: {id: reason}}`, `layout: 'plate'|'assembly'`, `base`, `collisions` (pairs from `checkPose`, tolerance 0), `timeMs`.
  - `note` is human-readable, e.g. `Drawer: slides 90 mm out along −Y`.
- **Pass 1, in-place (per part):** both `opts.poses` and the raw STL coordinates (identity) are tried; the frame keeping more parts wins. Starting from the base, a part is kept if its bbox (+1 mm) touches a kept part, its voxel overlap is ≤ 3 %, and it has contact (or sits nested inside a kept part, e.g. a pin in a hole). All kept → `in-place`; some kept → `mixed` (only the rest are searched); else `search`. Rejection reasons are in `pass1.rejected` and prefixed to each part's `reason`.
- **Print-plate layouts** (e.g. a slicer 3MF with several objects): `isPlateLayout(parts, poses)` is true when every part's bbox starts at z = 0 and the XY footprints do not overlap. Then pass 1 is skipped (plate positions say nothing about the assembly), every non-base part is searched, `layout` is `'plate'`, and the result is in the base part's plate frame. The 24-rotation search handles parts laid on their side for printing. Report: `node src/engine/assemble.test.js` loads `public/models/v{1,2,3}_print_layout.3mf` exactly like the UI (v1 3/3; v2 2/3: the drawer sits 5.1 mm deeper than the preset's latched pose. It is against its physical end stop (the rear leaf springs), and the push-push latch point is set by the heart groove, which a geometric search cannot infer; v3 9/10: everything except the backplate, in about 5 s).
- **Group placement (pass 2):** before a part is committed, `groupPlace` checks whether unplaced small parts (max dim < 25 mm) that come in ≥ 2 identical copies (same size and volume) fit its holes as fasteners. If they cover at least 2 holes, the part and its fasteners are positioned as one group. Fastener variants come from hole candidates against the part (overlap < 2 %, contact > 15 %), with each copy mapped onto the first copy's local frame. The group is then scanned over the top 5 distinct start poses: a coarse 1 mm grid ±14 mm perpendicular to the pin axis, followed by a 0.5 mm / ±0.4 mm refinement. It is scored as the part's score plus the mean pin score, minus 2 × the share sticking out of the assembly (this prefers the closed end of a slide path). After a local refinement, the fasteners get `parent · variant` poses. `opts.group = false` disables this. This step is what places the v3 drawer on its 4 pins in the housing grooves.
- **Pass 2, search:** places the parts pass 1 did not keep. Besides cavity fits and face abutments, it tries: back-face placement (opposite the base's opening, pushed in until seated, so dovetail plates seat); small parts centred in holes; rods with their shaft through a guide hole; parts with their own holes aligned hole-to-hole with coaxial holes (lever on its pivot).
  - Each part gets a solid voxel grid (Z-raycast parity, about 1 mm voxels). Cavities are found as empty voxels enclosed on at least 5 sides (pockets) or on 4 sides with an opposite pair open (slots/holes).
  - Parts are placed from largest to smallest. Each part tries all 24 axis-aligned rotations × (cavity-fit alignments + assembly-face abutments).
  - Candidates are scored as surface contact within about 1 mm minus 25 × core overlap, then refined in ±2-voxel steps. A part with no acceptable placement is left where it was, with confidence 0.
- **Joints:**
  - Pin- or fastener-sized parts are `fixed`. They get a `parent` when they ride on a moving part.
  - If a pin passes through a part and the part can swing ≥ 6° about the pin axis → `hinge`, with the range set to the free swing. A pin through the part takes priority over sliding; if a push rod/button blocks the swing, the swing is measured without it.
  - If one translation direction is free (≥ 2 mm, perpendicular directions less than half that) and the part sits more than 50 % inside its mate's bbox, or its travel is bounded → `slider`. The range is the travel, or the insertion depth if the part can slide all the way out. A rod that only escapes backwards uses its bounded direction (stops at first contact). A drawer that can also push in a little gets a negative range start, e.g. v2 `[-4, 90]`.
  - Everything else → `fixed`.
  - `path` joints (pins in curved slots) are **not** inferred.
- **Accuracy:** run `node src/engine/assemble.test.js [seed]` (not part of `npm test`). Each preset is scrambled with 24-rotation + ±200 mm moves. A part counts as correct when its centroid and bbox are within 1.5 mm of the truth, relative to the base. Typical results:

  | preset | UI-style (raw STLs, identity poses) | in-place | scrambled | time (UI) |
  |---|---|---|---|---|
  | v1 | 3/3 / 3/3 | 3/3 / 3/3 | 3/3 / 3/3 | ~1.3 s |
  | v2 | 3/3 / 3/3 | 3/3 / 3/3 | 3/3 / 3/3 | ~1.0 s |
  | v3 (UI has one pin_drawer) | 7/7 / 5/7 | 10/10 / 5/10 | 2/10 / 6/10 | ~3.7 s |

- **Limits:**
  - Only axis-aligned orientations are tried.
  - Identical parts (pins) may be swapped between equivalent holes; the test counts any instance as correct.
  - The v3 button slider comes out as pull-out −Y ~93 mm (it rests against the lever, so the bounded push direction measures 0); design is +Y 4.6 mm.
  - Slider ranges are geometric (insertion depth), not design limits. For example, the v1 drawer gets 90 mm where the design value is 80 mm.
  - Tilt-out `path` motion is not detected (the v3 drawer comes out `fixed`).
  - Hinge range stops at the first voxel overlap (the v3 lever gets 6° where the design value is −12.8°).
  - Pins are reported as `fixed` with no `parent` when their mate's motion was not inferred.

## Joint inference (autoAssemble)

- **Push rods (buttons)**: a small rod-shaped part whose free-travel direction escapes the base gets a slider in the *push-in* direction (toward the base centre). The range runs to first contact with the base and is capped at `min(5 mm, 0.25 × part extent)`. The reason says "push rod: …".
- **Driven levers**: a hinge part touched by a push rod is swung while the rod is pressed in. The range is `[0, ±a]`, where `a` is the angle at which the lever first contacts the base or a slid path part (0.5° steps).
- **Path joints (pins in grooves)**: a part with small pins (max dim < 25 mm, < 5 % of its volume, inside its bbox and in contact) gets a `path` joint. The part slides along a non-pin axis, then tilts ≥ 10° about one pin, with up to 1.5 mm shift perpendicular to the pin axis. Its pins become `fixed` with `parent` = that part.
  Shape: `{part, type:'path', axis, origin, range:[0,1], keyframes:[{t, value:{pos:[x,y,z], angle}}]}`. The transform is `T(pos+origin)·R(axis,angle)·T(−origin)`, and `solveJoints` interpolates the keyframes.

## Roles

Each `poses[i]` and `guesses[i]` has `role`, and the result has `roles: {id: role}`. The role is one of `'base' | 'drawer' | 'button' | 'lever' | 'pin' | 'backplate' | 'part'` (`'part'` when unsure). It is inferred from the joint type and geometry (base = largest; path or long slider = drawer; push rod = button; hinge = lever; small part fixed to a parent = pin; flat plate = backplate).

## Models

The objects in `public/models/v{1,2,3}_print_layout.3mf` carry their real part names (housing, drawer, lever, button, backplate, pin_drawer_1..4, pin_pivot). Only the names changed; geometry and placement are identical.

## Hinge linkages (desk-mount four-bar, v4)

When the parts contain ≥ 2 links (long thin bars, length > 4× width, with a round hole near each end through the thin axis), a mount with ≥ 2 coaxial pivot-hole pairs and a carried part with a matching pair, `autoAssemble` switches to an analytic linkage solver (`opts.linkage: false` turns it off):

- Hole axes are refined with a circle fit on the mesh vertices (teardrop tips rejected), so placements are exact rather than voxel-scored.
- Base = the mount: the pivoted part with screw holes on one face. That face is the desk side ("up"). Pivot A is the one farther from the desk and takes the links with a detent hole; pivot B takes the others.
- Links sit folded, parallel to the desk face, on the inner face of each lug (clearance + 0.1 mm). The carried part's pivot pairs go at A + L·u and B + L·u, level, with its opening toward the desk. Pins go into the ground pivots (head on the lug's outer face) and then into the coupler pivots (head on the link's outer face).
- Joints: each link gets a hinge about its mount pivot, swinging from folded to hanging (−up). The carried part and its coupler pins get two hinges, a counter-rotation about the coupler pivot followed by the link swing about the ground pivot (like the v4 preset): a level circular translation. Ground pins are fixed. Roles: `link`, `carrier`, `pin`.
- Orientation (desk mount): screw face up with its top at z = 0, everything below, links folding toward +Y, carried part swinging down toward −Y.
- Joints are derived from the poses, so in-place inputs get the same hinges.

## Upright orientation (plate layouts)

The orientation is always evaluated, deterministically and identically on the main thread and in the worker (turn it off with `opts.orient: false`). For print-plate inputs (`result.layout === 'plate'`), and for assembled inputs that are not upright (or with `opts.orient: true`), one global rotation is applied to every pose and joint (axes, origins, keyframe offsets). The result faces forward like the presets: back at +Y, the drawer pulls out toward −Y, and +Z is up. The lowest point sits on z=0, and the base's XY centre is kept.
- Back: the opposite of the drawer's pull-out direction (slider or path); if there is no drawer, the backplate's side.
- Up: the push button's side; otherwise the SKADIS hooks (the rear-most backplate vertices sit near its top edge); otherwise the axis nearest the given +Z.

`result.orient = { rotation: [16 numbers], reason }`, or `null` when no cue was found. Assembled inputs that are already upright keep their given pose; in that case the reason ends with "(already upright: kept given pose)".

## Placement refine, expected contacts, performance
- Flat parts (backplates) are slid into the face they mount on for as long as there is no overlap. This seats the v3 backplate on the housing's back (it was about 95 mm off before).
- Collision-aware refine (`opts.refine: false` turns it off): each searched part (largest first; pins and small fasteners are skipped) is nudged by up to 1.5 mm along the base axes. A nudge is kept only if it reduces the number of parts it intersects and keeps at least 60 % of its contact.
- `result.expected`: designed contacts in the preset `expected` format (`{a, b, box, reason}`, in the result's world frame): pins press-fitted in holes, and the backplate on the base back. Pass it to `classify(checkPose(...), result.expected)` so these show as amber rather than as errors.
- Speed and memory: scoring uses an inlined voxel lookup (about 2.5× faster). The voxel grid drops its eroded core array after sampling. BVHs are reused through `geometry.boundsTree`. The worker receives indexed geometry (position + index), not a non-indexed copy.
