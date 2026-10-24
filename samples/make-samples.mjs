// Generates simple test STLs (mm). Run: node samples/make-samples.mjs
import fs from 'node:fs';
const dir = new URL('.', import.meta.url).pathname;
function box([x0,y0,z0],[x1,y1,z1]){const v=(i)=>[i&1?x1:x0,i&2?y1:y0,i&4?z1:z0];
 const f=[[0,2,3,1],[4,5,7,6],[0,1,5,4],[2,6,7,3],[0,4,6,2],[1,3,7,5]];
 return f.flatMap(([a,b,c,d])=>[[v(a),v(b),v(c)],[v(a),v(c),v(d)]]);}
const stl=(n,tris)=>fs.writeFileSync(dir+n,`solid ${n}\n`+tris.map(t=>` facet normal 0 0 0\n  outer loop\n${t.map(p=>`   vertex ${p.join(' ')}`).join('\n')}\n  endloop\n endfacet`).join('\n')+`\nendsolid ${n}\n`);
// sleeve/slot: inner 50 (x) x 30 (z) x 80 deep (y), wall 3, open at front (y=0)
stl('slot.stl',[...box([-28,0,-3],[28,83,0]),...box([-28,0,30],[28,83,33]),...box([-28,0,0],[-25,83,30]),...box([25,0,0],[28,83,30]),...box([-25,80,0],[25,83,30])]);
stl('drawer_ok_0.2mm.stl',box([-24.8,0,0.2],[24.8,79.6,29.8]));       // 0.2 mm side clearance
stl('drawer_tight_interference.stl',box([-25.2,0,0.2],[25.2,79.6,29.8])); // 0.2 mm too wide each side
const proj=(name,desc,drawer)=>({name,description:desc,settings:{tolerance:0.3},
 parts:[{id:'slot',name:'Slot (fixed)',file:'slot.stl',fixed:true,color:'#8fb3ff'},{id:'drawer',name:'Drawer',file:drawer,color:'#ffb36b'}],
 joints:[{id:'pull',part:'drawer',type:'slider',axis:[0,-1,0],origin:[0,0,0],range:[0,60]}]});
fs.writeFileSync(dir+'drawer-ok.json',JSON.stringify(proj('Test: drawer with 0.2 mm clearance','Should be YELLOW (0.2 mm < 0.3 mm tolerance), no red crash.','drawer_ok_0.2mm.stl'),null,2));
fs.writeFileSync(dir+'drawer-interference.json',JSON.stringify(proj('Test: drawer too wide (interference)','Should be RED: drawer overlaps the slot walls.','drawer_tight_interference.stl'),null,2));
