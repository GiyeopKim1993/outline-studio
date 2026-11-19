'use strict';
/*
 * Boots the real index.html inside jsdom and drives the two regressions:
 *   1. white layer must never leak across batch items
 *   2. a tab click during processBatch must never misroute a result
 */
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const SRC = '/home/user/site-deploy/final-stage';
const ORDERS = ['vendor/clipper.js', 'pdf.js', 'scaffold-rules.js', 'nesting-geometry.js',
  'nesting.js', 'pdf-import.js', 'rle.js', 'render-state.js', 'batch-store.js', 'app.js'];

function boot() {
  let html = fs.readFileSync(path.join(SRC, 'index.html'), 'utf8');
  html = html.replace(/<script[^>]*src="[^"]*"[^>]*><\/script>/g, '');
  const dom = new JSDOM(html, { runScripts: 'outside-only', pretendToBeVisual: true, url: 'https://localhost/' });
  const { window } = dom;

  // Minimal canvas: enough for the pipeline to run, records what it drew.
  window.HTMLCanvasElement.prototype.getContext = function () {
    const c = this;
    return {
      canvas: c,
      fillStyle: '#000', strokeStyle: '#000', lineWidth: 1, globalAlpha: 1,
      globalCompositeOperation: 'source-over', lineCap: 'butt', lineJoin: 'miter', font: '10px sans-serif',
      imageSmoothingEnabled: true, filter: 'none',
      save() {}, restore() {}, beginPath() {}, closePath() {}, moveTo() {}, lineTo() {},
      bezierCurveTo() {}, quadraticCurveTo() {}, arc() {}, arcTo() {}, rect() {}, ellipse() {},
      fill() {}, stroke() {}, clip() {}, translate() {}, rotate() {}, scale() {},
      setTransform() {}, resetTransform() {}, setLineDash() {},
      drawImage(img) {
        if (img && img.__data) c.__drawn = img;
        else if (img && img.__drawn) { c.__drawn = img.__drawn; c.__needResample = true; }
      },
      fillRect() {}, strokeRect() {}, clearRect() {}, putImageData() {}, measureText: () => ({ width: 10 }),
      createLinearGradient: () => ({ addColorStop() {} }),
      getImageData: (x, y, w, h) => {
        const drawn = c.__drawn;
        if (!drawn) return { width: w, height: h, data: new Uint8ClampedArray(w * h * 4) };
        if (drawn.width === w && drawn.height === h) return { width: w, height: h, data: drawn.__data };
        // Nearest-neighbour resample, so a canvas drawn from a smaller canvas
        // still yields usable pixels the way a real browser would.
        const out = new Uint8ClampedArray(w * h * 4);
        for (let y = 0; y < h; y++) {
          const sy = Math.min(drawn.height - 1, Math.floor(y * drawn.height / h));
          for (let x = 0; x < w; x++) {
            const sx = Math.min(drawn.width - 1, Math.floor(x * drawn.width / w));
            const si = (sy * drawn.width + sx) * 4, di = (y * w + x) * 4;
            out[di] = drawn.__data[si]; out[di + 1] = drawn.__data[si + 1];
            out[di + 2] = drawn.__data[si + 2]; out[di + 3] = drawn.__data[si + 3];
          }
        }
        return { width: w, height: h, data: out };
      },
      createImageData: (w, h) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }),
      toDataURL: () => 'data:image/png;base64,AA==',
    };
  };
  window.HTMLCanvasElement.prototype.toBlob = function (cb) {
    cb(new window.Blob([new Uint8Array([1, 2, 3, 4])], { type: 'image/png' }));
  };
  window.HTMLCanvasElement.prototype.toDataURL = () => 'data:image/png;base64,AA==';

  // Bitmaps are synthetic: each file encodes its own pixel pattern.
  const bitmaps = new Map();
  window.createImageBitmap = async (blob) => {
    const tag = blob && blob.__tag;
    const spec = bitmaps.get(tag) || { width: 8, height: 8, period: 3, inset: 1 };
    const data = new Uint8ClampedArray(spec.width * spec.height * 4);
    for (let i = 0; i < spec.width * spec.height; i++) {
      const x = i % spec.width, y = (i / spec.width) | 0;
      const inside = x >= spec.inset && y >= spec.inset && x < spec.width - spec.inset && y < spec.height - spec.inset;
      const on = inside && (i % spec.period === 0) ? 255 : 0;
      data[i * 4] = on; data[i * 4 + 1] = on; data[i * 4 + 2] = on; data[i * 4 + 3] = on;
    }
    return { width: spec.width, height: spec.height, close() {}, __data: data, __tag: tag };
  };

  for (const file of ORDERS) {
    const code = fs.readFileSync(path.join(SRC, file), 'utf8');
    window.eval(code + '\n//# sourceURL=' + file);
  }
  return { dom, window, bitmaps };
}

function fakeFile(name, tag) {
  const file = new File([new Uint8Array([1, 2, 3])], name, { type: 'image/png' });
  Object.defineProperty(file, '__tag', { value: tag, enumerable: false });
  return file;
}

module.exports = { boot, fakeFile };
