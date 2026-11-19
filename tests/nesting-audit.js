'use strict';
/*
 * Nesting overlap audit.
 *
 * Drives the real nesting pipeline end to end (PDF import -> pipeline-style item
 * -> packNesting) and then checks the produced placements with an independent
 * geometric test, instead of trusting the packer's own safety outline.
 */
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const SRC = '/home/user/site-deploy/final-stage';

function loadEngine(win = {}) {
  const files = ['nesting-geometry.js', 'nesting.js'];
  for (const f of files) {
    const code = fs.readFileSync(path.join(SRC, f), 'utf8');
    // The engine reads ClipperLib from the global scope.
    new Function('window', 'globalThis', code)(win, win);
  }
  return win;
}

// ---- independent geometry (no shared code with nesting.js) ----------------
function signedArea(poly) {
  let a = 0;
  for (let i = 0; i < poly.length; i++) {
    const [x1, y1] = poly[i], [x2, y2] = poly[(i + 1) % poly.length];
    a += x1 * y2 - x2 * y1;
  }
  return a / 2;
}

function segCross(p1, p2, p3, p4) {
  const d = (a, b, c) => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
  const d1 = d(p3, p4, p1), d2 = d(p3, p4, p2), d3 = d(p1, p2, p3), d4 = d(p1, p2, p4);
  return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0));
}

function inside(pt, poly) {
  let c = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    if ((yi > pt[1]) !== (yj > pt[1]) && pt[0] < ((xj - xi) * (pt[1] - yi)) / (yj - yi) + xi) c = !c;
  }
  return c;
}

function polygonsIntersect(A, B) {
  for (let i = 0; i < A.length; i++) {
    for (let j = 0; j < B.length; j++) {
      if (segCross(A[i], A[(i + 1) % A.length], B[j], B[(j + 1) % B.length])) return true;
    }
  }
  if (inside(A[0], B) || inside(B[0], A)) return true;
  return false;
}

function transform(points, matrix) {
  const [a, b, c, d, e, f] = matrix;
  return points.map(([x, y]) => [a * x + c * y + e, b * x + d * y + f]);
}

function bbox(points) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const [x, y] of points) {
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
  }
  return { minX, minY, maxX, maxY };
}

/** Audit one packed result. Returns an array of problems, empty when clean. */
function audit(result, { minGapMm = 0 } = {}) {
  const problems = [];
  const P = result.placements;

  // 1. Each placement's own outline must match the declared box.
  const outlines = P.map((p) => {
    const loop = pickLoop(p);
    const pts = transform(loop.map(([x, y]) => [x / p.pixelsPerMm, y / p.pixelsPerMm]), p.matrix);
    return pts;
  });

  for (let i = 0; i < P.length; i++) {
    for (let j = i + 1; j < P.length; j++) {
      if (polygonsIntersect(outlines[i], outlines[j])) {
        problems.push(`CUT OVERLAP: ${P[i].name} (#${i}) x ${P[j].name} (#${j})`);
        continue;
      }
      if (minGapMm > 0) {
        const gap = polygonGap(outlines[i], outlines[j]);
        if (gap < minGapMm - 1e-6) {
          problems.push(`GAP TOO SMALL: ${P[i].name} x ${P[j].name} = ${gap.toFixed(3)}mm < ${minGapMm}mm`);
        }
      }
    }
  }

  // 2. Nothing may leave the sheet.
  for (let i = 0; i < P.length; i++) {
    const b = bbox(outlines[i]);
    if (b.minX < result.marginMm - 1e-6 || b.minY < result.marginMm - 1e-6) {
      problems.push(`OUT OF SHEET: ${P[i].name} at ${b.minX.toFixed(2)},${b.minY.toFixed(2)}`);
    }
    if (b.maxX > result.sheetWidthMm + 1e-6 || b.maxY > result.sheetHeightMm + 1e-6) {
      problems.push(`OUT OF SHEET: ${P[i].name} ends ${b.maxX.toFixed(2)},${b.maxY.toFixed(2)}`);
    }
  }

  // 3. Bases must not sit on top of artwork.
  for (const base of result.bases) {
    const rect = [[base.xMm, base.yMm], [base.xMm + base.widthMm, base.yMm],
      [base.xMm + base.widthMm, base.yMm + base.heightMm], [base.xMm, base.yMm + base.heightMm]];
    for (let i = 0; i < P.length; i++) {
      if (polygonsIntersect(rect, outlines[i])) {
        problems.push(`BASE ON ART: base ${base.xMm.toFixed(1)},${base.yMm.toFixed(1)} x ${P[i].name}`);
      }
    }
  }
  for (let i = 0; i < result.bases.length; i++) {
    for (let j = i + 1; j < result.bases.length; j++) {
      const a = result.bases[i], b = result.bases[j];
      const hit = a.xMm < b.xMm + b.widthMm && b.xMm < a.xMm + a.widthMm &&
        a.yMm < b.yMm + b.heightMm && b.yMm < a.yMm + a.heightMm;
      if (hit) problems.push('BASE OVERLAP');
    }
  }
  return problems;
}

function pickLoop(p) {
  const loops = (p.cutPaths || []).filter((l) => Array.isArray(l) && l.length >= 3);
  if (!loops.length) {
    const w = p.widthMm, h = p.heightMm;
    return [[0, 0], [w * p.pixelsPerMm, 0], [w * p.pixelsPerMm, h * p.pixelsPerMm], [0, h * p.pixelsPerMm]];
  }
  return loops.reduce((a, b) => (Math.abs(signedArea(b)) > Math.abs(signedArea(a)) ? b : a));
}

/** Minimum distance between two polygons (0 when they touch). */
function polygonGap(A, B) {
  let best = Infinity;
  const segDist = (p, a, b) => {
    const dx = b[0] - a[0], dy = b[1] - a[1];
    const len = dx * dx + dy * dy;
    let t = len ? ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len : 0;
    t = Math.max(0, Math.min(1, t));
    return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy));
  };
  for (let i = 0; i < A.length; i++) {
    for (let j = 0; j < B.length; j++) {
      const a1 = A[i], a2 = A[(i + 1) % A.length], b1 = B[j], b2 = B[(j + 1) % B.length];
      best = Math.min(best, segDist(a1, b1, b2), segDist(b1, a1, a2));
    }
  }
  return polygonsIntersect(A, B) ? 0 : best;
}

module.exports = { loadEngine, audit, polygonsIntersect, polygonGap, transform, pickLoop, bbox };

if (require.main === module) {
  const win = loadEngine();
  const packNesting = win.OutlineNesting.packNesting;

  // A spread of shapes: rectangles, L shapes, plus shapes with a notch.
  const items = [];
  const mk = (name, w, h, shape) => {
    const ppm = 12;
    const W = w * ppm, H = h * ppm;
    let loop;
    if (shape === 'L') loop = [[0, 0], [W, 0], [W, H / 2], [W / 2, H / 2], [W / 2, H], [0, H]];
    else if (shape === 'notch') loop = [[0, 0], [W, 0], [W, H], [W * 0.6, H], [W * 0.6, H * 0.4], [W * 0.4, H * 0.4], [W * 0.4, H], [0, H]];
    else loop = [[0, 0], [W, 0], [W, H], [0, H]];
    items.push({ name, width: W, height: H, pixelsPerMm: ppm, widthMm: w, heightMm: h, cutPaths: [loop], whitePaths: [loop], artwork: null });
  };

  for (let i = 0; i < 8; i++) mk(`rect${i}`, 45 + i * 4, 80 + (i % 5) * 6, 'rect');
  for (let i = 0; i < 4; i++) mk(`L${i}`, 60 + i * 5, 90 + i * 7, 'L');
  for (let i = 0; i < 4; i++) mk(`notch${i}`, 55 + i * 6, 85 + i * 4, 'notch');

  const r = packNesting(items);
  console.log(`placed ${r.placements.length}/${items.length}, rows=${r.rowCount}, bases=${r.bases.length}`);
  const problems = audit(r, { minGapMm: 0.25 });
  if (!problems.length) console.log('AUDIT: clean');
  else { console.log(`AUDIT: ${problems.length} problems`); problems.slice(0, 25).forEach((p) => console.log('  ' + p)); }
}

// A capsule with a tab at the bottom centre, 180° symmetric top/bottom.
function capsuleWithTabs(wMm, hMm, tabW, tabH, ppm = 12) {
  const W = wMm * ppm, H = hMm * ppm;
  const r = W / 2, tw = tabW * ppm, th = tabH * ppm;
  const pts = [];
  const seg = 10;
  // top arch
  for (let i = 0; i <= seg; i++) {
    const a = Math.PI + (Math.PI * i) / seg;
    pts.push([r + r * Math.cos(a), r + r * Math.sin(a)]);
  }
  // left side down to bottom
  pts.push([0, H - r]);
  // bottom arch (left to right)
  for (let i = 0; i <= seg; i++) {
    const a = Math.PI - (Math.PI * i) / seg;
    pts.push([r + r * Math.cos(a), H - r + r * Math.sin(a)]);
  }
  // tab at bottom centre going down
  pts.push([r + tw / 2, H + th]);
  pts.push([r + tw / 2, H]);
  pts.push([r - tw / 2, H]);
  pts.push([r - tw / 2, H + th]);
  pts.push([0, H - r]);
  return pts;
}

module.exports.capsuleWithTabs = capsuleWithTabs;
