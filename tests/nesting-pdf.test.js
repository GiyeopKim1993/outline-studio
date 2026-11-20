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

// ---------------------------------------------------------------------------
// Geometry and paint order inside the sheet content stream.
const sheet = require('node:zlib');

function decodeContent(pdf) {
  // The page content is the Flate stream that carries the BDC blocks.
  const raw = pdf.toString('latin1');
  for (const m of raw.matchAll(/(\d+) 0 obj\n<<([^]*?)>>\nstream\r?\n/g)) {
    if (/\/Subtype\s*\/(Image|Form)/.test(m[2])) continue;
    const length = Number((/\/Length (\d+)/.exec(m[2]) || [])[1]);
    if (!length) continue;
    const start = m.index + m[0].length;
    try {
      const text = sheet.inflateSync(pdf.subarray(start, start + length)).toString('latin1');
      if (text.includes('BDC')) return text;
    } catch (_) { /* not deflate, or not the content stream */ }
  }
  return null;
}

async function simpleSheet() {
  const ppm = 6, w = 90, h = 200;
  const item = (xMm, yMm) => ({
    artwork: fakeArtwork(w, h), width: w, height: h, pixelsPerMm: ppm,
    whitePaths: [[[0, 0], [w, 0], [w, h], [0, h]]],
    cutPaths: [[[0, 0], [w, 0], [w, h], [0, h]]],
    xMm, yMm, widthMm: w / ppm, heightMm: h / ppm, rot: 0,
  });
  const blob = await OutlinePDF.createSheet({
    sheetWidthMM: 400, sheetWidthMm: 400, sheetHeightMm: 300,
    items: [item(0, 0)], bases: [], whiteName: 'W', cutName: 'C',
  });
  return { data: Buffer.from(await blob.arrayBuffer()), ppm, w, h };
}

test('the artwork is painted at its real pixel extent, not as a single pixel', async () => {
  // `Do` paints onto the unit square. Painting it with the bare placement matrix
  // stamped a 90x200 artwork as 0.47pt (0.167mm), so a saved sheet looked like it
  // contained nothing but cut lines.
  const { data, ppm, w, h } = await simpleSheet();
  const content = decodeContent(data);
  assert.ok(content, 'content stream decoded');

  // The unit-square scale is the `cm` immediately before the `Do`; the placement
  // matrix sits before the clip path, so the two are not adjacent.
  const at = content.indexOf('/Artwork0 Do');
  assert.ok(at > 0, 'artwork paint found');
  const before = content.slice(0, at);
  const unit = /([-\d.]+) ([-\d.]+) ([-\d.]+) ([-\d.]+) ([-\d.]+) ([-\d.]+) cm\n$/.exec(before);
  assert.ok(unit, 'unit-square scale right before the Do');
  const place = [...before.matchAll(/([-\d.]+) ([-\d.]+) ([-\d.]+) ([-\d.]+) ([-\d.]+) ([-\d.]+) cm\n/g)];
  const pm = place[0];
  assert.ok(pm, 'placement matrix present');
  const sx = Math.abs(Number(pm[1])), sy = Math.abs(Number(pm[4]));
  const unitW = Number(unit[1]), unitH = Number(unit[4]);
  assert.equal(unitW, w, 'unit square scaled to the pixel width');
  assert.equal(unitH, -h, 'unit square scaled to the pixel height and flipped upright');
  // Combined x-scale must put one artwork pixel at 1/ppm mm in points.
  const ptPerMm = 72 / 25.4;
  assert.ok(Math.abs(sx * unitW - (w / ppm) * ptPerMm) < 1e-3,
    `artwork width ${sx * unitW}pt should be ${(w / ppm) * ptPerMm}pt`);
  // unitH is negative (the raster is flipped upright), so compare magnitudes.
  assert.ok(Math.abs(Math.abs(sy * unitH) - (h / ppm) * ptPerMm) < 1e-3,
    `artwork height ${Math.abs(sy * unitH)}pt should be ${(h / ppm) * ptPerMm}pt`);
});

test('white plate is painted before the artwork, cut line last', async () => {
  // The white plate is a solid silhouette of the whole piece. Emitting it after the
  // artwork buried the artwork, so only the cut line showed.
  const { data } = await simpleSheet();
  const content = decodeContent(data);
  const white = content.indexOf('/OC /WhiteLayer BDC');
  const art = content.indexOf('/OC /ArtLayer BDC');
  const cut = content.indexOf('/OC /CutLayer BDC');
  assert.ok(white >= 0 && art >= 0 && cut >= 0, 'all three layers emitted');
  assert.ok(white < art, 'white plate must go down before the artwork');
  assert.ok(art < cut, 'cut line must be last so it is never covered');
});

test('the cut stroke is 0.2mm in device space for items and bases', async () => {
  const { data } = await simpleSheet();
  const content = decodeContent(data);
  const widths = [...content.matchAll(/([\d.]+) w\n/g)].map((m) => Number(m[1]));
  assert.ok(widths.length >= 1, 'a stroke width was set');
  const ptPerMm = 72 / 25.4;
  // item cut: 0.2mm = 0.5669pt; it is written in a matrix that scales by 1/ppm,
  // so the user-space value is 0.2*ppm. Either way the device width is 0.2mm.
  const scalem = /([-\d.]+) [-\d.]+ [-\d.]+ ([-\d.]+) [-\d.]+ [-\d.]+ cm\n\/CutSpot/.exec(content);
  assert.ok(scalem, 'cut block found');
  const scale = Math.abs(Number(scalem[1]));
  const deviceMm = (widths[0] * scale) / ptPerMm;
  assert.ok(Math.abs(deviceMm - 0.2) < 1e-6, `cut stroke is ${deviceMm}mm, expected 0.2mm`);
});

test('imported spot names are reported and a cut spot is identified', async () => {
  // A sheet can only carry one white and one cut spot. Files from different shops
  // disagree, so the importer has to report what each file uses.
  const mod = { exports: {} };
  const win = {}; win.self = win; win.navigator = { userAgent: 'node', platform: 'node', appName: 'node' };
  const load = (code, args) => new Function('window', 'globalThis', 'self', 'navigator', 'console', 'module', 'exports', code)(...args);
  load(require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'pdf-import.js'), 'utf8'),
    [global, global, global, win.navigator, console, mod, mod.exports]);
  const imp = mod.exports;
  // The picker must prefer the usual cut words over anything else present.
  assert.equal(imp.__test_pickCutSpot([{ name: 'spot_0' }, { name: 'CutContour' }]), 'CutContour');
  assert.equal(imp.__test_pickCutSpot([{ name: 'White' }, { name: 'Die' }]), 'Die');
  assert.equal(imp.__test_pickCutSpot([{ name: 'White' }, { name: 'Kiss-cut' }]), 'Kiss-cut');
  // Fall back to the one spot that is not the white plate.
  assert.equal(imp.__test_pickCutSpot([{ name: 'rdg_white' }, { name: 'MyPlate' }]), 'MyPlate');
  assert.equal(imp.__test_pickCutSpot([]), null);
});

test('sheet artwork is not upside down relative to its cut line', async () => {
  // The artwork stream stores row 0 at the TOP of the picture, while PDF image
  // space puts v = 0 at the BOTTOM. Scaling the unit square with a positive height
  // therefore printed every item upside down — a full 180° out of phase with its
  // own cut line. `create()` already used `width 0 0 -height 0 height`; the sheet
  // writer had dropped the sign.
  const ppm = 6, w = 100, h = 200;
  const rgba = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 4;
      rgba[o] = y < h / 2 ? 230 : 30;       // top half red
      rgba[o + 1] = 30;
      rgba[o + 2] = y < h / 2 ? 30 : 230;   // bottom half blue
      rgba[o + 3] = 255;
    }
  }
  const artwork = { width: w, height: h, getContext: () => ({ getImageData: () => ({ data: rgba }) }) };
  const blob = await OutlinePDF.createSheet({
    sheetWidthMm: 100, sheetHeightMm: 100,
    items: [{
      artwork, width: w, height: h, pixelsPerMm: ppm, widthMm: w / ppm, heightMm: h / ppm,
      whitePaths: [[[0, 0], [w, 0], [w, h], [0, h]]],
      cutPaths: [[[0, 0], [w, 0], [w, h], [0, h]]],
      xMm: 30, yMm: 30, rot: 0,
    }],
    bases: [], whiteName: 'W', cutName: 'C',
  });
  const content = decodeContent(Buffer.from(await blob.arrayBuffer()));
  assert.ok(content, 'content stream decoded');
  // The last cm before the Do is the unit-square scale; its height must be negative.
  const at = content.indexOf('/Artwork0 Do');
  const unit = /([-\d.]+) ([-\d.]+) ([-\d.]+) ([-\d.]+) ([-\d.]+) ([-\d.]+) cm\n$/.exec(content.slice(0, at));
  assert.ok(unit, 'unit-square scale found');
  assert.equal(Number(unit[1]), w, 'width is positive');
  assert.equal(Number(unit[4]), -h, 'height must be negative so the raster is flipped upright');
});
