'use strict';
/*
 * Static contract between the three front-end files. Refactors tend to leave
 * orphaned markup, listeners for elements that no longer exist, or CSS for
 * classes nothing wears any more. These checks make such leftovers fail the
 * suite instead of rotting silently:
 *
 *   1. every id the scripts look up exists in index.html, exactly once
 *   2. every <label for> points at a real control
 *   3. every class a stylesheet selects is actually worn by markup or added
 *      by script (classes scripts toggle at runtime are an explicit list)
 *   4. every [data-*] attribute a stylesheet selects exists in the markup
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SRC = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(SRC, 'index.html'), 'utf8');
const css = fs.readFileSync(path.join(SRC, 'styles.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
const scripts = ['app.js', 'pdf.js', 'pdf-import.js', 'nesting.js', 'nesting-geometry.js', 'render-state.js', 'batch-store.js', 'rle.js', 'scaffold-rules.js', 'cut-vector.js']
  .map((f) => fs.readFileSync(path.join(SRC, f), 'utf8'));
const js = scripts.join('\n');

// Classes the scripts put on elements at runtime (classList or innerHTML).
const RUNTIME_CLASSES = new Set(['active', 'done', 'hidden', 'show', 'dragover', 'has-image', 'dragging', 'nest-svg', 'err',
  'busy', 'error', 'batch-head', 'batch-items', 'batch-item', 'nest-sheet']);

const htmlIds = [...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]);
const htmlClasses = new Set([...html.matchAll(/\sclass="([^"]+)"/g)].flatMap((m) => m[1].split(/\s+/).filter(Boolean)));
const htmlAttrs = new Set([...html.matchAll(/\s(data-[a-z-]+)=/g)].map((m) => m[1]));

test('index.html has no duplicate ids', () => {
  const seen = new Map();
  for (const id of htmlIds) seen.set(id, (seen.get(id) || 0) + 1);
  const dupes = [...seen].filter(([, n]) => n > 1).map(([id]) => id);
  assert.deepEqual(dupes, [], `duplicate ids: ${dupes.join(', ')}`);
});

test('every id the scripts reference exists in the markup', () => {
  const wanted = new Set();
  for (const m of js.matchAll(/\$\('([\w-]+)'\)/g)) wanted.add(m[1]);
  for (const m of js.matchAll(/getElementById\('([\w-]+)'\)/g)) wanted.add(m[1]);
  const missing = [...wanted].filter((id) => !htmlIds.includes(id));
  assert.deepEqual(missing, [], `scripts reference missing ids: ${missing.join(', ')}`);
});

test('every label for= points at a real control', () => {
  const missing = [...html.matchAll(/<label[^>]*\sfor="([^"]+)"/g)].map((m) => m[1])
    .filter((id) => !htmlIds.includes(id));
  assert.deepEqual(missing, [], `labels without a target: ${missing.join(', ')}`);
});

test('the stylesheet selects no class the app never wears', () => {
  const dead = [];
  // selector chunks: everything before a '{' that is not an at-rule prelude
  for (const m of css.matchAll(/([^{}@]+)\{/g)) {
    for (const chunk of m[1].split(',')) {
      const classes = [...chunk.matchAll(/\.(-?[a-zA-Z][\w-]*)/g)].map((c) => c[1]);
      for (const c of classes) {
        if (!htmlClasses.has(c) && !RUNTIME_CLASSES.has(c)) dead.push(c + '  ←  ' + chunk.trim());
      }
      for (const a of chunk.matchAll(/\[(data-[a-z-]+)/g)) {
        if (!htmlAttrs.has(a[1])) dead.push(a[1] + '  ←  ' + chunk.trim());
      }
    }
  }
  assert.deepEqual(dead, [], `dead stylesheet selectors:\n${dead.join('\n')}`);
});
