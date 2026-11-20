'use strict';
/*
 * Bases used to be stamped on a lattice anchored to the sheet margin, one step
 * of (baseSize + clearance). Whatever the artwork left over was skipped: a 29mm
 * strip beside the last item on a row stayed empty because the next lattice slot
 * landed past it. Bases are also checked against the real cut line now, not the
 * placed box, so they can use a hollow in a concave outline.
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
load(fs.readFileSync(path.join(SRC, 'nesting-geometry.js'), 'utf8'), [win, win, win, win.navigator, console]);
load(fs.readFileSync(path.join(SRC, 'nesting.js'), 'utf8'), [win, win, win, win.navigator, console]);
const N = win.OutlineNesting;
N.exposeClipper(clipper);

const BASE = 35;
const GAP = 0.25;
const MARGIN = 1;

function item(name, wMm, hMm, cut) {
  const ppm = 2;
  const rect = [[0, 0], [wMm * ppm, 0], [wMm * ppm, hMm * ppm], [0, hMm * ppm]];
  return {
    name, width: wMm * ppm, height: hMm * ppm, pixelsPerMm: ppm,
    widthMm: wMm, heightMm: hMm, cutPaths: cut || [rect], whitePaths: [rect],
  };
}
const tf = (pts, m) => pts.map(([x, y]) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]]);
const segDist = (p, a, b) => {
  const vx = b[0] - a[0], vy = b[1] - a[1];
  const L = vx * vx + vy * vy;
  let t = L ? ((p[0] - a[0]) * vx + (p[1] - a[1]) * vy) / L : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(p[0] - (a[0] + t * vx), p[1] - (a[1] + t * vy));
};
const sheets = (result) => result.placements.map((p) => {
  const s = p.outlineShift || [0, 0];
  return p.cutPaths.map((l) => tf(l.map(([x, y]) => [x + s[0], y + s[1]]), p.matrix));
});

test('no base lands within the clearance of a cut line', () => {
  const r = N.packNesting([item('a', 120, 150), item('b', 120, 150)]); 
  const art = sheets(r);
  for (const b of r.bases) {
    const corners = [[b.xMm, b.yMm], [b.xMm + BASE, b.yMm], [b.xMm + BASE, b.yMm + BASE], [b.xMm, b.yMm + BASE]];
    for (const loops of art) for (const pts of loops) {
      for (let i = 0; i < pts.length; i++) {
        for (const c of corners) {
          assert.ok(segDist(c, pts[i], pts[(i + 1) % pts.length]) >= GAP - 0.05,
            'a base is closer than the clearance to the artwork');
        }
      }
    }
  }
});

test('bases never overlap each other or leave the sheet', () => {
  const r = N.packNesting([item('a', 100, 120), item('b', 100, 120), item('c', 90, 110)]);
  for (let i = 0; i < r.bases.length; i++) {
    const b = r.bases[i];
    assert.ok(b.xMm >= MARGIN - 1e-9 && b.yMm >= MARGIN - 1e-9);
    assert.ok(b.xMm + BASE <= 400 - MARGIN + 1e-9 && b.yMm + BASE <= 300 - MARGIN + 1e-9);
    for (let j = i + 1; j < r.bases.length; j++) {
      const o = r.bases[j];
      const apart = b.xMm >= o.xMm + BASE + GAP - 1e-9 || o.xMm >= b.xMm + BASE + GAP - 1e-9 ||
        b.yMm >= o.yMm + BASE + GAP - 1e-9 || o.yMm >= b.yMm + BASE + GAP - 1e-9;
      assert.ok(apart, `bases ${i} and ${j} overlap`);
    }
  }
});

test('the leftover strip beside a row is not abandoned', () => {
  // One item leaves a wide strip on row 1. A margin-anchored lattice would step
  // straight over it; every base that fits there must be used.
  const r = N.packNesting([item('a', 130, 140)]);
  const strip = r.bases.filter((b) => b.yMm < 140);
  assert.ok(strip.length >= 3,
    `expected the empty right-hand strip to take bases, got ${strip.length}`);
});

test('a base can use the hollow of a concave item', () => {
  // A C shape facing right: the notch is free space a box test would refuse.
  const ppm = 2;
  const c = [[0, 0], [60 * ppm, 0], [60 * ppm, 10 * ppm], [20 * ppm, 10 * ppm],
    [20 * ppm, 50 * ppm], [60 * ppm, 50 * ppm], [60 * ppm, 60 * ppm], [0, 60 * ppm]];
  const r = N.packNesting([item('c', 60, 60, [c])]);
  const notch = r.bases.filter((b) => b.xMm > 20 && b.xMm < 40 && b.yMm > 10 && b.yMm < 50);
  assert.ok(notch.length >= 1, 'the concave notch should hold a base');
});

test('a large leftover block of bases never stacks a base on top of another', () => {
  // The shadow a placed base casts used to be patched straight into the integral
  // image, one row at a time. A prefix sum also accumulates downwards, so every
  // row below the shadow kept stale values: the next band saw free space and
  // stamped a second base over the first. Tall figures leave a big empty block, so
  // this is the case that exposed it — 8 overlapping pairs on a 400x300 sheet.
  const items = [];
  for (let i = 0; i < 8; i++) items.push(item(`t${i}`, 34 + i * 2, 92 + i * 3));
  const r = N.packNesting(items);
  assert.ok(r.bases.length > 40, `expected a large base block, got ${r.bases.length}`);
  for (let i = 0; i < r.bases.length; i++) {
    for (let j = i + 1; j < r.bases.length; j++) {
      const b = r.bases[i], o = r.bases[j];
      const apart = b.xMm >= o.xMm + BASE + GAP - 1e-9 || o.xMm >= b.xMm + BASE + GAP - 1e-9 ||
        b.yMm >= o.yMm + BASE + GAP - 1e-9 || o.yMm >= b.yMm + BASE + GAP - 1e-9;
      assert.ok(apart,
        `base ${i} at (${b.xMm.toFixed(2)},${b.yMm.toFixed(2)}) overlaps base ${j} at (${o.xMm.toFixed(2)},${o.yMm.toFixed(2)})`);
    }
  }
});

test('a base never straddles the boundary between two bands', () => {
  // A row may only occupy the lower part of its band. Accepting the topmost legal
  // y let a row overhang into the next band, where the second row could then be
  // pushed down onto it.
  const r = N.packNesting([item('a', 60, 100), item('b', 60, 100), item('c', 55, 95)]);
  const rowsOf = new Map();
  for (const b of r.bases) {
    const k = b.yMm.toFixed(3);
    if (!rowsOf.has(k)) rowsOf.set(k, []);
    rowsOf.get(k).push(b);
  }
  const tops = [...rowsOf.keys()].map(Number).sort((a, b) => a - b);
  for (let i = 1; i < tops.length; i++) {
    assert.ok(tops[i] - tops[i - 1] >= BASE + GAP - 1e-6,
      `base rows ${tops[i - 1]} and ${tops[i]} are closer than one base plus the clearance`);
  }
});

test('every base still clears the artwork in a crowded sheet', () => {
  // Guards the other direction: the burn list must not make sites look free.
  const ppm = 2;
  const items = [item('a', 120, 130), item('b', 110, 120), item('c', 100, 110), item('d', 95, 105)];
  const r = N.packNesting(items);
  const art = sheets(r);
  for (const b of r.bases) {
    const corners = [[b.xMm, b.yMm], [b.xMm + BASE, b.yMm], [b.xMm + BASE, b.yMm + BASE], [b.xMm, b.yMm + BASE],
      [b.xMm + BASE / 2, b.yMm + BASE / 2]];
    for (const loops of art) for (const pts of loops) {
      for (let i = 0; i < pts.length; i++) {
        for (const c of corners) {
          assert.ok(segDist(c, pts[i], pts[(i + 1) % pts.length]) >= GAP - 0.05,
            'a base is closer than the clearance to the artwork');
        }
      }
    }
  }
});
