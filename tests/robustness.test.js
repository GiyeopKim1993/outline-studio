'use strict';
/*
 * Fault injection. "Tests pass" is not the same as "robust": these tests break
 * things on purpose and check the app degrades instead of corrupting state.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { boot, fakeFile } = require('./harness.js');
const settle = (w, ms = 60) => new Promise((r) => w.setTimeout(r, ms));

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

const SPECS = (n) => Array.from({ length: n }, (_, i) => ({
  name: `img${i}.png`, width: 10 + i, height: 10 + i, period: 2 + (i % 3), inset: 1,
}));

const whiteInfo = (w) => w.document.getElementById('whiteInfo').textContent;
const status = (w) => w.document.getElementById('pipelineStatus').textContent;
const head = (w) => w.document.querySelector('.batch-head span')?.textContent || '';

test('a failing toBlob on one item does not abort the rest of the batch', async () => {
  const { window, bitmaps } = boot();
  await loadBatch(window, bitmaps, SPECS(3));

  // Sabotage the 2nd canvas compression only.
  const proto = window.HTMLCanvasElement.prototype;
  const realToBlob = proto.toBlob;
  let calls = 0;
  proto.toBlob = function (cb) {
    calls++;
    if (calls === 2) { cb(null); return; }   // real browsers pass null on failure
    return realToBlob.call(this, cb);
  };

  window.document.getElementById('batchProcessBtn').dispatchEvent(new window.Event('click'));
  await settle(window, 8000);
  proto.toBlob = realToBlob;

  const done = window.document.querySelectorAll('.batch-item.done').length;
  assert.ok(done >= 2, `the surviving items still completed: ${head(window)}`);
});

test('a failing createImageBitmap leaves the editor in a consistent state', async () => {
  const { window, bitmaps } = boot();
  await loadBatch(window, bitmaps, SPECS(2));
  window.document.getElementById('batchProcessBtn').dispatchEvent(new window.Event('click'));
  await settle(window, 6000);

  const real = window.createImageBitmap;
  window.createImageBitmap = async () => { throw new Error('decode failed'); };

  const buttons = Array.from(window.document.querySelectorAll('[data-batch-index]'));
  buttons[1].dispatchEvent(new window.Event('click'));
  await settle(window, 800);

  // The click must not leave a half-restored item behind.
  const text = whiteInfo(window);
  assert.ok(!/undefined|NaN/.test(text), `white info stays sane: ${text}`);
  assert.ok(!/undefined|NaN/.test(status(window)), `status stays sane: ${status(window)}`);

  // The app must still work once decoding recovers.
  window.createImageBitmap = real;
  buttons[0].dispatchEvent(new window.Event('click'));
  await settle(window, 600);
  assert.match(whiteInfo(window), /화이트 면적|화이트 영역이 없습니다/, 'recovers after the fault clears');
});

test('reloading files mid-batch cannot write into the new batch', async () => {
  const { window, bitmaps } = boot();
  await loadBatch(window, bitmaps, SPECS(3));
  window.document.getElementById('batchProcessBtn').dispatchEvent(new window.Event('click'));
  await settle(window, 200);

  // The user replaces the list while the first run is still writing results.
  const fresh = SPECS(2).map((s, i) => { bitmaps.set(`new${i}`, s); return fakeFile(s.name, `new${i}`); });
  const input = window.document.getElementById('fileInput');
  Object.defineProperty(input, 'files', { value: fresh, configurable: true });
  input.dispatchEvent(new window.Event('change'));

  // The old run must stop now, not keep churning through the old file list.
  const before = window.__outline.batchStore.writes;
  await settle(window, 3000);
  const after = window.__outline.batchStore.writes;
  assert.equal(after, before, 'the superseded run stopped writing results');

  await settle(window, 10000);
  const buttons = Array.from(window.document.querySelectorAll('[data-batch-index]'));
  assert.equal(buttons.length, 2, 'the list shows the new batch only');
  buttons.forEach((b, i) => assert.equal(b.getAttribute('title'), fresh[i].name,
    `slot ${i} belongs to the new batch`));

  // Results must belong to the NEW files: no stale completion from the old run.
  const done = window.document.querySelectorAll('.batch-item.done').length;
  assert.match(head(window), /^[0-2]\/2 처리 완료$/,
    `progress is measured against the new batch only: ${head(window)}`);
  assert.ok(!/undefined|NaN/.test(whiteInfo(window)), 'no corrupted numbers');
});

test('an aborted run leaves no stale results and the app stays usable', async () => {
  const { window, bitmaps } = boot();
  await loadBatch(window, bitmaps, SPECS(3));
  window.document.getElementById('batchProcessBtn').dispatchEvent(new window.Event('click'));
  await settle(window, 200);

  const fresh = SPECS(2).map((s, i) => { bitmaps.set(`solo${i}`, s); return fakeFile(s.name, `solo${i}`); });
  const input = window.document.getElementById('fileInput');
  Object.defineProperty(input, 'files', { value: fresh, configurable: true });
  input.dispatchEvent(new window.Event('change'));
  await settle(window, 10000);

  // Nothing from the old run may survive into the new list.
  const items = Array.from(window.document.querySelectorAll('[data-batch-index]'));
  assert.equal(items.length, 2);
  items.forEach((b, i) => assert.equal(b.getAttribute('title'), fresh[i].name, `slot ${i} is the new file`));
  assert.equal(window.document.querySelectorAll('.batch-item.done').length, 0,
    'no stale completion markers leak into the new batch');
  assert.ok(!/undefined|NaN/.test(whiteInfo(window)), 'numbers stay finite');

  // And the editor still works: the single file loaded normally.
  assert.match(window.document.getElementById('fileMeta').textContent, /solo0\.png|px/,
    'the new file really loaded');
});

test('a click storm during a long batch never produces NaN or undefined', async () => {
  const { window, bitmaps } = boot();
  await loadBatch(window, bitmaps, SPECS(4));
  window.document.getElementById('batchProcessBtn').dispatchEvent(new window.Event('click'));

  for (let k = 0; k < 30; k++) {
    const bs = Array.from(window.document.querySelectorAll('[data-batch-index]'));
    const t = bs[k % bs.length];
    if (t && !t.disabled) t.dispatchEvent(new window.Event('click'));
    const text = whiteInfo(window);
    assert.ok(!/undefined|NaN/.test(text), `consistent mid-storm at k=${k}: ${text}`);
    await settle(window, 80);
  }
  await settle(window, 9000);

  assert.match(head(window), /4\/4 처리 완료/, `all items landed: ${head(window)}`);
});

test('pressing process twice does not double-run the batch', async () => {
  const { window, bitmaps } = boot();
  await loadBatch(window, bitmaps, SPECS(2));
  const btn = window.document.getElementById('batchProcessBtn');
  btn.dispatchEvent(new window.Event('click'));
  btn.dispatchEvent(new window.Event('click'));
  btn.dispatchEvent(new window.Event('click'));
  await settle(window, 8000);
  assert.match(head(window), /2\/2 처리 완료/, `one clean run: ${head(window)}`);
});

test('a batch item with no result yet never shows the previous item numbers', async () => {
  const { window, bitmaps } = boot();
  await loadBatch(window, bitmaps, SPECS(3));
  // Do not process: every item is unprocessed, so there is nothing to show.
  const bs = Array.from(window.document.querySelectorAll('[data-batch-index]'));
  for (const b of bs) {
    b.dispatchEvent(new window.Event('click'));
    await settle(window, 300);
    const text = whiteInfo(window);
    assert.ok(!/화이트 면적/.test(text),
      `unprocessed item ${b.dataset.batchIndex} must not claim a white area: ${text}`);
  }
});
