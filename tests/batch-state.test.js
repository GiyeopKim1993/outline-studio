'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { packMask, unpackMask } = require('../rle.js');
const { BatchStore } = require('../batch-store.js');
const { RenderState } = require('../render-state.js');

function mask(pattern) {
  return Uint8Array.from(pattern);
}

// ---------------------------------------------------------------- RLE
test('RLE round-trips a binary mask exactly', () => {
  const original = mask([1, 1, 1, 0, 0, 1, 0, 1, 1, 1, 1, 0]);
  const packed = packMask(original);
  assert.ok(packed.length < original.length + 3);
  assert.deepEqual(Array.from(unpackMask(packed, original.length)), Array.from(original));
});

test('RLE handles long runs beyond 127 and an empty tail', () => {
  const original = new Uint8Array(600);
  original.fill(1, 300, 500);
  const packed = packMask(original);
  const back = unpackMask(packed, original.length);
  assert.deepEqual(Array.from(back), Array.from(original));
});

test('RLE of an all-zero mask returns all zeros', () => {
  const original = new Uint8Array(50);
  assert.deepEqual(Array.from(unpackMask(packMask(original), 50)), Array.from(original));
});

// ------------------------------------------------------- render ownership
test('render state rejects a commit split across an await boundary', async () => {
  // The regression: mask came from item A while white paths came from item B.
  const order = [];
  const store = new FakeStore();
  const state = new RenderState((partial) => store.apply(partial));

  let releaseA;
  const aReady = new Promise((r) => { releaseA = r; });

  const loadA = state.commit(async () => {
    await aReady;
    return { mask: mask([1, 1]), whitePaths: [[[0, 0], [1, 0]]], w: 2, h: 1 };
  });
  // A second commit starts before the first finished.
  const loadB = state.commit(async () => ({ mask: mask([0, 0]), whitePaths: [[[2, 2], [3, 2]]], w: 2, h: 1 }));
  releaseA();
  await Promise.allSettled([loadA, loadB]);

  const applied = store.snapshots;
  for (const snap of applied) {
    // Every applied snapshot must be internally consistent: a mask with
    // foreground pixels always carries the white paths that were built with it.
    if (snap.mask && snap.mask[0] === 1) {
      assert.deepEqual(snap.whitePaths, [[[0, 0], [1, 0]]], 'stale commit must never publish');
    }
  }
  assert.equal(state.version, 2, 'both commits are counted');
  assert.equal(state.staleRejects, 1, 'the older commit was discarded');
});

test('render state applies exactly one atomic update per commit', async () => {
  const applied = [];
  const state = new RenderState((partial) => applied.push(partial));
  await state.commit(async () => ({ mask: mask([1]), whitePaths: [], w: 1, h: 1 }));
  await state.commit(async () => ({ mask: mask([0]), whitePaths: [], w: 1, h: 1 }));
  assert.equal(applied.length, 2, 'one publish per commit, never a partial field write');
  assert.equal(applied[0].mask[0], 1);
  assert.equal(applied[1].mask[0], 0);
});

// ------------------------------------------------------------- batch store
test('batch store writes results to the requested slot, not the active one', () => {
  const store = new BatchStore(3);
  store.setActive(0);
  // Simulate the active tab moving while a save for slot 2 is in flight.
  store.setActive(1);
  store.put(2, { maskRle: 'two' });
  assert.deepEqual(store.get(2), { maskRle: 'two' });
  assert.equal(store.get(0), undefined, 'slot 0 must not receive the write');
  assert.equal(store.get(1), undefined, 'slot 1 must not receive the write');
});

test('batch store ignores writes for out-of-range or unknown slots', () => {
  const store = new BatchStore(2);
  store.put(5, { maskRle: 'x' });
  store.put(-1, { maskRle: 'y' });
  assert.equal(store.completedCount(), 0);
  assert.equal(store.get(5), undefined);
});

test('batch store tracks completion and never mutates stored results', () => {
  const store = new BatchStore(2);
  store.put(0, { maskRle: 'rle', whitePaths: [[[0, 0]]] });
  const snapshot = store.get(0);
  snapshot.whitePaths.push([[9, 9]]);
  assert.equal(store.get(0).whitePaths.length, 1, 'callers get a defensive copy');
  assert.equal(store.completedCount(), 1);
  assert.equal(store.has(0), true);
  assert.equal(store.has(1), false);
});

class FakeStore {
  constructor() { this.snapshots = []; }
  apply(partial) { this.snapshots.push(partial); }
}

// ------------------------------------------------- source-level invariants
// These encode the two rules that make the bugs impossible. They are cheap and
// they fail loudly if someone reintroduces the old pattern.
const fs = require('node:fs');
const APP = fs.readFileSync('/home/user/site-deploy/final-stage/app.js', 'utf8');

test('no result is ever written to an implicit "current" slot', () => {
  assert.equal(/batchResults\s*\[/.test(APP), false, 'batchResults array writes are gone');
  assert.equal(/let[^;]*\bbatchIndex\b/.test(APP), false, 'the mutable batchIndex global is gone');
  // Every store write must name its slot.
  const writes = APP.match(/batchStore\.put\([^)]*/g) || [];
  assert.ok(writes.length >= 2, 'batch results are written through the store');
  for (const w of writes) assert.ok(/\(\s*i\s*,|\(\s*index\s*,|\(\s*\d/.test(w), `explicit slot: ${w}`);
});

test('an item snapshot is always captured before the first await', () => {
  const start = APP.indexOf('async function saveBatchInto(');
  assert.ok(start > 0, 'saveBatchInto exists');
  const raw = APP.slice(start, APP.indexOf('async function', start + 10));
  const body = raw.replace(/\/\/[^\n]*/g, '');   // comments mention `await`; ignore them
  const firstAwait = body.indexOf('await ');
  assert.ok(firstAwait > 0, 'the save awaits the artwork blob');
  const before = body.slice(0, firstAwait);
  // mask, white paths and metrics must all be read before the await.
  for (const field of ['state.mask', 'state.autoMask', 'state.whitePaths', 'whiteAreaMm2', 'state.metrics']) {
    assert.ok(before.includes(field), `${field} is captured before awaiting`);
  }
  // ...and never re-read afterwards, which is what mixed two items together.
  const after = body.slice(firstAwait);
  assert.equal(/state\.(mask|autoMask|whitePaths|whiteAreaMm2|metrics)\b/.test(after), false,
    'nothing re-reads mutable state across the await boundary');
});

test('restore publishes one atomic snapshot', () => {
  const start = APP.indexOf('async function restoreBatchItem(');
  const raw = APP.slice(start, APP.indexOf('async function', start + 10));
  const body = raw.replace(/\/\/[^\n]*/g, '');

  // The item is assembled as one object literal, never field by field.
  assert.ok(/renderState\.commit\(async\(\)=>\{/.test(body), 'restore stages a snapshot');
  const literal = body.slice(body.indexOf('return {'), body.indexOf('};', body.indexOf('return {')));
  for (const field of ['mask', 'whitePaths', 'whiteAreaMm2', 'metrics', 'artCanvas']) {
    assert.ok(literal.includes(field), `${field} is part of the published snapshot`);
  }
  // Publishing must not happen field-by-field on `state`.
  assert.equal(/state\.[a-zA-Z]+\s*=/.test(body), false,
    'restore never mutates state field by field');
  // The async decode happens before the snapshot is returned, so nothing can
  // observe a half-built item.
  assert.ok(body.indexOf('await createImageBitmap') < body.indexOf('return {'),
    'decode finishes before publishing');
});

test('every editing entry point runs under the editor lock', () => {
  assert.ok(/withEditor\(processBatch\)/.test(APP), 'batch run is serialised');
  assert.ok(/withEditor\(\(\)=>selectBatchItem/.test(APP), 'tab clicks are serialised');
  assert.ok(/withEditor\(async\(\)=>\{await processPipeline/.test(APP), 'manual run is serialised');
});

// ---------------------------------------------------------------- per-item white tint
test('BatchStore.update merges per-item fields such as whiteTint', () => {
  const s = new BatchStore(2);
  assert.equal(s.update(0, { whiteTint: 40 }), false, 'empty slot rejects updates');
  s.put(0, { name: 'a', maskRle: 'x' });
  assert.equal(s.update(0, { whiteTint: 40 }), true);
  assert.equal(s.get(0).whiteTint, 40);
  assert.equal(s.get(0).name, 'a', 'other fields survive');
  assert.equal(s.ref(0).whiteTint, 40);
  assert.equal(s.ref(7), undefined);
  const patched = s.get(0);
  patched.whiteTint = 1;
  assert.equal(s.ref(0).whiteTint, 40, 'get() copies stay defensive');
});
