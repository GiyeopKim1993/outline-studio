'use strict';
/*
 * The three search options: global order ('size-desc' / 'size-asc'), the beam
 * width / candidate window, and the cross-sheet absorb pass.
 *
 * Pinned here:
 *   1. an order really re-composes the sheets (the flag is not a no-op)
 *   2. an unknown order falls back to the input order byte for byte
 *   3. the caller's item array is never re-ordered as a side effect
 *   4. wider/narrower search settings stay valid and repeatable
 *   5. absorb merges when a merge exists, and otherwise leaves the sheet list
 *      untouched - it may never add a sheet, lose a piece or drop the bases
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { boot } = require('./harness.js');

const { window } = boot();
const { packNesting, packSheets, absorbLastSheet } = window.OutlineNesting;

const OPTS = { sheetWidthMm: 400, sheetHeightMm: 300, marginMm: 1, clearanceMm: 0.25, fillBases: false, baseSizeMm: 35, extraBases: 0 };

function rect(name, wMm, hMm, ppm = 2) {
  const w = wMm * ppm, h = hMm * ppm;
  const loop = [[0, 0], [w, 0], [w, h], [0, h]];
  return { name, cutPaths: [loop], whitePaths: [loop], width: w, height: h, pixelsPerMm: ppm, widthMm: wMm, heightMm: hMm };
}

// Three short pieces (portrait-normalised to 45 x 60) plus three tall ones.
const mixed = () => [rect('s0', 60, 45), rect('s1', 60, 45), rect('s2', 60, 45),
  rect('t0', 130, 250), rect('t1', 130, 250), rect('t2', 130, 250)];
const talls = (n) => Array.from({ length: n }, (_, i) => rect(`t${i}`, 130, 250));
const shorts = (n) => Array.from({ length: n }, (_, i) => rect(`u${i}`, 60, 45));

// An 18 piece job measured out of a 200 job sweep: the default order needs five
// sheets, small-first needs four. Sizes are [width mm, height mm] as authored.
const BIG_SPEC = [[130, 285], [60, 240], [130, 285], [130, 45], [60, 70], [80, 148], [60, 190], [60, 240],
  [80, 148], [160, 70], [160, 190], [45, 285], [45, 190], [160, 285], [60, 100], [60, 148], [160, 70], [190, 45]];
const big = () => BIG_SPEC.map(([w, h], i) => rect(`i${i}`, w, h));

// Built with plain loops: the packer runs in the jsdom realm, and deepEqual
// rejects a foreign array even when the contents match.
function names(packed) {
  const out = [];
  for (const s of packed.sheets) for (const p of s.result.placements) out.push(p.name);
  return out.sort();
}
function fingerprint(packed) {
  const out = [];
  for (const s of packed.sheets) {
    const row = [];
    for (const p of s.result.placements) row.push([p.name, +p.xMm.toFixed(6), +p.yMm.toFixed(6), p.rot, p.rowIndex]);
    out.push(row);
  }
  return JSON.stringify(out);
}

function assertValidSheet(result, label) {
  const gap = OPTS.clearanceMm;
  for (const p of result.placements) {
    assert.ok(p.xMm >= 1 - 1e-6 && p.yMm >= 1 - 1e-6, `${label}: ${p.name} starts inside the margin`);
    assert.ok(p.xMm + p.widthMm <= 399 + 1e-6, `${label}: ${p.name} ends by x = 399`);
    assert.ok(p.yMm + p.heightMm <= 299 + 1e-6, `${label}: ${p.name} ends by y = 299`);
    assert.ok(Number.isFinite(p.xMm) && Number.isFinite(p.yMm), `${label}: ${p.name} has finite coordinates`);
  }
  const ps = result.placements;
  for (let i = 0; i < ps.length; i++) {
    for (let j = i + 1; j < ps.length; j++) {
      const a = ps[i], b = ps[j];
      const overlap = a.xMm < b.xMm + b.widthMm - 1e-6 && b.xMm < a.xMm + a.widthMm - 1e-6 &&
        a.yMm < b.yMm + b.heightMm - 1e-6 && b.yMm < a.yMm + a.heightMm - 1e-6;
      assert.equal(overlap, false, `${label}: ${a.name} overlaps ${b.name}`);
    }
  }
  for (let k = 1; k < result.rows.length; k++) {
    const prev = result.rows[k - 1], cur = result.rows[k];
    assert.ok(cur.yMm >= prev.yMm + prev.heightMm + gap - 1e-6, `${label}: row ${k} keeps the ${gap} mm gap`);
  }
}

test('small-first order packs the 18 piece job into four sheets instead of five', () => {
  const base = packSheets(big(), OPTS);
  const asc = packSheets(big(), { ...OPTS, order: 'size-asc' });
  assert.equal(base.sheets.length, 5);
  assert.deepEqual([...base.sheets.map((s) => s.result.placements.length)], [7, 5, 3, 2, 1], 'the default leaves thin tail sheets');
  assert.equal(asc.sheets.length, 4, 'small-first absorbs the tail');
  assert.deepEqual([...asc.sheets.map((s) => s.result.placements.length)], [7, 7, 2, 2]);
  assert.deepEqual(names(asc), names(base), 'the same 18 pieces are placed');
  assert.equal(asc.unplaced.length, 0);
  assert.notEqual(fingerprint(asc), fingerprint(base), 'the option must change the layout');
  for (const s of asc.sheets) assertValidSheet(s.result, 'size-asc big job');
});

test('big-first order is not a blanket improvement', () => {
  // Measured over 200 jobs of 17-24 pieces: size-desc saved 3 sheets and cost 9,
  // size-asc saved 10 and cost none. The knob is offered, not imposed.
  const base = packSheets(big(), OPTS);
  const desc = packSheets(big(), { ...OPTS, order: 'size-desc' });
  assert.ok(desc.sheets.length >= base.sheets.length, 'big-first must not be assumed to win');
  assert.deepEqual(names(desc), names(base), 'it still places every piece');
  for (const s of desc.sheets) assertValidSheet(s.result, 'size-desc big job');
});

test('order size-asc puts the small pieces first', () => {
  const asc = packSheets(mixed(), { ...OPTS, order: 'size-asc' });
  assert.deepEqual(names(asc), ['s0', 's1', 's2', 't0', 't1', 't2']);
  const leftmost = asc.sheets[0].result.placements.slice().sort((a, b) => a.xMm - b.xMm)[0];
  assert.ok(leftmost.name.startsWith('s'), `expected a short piece first, got ${leftmost.name}`);
  for (const s of asc.sheets) assertValidSheet(s.result, 'size-asc');
});

test('an unknown order falls back to the input order, byte for byte', () => {
  assert.equal(fingerprint(packSheets(mixed(), { ...OPTS, order: 'sideways' })),
    fingerprint(packSheets(mixed(), OPTS)));
});

test('the caller array keeps its order and repeated runs agree', () => {
  const items = mixed();
  const before = items.map((i) => i.name);
  const a = packSheets(items, { ...OPTS, order: 'size-desc' });
  assert.deepEqual(items.map((i) => i.name), before, 'packSheets must not sort the caller array');
  assert.equal(fingerprint(packSheets(items, { ...OPTS, order: 'size-desc' })), fingerprint(a), 'deterministic');
});

test('beam width and candidate window are honoured and stay valid', () => {
  const items = mixed().concat([rect('x0', 90, 200), rect('x1', 90, 200)]);
  for (const opts of [{ beamWidth: 1, candidateLimit: 1 }, { beamWidth: 6, candidateLimit: 40 }, { beamWidth: 12, candidateLimit: 64 }]) {
    const packed = packSheets(items, { ...OPTS, ...opts });
    assert.deepEqual(names(packed), [...items.map((i) => i.name)].sort(), `every piece placed with ${JSON.stringify(opts)}`);
    assert.equal(packed.unplaced.length, 0);
    for (const s of packed.sheets) assertValidSheet(s.result, JSON.stringify(opts));
    assert.equal(fingerprint(packSheets(items, { ...OPTS, ...opts })), fingerprint(packed), 'search settings are not random');
  }
  // A window narrower than the pool must not hide pieces: it slides as items are used.
  assert.equal(packNesting(shorts(5), { ...OPTS, candidateLimit: 1 }).placements.length, 5);
});

test('auto adopts the fewest-sheet order and keeps the default whenever orders tie', () => {
  const auto = packSheets(big(), { ...OPTS, order: 'auto' });
  assert.equal(auto.sheets.length, 4, 'the 18 piece job reaches the size-asc layout');
  assert.deepEqual([...auto.sheets.map((s) => s.result.placements.length)], [7, 7, 2, 2]);
  assert.equal(auto.unplaced.length, 0);
  for (const s of auto.sheets) assertValidSheet(s.result, 'auto big job');
  // Every order packs this job identically, so auto must return the input-order
  // result byte for byte - which is what keeps existing sessions reproducible.
  const base = packSheets(mixed(), OPTS);
  assert.equal(fingerprint(packSheets(mixed(), { ...OPTS, order: 'auto' })), fingerprint(base));
  // And auto may never cost a sheet compared with the default.
  for (const items of [mixed(), talls(7), big()]) {
    const b = packSheets(items, OPTS);
    const a = packSheets(items, { ...OPTS, order: 'auto' });
    assert.ok(a.sheets.length <= b.sheets.length, 'auto must not add sheets');
    assert.deepEqual(names(a), names(b), 'auto places the same pieces');
  }
  assert.equal(fingerprint(packSheets(big(), { ...OPTS, order: 'auto' })), fingerprint(auto), 'auto is deterministic');
  // A job the area bound already proves optimal keeps the input-order layout.
  const one = [rect('p0', 100, 100), rect('p1', 100, 100)];
  assert.equal(fingerprint(packSheets(one, { ...OPTS, order: 'auto' })), fingerprint(packSheets(one, OPTS)));
});

test('the sheet bound uses net cut area, not bounding boxes', () => {
  const box = packNesting([rect('a', 100, 148)], OPTS);
  assert.ok(Math.abs(box.totalAreaMm2 - 100 * 148) < 100 * 148 * 0.02, `rectangle cut area ~ its box, got ${box.totalAreaMm2}`);
  // An L silhouette interlocks with its neighbours, so its boxes may overlap:
  // only the net cut area stays additive. The notch must not count.
  const ppm = 2, w = 130 * ppm, h = 250 * ppm;
  const loop = [[0, 0], [w, 0], [w, h * 0.55], [w * 0.5, h * 0.55], [w * 0.5, h], [0, h]];
  const item = { name: 'L', cutPaths: [loop], whitePaths: [loop], width: w, height: h, pixelsPerMm: ppm, widthMm: 130, heightMm: 250 };
  const r = packNesting([item], OPTS);
  assert.ok(r.totalAreaMm2 > 130 * 250 * 0.6 && r.totalAreaMm2 < 130 * 250 * 0.9,
    `L cut area must sit between 60% and 90% of its box, got ${r.totalAreaMm2}`);
});

test('packNesting on its own reads auto as the input order', () => {
  const key = (r) => JSON.stringify(r.placements.map((p) => [p.name, p.xMm, p.yMm, p.rot]));
  assert.equal(key(packNesting(big(), { ...OPTS, order: 'auto' })), key(packNesting(big(), OPTS)));
});

test('absorb merges a stranded tail sheet when the union really fits', () => {
  const tall = rect('t0', 130, 250);
  const shorts = [rect('s0', 60, 45), rect('s1', 60, 45), rect('s2', 60, 45)];
  const sheets = [
    { subset: [tall], result: packNesting([tall], OPTS) },
    { subset: shorts, result: packNesting(shorts, OPTS) },
  ];
  absorbLastSheet(sheets, OPTS);
  assert.equal(sheets.length, 1, 'the tail sheet is gone');
  assert.equal(sheets[0].result.placements.length, 4, 'all four pieces now share one sheet');
  assert.deepEqual([...sheets[0].subset.map((i) => i.name)].sort(), ['s0', 's1', 's2', 't0']);
  assertValidSheet(sheets[0].result, 'absorbed');
});

test('absorb refills the bases of a sheet it rewrote', () => {
  const withBases = { ...OPTS, fillBases: true };
  const sheets = [
    { subset: [rect('t0', 130, 250)], result: null },
    { subset: [rect('s0', 60, 45), rect('s1', 60, 45), rect('s2', 60, 45)], result: null },
  ];
  for (const s of sheets) s.result = packNesting(s.subset, withBases);
  absorbLastSheet(sheets, withBases);
  assert.equal(sheets.length, 1);
  assert.ok(sheets[0].result.bases.length > 0, 'the merged sheet carries bases again');
  for (const b of sheets[0].result.bases) {
    for (const p of sheets[0].result.placements) {
      const hit = b.xMm < p.xMm + p.widthMm + 0.25 - 1e-6 && p.xMm < b.xMm + b.widthMm + 0.25 - 1e-6 &&
        b.yMm < p.yMm + p.heightMm + 0.25 - 1e-6 && p.yMm < b.yMm + b.heightMm + 0.25 - 1e-6;
      assert.equal(hit, false, 'no base lands on artwork after the merge');
    }
  }
});

test('absorb leaves an unmergeable sheet list exactly as it was', () => {
  const sheets = [
    { subset: talls(3), result: packNesting(talls(3), OPTS) },
    { subset: talls(1), result: packNesting(talls(1), OPTS) },
  ];
  const before = fingerprint({ sheets });
  absorbLastSheet(sheets, OPTS);
  assert.equal(sheets.length, 2, 'four 130 mm pieces never fit one 398 mm row');
  assert.equal(fingerprint({ sheets }), before, 'a failed merge changes nothing');
});

test('absorb never adds a sheet, loses a piece or breaks the layout', () => {
  for (const items of [mixed(), talls(7), talls(3).concat(mixed()), mixed().concat(mixed()), big()]) {
    const base = packSheets(items, OPTS);
    const absorbed = packSheets(items, { ...OPTS, absorbLastSheet: true });
    assert.ok(absorbed.sheets.length <= base.sheets.length,
      `absorb grew the job from ${base.sheets.length} to ${absorbed.sheets.length} sheets`);
    assert.deepEqual(names(absorbed), [...items.map((i) => i.name)].sort(), 'every piece placed exactly once');
    assert.equal(absorbed.unplaced.length, 0);
    for (const s of absorbed.sheets) assertValidSheet(s.result, 'absorb');
  }
});
