// v3 button-kick tilt-out (/workspace/skadis_drawer/v3_tilt_out/skadis_drawer_v3.scad + check.py)
// t 0..0.3: button pushed 4.6 mm, lever swings 12.8°, drawer kicked (y -10, z +0.8 detent lift)
// t 0.3..1: drawer tilts 0..40° about rear pin (drawer-frame y=80,z=10) riding in housing grooves.
// pin_pivot (lever axle, Ø3 in Ø3.4 holes) placed along +X through lever pivot (y=93.6, z=60), head at x=-10.6.
const P = 'v3_pin_drawer.stl';
const pin = (s, y) => {
  const c = Math.cos(Math.PI / 2 * s), sn = Math.sin(Math.PI / 2 * s);
  // T(s*(58-1.2), y, 10) * RotY(90*s), column-major
  return [c,0,-sn,0, 0,1,0,0, sn,0,c,0, s * 56.8, y, 10, 1];
};
const drawerPath = { type: 'path', part: 'drawer', axis: [1, 0, 0], origin: [0, 80, 10], range: [0, 1],
  keyframes: [
    { t: 0, value: { pos: [0, 0, 0], angle: 0 } },
    { t: 0.3, value: { pos: [0, -10, 0.8], angle: 0 } },
    { t: 1, value: { pos: [0, -10, 0.8], angle: 40 } },
  ] };
const pins = [[-1, 80, 'pinRL'], [1, 80, 'pinRR'], [-1, 65, 'pinFL'], [1, 65, 'pinFR']];
export default {
  id: 'v3', name: 'v3 tilt-out', base: '/models/',
  parts: [
    { id: 'housing', file: 'v3_housing.stl' },
    { id: 'drawer', file: 'v3_drawer.stl' },
    { id: 'backplate', file: 'v3_backplate.stl' },
    { id: 'lever', file: 'v3_lever.stl' },
    { id: 'button', file: 'v3_button.stl' },
    ...pins.map(([, , id]) => ({ id, file: P })),
    { id: 'pin_pivot', file: 'v3_pin_pivot.stl' },
  ],
  joints: [
    { type: 'fixed', part: 'housing' },
    { type: 'fixed', part: 'backplate', offset: [1,0,0,0, 0,1,0,0, 0,0,1,0, 0,107.4,0,1] },
    drawerPath,
    ...pins.map(([s, y, id]) => ({ type: 'fixed', part: id, parent: 'drawer', offset: pin(s, y) })),
    { type: 'fixed', part: 'pin_pivot', offset: [0,0,-1,0, 0,1,0,0, 1,0,0,0, -10.6,93.6,60,1] },
    { type: 'fixed', part: 'lever', offset: [1,0,0,0, 0,1,0,0, 0,0,1,0, 0,93.6,60,1] },
    { type: 'hinge', part: 'lever', axis: [1, 0, 0], origin: [0, 93.6, 60], range: [0, -12.8],
      keyframes: [{ t: 0, value: 0 }, { t: 0.3, value: -12.8 }, { t: 1, value: -12.8 }] },
    { type: 'fixed', part: 'button', offset: [1,0,0,0, 0,1,0,0, 0,0,1,0, 0,-8,81,1] },
    { type: 'slider', part: 'button', axis: [0, 1, 0], range: [0, 4.6],
      keyframes: [{ t: 0, value: 0 }, { t: 0.3, value: 4.6 }, { t: 1, value: 4.6 }] },
  ],
  ignorePairs: [
    ['housing', 'backplate'], // dovetail mount, faces flush by design
    ...pins.map(([, , id]) => ['drawer', id]), // press-fit
    ['lever', 'button'], // button rod pushes the lever (designed contact)
  ],
  expected: [
    ...pins.map(([, , id]) => ({ a: 'housing', b: id, box: [[-80, -50, -60], [80, 110, 40]], reason: 'pin rides in side groove' })),
    { a: 'housing', b: 'button', box: [[-3.5, -12, 79], [3.5, 100, 87]], reason: 'push rod in header hole / guide sleeves (rodClr 0.3)' },
    { a: 'housing', b: 'pin_pivot', box: [[-12, 88, 55], [12, 100, 65]], reason: 'pivot pin head seated on boss, Ø3 shank in Ø3.4 holes' },
    { a: 'lever', b: 'pin_pivot', box: [[-12, 88, 55], [12, 100, 65]], reason: 'Ø3 pivot pin in Ø3.4 lever hole (0.2 radial)' },
    { a: 'drawer', b: 'lever', box: [[-10, 75, 0], [10, 100, 90]], reason: 'lever kicks drawer back face' },
  ],
};
