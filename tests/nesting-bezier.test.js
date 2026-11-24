'use strict';
/*
 * The vector cut contour carries cubic segments (['C',c1x,c1y,c2x,c2y,x,y]).
 * Every nesting consumer has to honour that format: the packer's collision
 * outline, the base-fill raster and the preview svg. These tests feed a
 * square whose sides are straight-line cubics — identical geometry to the
 * polygon square — and demand identical, finite results. Before the fix the
 * bezier square packed as a zero-size item (or hung), and the preview path
 * data contained NaN.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { boot } = require('./harness.js');

// One cubic per side, control points on the segment: geometry == polygon.
const seg = (x0, y0, x1, y1) => ['C', x0 + (x1 - x0) / 3, y0 + (y1 - y0) / 3, x0 + 2 * (x1 - x0) / 3, y0 + 2 * (y1 - y0) / 3, x1, y1];
const bezierSquare = (s) => [[0, 0], seg(0, 0, s, 0), seg(s, 0, s, s), seg(s, s, 0, s), seg(0, s, 0, 0)];
const polySquare = (s) => [[0, 0], [s, 0], [s, s], [0, s]];

const OPTS = { sheetWidthMm: 400, sheetHeightMm: 300, marginMm: 1, clearanceMm: 0.25, fillBases: false, baseSizeMm: 35, extraBases: 0 };

// cutPaths live in PIXEL space (the pipeline stores them that way); the
// packer divides by pixelsPerMm to get millimetres.
function item(name, loopMaker, size = 20) {
  const ppm = 10;
  const px = size * ppm;
  return {
    name, cutPaths: [loopMaker(px)], whitePaths: [[[20, 20], [px - 20, 20], [px - 20, px - 20]]],
    width: px, height: px, pixelsPerMm: ppm,
    widthMm: size, heightMm: size, artwork: null, pixels: new Uint8Array(16),
  };
}

test('a bezier-cut item packs at its true size, same as the polygon twin', () => {
  const { window } = boot();
  const pack = (cutPaths) => window.OutlineNesting.packNesting([item('x', () => cutPaths[0])], OPTS);
  const a = pack([bezierSquare(200)]).placements[0];
  const b = pack([polySquare(200)]).placements[0];
  for (const p of [a, b]) {
    assert.ok(Number.isFinite(p.widthMm) && Number.isFinite(p.heightMm), 'placement size is finite');
    assert.ok(p.widthMm > 19 && p.widthMm < 21, `true width, got ${p.widthMm}`);
    assert.ok(p.heightMm > 19 && p.heightMm < 21, `true height, got ${p.heightMm}`);
  }
  assert.ok(Math.abs(a.widthMm - b.widthMm) < 1e-6, 'bezier and polygon agree on width');
  assert.ok(Math.abs(a.heightMm - b.heightMm) < 1e-6, 'bezier and polygon agree on height');
});

test('two bezier-cut items keep the requested clearance on the sheet', () => {
  const { window } = boot();
  const res = window.OutlineNesting.packNesting([item('a', bezierSquare), item('b', bezierSquare)], OPTS);
  assert.equal(res.placements.length, 2, 'both placed');
  assert.equal(res.unplaced.length, 0);
  const [p, q] = res.placements;
  const gapX = Math.max(p.xMm - (q.xMm + q.widthMm), q.xMm - (p.xMm + p.widthMm));
  const gapY = Math.max(p.yMm - (q.yMm + q.heightMm), q.yMm - (p.yMm + p.heightMm));
  assert.ok(Math.max(gapX, gapY) >= OPTS.clearanceMm - 1e-6, `clearance honoured, gap ${Math.max(gapX, gapY)}`);
});

test('the preview svg draws bezier cuts without NaN', () => {
  const { window } = boot();
  const res = window.OutlineNesting.packNesting([item('a', bezierSquare)], OPTS);
  const svg = window.OutlineNesting.nestingPreviewSvg(res, { labels: ['a'] });
  assert.ok(!svg.includes('NaN'), 'no NaN in preview path data');
  assert.match(svg, /<path d="M[-\d. ]+C[-\d. ]/, 'bezier commands reach the preview');
});

test('the base-fill raster sees the bezier footprint', () => {
  const { window } = boot();
  // Room for bases everywhere except under the item: with the footprint
  // invisible to the raster (the NaN rows bug) the filler stamps bases on
  // top of the artwork.
  const res = window.OutlineNesting.packNesting([item('a', bezierSquare)],
    { ...OPTS, fillBases: true, sheetWidthMm: 100, sheetHeightMm: 100 });
  assert.ok(res.bases.length > 0, 'the filler still finds free pockets');
  assert.equal(res.placements.length, 1);
  const p = res.placements[0];
  for (const b of res.bases) {
    const overlaps = b.xMm < p.xMm + p.widthMm && b.xMm + 35 > p.xMm && b.yMm < p.yMm + p.heightMm && b.yMm + 35 > p.yMm;
    assert.ok(!overlaps, `base at ${b.xMm},${b.yMm} sits under the item`);
  }
});
