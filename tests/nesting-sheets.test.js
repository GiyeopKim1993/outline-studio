'use strict';
/*
 * A job bigger than one sheet must flow into the next: packSheets fills
 * sheet 1, feeds the leftovers to sheet 2, and only gives up on items that
 * can never fit the sheet at all.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { boot } = require('./harness.js');

const OPTS = { sheetWidthMm: 400, sheetHeightMm: 300, marginMm: 1, clearanceMm: 0.25, fillBases: false, baseSizeMm: 35, extraBases: 0 };

function rect(name, wMm, hMm, ppm = 2) {
  const w = wMm * ppm, h = hMm * ppm;
  const rectLoop = [[0, 0], [w, 0], [w, h], [0, h]];
  return { name, cutPaths: [rectLoop], whitePaths: [rectLoop], width: w, height: h, pixelsPerMm: ppm, widthMm: wMm, heightMm: hMm };
}

test('leftovers flow into the next sheet until every item is placed', () => {
  const { window } = boot();
  // 6 pieces of 180x140mm: two fit a 400x300 sheet per row, never all six.
  const items = Array.from({ length: 6 }, (_, i) => rect(`p${i}`, 180, 140));
  const packed = window.OutlineNesting.packSheets(items, OPTS);
  assert.ok(packed.sheets.length >= 2, `expected several sheets, got ${packed.sheets.length}`);
  assert.equal(packed.unplaced.length, 0, 'nothing impossible in this job');
  const seen = [];
  for (const sheet of packed.sheets) {
    assert.ok(sheet.result.placements.length > 0, 'every sheet carries work');
    for (const p of sheet.result.placements) seen.push(sheet.subset[p._idx].name);
  }
  assert.equal(seen.length, 6, 'each item placed exactly once');
  assert.equal(new Set(seen).size, 6, 'no item duplicated across sheets');
});

test('a piece bigger than the sheet is reported, not retried forever', () => {
  const { window } = boot();
  const packed = window.OutlineNesting.packSheets([rect('huge', 500, 500), rect('ok', 50, 50)], OPTS);
  assert.deepEqual([...packed.unplaced.map((u) => u.name)], ['huge']);
  assert.equal(packed.sheets.length, 1);
  assert.equal([...packed.sheets[0].subset.map((i) => i.name)].filter((n) => n === 'ok').length, 1);
});

test('a one-sheet job keeps the single-sheet shape', () => {
  const { window } = boot();
  const items = [rect('a', 50, 50), rect('b', 50, 50)];
  const packed = window.OutlineNesting.packSheets(items, OPTS);
  assert.equal(packed.sheets.length, 1);
  const direct = window.OutlineNesting.packNesting(items, OPTS);
  assert.equal(packed.sheets[0].result.placements.length, direct.placements.length);
  assert.equal(packed.sheets[0].result.usedHeightMm, direct.usedHeightMm);
});
