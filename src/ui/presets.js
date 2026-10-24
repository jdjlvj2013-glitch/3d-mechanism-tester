// Lists presets: Gram's src/engine/presets/* (read-only) + UI sample STLs in /samples.
// Preferred: Gram's src/engine/presets/index.js exporting `presets` (array). Fallback: each file in the folder.
const gramIndex = Object.values(import.meta.glob('../engine/presets/index.js', { eager: true }))[0];
const gramFiles = import.meta.glob(['../engine/presets/*.{json,js,mjs,ts}', '!../engine/presets/index.js'], { eager: true });
const gram = Array.isArray(gramIndex?.presets) ? Object.fromEntries(gramIndex.presets.map((p, i) => ['presets/' + (p.id || i), p])) : gramFiles;
const sampleProjects = import.meta.glob('../../samples/*.json', { eager: true, import: 'default' });
const sampleFiles = import.meta.glob('../../samples/*.{stl,3mf}', { eager: true, query: '?url', import: 'default' });
const pubSamples = import.meta.glob('../../public/samples/*.json', { eager: true, import: 'default' });
const base = import.meta.env.BASE_URL || '/';

function resolveModel(f) {
  if (!f) return null;
  if (/^(https?:|data:|blob:|\/)/.test(f)) return f;
  return base + 'models/' + f.replace(/^\.?\/?(public\/)?(models\/)?/, '');
}
function normalize(raw, key, resolver) {
  let d = raw && (raw.default ?? raw.preset ?? raw);
  if (Array.isArray(d)) return d.map((x, i) => normalize(x, key + '#' + i, resolver)).flat();
  if (!d || typeof d !== 'object' || !d.parts) return [];
  const b = d.base ? (d.base.startsWith('/') ? base + d.base.slice(1) : d.base).replace(/\/?$/, '/') : null;
  const res = (f) => (b && f && !/^(https?:|data:|blob:|\/)/.test(f) ? b + f : resolver(f));
  const moving = new Set((d.joints || []).filter(j => j.type !== 'fixed').map(j => j.part));
  return [{
    key, ignorePairs: d.ignorePairs || [], expected: d.expected || [], name: d.name || d.title || key.split('/').pop().replace(/\.\w+$/, ''),
    description: d.description || '',
    parts: d.parts.map((p, i) => ({ id: p.id || p.name || 'part' + i, name: p.name || p.id || p.file,
      url: res(p.file || p.url || p.path || p.model), color: p.color, fixed: p.fixed ?? !moving.has(p.id || p.name), file: p.file || p.url || p.path })),
    joints: d.joints || [], settings: d.settings || (d.tolerance != null ? { tolerance: d.tolerance } : {}),
  }];
}
export function listPresets() {
  const g = Object.entries(gram).flatMap(([k, m]) => normalize(m, k, resolveModel)).map(p => ({ ...p, source: 'Gram' }));
  const s = Object.entries(sampleProjects).flatMap(([k, m]) => normalize(m, k, f => sampleFiles['../../samples/' + f] || f))
    .map(p => ({ ...p, source: 'Test sample' }));
  const ps = Object.entries(pubSamples).flatMap(([k, m]) => normalize(m, k, f => /^(https?:|data:|blob:|\/)/.test(f) ? f : /models\//.test(f) ? resolveModel(f) : base + 'samples/' + f)).map(p => ({ ...p, source: 'Gram' }));
  return { gram: [...g, ...ps], samples: s };
}
