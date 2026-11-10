'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { chooseWidth, selectFragments } = require('../scaffold-rules.js');

test('approved width tiers, including their exact boundaries', () => {
  for (const [w, expected] of [
    [10, 6], [49.99, 49.99 * 0.6], [50, 30], [99.99, 30],
    [100, 50], [149.99, 50], [150, 70], [199.99, 70], [200, 90], [450, 90]
  ]) {
    const result = chooseWidth(w);
    assert.ok(Math.abs(result.scaffoldWidthMm - expected) < 1e-9, `${w} mm`);
    assert.ok(result.scaffoldWidthMm < w, `scaffold must be narrower than ${w}`);
  }
  for (let w = 0.01; w <= 500; w += 0.137) assert.ok(chooseWidth(w).scaffoldWidthMm < w);
  for (const value of [0, -1, Infinity, NaN]) assert.throws(() => chooseWidth(value));
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
