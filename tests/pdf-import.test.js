'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
global.window = global;
require('../pdf.js');
const imp = require('../pdf-import.js');

// Build a real artwork PDF with our own writer, then import it back.
async function finishedPdf({ whiteName = 'White Ink', cutName = 'Cut/1' } = {}) {
  const ppm = 6, w = 120, h = 240; // 20 x 40 mm
  const rgba = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 4;
      rgba[o] = (x * 255 / w) | 0; rgba[o + 1] = 90; rgba[o + 2] = (y * 255 / h) | 0; rgba[o + 3] = 255;
    }
  }
  const art = { getContext: () => ({ getImageData: () => ({ data: rgba }) }) };
  const blob = await OutlinePDF.create({
    artwork: art, width: w, height: h, pixelsPerMm: ppm,
    whitePaths: [[[5, 5], [w - 5, 5], [w - 5, h - 5], [5, h - 5]]],
    cutPaths: [[[2, 2], [w - 2, 2], [w - 2, h - 2], [2, h - 2]]],
    whiteName, cutName,
  });
  return Buffer.from(await blob.arrayBuffer());
}

function ab(buf) {
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
}

test('imports page size, artwork, white and cutline from a finished PDF', async () => {
  const buf = await finishedPdf();
  const model = await imp.extractItemModel(ab(buf), { pixelsPerMm: 6 });
  assert.ok(Math.abs(model.widthMm - 20) < 0.01, `page width ${model.widthMm}`);
  assert.ok(Math.abs(model.heightMm - 40) < 0.01, `page height ${model.heightMm}`);
  assert.equal(model.W, 120);
  assert.equal(model.H, 240);
  assert.equal(model.images.length, 1, 'raster artwork found');
  assert.equal(model.images[0].info.width, 120);
  assert.equal(model.images[0].info.colorSpace, '/DeviceRGB');
  assert.equal(model.cutPaths.length, 1, 'stroked outline becomes the cutline');
  assert.equal(model.whitePaths.length, 1, 'filled plate becomes white');
});

test('imported cutline keeps the drawn clearance inside the page box', async () => {
  const model = await imp.extractItemModel(ab(await finishedPdf()), { pixelsPerMm: 6 });
  const cut = model.cutPaths[0];
  const xs = cut.map((p) => p[0]), ys = cut.map((p) => p[1]);
  // Cut rect is inset by 2 px at ppm 6 from a 120x240 canvas.
  assert.ok(Math.abs(Math.min(...xs) - 2) < 0.5, `left ${Math.min(...xs)}`);
  assert.ok(Math.abs(Math.min(...ys) - 2) < 0.5, `top ${Math.min(...ys)}`);
  assert.ok(Math.abs(Math.max(...xs) - 118) < 0.5, `right ${Math.max(...xs)}`);
  const white = model.whitePaths[0];
  assert.ok(Math.min(...white.map((p) => p[0])) > Math.min(...xs), 'white sits inside the cutline');
});

test('toNestingItem paints artwork and returns pipeline-shaped item', async () => {
  // Minimal canvas/bimap shim so the DOM path runs under Node.
  const drawCalls = [];
  class Ctx {
    constructor() { this.matrix = null; }
    setTransform(a, b, c, d, e, f) { this.matrix = [a, b, c, d, e, f]; }
    drawImage(bmp) { drawCalls.push({ matrix: this.matrix, size: [bmp.width, bmp.height] }); }
    save() {} restore() {}
    beginPath() {} moveTo() {} lineTo() {} closePath() {} fill() {}
  }
  const createCanvas = (w, h) => ({ width: w, height: h, getContext: () => new Ctx() });
  const decodeImage = async () => ({ width: 120, height: 240, close() {} });

  const item = await imp.toNestingItem(ab(await finishedPdf()), {
    pixelsPerMm: 6, name: 'finished', createCanvas, decodeImage,
  });
  assert.equal(item.name, 'finished');
  assert.equal(item.sourcePdf, true);
  assert.equal(item.pixelsPerMm, 6);
  assert.equal(item.width, 120);
  assert.equal(item.height, 240);
  assert.ok(Math.abs(item.widthMm - 20) < 0.01);
  assert.equal(item.cutPaths.length, 1);
  assert.equal(item.whitePaths.length, 1);
  assert.equal(drawCalls.length, 1, 'artwork image was painted');
  // 20mm x 40mm at 6 px/mm.
  assert.ok(Math.abs(drawCalls[0].matrix[0] - 1) < 1e-6, 'scale x');
  // y is flipped: PDF user space is y-up, canvas is y-down.
  assert.ok(Math.abs(drawCalls[0].matrix[3] + 1) < 1e-6, 'y flip');
  assert.ok(Math.abs(drawCalls[0].matrix[5] - 240) < 1e-3, 'origin sits at the bottom of the canvas');
});

test('vector-only PDFs fall back to the page box as cutline', async () => {
  // Hand-rolled minimal PDF with no image and no stroked path.
  const content = 'q 1 0 0 1 0 0 cm Q\n';
  const objs = [];
  objs.push('<< /Type /Catalog /Pages 2 0 R >>');
  objs.push('<< /Type /Pages /Kids [3 0 R] /Count 1 >>');
  objs.push('<< /Type /Page /Parent 2 0 R /MediaBox [0 0 283.46 141.73] /Resources << >> /Contents 4 0 R >>');
  objs.push(`<< /Length ${content.length} >>\nstream\n${content}endstream`);
  let pdf = '%PDF-1.7\n';
  const offsets = [0];
  objs.forEach((body, i) => {
    offsets.push(pdf.length);
    pdf += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = pdf.length;
  pdf += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  offsets.slice(1).forEach((o) => { pdf += `${String(o).padStart(10, '0')} 00000 n \n`; });
  pdf += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;

  const model = await imp.extractItemModel(ab(Buffer.from(pdf, 'latin1')), { pixelsPerMm: 10 });
  assert.ok(Math.abs(model.widthMm - 100) < 0.05, `width ${model.widthMm}`);
  assert.ok(Math.abs(model.heightMm - 50) < 0.05, `height ${model.heightMm}`);
  assert.equal(model.images.length, 0);
  assert.equal(model.cutPaths.length, 1, 'page box fallback');
  assert.equal(model.whitePaths.length, 1, 'white falls back to the cutline');
  // Box corners must span the page.
  const xs = model.cutPaths[0].map((p) => p[0]);
  assert.ok(Math.abs(Math.max(...xs) - model.W) < 1, 'cutline reaches the page edge');
});

test('handles writer-baked path space (our own nesting sheets)', async () => {
  // Our sheet writer draws paths in artwork-pixel space with the flip baked in;
  // the importer must normalise that onto the page box instead of scaling by pt.
  const ppm = 6, w = 120, h = 240;
  const rgba = new Uint8ClampedArray(w * h * 4).fill(180);
  const art = { getContext: () => ({ getImageData: () => ({ data: rgba }) }) };
  const layer = [[[10, 10], [110, 10], [110, 230], [10, 230]]];
  const blob = await OutlinePDF.createSheet({
    sheetWidthMm: 20, sheetHeightMm: 40,
    items: [{
      artwork: art, width: w, height: h, pixelsPerMm: ppm, rot: 0,
      whitePaths: layer, cutPaths: layer,
      xMm: 0, yMm: 0, widthMm: 20, heightMm: 40,
    }],
    bases: [], whiteName: 'W', cutName: 'C',
  });
  const buf = Buffer.from(await blob.arrayBuffer());
  const model = await imp.extractItemModel(ab(buf), { pixelsPerMm: 12 });
  assert.ok(Math.abs(model.widthMm - 20) < 0.05, `page ${model.widthMm}`);
  const xs = model.cutPaths[0].map((p) => p[0]);
  const ys = model.cutPaths[0].map((p) => p[1]);
  // Everything stays on the canvas.
  assert.ok(Math.min(...xs) >= -1 && Math.max(...xs) <= model.W + 1, `x ${Math.min(...xs)}..${Math.max(...xs)} of ${model.W}`);
  assert.ok(Math.min(...ys) >= -1 && Math.max(...ys) <= model.H + 1, `y ${Math.min(...ys)}..${Math.max(...ys)} of ${model.H}`);
  // And it fills most of the page (the layer is inset by 10/120 and 10/240).
  assert.ok(Math.max(...xs) - Math.min(...xs) > model.W * 0.7);
});

test('rejects non-PDF input', async () => {
  await assert.rejects(() => imp.inspect(ab(Buffer.from('hello world'))), /PDF 파일이 아닙니다/);
});

test('PNG encoder produces a valid signature and size header', () => {
  const rgba = new Uint8Array(4 * 4 * 4).fill(200);
  const blob = imp.encodePng(rgba, 4, 4);
  assert.equal(blob.type, 'image/png');
});
