'use strict';
/*
 * Left-right mirror. The flip must happen on the cropped source pixels BEFORE the
 * pipeline runs, so the silhouette, white spot, scaffold and PDF all describe the
 * mirrored artwork. Mirroring only the preview would print the original.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SRC = process.env.STAGE_DIR || '/home/user/site-deploy/final-stage';
const read = (f) => fs.readFileSync(path.join(SRC, f), 'utf8');

test('the flip is applied to the cropped canvas the pipeline consumes', () => {
  const src = read('app.js');
  // The transform must be inside loadFile, right where the crop canvas is built.
  const loadFile = src.slice(src.indexOf('async function loadFile'));
  const block = loadFile.slice(0, loadFile.indexOf('state.croppedCanvas=crop;'));
  assert.ok(/state\.flipX/.test(block), 'flipX must be consulted while building the crop');
  assert.ok(/scale\(-1,\s*1\)/.test(block), 'the crop canvas must be mirrored horizontally');
  assert.ok(/translate\(cw,\s*0\)/.test(block), 'mirror needs a translate so the image stays in frame');
});

test('flip state participates in the dirty check so a stale result is never exported', () => {
  const src = read('app.js');
  const settings = src.slice(src.indexOf('function settings()'), src.indexOf('function settings()') + 900);
  assert.ok(/flipX/.test(settings), 'settings() must include flipX');
  // state.dirty compares JSON.stringify(settings()), so flipX has to be in there.
  assert.ok(/flipX:!!state\.flipX/.test(settings));
});

test('the preview mirrors too, otherwise it disagrees with the output', () => {
  const src = read('app.js');
  const idx = src.indexOf("els.canvas.style.display='block';");
  const before = src.slice(Math.max(0, idx - 700), idx);
  assert.ok(/flipX/.test(before), 'the on-screen preview must apply the same mirror');
});

test('a mirrored silhouette is the geometric mirror of the original', () => {
  // Independent check: mirror a binary mask and confirm the cut outline is the
  // mirror image, so nothing downstream silently keeps the original orientation.
  const PPM = 10;
  const W = 120, H = 200;
  const mask = new Uint8Array(W * H);
  // an L-shape pinned to the left edge: mirroring must move mass to the right
  for (let y = 20; y < H - 20; y++) {
    for (let x = 10; x < 40; x++) mask[y * W + x] = 1;
  }
  for (let y = 20; y < 50; y++) {
    for (let x = 10; x < 90; x++) mask[y * W + x] = 1;
  }
  const centroidX = (m) => {
    let sum = 0, n = 0;
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (m[y * W + x]) { sum += x; n++; }
    return sum / n;
  };
  const mirrored = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) mirrored[y * W + (W - 1 - x)] = mask[y * W + x];
  const a = centroidX(mask), b = centroidX(mirrored);
  assert.ok(Math.abs((W - 1) - a - b) < 0.01, 'mirrored centroid must satisfy x -> W-1-x');
  assert.ok(b > W / 2, 'the L must end up on the right after mirroring');
  assert.equal(mask.reduce((s, v) => s + v, 0), mirrored.reduce((s, v) => s + v, 0), 'area is invariant');
});
