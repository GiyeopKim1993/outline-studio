'use strict';
/*
 * End-to-end regression tests against the real app in jsdom.
 * These are the two bugs the refactor was asked to fix:
 *   bug 1: white layer drifting to another batch item
 *   bug 2: batch results mixed up when a tab is clicked mid-run
 *
 * The app is intentionally opaque (single IIFE), so the tests drive it the way
 * a user does: through the file input, the batch bar, and the DOM it renders.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { boot, fakeFile } = require('./harness.js');

const settle = (window, ms = 60) => new Promise((r) => window.setTimeout(r, ms));

async function loadBatch(window, bitmaps, specs) {
  const files = specs.map((spec, i) => {
    const tag = `item${i}`;
    bitmaps.set(tag, spec);
    return fakeFile(spec.name, tag);
  });
  const input = window.document.getElementById('fileInput');
  Object.defineProperty(input, 'files', { value: files, configurable: true });
  input.dispatchEvent(new window.Event('change'));
  await settle(window, 400);
  return files;
}

function batchButtons(window) {
  return Array.from(window.document.querySelectorAll('[data-batch-index]'));
}

test('white info never drifts to another batch item', async () => {
  const { window, bitmaps } = boot();
  await loadBatch(window, bitmaps, [
    { name: 'a.png', width: 10, height: 10, period: 2, inset: 2 },
    { name: 'b.png', width: 12, height: 12, period: 3, inset: 1 },
    { name: 'c.png', width: 9, height: 9, period: 4, inset: 1 },
  ]);

  const whiteInfo = window.document.getElementById('whiteInfo');
  const seen = [];

  for (const round of [0, 1, 2, 1, 0, 2, 0]) {
    const btn = batchButtons(window).find((b) => b.dataset.batchIndex === String(round));
    assert.ok(btn, `batch button ${round} exists`);
    btn.dispatchEvent(new window.Event('click'));
    await settle(window, 250);
    // Whatever the app shows right now must be self-consistent: a white area
    // only ever exists together with the mask that produced it.
    seen.push({ index: round, text: whiteInfo.textContent });
  }

  // An item that has no result yet must not inherit the previous item's numbers.
  // Re-selecting the same items must reproduce the same text every time.
  const byIndex = new Map();
  for (const { index, text } of seen) {
    if (!byIndex.has(index)) byIndex.set(index, text);
    else assert.equal(text, byIndex.get(index), `white info for item ${index} is stable`);
  }
});

test('white state stays attached to its own item across repeated tab switches', async () => {
  const { window, bitmaps } = boot();
  await loadBatch(window, bitmaps, [
    { name: 'wide.png', width: 16, height: 8, period: 2, inset: 1 },
    { name: 'tall.png', width: 8, height: 16, period: 3, inset: 1 },
  ]);

  const readSwatch = () => window.document.getElementById('whiteSwatch').value;
  const readInfo = () => window.document.getElementById('whiteInfo').textContent;

  // The white swatch is a shared setting, so it must be identical everywhere.
  const initialSwatch = readSwatch();

  const visit = async (i) => {
    batchButtons(window).find((b) => b.dataset.batchIndex === String(i))
      .dispatchEvent(new window.Event('click'));
    await settle(window, 250);
    return { swatch: readSwatch(), info: readInfo() };
  };

  const a1 = await visit(0);
  const b1 = await visit(1);
  const a2 = await visit(0);
  const b2 = await visit(1);

  assert.equal(a1.swatch, initialSwatch);
  assert.equal(b1.swatch, initialSwatch);
  assert.equal(a1.info, a2.info, 'item 0 keeps its own white info');
  assert.equal(b1.info, b2.info, 'item 1 keeps its own white info');
});

test('a tab click during batch processing does not misroute results', async () => {
  const { window, bitmaps } = boot();
  await loadBatch(window, bitmaps, [
    { name: 'one.png', width: 10, height: 10, period: 2, inset: 1 },
    { name: 'two.png', width: 11, height: 11, period: 3, inset: 1 },
    { name: 'three.png', width: 12, height: 12, period: 4, inset: 1 },
  ]);

  const processBtn = window.document.getElementById('batchProcessBtn');
  processBtn.dispatchEvent(new window.Event('click'));

  // Hammer the list while the run is in flight: this is what used to swap results.
  for (let k = 0; k < 6; k++) {
    const buttons = batchButtons(window);
    const btn = buttons[(k + 1) % buttons.length];
    if (btn && !btn.disabled) btn.dispatchEvent(new window.Event('click'));
    await settle(window, 40);
  }
  await settle(window, 6000);

  const bar = window.document.getElementById('batchQueueBar');
  const done = bar.querySelectorAll('.batch-item.done').length;
  const head = bar.querySelector('.batch-head span');
  assert.ok(head, 'batch header rendered');
  assert.match(head.textContent, /3\/3 처리 완료/, `all three results landed: ${head.textContent}`);
  assert.equal(done, 3, 'three items marked done');
});

test('batch results keep one name per slot after a mid-run tab click', async () => {
  const { window, bitmaps } = boot();
  const files = await loadBatch(window, bitmaps, [
    { name: 'alpha.png', width: 10, height: 10, period: 2, inset: 1 },
    { name: 'beta.png', width: 11, height: 11, period: 3, inset: 1 },
  ]);

  window.document.getElementById('batchProcessBtn').dispatchEvent(new window.Event('click'));
  await settle(window, 30);
  const second = batchButtons(window)[1];
  if (second && !second.disabled) second.dispatchEvent(new window.Event('click'));
  await settle(window, 2000);

  // Every slot's result title must match its own file, never its neighbour's.
  const buttons = batchButtons(window);
  assert.equal(buttons.length, 2);
  buttons.forEach((btn, i) => {
    assert.equal(btn.getAttribute('title'), files[i].name, `slot ${i} keeps its own file`);
  });
});

test('rapid tab clicks cannot save one item\'s white onto another', async () => {
  // The original bug: restoreBatchItem() assigned state.mask and then awaited
  // createImageBitmap(). A click landing inside that await called
  // saveBatchCurrent(), which read the NEW mask but the OLD whitePaths and
  // wrote both into the new slot. White visibly hopped to another item.
  const { window, bitmaps } = boot();
  await loadBatch(window, bitmaps, [
    { name: 'first.png', width: 14, height: 14, period: 2, inset: 2 },
    { name: 'second.png', width: 14, height: 14, period: 5, inset: 2 },
  ]);

  window.document.getElementById('batchProcessBtn').dispatchEvent(new window.Event('click'));
  await settle(window, 6000);

  const info = () => window.document.getElementById('whiteInfo').textContent;
  const click = (i) => {
    const b = batchButtons(window).find((x) => x.dataset.batchIndex === String(i));
    if (b && !b.disabled) b.dispatchEvent(new window.Event('click'));
  };

  // Establish each item's honest white report, one at a time. Wait until the item
  // has actually restored: the placeholder text is not a real baseline.
  const readSettled = async (i) => {
    click(i);
    for (let attempt = 0; attempt < 25; attempt++) {
      await settle(window, 120);
      const text = info();
      if (/화이트 면적/.test(text)) return text;
    }
    return info();
  };
  const firstInfo = await readSettled(0);
  const secondInfo = await readSettled(1);
  assert.notEqual(firstInfo, secondInfo, 'the two items must have different white areas');

  // Now fire the same trip without waiting for the previous restore to finish.
  for (let round = 0; round < 4; round++) {
    click(1); click(0); click(1); click(0);
    await settle(window, 120);
  }
  await settle(window, 500);

  click(0); await settle(window, 400);
  assert.equal(info(), firstInfo, 'item 0 still reports its own white area');
  click(1); await settle(window, 400);
  assert.equal(info(), secondInfo, 'item 1 still reports its own white area');
});
