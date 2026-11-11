'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { chooseWidth, roundedTriangleDimensions, roundedTriangleMask, selectFragments } = require('../scaffold-rules.js');

test('shape switches at the exact 50mm pre-scaffold outline width', () => {
  for (const [w, shape] of [[0.01,'triangle'],[33,'triangle'],[49.999999,'triangle'],[50,'rounded_rectangle'],[80,'rounded_rectangle'],[200,'rounded_rectangle']]) {
    const result=chooseWidth(w);assert.equal(result.nominalDimensionMm,50);assert.equal(result.shape,shape);assert.equal(result.cornerRadiusMm,1);
    if(shape==='triangle'){
      assert.equal(result.triangle.virtualSideMm,50);
      assert.ok(Math.abs(result.scaffoldWidthMm - 48.53589838486224)<1e-10);
    }else{assert.equal(result.scaffoldWidthMm,50);assert.equal(result.triangle,null);}
  }
  for(const w of [0,-1,NaN,Infinity])assert.throws(()=>chooseWidth(w));
});

test('rounded equilateral triangle uses a virtual 50mm side and true R1 fillets', () => {
  const d=roundedTriangleDimensions();
  assert.equal(d.virtualSideMm,50);assert.equal(d.cornerRadiusMm,1);
  assert.ok(Math.abs(d.virtualHeightMm - 25*Math.sqrt(3))<1e-10);
  assert.ok(Math.abs(d.roundedWidthMm - 48.53589838486224)<1e-10);
  assert.ok(Math.abs(d.roundedHeightMm - 42.30127018922193)<1e-10);
  assert.ok(Math.abs(d.straightSideMm - 46.53589838486224)<1e-10);
  assert.equal(roundedTriangleDimensions(50,0).roundedWidthMm,50);
  for(const [side,r] of [[50,-1],[0,1],[50,15],[NaN,1],[50,NaN]])assert.throws(()=>roundedTriangleDimensions(side,r));
});

test('the rounded mask is point-up, base-aligned, symmetric, and has R1 corners', () => {
  const w=620,h=620,cx=310,bottom=550,ppm=10;
  const mask=roundedTriangleMask(w,h,cx,bottom,ppm);
  const sharp=roundedTriangleMask(w,h,cx,bottom,ppm,50,0);
  let minX=w,maxX=-1,minY=h,maxY=-1,area=0,sharpArea=0;
  for(let y=0;y<h;y++)for(let x=0;x<w;x++){
    const i=y*w+x;if(sharp[i])sharpArea++;
    assert.equal(mask[i],mask[y*w+(2*cx-1-x)],`symmetry at ${x},${y}`);
    if(mask[i]){area++;minX=Math.min(minX,x);maxX=Math.max(maxX,x);minY=Math.min(minY,y);maxY=Math.max(maxY,y);assert.equal(sharp[i],1,'fillet cannot extend outside the virtual triangle');}
  }
  assert.ok(area>0&&area<sharpArea);
  assert.ok(Math.abs((maxX-minX+1)/ppm-48.535898)<.11);
  assert.ok(Math.abs((maxY-minY+1)/ppm-42.301270)<.11);
  assert.equal(maxY,bottom-1,'base stays at the requested bottom');
  const top=bottom-25*Math.sqrt(3)*ppm;
  assert.equal(mask[Math.floor(top+.5*ppm)*w+cx],0,'sharp apex is rounded away');
  assert.equal(mask[Math.floor(top+1.1*ppm)*w+cx],1,'material starts at the rounded apex');
  assert.equal(mask[(bottom-1)*w+Math.floor(cx-24.5*ppm)],0,'virtual lower corner is rounded away');
  assert.equal(mask[(bottom-1)*w+cx],1,'middle of the base is present');
});

test('the upper scaffold-only fragment is removed and the lower fragment is merged', () => {
  const w = 9, h = 9, outline = new Uint8Array(w * h), rect = new Uint8Array(w * h);
  for (let x = 0; x < w; x++) outline[3 * w + x] = 1; // original silhouette splits the rectangle
  outline[0] = 1; outline[8 * w + 8] = 1; // outside the rectangle must remain intact
  for (let y = 0; y < h; y++) for (let x = 1; x <= 7; x++) rect[y * w + x] = 1;
  const original = outline.slice();
  const selection = selectFragments(outline, rect, w, h, 2);
  assert.deepEqual(outline, original, 'the input silhouette must not be changed');
  assert.equal(selection.dropped, 1); assert.equal(selection.kept, 1);
  for (let i = 0; i < outline.length; i++) if (outline[i]) assert.equal(selection.mask[i], 1, 'every original pixel remains');
  for (let y = 0; y <= 2; y++) for (let x = 1; x <= 7; x++) assert.equal(selection.mask[y * w + x], 0);
  for (let y = 4; y < h; y++) for (let x = 1; x <= 7; x++) assert.equal(selection.mask[y * w + x], 1);
});

test('if one scaffold-only fragment reaches the upper third, all of it is removed', () => {
  const w = 7, h = 7, outline = new Uint8Array(w * h), rect = new Uint8Array(w * h).fill(1);
  outline[3 * w + 3] = 1; // a small island does not split the surrounding rectangle
  const selection = selectFragments(outline, rect, w, h, 2);
  assert.equal(selection.dropped, 1); assert.equal(selection.kept, 0);
  assert.deepEqual(selection.mask, outline);
});

test('a rectangle entirely inside the outline cannot cut or alter the original', () => {
  const outline = new Uint8Array(25).fill(1), rect = new Uint8Array(25).fill(1);
  const selection = selectFragments(outline, rect, 5, 5, 1.6);
  assert.equal(selection.dropped, 0); assert.equal(selection.kept, 0);
  assert.deepEqual(selection.mask, outline);
});
