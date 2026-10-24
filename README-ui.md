# UI (src/ui/) — 3D Mechanism Tester

Entry: `src/ui/index.js` exports `mount(rootEl)` (also default). Friday's `src/main.js` mounts it. Plain JS + three.js, no framework.

## Files
- `src/ui/index.js` — whole UI: start screen (drop zone, file picker, Samples list), part list (name, colour, show, fixed), 3D view (OrbitControls, Z-up grid, axes), joint editor (Slides / Swings / Doesn't move; axis, hinge pin point, min/max mm or °; preset keyframes kept until range edited), motion slider + play/pause loop, tolerance input (default 0.3) + printer presets 0.2/0.3/0.4, results panel (red crash, yellow gap < tolerance, blue expected contact, grey ignored pairs, green clear pairs), "Check full motion" via sweepAsync (web worker, progress bar + Cancel, UI stays responsive; 41 positions; colours via engine classify(); reports crash ranges or tightest spot + "Show" button), help panel, save/load project JSON (parts by filename + joints + tolerance + ignorePairs/expected). Exposes `window.__mechTester` for tests.
- `src/ui/engine.js` — **engine adapter**, the only file importing the engine. Uses `src/engine/index.js` (`checkPose`, `solveJoints`, `sweepAsync`, `classify`, `loadSTL`; `sweep` kept) per function; falls back to the stub for any missing one. Engine panel in the UI shows which is active (currently all = Gram's engine).
- `src/ui/engineStub.js` — TEMPORARY fallback (three-mesh-bvh triangle checks, slider/hinge/fixed joints in Gram's joint format). Unused while src/engine exists.
- `src/ui/presets.js` — Samples list: reads `presets` from `src/engine/presets/index.js` (fallback: each file in that folder), plus `public/samples/*.json` and UI test projects `samples/*.json`. Empty → friendly message. Preset `base:'/models/'` is resolved relative to the app base (works under subpaths).
- `src/ui/style.css`.
- Expected contacts: a collision/near-miss whose pair matches a preset `expected` entry and all points fall inside its `box` is shown blue, not red/yellow, and listed separately. `ignorePairs` are passed to the engine and listed as "not checked".

## Outside src/ui
- `package.json`: deps three, three-mesh-bvh (dev: vite; vite-plugin-pwa was added by Friday). index.html / vite.config.js / src/main.js not touched.
- `samples/` — `make-samples.mjs` generates `slot.stl`, `drawer_ok_0.2mm.stl` (0.2 mm clearance → yellow), `drawer_tight_interference.stl` (0.2 mm too wide → red) and two project JSONs.
- `tests-ui/ui-test.mjs`, `tests-ui/gram-presets.mjs`, `tests-ui/cancel-test.mjs` — headless Chrome (puppeteer-core, install with `npm i --no-save puppeteer-core`) against `npx vite preview --port 4179`.
- `screenshots/`.

## Known limits
- Part fully inside another isn't flagged (engine limitation; noted in help).
- Cancel aborts via AbortController (opts.signal); Gram's worker terminates; AbortError shows 'Check cancelled.'
