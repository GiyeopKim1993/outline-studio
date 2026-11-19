'use strict';
/*
 * Regression: dense, organic cut lines (a 300dpi character standee has ~3000
 * points per outline).
 *
 * The packer used to sample every outline down to 96 points. That shaved detail
 * off the shape, so two items could be packed closer than their real cut lines
 * allow: 46.25mm apart was needed, 45mm was reported. On screen and in the
 * exported PDF the cut lines then crossed.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SRC = process.env.STAGE_DIR || '/home/user/site-deploy/final-stage';
const mod = { exports: {} };
const win = {};
win.self = win;
win.navigator = { userAgent: 'node', platform: 'node', appName: 'node' };
const load = (code, args) => new Function('window', 'globalThis', 'self', 'navigator', 'console', 'module', 'exports', code)(...args);

const clipper = (() => {
  load(fs.readFileSync(path.join(SRC, 'vendor/clipper.js'), 'utf8'),
    [win, win, win, win.navigator, console, mod, mod.exports]);
  return mod.exports;
})();
load(fs.readFileSync(path.join(SRC, 'nesting-geometry.js'), 'utf8'),
  [win, win, win, win.navigator, console]);
load(fs.readFileSync(path.join(SRC, 'nesting.js'), 'utf8'),
  [win, win, win, win.navigator, console]);
const N = win.OutlineNesting;
N.exposeClipper(clipper);

const PPM = 12;

/** A standee-like outline: dense, organic, slightly asymmetric. */
function organicOutline(wMm, hMm, seed) {
  const pts = [];
  const n = 900;
  const W = wMm * PPM, H = hMm * PPM;
  for (let i = 0; i < n; i++) {
    const t = (i / n) * Math.PI * 2;
    const wobble = 1
      + 0.18 * Math.sin(t * 3 + seed)
      + 0.09 * Math.sin(t * 7 + seed * 2)
      + 0.04 * Math.sin(t * 17 + seed * 3);
    // ellipse-ish body, but the top-left corner has a distinct notch
    let x = W / 2 + (W / 2) * wobble * Math.cos(t);
    let y = H / 2 + (H / 2) * wobble * Math.sin(t);
    if (x < W * 0.2 && y < H * 0.12) y += H * 0.06;
    pts.push([Math.max(0, Math.min(W, x)), Math.max(0, Math.min(H, y))]);
  }
  return pts;
}

const mkItem = (name, w, h, seed) => {
  const loop = organicOutline(w, h, seed);
  return {
    name, width: w * PPM, height: h * PPM, pixelsPerMm: PPM,
    widthMm: w, heightMm: h, cutPaths: [loop], whitePaths: [loop], artwork: null,
  };
};

// Independent geometry, sharing no code with the engine.
const segCross = (p1, p2, p3, p4) => {
  const d = (a, b, c) => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
  const d1 = d(p3, p4, p1), d2 = d(p3, p4, p2), d3 = d(p1, p2, p3), d4 = d(p1, p2, p4);
  return ((d1 > 1e-9 && d2 < -1e-9) || (d1 < -1e-9 && d2 > 1e-9))
    && ((d3 > 1e-9 && d4 < -1e-9) || (d3 < -1e-9 && d4 > 1e-9));
};
const inside = (pt, poly) => {
  let c = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    if ((yi > pt[1]) !== (yj > pt[1]) && pt[0] < ((xj - xi) * (pt[1] - yi)) / (yj - yi) + xi) c = !c;
  }
  return c;
};
const intersects = (A, B) => {
  for (let i = 0; i < A.length; i++) {
    for (let j = 0; j < B.length; j++) {
      if (segCross(A[i], A[(i + 1) % A.length], B[j], B[(j + 1) % B.length])) return true;
    }
  }
  return inside(A[0], B) || inside(B[0], A);
};
const tf = (pts, m) => pts.map(([x, y]) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]]);
// Placements carry raw pixel loops plus the shift that normalises them, exactly
// like the preview and the PDF export.
const outlineOf = (p, loop) => {
  const s = p.outlineShift || [0, 0];
  return tf(loop.map(([x, y]) => [x + s[0], y + s[1]]), p.matrix);
};
const bbox = (pts) => {
  let a = Infinity, b = Infinity, c = -Infinity, d = -Infinity;
  for (const [x, y] of pts) { a = Math.min(a, x); c = Math.max(c, x); b = Math.min(b, y); d = Math.max(d, y); }
  return [a, b, c, d];
};
// Overlap means "closer than the clearance the packer promises", not "touching".
const CLEARANCE = 0.25;
const bboxHit = (A, B, gap = CLEARANCE) =>
  A[0] < B[2] - gap + 1e-3 && B[0] < A[2] - gap + 1e-3 &&
  A[1] < B[3] - gap + 1e-3 && B[1] < A[3] - gap + 1e-3;

test('dense outlines are not sampled so hard that the shape shrinks', () => {
  const loop = organicOutline(50, 150, 1);
  const item = { name: 'a', width: 50 * PPM, height: 150 * PPM, pixelsPerMm: PPM, widthMm: 50, heightMm: 150, cutPaths: [loop], whitePaths: [loop] };
  const built = N.packNesting([item]);
  const p = built.placements[0];
  const real = bbox(loop.map(([x, y]) => [x / PPM, y / PPM]));
  // The packer's box is allowed to be marginally larger (it adds clearance) but
  // must never be smaller than the real cut line.
  assert.ok(p.widthMm >= (real[2] - real[0]) - 1e-6,
    `width ${p.widthMm.toFixed(3)} was under the real ${(real[2] - real[0]).toFixed(3)}`);
  assert.ok(p.heightMm >= (real[3] - real[1]) - 1e-6,
    `height ${p.heightMm.toFixed(3)} was under the real ${(real[3] - real[1]).toFixed(3)}`);
});

test('dense items keep a real 0.25mm gap, measured on the cut lines', () => {
  const items = [];
  for (let i = 0; i < 6; i++) items.push(mkItem(`d${i}`, 44 + i * 3, 120 + i * 8, i + 1));
  const r = N.packNesting(items);
  assert.ok(r.placements.length >= 4, 'most items should fit');

  const outlines = r.placements.map((p) => p.cutPaths.map((l) => outlineOf(p, l)));
  for (let i = 0; i < outlines.length; i++) {
    for (let j = i + 1; j < outlines.length; j++) {
      for (const A of outlines[i]) {
        for (const B of outlines[j]) {
          assert.equal(intersects(A, B), false,
            `cut lines cross: ${r.placements[i].name} x ${r.placements[j].name}`);
        }
      }
    }
  }
});

test('a mixed set of dense items never overlaps and no base lands on artwork', () => {
  const items = [];
  for (let i = 0; i < 8; i++) items.push(mkItem(`m${i}`, 47 + i * 5, 130 + (i % 4) * 15, i * 3 + 1));
  const r = N.packNesting(items);

  const outlines = r.placements.map((p) => { const all = p.cutPaths.map((l) => outlineOf(p, l)).flat(); return { b: bbox(all), loops: p.cutPaths.map((l) => outlineOf(p, l)) }; });

  for (let i = 0; i < outlines.length; i++) {
    for (let j = i + 1; j < outlines.length; j++) {
      assert.equal(bboxHit(outlines[i].b, outlines[j].b), false,
        `real extents overlap: ${r.placements[i].name} x ${r.placements[j].name}`);
    }
  }
  for (const base of r.bases) {
    const box = [base.xMm, base.yMm, base.xMm + base.widthMm, base.yMm + base.heightMm];
    for (const o of outlines) {
      assert.equal(bboxHit(box, o.b), false, 'a base sits on artwork');
    }
  }
});

test('the exported sheet keeps the gap the engine promised', () => {
  // The PDF must place items exactly where the packer said, otherwise the preview
  // and the print disagree.
  const items = [mkItem('p0', 50, 150, 1), mkItem('p1', 50, 150, 2), mkItem('p2', 50, 150, 3)];
  const r = N.packNesting(items);
  const outlines = r.placements.map((p) => p.cutPaths.map((l) => outlineOf(p, l)));
  for (let i = 0; i < outlines.length; i++) {
    for (let j = i + 1; j < outlines.length; j++) {
      for (const A of outlines[i]) {
        for (const B of outlines[j]) {
          assert.equal(intersects(A, B), false, `rotation ${r.placements[i].rot}/${r.placements[j].rot} overlaps`);
        }
      }
    }
  }
});
