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
  // Exports are CMYK now, and the importer has to round-trip its own output.
  assert.equal(model.images[0].info.colorSpace, '/DeviceCMYK');
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

// ---------------------------------------------------------------------------
// Print-ready files wrap each plate in its own Form XObject, tag the layers with
// marked content, and store the process art with a separate soft matte. Reading
// the page stream alone saw none of it and fell back to the page box, so a
// finished artwork imported as a blank rectangle with a rectangular cut line.
function formWrapped({ withSMask = true, dw = 8, dh = 16 } = {}) {
  const w = dw, h = dh;
  const art = Buffer.alloc(w * h * 3);
  const mask = Buffer.alloc(w * h);
  const white = Buffer.alloc(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      art[i * 3] = 10; art[i * 3 + 1] = 20; art[i * 3 + 2] = 30;
      // top row opaque, bottom row transparent -> catches a row-order flip
      mask[i] = y === 0 ? 255 : 0;
      white[i] = 255;
    }
  }
  const enc = (b) => require('node:zlib').deflateSync(b);
  const streams = [];
  const obj = (n, dict, data) => `\n${n} 0 obj\n<<${dict}>>\nstream\n${data}\nendstream\nendobj`;
  const cutStream = `q /CutOverprint gs /CutSpot CS 1 SCN 2 w\n10 10 m\n250 10 l\n250 400 l\n10 400 l\nh\nS\nQ\n`;
  let out = '%PDF-1.4\n';
  out += obj(1, '/Type/Catalog/Pages 2 0 R', '').replace(/stream[\s\S]*endstream/, '');
  out += `\n2 0 obj\n<</Type/Pages/Count 1/Kids[3 0 R]>>\nendobj\n`;
  out += `\n3 0 obj\n<</Type/Page/Parent 2 0 R/MediaBox[0 0 260 420]/Contents 4 0 R/Resources<</Properties<</MCWhite 5 0 R/MCRaster 6 0 R/MCOutline 7 0 R>>/XObject<</WhiteForm 8 0 R/RasterForm 9 0 R/OutlineForm 10 0 R>>>>>>\nendobj\n`;
  const page = `/OC /MCWhite BDC\nq\n/WhiteForm Do\nQ\nEMC\n/OC /MCRaster BDC\nq\n/RasterForm Do\nQ\nEMC\n/OC /MCOutline BDC\nq\n/OutlineForm Do\nQ\nEMC\n`;
  out += obj(4, `/Length ${enc(Buffer.from(page)).length}/Filter/FlateDecode`, enc(Buffer.from(page)).toString('latin1'));
  out += `\n5 0 obj\n<</Type/OCG/Name(White spot: rdg_white)>>\nendobj\n`;
  out += `\n6 0 obj\n<</Type/OCG/Name(Artwork)>>\nendobj\n`;
  out += `\n7 0 obj\n<</Type/OCG/Name(Cutline spot: CutContour)>>\nendobj\n`;
  const formBody = (xobj) => `q 5 5 250 400 re W n q 250 0 0 400 5 5 cm ${xobj} Do Q Q`;
  out += obj(8, `/Type/XObject/Subtype/Form/BBox[0 0 260 420]/Resources<</XObject<</ImWhite 11 0 R>>>>/Length ${enc(Buffer.from(formBody('/ImWhite'))).length}/Filter/FlateDecode`, enc(Buffer.from(formBody('/ImWhite'))).toString('latin1'));
  out += obj(9, `/Type/XObject/Subtype/Form/BBox[0 0 260 420]/Resources<</XObject<</Im1 12 0 R>>>>/Length ${enc(Buffer.from(formBody('/Im1'))).length}/Filter/FlateDecode`, enc(Buffer.from(formBody('/Im1'))).toString('latin1'));
  const cutEnc = enc(Buffer.from(cutStream));
  out += obj(10, `/Type/XObject/Subtype/Form/BBox[0 0 260 420]/Resources<</ColorSpace<</CutSpot[/Separation/CutContour/DeviceCMYK 13 0 R]>>/ExtGState<</CutOverprint<</Type/ExtGState/OP true/op true/OPM 1>>>>>>/Length ${cutEnc.length}/Filter/FlateDecode`, cutEnc.toString('latin1'));
  const whEnc = enc(white);
  out += obj(11, `/Type/XObject/Subtype/Image/Width ${w}/Height ${h}/BitsPerComponent 8/ColorSpace[/Separation/spot_0/DeviceCMYK 13 0 R]/Filter/FlateDecode/Length ${whEnc.length}`, whEnc.toString('latin1'));
  const artEnc = enc(art);
  const sm = withSMask ? '/SMask 14 0 R' : '';
  out += obj(12, `/Type/XObject/Subtype/Image/Width ${w}/Height ${h}/BitsPerComponent 8/ColorSpace/DeviceRGB/Filter/FlateDecode${sm}/Length ${artEnc.length}`, artEnc.toString('latin1'));
  out += `\n13 0 obj\n<</FunctionType 2/Domain[0 1]/C0[0 0 0 0]/C1[0 1 0 0]/N 1>>\nendobj\n`;
  const smEnc = enc(mask);
  out += obj(14, `/Type/XObject/Subtype/Image/Width ${w}/Height ${h}/BitsPerComponent 8/ColorSpace/DeviceGray/Filter/FlateDecode/Length ${smEnc.length}`, smEnc.toString('latin1'));
  out += `\ntrailer\n<</Root 1 0 R/Size 15>>\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

test('reads a Form-wrapped, layer-tagged print file', async () => {
  const buf = formWrapped();
  const model = await imp.extractItemModel(ab(buf), { pixelsPerMm: 6 });
  // The cut line lives one form down; before the fix this fell back to the page box.
  assert.equal(model.cutPaths.length, 1);
  assert.ok(model.cutPaths[0].length >= 4, `cutline points ${model.cutPaths[0].length}`);
  const xs = model.cutPaths[0].map((p) => p[0]), ys = model.cutPaths[0].map((p) => p[1]);
  assert.ok(Math.max(...xs) - Math.min(...xs) > model.W * 0.5, 'cut line spans the plate');
  assert.ok(Math.max(...ys) - Math.min(...ys) > model.H * 0.5, 'cut line spans the plate');
  // Two plates, and the spot-ink one is tagged as the white plate, not art.
  assert.equal(model.images.length, 2);
  const roles = model.images.map((i) => i.role).sort();
  assert.deepEqual(roles, ['art', 'white']);
});

test('honours the soft matte and the raster row order', async () => {
  const buf = formWrapped();
  const model = await imp.extractItemModel(ab(buf), { pixelsPerMm: 6 });
  const art = model.images.find((i) => i.role === 'art');
  assert.ok(art.info.hasSMask, 'SMask detected');

  // Decode the prepared PNG and check the matte landed on the top row.
  let png = null;
  const createCanvas = (W, H) => ({ width: W, height: H, getContext: () => ({ save() {}, restore() {}, setTransform() {}, drawImage() {}, beginPath() {}, moveTo() {}, lineTo() {}, closePath() {}, fill() {}, set fillStyle(v) {} }) });
  await imp.toNestingItem(ab(buf), {
    pixelsPerMm: 6, createCanvas,
    decodeImage: async (blob) => { png = Buffer.from(await blob.arrayBuffer()); return { width: 1, height: 1, close() {} }; },
  });
  assert.ok(png && png.slice(1, 4).toString() === 'PNG', 'a PNG was produced');
  const zlib = require('node:zlib');
  let off = 8; const idat = [];
  while (off < png.length) {
    const len = png.readUInt32BE(off), type = png.slice(off + 4, off + 8).toString();
    if (type === 'IDAT') idat.push(png.slice(off + 8, off + 8 + len));
    off += 12 + len;
  }
  // The encoder must write a checksum a decoder accepts; it used to write a
  // mangled adler32 and every browser rejected the image.
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const w = png.readUInt32BE(16), h = png.readUInt32BE(20);
  assert.equal(raw.length, (w * 4 + 1) * h);
  const at = (x, y) => raw[y * (w * 4 + 1) + 1 + x * 4 + 3];
  // Opaque row in the stream is the top of the picture, which is v = 1 in PDF
  // image space, i.e. the LAST row of the decoded bitmap.
  assert.equal(at(0, h - 1), 255, 'top-of-image row stays opaque');
  assert.equal(at(0, 0), 0, 'bottom-of-image row is transparent');
});

test('a plate far larger than the canvas is downsampled, not encoded in full', async () => {
  // A 5301x8135 plate used to be encoded at full size: a 172MB PNG that no
  // decoder would take, and seconds of work per import.
  const big = formWrapped({ dw: 1200, dh: 2000 });
  const model = await imp.extractItemModel(ab(big), { pixelsPerMm: 6 });
  assert.ok(model.W < 1200, `item canvas ${model.W} should be smaller than the plate`);

  let emitted = null;
  const createCanvas = (W, H) => ({ width: W, height: H, getContext: () => ({ save() {}, restore() {}, setTransform() {}, drawImage() {}, beginPath() {}, moveTo() {}, lineTo() {}, closePath() {}, fill() {}, set fillStyle(v) {} }) });
  await imp.toNestingItem(ab(big), {
    pixelsPerMm: 6, createCanvas,
    decodeImage: async (blob) => {
      const b = Buffer.from(await blob.arrayBuffer());
      emitted = { w: b.readUInt32BE(16), h: b.readUInt32BE(20), size: blob.size };
      return { width: 1, height: 1, close() {} };
    },
  });
  assert.ok(emitted, 'a PNG was produced');
  assert.ok(emitted.w <= model.W && emitted.h <= model.H,
    `emitted ${emitted.w}x${emitted.h} must not exceed the canvas ${model.W}x${model.H}`);
  assert.ok(emitted.size < 8 * 1024 * 1024, `plates should not be encoded at full size (got ${emitted.size})`);
});

test('detectNativePpm reads the embedded raster density and caps it at press res', () => {
  const pt = (mm) => (mm * 72) / 25.4;
  const doc = {
    widthMm: 97.2, heightMm: 147.2,
    images: [{ info: { width: 5301, height: 8135 }, ctm: [pt(93.5), 0, 0, pt(143.5), 0, 0] }],
  };
  const ppm = imp.detectNativePpm(doc);
  assert.ok(Math.abs(ppm * 25.4 - 1440) < 1.5, `expected ~1440 dpi, got ${ppm * 25.4}`);
  const huge = {
    widthMm: 97.2, heightMm: 147.2,
    images: [{ info: { width: 20000, height: 30000 }, ctm: [pt(93.5), 0, 0, pt(143.5), 0, 0] }],
  };
  assert.ok(Math.abs(imp.detectNativePpm(huge) - imp.MAX_PPM) < 1e-9, 'density above the press cap is capped');
  assert.equal(imp.detectNativePpm({ widthMm: 10, heightMm: 10, images: [] }), null, 'vector-only files have no native density');
  const logo = {
    widthMm: 100, heightMm: 100,
    images: [{ info: { width: 4000, height: 4000 }, ctm: [pt(10), 0, 0, pt(10), 0, 0] }],
  };
  assert.equal(imp.detectNativePpm(logo), null, 'a tiny logo must not set the job resolution');
});

test("pixelsPerMm 'native' follows the embedded plate density", async () => {
  const big = formWrapped({ dw: 1200, dh: 2000 });
  const model = await imp.extractItemModel(ab(big), { pixelsPerMm: 'native' });
  assert.equal(model.ppm, model.nativePpm, 'native mode must use the detected density');
  assert.ok(model.ppm > 12, `plate is denser than the old 305 dpi grid (got ${model.ppm} px/mm)`);
  const fixed = await imp.extractItemModel(ab(big), { pixelsPerMm: 6 });
  assert.equal(fixed.ppm, 6, 'an explicit numeric grid still wins');
});

test('imported white plates are choked inside the artwork silhouette', async () => {
  global.ClipperLib = global.ClipperLib || require('../vendor/clipper.js');
  const ppm = 10; // 10 px/mm: a 100 px square is 10 mm
  const square = [[[0, 0], [100, 0], [100, 100], [0, 100]]];
  const choked = imp.chokeWhitePaths(square, ppm);
  assert.ok(choked.length, 'the plate survives the erosion');
  const xs = choked.flat().map((p) => p[0]);
  const ys = choked.flat().map((p) => p[1]);
  const wMm = (Math.max(...xs) - Math.min(...xs)) / ppm;
  const hMm = (Math.max(...ys) - Math.min(...ys)) / ppm;
  // 10 mm square eroded 0.3 mm per side; a convex square is unchanged by opening.
  assert.ok(Math.abs(wMm - 9.4) < 0.05, `width ${wMm} mm should be 10 - 2*0.3`);
  assert.ok(Math.abs(hMm - 9.4) < 0.05, `height ${hMm} mm should be 10 - 2*0.3`);
  // A 0.2 mm-wide spike (narrower than twice the opening radius) is removed.
  const spike = [[[0, 0], [100, 0], [100, 2], [50, 2], [50, 40], [48, 40], [48, 2], [0, 2]]];
  const opened = imp.chokeWhitePaths(spike, ppm);
  const ys2 = opened.flat().map((p) => p[1]);
  assert.ok(Math.max(...ys2) / ppm < 20, 'the hairline finger must not survive the opening');
  const model = await imp.extractItemModel(ab(formWrapped({ dw: 1200, dh: 2000 })), { pixelsPerMm: 6 });
  assert.ok(model.whitePaths.length, 'extraction still returns a white plate');
});

test('a white plate drawn proud of the cut line is clipped back inside it', () => {
  global.ClipperLib = global.ClipperLib || require('../vendor/clipper.js');
  const ppm = 10;
  const plate = [[[-20, -20], [120, -20], [120, 120], [-20, 120]]]; // 2 mm bleed past the cut
  const cut = [[[0, 0], [100, 0], [100, 100], [0, 100]]];
  const choked = imp.chokeWhitePaths(plate, ppm, cut);
  const xs = choked.flat().map((p) => p[0]);
  const ys = choked.flat().map((p) => p[1]);
  assert.ok(Math.max(...xs) / ppm <= 9.75, `plate must stay inside the cut (max x ${Math.max(...xs) / ppm} mm)`);
  assert.ok(Math.min(...ys) / ppm >= 0.25, `plate must stay inside the cut (min y ${Math.min(...ys) / ppm} mm)`);
});
