'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {BASE,createBaseGeometry}=require('../nesting-geometry.js');

test('35mm rounded base has R3 corners and requested diagonal rounded slit',()=>{
 const g=createBaseGeometry(.3);
 assert.equal(g.widthMm,35);assert.equal(g.heightMm,35);assert.equal(g.cornerRadiusMm,3);
 assert.equal(g.slotLengthMm,33);assert.equal(g.angleDeg,45);assert.equal(g.slotWidthMm,2.7);
 assert.ok(g.outer.length>32);assert.ok(g.slit.length>24);
 for(const [x,y] of [...g.outer,...g.slit]){assert.ok(x>=0&&x<=35);assert.ok(y>=0&&y<=35);}
});
test('base tolerance is user-adjustable and reduces the nominal 3mm slot',()=>{
 assert.equal(createBaseGeometry(.5).slotWidthMm,2.5);
 assert.equal(createBaseGeometry(0).slotWidthMm,3);
 assert.throws(()=>createBaseGeometry(3),/Tolerance/);
 assert.throws(()=>createBaseGeometry(-.1),/Tolerance/);
});
