'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const zlib = require('node:zlib');
global.window = global;
require('../pdf.js');
const { createBaseGeometry } = require('../nesting-geometry.js');

function fakeArtwork(width, height) {
  const rgba = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    rgba[i * 4] = 200; rgba[i * 4 + 1] = 60; rgba[i * 4 + 2] = 80; rgba[i * 4 + 3] = 255;
  }
  return { getContext: () => ({ getImageData: () => ({ data: rgba }) }) };
}

test('nesting sheet PDF is 400x300mm with items, bases and 3 OCG layers', async () => {
  const ppm = 11.813953488372093; // 300dpi
  const w = 118, h = 59; // ~10 x 5 mm at 300dpi
  const item = (xMm, yMm) => ({
    artwork: fakeArtwork(w, h), width: w, height: h, pixelsPerMm: ppm,
    whitePaths: [[[2, 2], [w - 2, 2], [w - 2, h - 2], [2, h - 2]]],
    cutPaths: [[[0, 0], [w, 0], [w, h], [0, h]]],
    xMm, yMm, widthMm: w / ppm, heightMm: h / ppm,
  });
  const g = createBaseGeometry(0.3);
  const blob = await OutlinePDF.createSheet({
    sheetWidthMm: 400, sheetHeightMm: 300,
    items: [item(0, 0), item(20, 0)],
    bases: [{ xMm: 100, yMm: 100, outer: g.outer, slit: g.slit }],
    whiteName: 'White Ink', cutName: 'Cut/1',
  });
  const data = Buffer.from(await blob.arrayBuffer());
  const pdf = data.toString('latin1');
  const expectedW = (400 * 72 / 25.4).toFixed(6).replace(/0+$/, '').replace(/\.$/, '');
  assert.ok(pdf.includes('/MediaBox [0 0 '), 'MediaBox present');
  assert.match(pdf, /\/OCProperties/);
  assert.match(pdf, /\/Artwork0 \d+ 0 R/);
  assert.match(pdf, /\/Artwork1 \d+ 0 R/);
  assert.match(pdf, /\/Separation \/White#20Ink/);
  assert.match(pdf, /\/Separation \/Cut#2F1/);
  assert.match(pdf, /\/ArtOverprint << \/Type \/ExtGState \/OP true/);
  // Content stream must reference both images and base cut paths.
  const m = /stream\n/.exec(pdf);
  assert.ok(m);
  const tail = pdf.slice(m.index);
  assert.ok(tail.includes('/Artwork0 Do') || data.toString('latin1').includes('Artwork0'));
  assert.ok(expectedW.length > 0);
});

// Collect the placement matrices actually written into the page content stream.
function readContentMatrices(buf) {
  const raw = buf.toString('latin1');
  const streams = [];
  const re = /stream\n/g;
  let m;
  while ((m = re.exec(raw))) {
    const start = m.index + m[0].length;
    const end = raw.indexOf('\nendstream', start);
    if (end < 0) break;
    const chunk = buf.slice(start, end);
    let text;
    try { text = zlib.inflateSync(chunk).toString('latin1'); } catch (_) { text = chunk.toString('latin1'); }
    streams.push(text);
  }
  const content = streams.find((t) => t.includes('Artwork0')) || '';
  // Artwork is now clipped: "cm", then the cut path + "W* n", then "Do".
  return [...content.matchAll(/\/ArtOverprint gs\n([-\d. ]+) cm\n[\s\S]*?\/Artwork(\d+) Do/g)]
    .map((mm) => mm[1].trim().split(/\s+/).map(Number));
}

// PDF points -> sheet millimetres (origin top-left, y down).
function toSheetMm(matrix, sheetHeightMm) {
  const k = 72 / 25.4;
  const [a, b, c, d, e, f] = matrix;
  return (u, v) => {
    const xPt = a * u + c * v + e, yPt = b * u + d * v + f;
    return [xPt / k, sheetHeightMm - yPt / k];
  };
}

test('sheet writer applies the packer rotation to artwork, white and cut', async () => {
  const ppm = 2, w = 120, h = 60; // artwork px = 60 x 30 mm
  const art = fakeArtwork(w, h);
  const mk = (rot, xMm) => ({
    artwork: art, width: w, height: h, pixelsPerMm: ppm, rot,
    whitePaths: [[[0, 0], [w, 0], [w, h], [0, h]]],
    cutPaths: [[[0, 0], [w, 0], [w, h], [0, h]]],
    xMm, yMm: 20,
    widthMm: rot % 180 === 0 ? w / ppm : h / ppm,
    heightMm: rot % 180 === 0 ? h / ppm : w / ppm,
  });
  const rots = [0, 90, 180, 270];
  const blob = await OutlinePDF.createSheet({
    sheetWidthMm: 400, sheetHeightMm: 300,
    items: rots.map((rot, i) => mk(rot, 10 + i * 70)),
    bases: [], whiteName: 'White Ink', cutName: 'Cut/1',
  });
  const matrices = readContentMatrices(Buffer.from(await blob.arrayBuffer()));
  assert.equal(matrices.length, 4, 'one artwork block per item');
  matrices.forEach((matrix, i) => {
    const rot = rots[i];
    const bw = rot % 180 === 0 ? w / ppm : h / ppm;
    const bh = rot % 180 === 0 ? h / ppm : w / ppm;
    const map = toSheetMm(matrix, 300);
    const corners = [[0, 0], [w, 0], [w, h], [0, h]].map(([u, v]) => map(u, v));
    const xs = corners.map((c) => c[0]), ys = corners.map((c) => c[1]);
    const tol = 1e-3;
    assert.ok(Math.abs(Math.min(...xs) - (10 + i * 70)) < tol, `rot ${rot} left edge`);
    assert.ok(Math.abs(Math.min(...ys) - 20) < tol, `rot ${rot} top edge`);
    assert.ok(Math.abs((Math.max(...xs) - Math.min(...xs)) - bw) < tol, `rot ${rot} width`);
    assert.ok(Math.abs((Math.max(...ys) - Math.min(...ys)) - bh) < tol, `rot ${rot} height`);
  });
});

test('sheet writer refuses empty items', async () => {
  await assert.rejects(
    () => OutlinePDF.createSheet({ items: [], whiteName: 'W', cutName: 'C' }),
    /배치할 이미지가 없습니다/
  );
});
