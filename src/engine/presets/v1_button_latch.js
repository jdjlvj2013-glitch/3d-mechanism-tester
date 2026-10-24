// v1 push-button latch drawer (/workspace/skadis_drawer/skadis_drawer.scad)
// Closed: drawer at z=+clr(0.4). Slides out along -Y; range 0..80 mm (drawer depth 90, keeps 10 mm engaged).
// Backplate sits behind housing at y=hD=94.61. Bump on compliant tongue (housing floor, y 11..16, |x|<7)
// deflects as drawer rides over it -> expected contact region.
export default {
  id: 'v1', name: 'v1 button latch', base: '/models/',
  parts: [
    { id: 'housing', file: 'v1_housing.stl' },
    { id: 'drawer', file: 'v1_drawer.stl' },
    { id: 'backplate', file: 'v1_backplate.stl' },
  ],
  joints: [
    { type: 'fixed', part: 'housing' },
    { type: 'fixed', part: 'backplate', offset: [1,0,0,0, 0,1,0,0, 0,0,1,0, 0,94.61,0,1] },
    { type: 'slider', part: 'drawer', axis: [0, -1, 0], range: [0, 80],
      keyframes: [{ t: 0, value: 0 }, { t: 1, value: 80 }] },
    { type: 'fixed', part: 'drawer', offset: [1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0.4,1] },
  ],
  ignorePairs: [['housing', 'backplate']], // dovetail mount, faces flush by design
  expected: [
    { a: 'drawer', b: 'housing', box: [[-8, -8, -3], [8, 20, 2.1]], reason: 'latch bump / flex tongue rides under drawer' },
  ],
};
