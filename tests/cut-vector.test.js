'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const C = require('../vendor/clipper.js');
const V = require('../cut-vector.js');
const SR = require('../scaffold-rules.js');

function bboxOf(loop) { return V.bbox(loop); }
function widthAt(poly, y) {
  const xs = [];
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length];
    if ((a[1] - y) * (b[1] - y) < 0) { const t = (y - a[1]) / (b[1] - a[1]); xs.push(a[0] + t * (b[0] - a[0])); }
  }
  xs.sort((p, q) => p - q);
  return xs.length ? xs[xs.length - 1] - xs[0] : null;
}

test('closed-loop RDP removes staircase points and honours the mm tolerance', () => {
  // 60 mm circle sampled on a 0.153 mm pixel grid (mask staircase), y down.
  const orig = [];
  for (let a = 0; a < 360; a += 0.4) {
    const r = 30, x = 50 + r * Math.cos(a * Math.PI / 180), y = 50 + r * Math.sin(a * Math.PI / 180);
    orig.push([Math.round(x / 0.153) * 0.153, Math.round(y / 0.153) * 0.153]);
  }
  const simp = V.simplifyLoop(orig, 0.1);
  assert.ok(simp.length < orig.length / 4, `expected heavy reduction, got ${simp.length}/${orig.length}`);
  assert.ok(V.loopDeviation(orig, simp) <= 0.1 + 1e-9, 'deviation must stay within tolerance');
  // zero tolerance must reproduce the original exactly
  assert.equal(V.loopDeviation(orig, V.simplifyLoop(orig, 0)), 0);
});

test('parametric triangle matches the analytic Minkowski dimensions', () => {
  const d = SR.roundedTriangleDimensions(47, 1);
  const tri = V.roundedTrianglePoly(50, 100, 47, 1);
  const bb = bboxOf(tri);
  assert.ok(Math.abs((bb.maxX - bb.minX) - d.roundedWidthMm) < 0.002, 'rounded width');
  assert.ok(Math.abs((bb.maxY - bb.minY) - d.roundedHeightMm) < 0.002, 'rounded height');
  assert.ok(Math.abs(bb.maxY - 100) < 1e-9, 'virtual base sits at bottom');
  // area = inset triangle + perimeter*r + pi r^2 (Minkowski with the fillet disk)
  const inset = Math.pow(d.straightSideMm, 2) * Math.sqrt(3) / 4;
  const expect = inset + 3 * d.straightSideMm * 1 + Math.PI * 1;
  assert.ok(Math.abs(Math.abs(V.loopArea(tri)) - expect) < 0.2, `area ${Math.abs(V.loopArea(tri))} vs ${expect}`);
});

test('parametric rounded rectangle matches width, height and R1 corners', () => {
  const rc = V.roundedRectPoly(50, 10, 90, 47, 1);
  const bb = bboxOf(rc);
  assert.ok(Math.abs((bb.maxX - bb.minX) - 47) < 1e-9);
  assert.ok(Math.abs((bb.maxY - bb.minY) - 80) < 1e-9);
  const expect = 47 * 80 - (4 - Math.PI) * 1;
  assert.ok(Math.abs(Math.abs(V.loopArea(rc)) - expect) < 0.05);
  // inside the R1 corner band the row width follows the arc within chord tol
  const yCorner = 10.55, expectCorner = 2 * ((47 / 2 - 1) + Math.sqrt(1 - (11 - yCorner) * (11 - yCorner)));
  assert.ok(Math.abs(widthAt(rc, yCorner) - expectCorner) < 0.03, `corner row ${widthAt(rc, yCorner)} vs ${expectCorner}`);
});

test('parametric tab: sharp root corners by default, fillet only on explicit request', () => {
  const tb = V.tabPoly(50, 100, 3, 30, 1, 0.75);
  const bb = bboxOf(tb);
  assert.ok(Math.abs((bb.maxX - bb.minX) - 30) < 1e-6, 'top width exactly the tab width (V1/V2 sharp)');
  assert.ok(Math.abs((bb.maxY - bb.minY) - 3) < 1e-9, 'depth 3');
  for (const sx of [-1, 1]) {
    assert.ok(tb.some(p => Math.hypot(p[0] - (50 + sx * 15), p[1] - 100) < 1e-9),
      `sharp junction corner at (${50 + sx * 15},100)`);
  }
  assert.ok(Math.abs(widthAt(tb, 102.24) - 28) < 0.02, 'flank chord end width 30-2*taper');
  const cR = [50 + 15 - 1 - 0.75, 103 - 0.75];
  const arc = tb.filter(p => Math.abs(Math.hypot(p[0] - cR[0], p[1] - cR[1]) - 0.75) < 1e-9);
  assert.ok(arc.length >= 4, 'right tip arc segmented (V3 R0.75 kept)');
  const rp = V.tabRootParams(3, 30, 1, 0.75, 3);
  assert.ok(rp.r > 2.4 && rp.r < 2.5, `explicit root fillet still clamps to flank room: ${rp.r}`);
  const fr = V.tabPoly(50, 100, 3, 30, 1, 0.75, 3);
  assert.ok(Math.abs((bboxOf(fr).maxX - bboxOf(fr).minX) - (30 + 2 * rp.t)) < 1e-6, 'explicit rootR widens top by 2t');
  const cl = V.tabPoly(50, 100, 1, 30, 1, 0.75);
  assert.ok(Math.abs((bboxOf(cl).maxY - bboxOf(cl).minY) - 1) < 1e-9);
});

test('buildCutVector unions silhouette, scaffold fragment and tab (contact bar removed)', () => {
  const rect = [[10, 5], [70, 5], [70, 105], [10, 105]];
  const res = V.buildCutVector({
    outlineLoopsMm: [rect], cxMm: 40, topMm: 5, bottomMm: 105, upperEndMm: 5 + 100 / 3,
    scaffold: { shape: 'rounded_rectangle', scaffoldWidthMm: 47, nominalDimensionMm: 47, cornerRadiusMm: 1 },
    gapMm: 0, speckMm2: 1, tab: { width: 30, depth: 3, taper: 1, tipR: 0.75 }
  }, C);
  assert.equal(res.loops.length, 1, 'single outer loop');
  assert.equal(res.keptCells, 0, 'scaffold flush with the outline bottom adds no fragment');
  assert.equal(res.droppedCells, 0);
  const bb = bboxOf(res.loops[0]);
  assert.ok(Math.abs((bb.maxX - bb.minX) - 60) < 1e-6, 'outline width preserved');
  assert.ok(Math.abs((bb.maxY - bb.minY) - 103) < 1e-6, 'outline+tab height');
  assert.ok(widthAt(res.loops[0], bb.maxY - 0.5) < 28.2, 'tab tip zone');
  assert.ok(Math.abs(widthAt(res.loops[0], bb.maxY - 3.5) - 60) < 1e-6, 'junction row is plain outline width (no bar lip)');
  assert.ok(Math.abs(widthAt(res.loops[0], bb.maxY - 2.5) - (30 - 2 * 0.5 / 2.25)) < 0.01, 'tab flank starts right at the silhouette bottom (taper over depth-tipR)');
  assert.ok(res.loops[0].length < 120, `vector stays compact: ${res.loops[0].length} pts`);
});

test('buildCutVector drops upper-third scaffold fragments like selectFragments', () => {
  // narrow tall outline: scaffold column sticks out at top AND bottom
  const rect = [[35, 5], [45, 5], [45, 105], [35, 105]];
  const res = V.buildCutVector({
    outlineLoopsMm: [rect], cxMm: 40, topMm: 5, bottomMm: 105, upperEndMm: 5 + 100 / 3,
    scaffold: { shape: 'rounded_rectangle', scaffoldWidthMm: 47, nominalDimensionMm: 47, cornerRadiusMm: 1 },
    gapMm: 0, speckMm2: 1, tab: { width: 30, depth: 3, taper: 1, tipR: 0.75 }
  }, C);
  assert.ok(res.droppedCells >= 1, 'upper fragment discarded');
  const bb = bboxOf(res.loops[0]);
  assert.ok(Math.abs(bb.minY - 5) < 1e-6, 'top stays at the outline, no upper scaffold wings');
  assert.ok(Math.abs((bb.maxX - bb.minX) - 30) < 0.05, 'tab width governs the widest row');
});

test('vector cut stays within tolerance of the raster chain on a synthetic silhouette', () => {
  // raster: dilated staircase of a 60 mm circle; vector: same loop simplified
  const ppm = 6.5512, steps = [];
  for (let a = 0; a < 360; a += 0.5) {
    const x = 50 + 30 * Math.cos(a * Math.PI / 180), y = 60 + 30 * Math.sin(a * Math.PI / 180);
    steps.push([Math.round(x * ppm) / ppm, Math.round(y * ppm) / ppm]);
  }
  const res = V.buildCutVector({
    outlineLoopsMm: [steps], cxMm: 50, topMm: 30, bottomMm: 89.8, upperEndMm: 30 + 60 / 3,
    scaffold: { shape: 'triangle', scaffoldWidthMm: 45.53589838486224, nominalDimensionMm: 47, cornerRadiusMm: 1 },
    gapMm: 0, speckMm2: 1, tab: { width: 30, depth: 3, taper: 1, tipR: 0.75 }
  }, C);
  assert.equal(res.loops.length, 1);
  // away from the intentional junction fillets the silhouette must respect RDP
  const body = steps.filter(p => p[1] < 78);
  const dev = V.loopDeviation(body, res.loops[0]);
  assert.ok(dev <= 0.1 + 0.01, `silhouette deviation ${dev} mm must respect the RDP tolerance`);
  assert.ok(res.loops[0].length < steps.length / 3, 'point count collapses');
});

// ---- cubic Bézier fitting (point-count reduction at the approved 0.15 mm budget)
const stair = (pts) => pts.map(p => [Math.round(p[0] / 0.153) * 0.153, Math.round(p[1] / 0.153) * 0.153]);
const rectStair = () => {
  const r = [];
  const edge = (a, b, c, d, n) => { for (let i = 0; i < n; i++) { const t = i / n; r.push([a + (c - a) * t, b + (d - b) * t]); } };
  edge(0, 0, 30, 0, 90); edge(30, 0, 30, 20, 60); edge(30, 20, 0, 20, 90); edge(0, 20, 0, 0, 60);
  return stair(r);
};
const circleStair = () => {
  const r = [];
  for (let a = 0; a < 360; a += 0.5) r.push([50 + 30 * Math.cos(a * Math.PI / 180), 60 + 30 * Math.sin(a * Math.PI / 180)]);
  return stair(r);
};

test('cubic fit keeps sharp corners exact anchors and stays within tolerance', () => {
  const sq = rectStair();
  const fit = V.fitLoopCubics(sq, 0.15, 0, 0.7);
  assert.ok(fit.length - 1 <= 12, `corner-dominated fit stays tiny: ${fit.length - 1} anchors`);
  for (const c of stair([[0, 0], [30, 0], [30, 20], [0, 20]])) {
    // an anchor is the loop start (bare point) or any command endpoint
    assert.ok(fit.some(e => (e.length === 2
      ? Math.hypot(e[0] - c[0], e[1] - c[1])
      : Math.hypot(e[5] - c[0], e[6] - c[1])) < 1e-9),
      `quantised corner ${c} must survive as an exact anchor`);
  }
  const dev = V.loopDeviation(sq, V.flattenCubics(fit, 24));
  assert.ok(dev <= 0.16, `fit deviation ${dev} mm within the 0.15 budget + quantisation`);
});

test('fitSelectLoops leaves parametric loops untouched and fits silhouette-scale loops', () => {
  const small = V.tabPoly(50, 100, 3, 30, 1, 0.75);
  const big = circleStair();
  const out = V.fitSelectLoops([small, big], 0.15, 0.7);
  assert.deepStrictEqual(out[0], small, 'tab loop stays an exact polyline');
  assert.ok(out[1].length - 1 < 90, `circle collapses: ${out[1].length - 1} anchors`);
  assert.ok(out[1].some(e => e[0] === 'C'), 'smooth runs become cubics');
  const st = V.loopStats(out);
  assert.equal(st.curves, out[1].filter(e => e[0] === 'C').length);
  assert.equal(st.anchors, out[0].length + out[1].length);
});

test('buildCutVector fitTolMm shrinks the silhouette loop but preserves its shape', () => {
  const steps = circleStair();
  const cfg = {
    outlineLoopsMm: [steps], cxMm: 50, topMm: 30, bottomMm: 89.8, upperEndMm: 50,
    scaffold: { shape: 'triangle', scaffoldWidthMm: 45.53589838486224, nominalDimensionMm: 47, cornerRadiusMm: 1 },
    gapMm: 0, speckMm2: 1, tab: { width: 30, depth: 3, taper: 1, tipR: 0.75 }
  };
  const raw = V.buildCutVector(cfg, C);
  const fit = V.buildCutVector(Object.assign({}, cfg, { fitTolMm: 0.15 }), C);
  assert.ok(!raw.loops[0].some(e => e[0] === 'C'), 'no fit without fitTolMm');
  assert.ok(fit.loops[0].some(e => e[0] === 'C'), 'fit applied with fitTolMm');
  assert.ok(fit.loops[0].length < raw.loops[0].length * 0.7, `${fit.loops[0].length} vs ${raw.loops[0].length} commands`);
  const dev = V.loopDeviation(raw.loops[0], V.flattenCubics(fit.loops[0], 16));
  assert.ok(dev <= 0.16, `fitted contour stays within budget: ${dev} mm`);
});

test('datum-run anchoring keeps the seating plane straight across a tangent fillet', () => {
  // Reproduces the real defect: the seat row joins the scaffold R3 fillet
  // tangentially, so corner detection sees no corner there and one cubic
  // spans row+fillet+flank, bowing the row below the datum within budget.
  const loop = [[5.5, 0]];
  for (const x of [4, 2, 1, 0.4]) loop.push([x, 0]);          // straight datum row
  loop.push([0, 0]);
  for (let k = 1; k <= 10; k++) {                              // R3 fillet, tangent at both ends
    const th = Math.PI / 2 + (Math.PI / 2) * (k / 10);
    loop.push([3 * Math.cos(th), -3 + 3 * Math.sin(th)]);
  }
  for (const y of [-4.5, -6, -8]) loop.push([-3, y]);          // flank
  loop.push([-1, -8], [2, -8], [5.5, -8], [5.5, -4], [5.5, -2]);
  const free = V.flattenCubics(V.fitLoopCubics(loop, 0.15, 0, 0.7), 48);
  const sagFree = Math.max(...free.map(p => p[1]));
  assert.ok(sagFree > 0.05, `unanchored fit must reproduce the bow (got ${sagFree})`);
  const anchored = V.flattenCubics(V.fitLoopCubics(loop, 0.15, 0, 0.7, 0), 48);
  for (const p of anchored) assert.ok(p[1] <= 1e-6, `datum row must stay exact: ${p}`);
  const dev = V.loopDeviation(loop, anchored);
  assert.ok(dev <= 0.15, `anchored fit still within budget (${dev})`);
});

test('pdf vectorPath emits cubic operators for fitted loops', () => {
  globalThis.window = globalThis.window || {};
  require('../pdf.js');
  const vp = globalThis.window.OutlinePDF._vectorPath;
  const d = vp([[[0, 0], ['C', 1, 0, 2, 1, 3, 1], [3, 0]]]);
  assert.match(d, /0 0 m/);
  assert.match(d, /1 0 2 1 3 1 c/);
  assert.match(d, /3 0 l/);
  assert.match(d, /h\n?$/);
});

test('cubic fit never exports a self-intersecting loop (hairpin slits stay collinear)', () => {
  const base = circleStair();
  // zero-width slit: out-and-back detour like a 1 px morphology artifact
  const k = 100, tip = [base[k][0] + 0.5, base[k][1]];
  const spiked = base.slice(0, k + 1).concat([tip], base.slice(k + 1));
  const out = V.fitSelectLoops([spiked], 0.15, 0.7);
  assert.ok(!V.loopSelfIntersects(out[0]), 'fitted loop must stay simple');
  const dev = V.loopDeviation(spiked, V.flattenCubics(out[0], 16));
  assert.ok(dev <= 0.16, `slit followed within budget: ${dev} mm`);
  // and a plain staircase circle stays simple too
  const plain = V.fitSelectLoops([circleStair()], 0.15, 0.7);
  assert.ok(!V.loopSelfIntersects(plain[0]));
});
