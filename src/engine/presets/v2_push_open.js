// v2 push-push (/workspace/skadis_drawer/v2_push_open/). Keyframes in drawer y-offset (+Y = into housing):
// open-ish -10 (ejected) -> -1.2 latched -> +3 overtravel -> -1.2 latched -> -80 pulled out.
// Follower pin rides in heart groove on a flexing blade (x ±4) and the leaf springs compress at the rear: both expected.
export default {
  id: 'v2', name: 'v2 push-open', base: '/models/',
  parts: [
    { id: 'housing', file: 'v2_housing.stl' },
    { id: 'drawer', file: 'v2_drawer.stl' },
    { id: 'backplate', file: 'v2_backplate.stl' },
  ],
  joints: [
    { type: 'fixed', part: 'housing' },
    { type: 'fixed', part: 'backplate', offset: [1,0,0,0, 0,1,0,0, 0,0,1,0, 0,98.11,0,1] },
    { type: 'slider', part: 'drawer', axis: [0, 1, 0], range: [-80, 3],
      keyframes: [{ t: 0, value: -1.2 }, { t: 0.15, value: 3 }, { t: 0.3, value: -1.2 }, { t: 0.4, value: -10 }, { t: 1, value: -80 }] },
  ],
  ignorePairs: [['housing', 'backplate']], // dovetail mount, faces flush by design
  expected: [
    { a: 'drawer', b: 'housing', box: [[-7, -90, -8], [7, 100, 1.7]], reason: 'follower pin/blade in heart groove (blade flexes ±4 mm)' },
    { a: 'drawer', b: 'housing', box: [[-61, -90, -0.1], [61, 100, 0.1]], reason: 'drawer bottom slides on housing floor (gravity support; 0.01 = scad -0.01 bay overcut)' },
    { a: 'drawer', b: 'housing', box: [[-56, 80, 7], [56, 100, 29]], reason: 'printed ejector leaf springs compress' },
  ],
};
