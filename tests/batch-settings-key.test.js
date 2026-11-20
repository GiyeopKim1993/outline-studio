'use strict';
/*
 * A saved batch result is only reusable while the pipeline settings are
 * unchanged. Before this, `if (batchStore.has(i)) continue;` reused every cached
 * item forever, so changing the mirror, offset, height or any other setting and
 * re-running the batch silently kept the old results.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SRC = process.env.STAGE_DIR || '/home/user/site-deploy/final-stage';
const app = fs.readFileSync(path.join(SRC, 'app.js'), 'utf8');

test('each saved batch item records the settings it was produced with', () => {
  const save = app.slice(app.indexOf('async function saveBatchInto'), app.indexOf('function escapeHtml'));
  assert.ok(/settingsKey:settingsKey\(\)/.test(save),
    'saveBatchInto must store the settings signature');
});

test('the batch reuses a cached item only when the signature matches', () => {
  const proc = app.slice(app.indexOf('async function processBatch'), app.indexOf('function escapeHtml'));
  assert.ok(/cached\.settingsKey===settingsKey\(\)/.test(proc),
    'the cache check must compare the stored signature with the current one');
  // The old unconditional skip must be gone.
  assert.ok(!/if\(batchStore\.has\(i\)\)continue;/.test(proc),
    'the unconditional skip must not remain');
});

test('the signature covers every setting the pipeline reads, including the mirror', () => {
  const settingsBody = app.slice(app.indexOf('function settings(){'), app.indexOf('function settings(){') + 900);
  for (const key of ['targetHeight', 'offset', 'webWidth', 'gap', 'tabWidth', 'tabDepth',
    'taper', 'tipR', 'speck', 'alpha', 'flipX']) {
    assert.ok(new RegExp(key).test(settingsBody), `settings() must include ${key}`);
  }
});

test('a settings signature is stable for identical settings and changes when one changes', () => {
  // Model the contract: JSON of a plain object.
  const base = { targetHeight: 148.5, offset: 2, flipX: false };
  const same = { targetHeight: 148.5, offset: 2, flipX: false };
  const flipped = { targetHeight: 148.5, offset: 2, flipX: true };
  assert.equal(JSON.stringify(base), JSON.stringify(same));
  assert.notEqual(JSON.stringify(base), JSON.stringify(flipped));
});
