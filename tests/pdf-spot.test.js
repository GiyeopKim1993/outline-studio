'use strict';
// Dependency-free PDF writer checks: run with `node --test tests/*.test.js`.
const test = require('node:test');
const assert = require('node:assert/strict');
const zlib = require('node:zlib');
global.window = global;
require('../pdf.js');

function fixture() {
  const width = 8, height = 6;
  const rgba = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    rgba[i * 4] = 210; rgba[i * 4 + 1] = 50; rgba[i * 4 + 2] = 70;
    rgba[i * 4 + 3] = i % 3 ? 255 : 0;
  }
  return {
    artwork: { getContext: () => ({ getImageData: () => ({ data: rgba }) }) },
    width, height, pixelsPerMm: 11.813953488372093,
    whitePaths: [[[1.772, 1.772], [6.228, 1.772], [6.228, 4.228], [1.772, 4.228]]],
    cutPaths: [[[0, 0], [8, 0], [8, 6], [0, 6]]],
    whiteName: 'White Ink', cutName: 'Cut/1'
  };
}
function extractContent(bytes) {
  const pdf = bytes.toString('latin1');
  const match = /4 0 obj\n<<\s*(\/Filter \/FlateDecode)?\s*\/Length (\d+) >>\nstream\n/.exec(pdf);
  assert.ok(match, 'page content stream is present');
  const start = match.index + match[0].length;
  const stream = bytes.subarray(start, start + Number(match[2]));
  return (match[1] ? zlib.inflateSync(stream) : stream).toString('utf8');
}

test('PDF contains separate escaped spot inks, vector paths, and overprint', async () => {
  const data = Buffer.from(await (await OutlinePDF.create(fixture())).arrayBuffer());
  const pdf = data.toString('latin1');
  assert.match(pdf, /\/Separation \/White#20Ink \/DeviceCMYK/);
  assert.match(pdf, /\/Separation \/Cut#2F1 \/DeviceCMYK/);
  assert.match(pdf, /\/OP true \/op true \/OPM 1/);
  assert.doesNotMatch(pdf, /\/BM \/Multiply/); // Normal blending avoids changing process plates.
  assert.match(pdf, /\/SMask \d+ 0 R/);
  assert.match(pdf, /\/OCProperties/);
  const content = extractContent(data);
  assert.match(content, /\/WhiteSpot cs\n1 scn/);
  assert.match(content, /1\.772 1\.772 m/);
  assert.match(content, /\nf\*\n/); // Preserve transparent holes via the even-odd rule.
  assert.match(content, /\/CutSpot CS\n1 SCN/);
  assert.match(content, /\/Artwork Do/);
  const matrix = /([0-9.]+) 0 0 -([0-9.]+) 0 [0-9.]+ cm/.exec(content);
  assert.ok(matrix, 'vector transform is present');
  assert.ok(Math.abs(Number(matrix[1]) - 72 / (25.4 * fixture().pixelsPerMm)) < 0.000001);
  assert.equal(matrix[1], matrix[2]); // Preserve sub-pixel alignment.
});

test('uncompressed fallback still yields a valid PDF with spot paths', async () => {
  const original = global.CompressionStream;
  global.CompressionStream = undefined;
  try {
    const data = Buffer.from(await (await OutlinePDF.create(fixture())).arrayBuffer());
    assert.ok(data.subarray(0, 8).toString().startsWith('%PDF-1.7'));
    assert.match(extractContent(data), /\/WhiteSpot cs/);
  } finally { global.CompressionStream = original; }
});

test('refuses to silently export a blank white plate or blank cutline', async () => {
  await assert.rejects(() => OutlinePDF.create({ ...fixture(), whitePaths: [] }), /화이트 영역이 없습니다/);
  await assert.rejects(() => OutlinePDF.create({ ...fixture(), cutPaths: [] }), /칼선이 비어 있습니다/);
});
