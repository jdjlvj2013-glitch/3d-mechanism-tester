// App entry (owned by packaging). Mounts Dave's UI if present, else a placeholder.
// Contract: src/ui/index.js should `export function mount(rootEl)` (default export also accepted).
// The UI imports the engine (src/engine/, exporting checkPose / solveJoints) itself.
const uiModules = import.meta.glob('./ui/index.js'); // empty object if file doesn't exist yet

const root = document.getElementById('app');
const loadUi = uiModules['./ui/index.js'];

if (loadUi) {
  loadUi().then((m) => (m.mount || m.default)?.(root));
} else {
  root.innerHTML = '<p style="padding:2rem">3D Mechanism Tester — UI not built yet (expects src/ui/index.js exporting mount(rootEl)).</p>';
}
