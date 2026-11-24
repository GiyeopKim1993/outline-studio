'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
global.ClipperLib = require('../vendor/clipper.js');
global.CutVector = require('../cut-vector.js');
const {
  packNesting, nestingPreviewSvg, placementMatrix, polygonsOverlap, MARGIN_MM,
} = require('../nesting.js');
const { createBaseGeometry } = require('../nesting-geometry.js');

// Artwork stub: pixel size = mm size * ppm, rectangular cut outline.
function item(name, wMm, hMm, opts = {}) {
  const ppm = opts.ppm || 2;
  const w = wMm * ppm, h = hMm * ppm;
  const rect = [[0, 0], [w, 0], [w, h], [0, h]];
  const cut = opts.cutPaths || [rect];
  return { name, width: w, height: h, pixelsPerMm: ppm, widthMm: wMm, heightMm: hMm, cutPaths: cut, whitePaths: [rect] };
}

const segPointDist = (p, a, b) => {
  const vx = b[0] - a[0], vy = b[1] - a[1];
  const L = vx * vx + vy * vy;
  let t = L ? ((p[0] - a[0]) * vx + (p[1] - a[1]) * vy) / L : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(p[0] - (a[0] + t * vx), p[1] - (a[1] + t * vy));
};
const tf = (pts, m) => pts.map(([x, y]) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]]);

function byName(result, name) {
  return result.placements.filter((p) => p.name === name);
}

test('row 1 starts at (1,1) and finishes by x = 399', () => {
  const r = packNesting([item('a', 100, 60), item('b', 90, 60)]);
  assert.equal(r.rowCount, 1);
  const row = r.rows[0];
  assert.equal(row.yMm, MARGIN_MM);
  assert.equal(r.placements[0].xMm, MARGIN_MM);
  assert.equal(r.placements[0].yMm, MARGIN_MM);
  for (const p of r.placements) {
    assert.ok(p.xMm >= MARGIN_MM - 1e-9);
    assert.ok(p.xMm + p.widthMm <= 400 - MARGIN_MM + 1e-9, 'must end by x=399');
    assert.ok(p.yMm + p.heightMm <= 300 - MARGIN_MM + 1e-9, 'must end by y=299');
  }
});

test('items are normalised to portrait (long side vertical)', () => {
  const r = packNesting([item('wide', 148, 60)]);
  const p = byName(r, 'wide')[0];
  assert.ok(p.heightMm > p.widthMm, `expected portrait, got ${p.widthMm}x${p.heightMm}`);
  assert.ok(Math.abs(p.widthMm - 60) < 1e-6 && Math.abs(p.heightMm - 148) < 1e-6);
  assert.ok(p.rot === 90 || p.rot === 270);
});

test('portrait orientation keeps the 0.25 mm outline gap between neighbours', () => {
  const r = packNesting([item('a', 148, 60), item('b', 148, 60)]);
  assert.equal(r.placements.length, 2);
  const [a, b] = r.placements.slice().sort((p, q) => p.xMm - q.xMm);
  assert.ok(a.heightMm > a.widthMm, 'portrait: long side vertical');
  assert.ok([0, 90, 180, 270].includes(a.rot));
  assert.ok(b.xMm >= a.xMm + a.widthMm + 0.25 - 1e-6, 'neighbours keep at least 0.25mm');
  assert.ok(b.xMm < a.xMm + a.widthMm + 1, 'but they are not pushed apart further than needed');
});

test('rows do not overlap and keep 0.25mm clearance on the real outline', () => {
  const items = [];
  for (let i = 0; i < 12; i++) items.push(item(`i${i}`, 60 + i * 3, 100 + (i % 4) * 8));
  const r = packNesting(items);
  assert.ok(r.rowCount >= 2, 'should wrap into several rows');
  for (let i = 0; i < r.placements.length; i++) {
    for (let j = i + 1; j < r.placements.length; j++) {
      const a = r.placements[i], b = r.placements[j];
      const overlap = a.xMm < b.xMm + b.widthMm - 1e-6 && b.xMm < a.xMm + a.widthMm - 1e-6 &&
        a.yMm < b.yMm + b.heightMm - 1e-6 && b.yMm < a.yMm + a.heightMm - 1e-6;
      assert.equal(overlap, false, `overlap ${a.name}/${b.name}`);
    }
  }
  for (let k = 1; k < r.rows.length; k++) {
    const prev = r.rows[k - 1], cur = r.rows[k];
    assert.ok(cur.yMm >= prev.yMm + prev.heightMm + 0.25 - 1e-6, 'row gap must be at least 0.25mm');
    assert.equal(cur.yMm, r.rows[k].yMm);
    assert.ok(cur.yMm > 1, 'row 2+ starts below row 1');
    assert.equal(r.placements.filter((p) => p.rowIndex === k)[0].xMm, MARGIN_MM, 'row starts at x = 1');
  }
});

test('row search maximises item count before shortening the row', () => {
  // Six narrow items fit on one row only if the packer searches the order.
  const items = [item('a', 45, 148), item('b', 80, 148), item('c', 60, 100), item('d', 55, 120), item('e', 65, 65), item('f', 40, 140)];
  const r = packNesting(items);
  assert.equal(r.rows[0].count, 6);
  assert.equal(r.unplaced.length, 0);
  assert.ok(r.rows[0].endXMm <= 399);
});

test('items that cannot fit in the remaining sheet height are reported', () => {
  const items = [];
  for (let i = 0; i < 20; i++) items.push(item(`s${i}`, 80, 148));
  const r = packNesting(items);
  assert.ok(r.unplaced.length > 0);
  for (const u of r.unplaced) assert.ok(['sheet-full', 'sheet-size'].includes(u.reason));
  const huge = packNesting([item('huge', 500, 50)]);
  assert.equal(huge.unplaced[0].reason, 'sheet-size');
});

test('leftover space is filled with 35mm bases that clear the artwork', () => {
  const r = packNesting([item('a', 148, 60), item('b', 148, 60)]);
  assert.ok(r.bases.length > 0);
  for (const b of r.bases) {
    assert.equal(b.widthMm, 35);
    for (const p of r.placements) {
      const overlap = b.xMm < p.xMm + p.widthMm + 0.25 - 1e-6 && p.xMm < b.xMm + b.widthMm + 0.25 - 1e-6 &&
        b.yMm < p.yMm + p.heightMm + 0.25 - 1e-6 && p.yMm < b.yMm + b.heightMm + 0.25 - 1e-6;
      assert.equal(overlap, false, `base ${b.xMm},${b.yMm} overlaps ${p.name}`);
    }
  }
  // Bases never overlap each other either.
  for (let i = 0; i < r.bases.length; i++) {
    for (let j = i + 1; j < r.bases.length; j++) {
      const a = r.bases[i], b = r.bases[j];
      const overlap = a.xMm < b.xMm + b.widthMm - 1e-6 && b.xMm < a.xMm + a.widthMm - 1e-6 &&
        a.yMm < b.yMm + b.heightMm - 1e-6 && b.yMm < a.yMm + a.heightMm - 1e-6;
      assert.equal(overlap, false);
    }
  }
  const off = packNesting([item('a', 148, 60)], { fillBases: false });
  assert.equal(off.bases.length, 0);
});

test('placementMatrix maps artwork pixels onto the sheet for every rotation', () => {
  for (const rot of [0, 90, 180, 270]) {
    const ppm = 2, W = 100, H = 60;
    const bw = rot % 180 === 0 ? W / ppm : H / ppm;
    const bh = rot % 180 === 0 ? H / ppm : W / ppm;
    const p = { rot, pixelsPerMm: ppm, width: W, height: H, xMm: 10, yMm: 20, widthMm: bw, heightMm: bh };
    const m = placementMatrix(p);
    const corners = [[0, 0], [W, 0], [W, H], [0, H]].map(([u, v]) => [m[0] * u + m[2] * v + m[4], m[1] * u + m[3] * v + m[5]]);
    const xs = corners.map((c) => c[0]), ys = corners.map((c) => c[1]);
    assert.ok(Math.abs(Math.min(...xs) - 10) < 1e-6, `rot ${rot} x`);
    assert.ok(Math.abs(Math.min(...ys) - 20) < 1e-6, `rot ${rot} y`);
    assert.ok(Math.abs((Math.max(...xs) - Math.min(...xs)) - bw) < 1e-6);
    assert.ok(Math.abs((Math.max(...ys) - Math.min(...ys)) - bh) < 1e-6);
  }
});

test('two L shapes interlock instead of being packed as boxes', () => {
  // The whole point of holding the real outline: two identical Ls share a
  // corner, so they must sit closer than their bounding boxes ever could.
  const ell = [[0, 0], [60, 0], [60, 20], [20, 20], [20, 80], [0, 80]];
  const r = packNesting([item('L1', 60, 80, { cutPaths: [ell] }), item('L2', 60, 80, { cutPaths: [ell] })]);
  assert.equal(r.placements.length, 2);
  const [a, b] = r.placements;
  const boxGap = b.xMm - (a.xMm + a.widthMm);
  assert.ok(boxGap < 0, `boxes must overlap for an interlocked pair, got ${boxGap.toFixed(3)}mm`);
  // ...and the real outlines must still keep the 0.25mm clearance.
  const shift = (p) => {
    const s = p.outlineShift || [0, 0];
    return tf(ell.map(([x, y]) => [x + s[0], y + s[1]]), p.matrix);
  };
  const A = shift(a), B = shift(b);
  let nearest = Infinity;
  for (const [P, Q] of [[A, B], [B, A]]) {
    for (const q of Q) {
      for (let i = 0; i < P.length; i++) nearest = Math.min(nearest, segPointDist(q, P[i], P[(i + 1) % P.length]));
    }
  }
  assert.ok(nearest >= 0.24, `cut lines keep the 0.25mm gap, got ${nearest.toFixed(3)}mm`);
});

test('rejects empty or invalid input', () => {
  assert.throws(() => packNesting([]), /네스팅할 이미지/);
  assert.throws(() => packNesting([{ name: 'x', width: 0, height: 0, pixelsPerMm: 1 }]), /크기가 올바르지/);
});

test('preview draws rows, cut outlines and real base geometry', () => {
  const geo = createBaseGeometry(0.3);
  const r = packNesting([item('a', 148, 60), item('b', 148, 60)]);
  const svg = nestingPreviewSvg(r, { baseGeometry: geo, thumbnails: ['data:image/png;base64,AAAA'] });
  assert.match(svg, /viewBox="0 0 400 300"/);
  assert.ok((svg.match(/<path/g) || []).length >= r.bases.length * 2, 'base outer + slit paths');
  assert.ok(svg.includes('<image href="data:image/png;base64,AAAA"'), 'thumbnail embedded');
  assert.ok(svg.includes('matrix('), 'placement matrix applied');
  assert.ok(!svg.includes('<line x1="0.5"'), 'legacy placeholder removed');
});

test('placementMatrix is exported and follows a manual move', () => {
  // The sheet editor drags placements; it relies on this helper to rebuild the
  // cached matrix. A stale matrix moved the dashed box but left the artwork,
  // white plate and cut line behind.
  assert.equal(typeof placementMatrix, 'function');
  const p = { rot: 0, pixelsPerMm: 4, width: 40, height: 80, xMm: 10, yMm: 20, widthMm: 10, heightMm: 20 };
  assert.deepEqual(placementMatrix(p), [0.25, 0, 0, 0.25, 10, 20]);
  p.xMm = 55; p.yMm = 60;
  assert.deepEqual(placementMatrix(p), [0.25, 0, 0, 0.25, 55, 60], 'translation follows xMm/yMm');
  p.rot = 180;
  assert.deepEqual(placementMatrix(p), [-0.25, 0, 0, -0.25, 65, 80], 'a half turn keeps the footprint anchored');
});
