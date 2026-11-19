'use strict';
/*
 * Regression: an item whose cut line is several separate loops.
 *
 * A character standee usually has a detached halo, a floating prop or a loose
 * strand. The packer used to take only the largest loop, so it believed the item
 * was smaller than it is: rows came out too short, artwork overlapped the next
 * row, and bases landed on the part it could not see.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SRC = '/home/user/site-deploy/final-stage';
const win = {};
// ClipperLib sniffs self/navigator at load time; give it a browser-shaped scope.
win.self = win;
win.navigator = { userAgent: 'node', platform: 'node', appName: 'node' };
const sandbox = { window: win, globalThis: win, self: win, navigator: win.navigator, console };
for (const f of ['vendor/clipper.js', 'nesting-geometry.js', 'nesting.js']) {
  const code = fs.readFileSync(path.join(SRC, f), 'utf8');
  new Function('window', 'globalThis', 'self', 'navigator', 'console', code)(
    win, win, win, win.navigator, console);
}
const { packNesting } = win.OutlineNesting;

const PPM = 12;
const rect = (x, y, w, h) => [[x, y], [x + w, y], [x + w, y + h], [x, y + h]];

/** Body + a detached halo above it, like a standee with a floating ring. */
function haloItem(name, wMm, hMm, haloMm) {
  const W = wMm * PPM, H = hMm * PPM;
  const halo = rect(W * 0.25, 0, W * 0.5, haloMm * PPM);
  const body = rect(0, haloMm * PPM, W, H - haloMm * PPM);
  return {
    name, width: W, height: H, pixelsPerMm: PPM, widthMm: wMm, heightMm: hMm,
    cutPaths: [body, halo], whitePaths: [body, halo], artwork: null,
  };
}

const tf = (pts, m) => pts.map(([x, y]) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]]);
const bbox = (pts) => {
  let a = Infinity, b = Infinity, c = -Infinity, d = -Infinity;
  for (const [x, y] of pts) { a = Math.min(a, x); c = Math.max(c, x); b = Math.min(b, y); d = Math.max(d, y); }
  return [a, b, c, d];
};
const hits = (A, B) => A[0] < B[2] - 1e-6 && B[0] < A[2] - 1e-6 && A[1] < B[3] - 1e-6 && B[1] < A[3] - 1e-6;

test('a detached halo counts towards the item size', () => {
  const items = [haloItem('halo', 50, 150, 18)];
  const r = packNesting(items);
  const p = r.placements[0];
  assert.ok(Math.abs(p.heightMm - 150) < 0.01,
    `height must cover the halo too, got ${p.heightMm.toFixed(2)}mm`);
  assert.ok(Math.abs(p.widthMm - 50) < 0.01, `width stays 50mm, got ${p.widthMm.toFixed(2)}`);
});

test('rows are tall enough for the whole item, so nothing falls into the next row', () => {
  const items = [];
  for (let i = 0; i < 6; i++) items.push(haloItem(`h${i}`, 50 + (i % 3) * 6, 150, 18));
  const r = packNesting(items);
  for (const row of r.rows) {
    assert.ok(row.heightMm >= 150 - 0.01, `row height ${row.heightMm.toFixed(2)} covers 150mm items`);
  }
});

test('separate pieces of different items never overlap on the sheet', () => {
  const items = [];
  for (let i = 0; i < 8; i++) items.push(haloItem(`h${i}`, 46 + i * 4, 140 + (i % 4) * 10, 16));
  const r = packNesting(items);
  const extents = r.placements.map((p) => {
    const all = p.cutPaths.map((l) => tf(l, p.matrix)).flat();
    return { name: p.name, b: bbox(all) };
  });
  for (let i = 0; i < extents.length; i++) {
    for (let j = i + 1; j < extents.length; j++) {
      assert.equal(hits(extents[i].b, extents[j].b), false,
        `real extent overlap: ${extents[i].name} x ${extents[j].name}`);
    }
  }
});

test('no base is placed on top of any piece of the item', () => {
  const items = [];
  for (let i = 0; i < 6; i++) items.push(haloItem(`h${i}`, 50, 150, 18));
  const r = packNesting(items);
  for (const b of r.bases) {
    const box = [b.xMm, b.yMm, b.xMm + b.widthMm, b.yMm + b.heightMm];
    for (const p of r.placements) {
      const all = p.cutPaths.map((l) => tf(l, p.matrix)).flat();
      assert.equal(hits(box, bbox(all)), false,
        `base at ${b.xMm.toFixed(1)},${b.yMm.toFixed(1)} sits on ${p.name}`);
    }
  }
});

test('placed boxes match the real cut extents for multi-piece items', () => {
  const items = [haloItem('a', 50, 150, 18), haloItem('b', 50, 150, 18)];
  const r = packNesting(items);
  for (const p of r.placements) {
    const all = p.cutPaths.map((l) => tf(l, p.matrix)).flat();
    const b = bbox(all);
    assert.ok(Math.abs(b[0] - p.xMm) < 0.06, `${p.name} left edge ${b[0]} vs ${p.xMm}`);
    assert.ok(Math.abs(b[1] - p.yMm) < 0.06, `${p.name} top edge ${b[1]} vs ${p.yMm}`);
    assert.ok(Math.abs(b[2] - (p.xMm + p.widthMm)) < 0.06, `${p.name} right edge`);
    assert.ok(Math.abs(b[3] - (p.yMm + p.heightMm)) < 0.06, `${p.name} bottom edge`);
  }
});

test('a genuine hole stays a hole instead of being filled in', () => {
  const W = 60 * PPM, H = 100 * PPM;
  const outer = rect(0, 0, W, H);
  const hole = rect(W * 0.3, H * 0.3, W * 0.4, H * 0.4);
  const item = {
    name: 'ring', width: W, height: H, pixelsPerMm: PPM, widthMm: 60, heightMm: 100,
    cutPaths: [outer, hole], whitePaths: [outer, hole], artwork: null,
  };
  const r = packNesting([item]);
  // The outer size must still be the full card.
  assert.ok(Math.abs(r.placements[0].widthMm - 60) < 0.01);
  assert.ok(Math.abs(r.placements[0].heightMm - 100) < 0.01);
});
