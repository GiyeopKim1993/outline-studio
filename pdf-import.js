'use strict';

/*
 * PDF importer: turns an already-finished die-cut PDF into a nesting item.
 *
 * Reads the page MediaBox (the real cut size), the page content stream, and the
 * image XObjects referenced by `/Name Do`. Paths are kept in viewBox millimetres
 * and tagged with the operator used to paint them:
 *   'S' stroke only  -> cutline candidate
 *   'f' fill         -> artwork / white candidate
 *   'B' both         -> cutline + artwork
 * This lets the browser app render the artwork on a canvas and rebuild
 * white / cut paths in exactly the same pixel space the rest of the pipeline uses.
 */

const PT_PER_MM = 72 / 25.4;

// ------------------------------------------------------------------ bytes
function latin1(bytes) {
  let out = '';
  for (let i = 0; i < bytes.length; i += 8192) {
    out += String.fromCharCode.apply(null, bytes.subarray(i, i + 8192));
  }
  return out;
}

function isWhitespace(ch) {
  const c = typeof ch === 'number' ? ch : ch.charCodeAt(0);
  return c === 32 || c === 10 || c === 13 || c === 9 || c === 0 || c === 12;
}

function isDelimiter(ch) {
  const c = typeof ch === 'number' ? ch : ch.charCodeAt(0);
  return c === 40 || c === 41 || c === 60 || c === 62 || c === 91 || c === 93 ||
    c === 123 || c === 125 || c === 47 || c === 37;
}

// ------------------------------------------------------------- inflate
async function inflate(bytes) {
  if (typeof DecompressionStream !== 'function') throw new Error('이 브라우저에서는 압축된 PDF를 읽을 수 없습니다.');
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

// ------------------------------------------------------------- objects
function parseObjectTable(text) {
  const objects = new Map();
  const re = /(\d+)\s+(\d+)\s+obj\b/g;
  let m;
  while ((m = re.exec(text))) {
    const num = Number(m[1]);
    const start = m.index + m[0].length;
    const end = text.indexOf('endobj', start);
    if (end < 0) continue;
    objects.set(num, { start, end, body: text.slice(start, end) });
    re.lastIndex = end;
  }
  return objects;
}

function objectStreamOf(object, text) {
  const body = object.body;
  const sIdx = body.indexOf('stream');
  if (sIdx < 0) return null;
  const dict = body.slice(0, sIdx);
  let dataStart = object.start + sIdx + 'stream'.length;
  // EOL after the keyword is not part of the data.
  if (text[dataStart] === '\r') dataStart++;
  if (text[dataStart] === '\n') dataStart++;
  const eIdx = body.indexOf('endstream', sIdx);
  const endstreamPos = eIdx < 0 ? object.end : object.start + eIdx;
  // Prefer /Length: binary stream data can legitimately end with CR/LF, so
  // trimming the EOL before `endstream` corrupts compressed payloads.
  const lenMatch = /\/Length\s+(\d+)(?!\s+\d+\s+R)/.exec(dict);
  let dataEnd = endstreamPos;
  if (lenMatch) {
    const declared = Number(lenMatch[1]);
    if (declared > 0 && dataStart + declared <= endstreamPos) dataEnd = dataStart + declared;
  }
  return { dict, bytes: { start: dataStart, end: dataEnd }, exact: Boolean(lenMatch) };
}

function streamBytes(bytes, text, record) {
  let end = record.bytes.end;
  if (!record.exact) {
    // No /Length: strip the single EOL that precedes `endstream`.
    if (text[end - 1] === '\n') end--;
    if (text[end - 1] === '\r') end--;
  }
  return bytes.subarray(record.bytes.start, end);
}

async function decodeStream(bytes, text, record) {
  const data = streamBytes(bytes, text, record);
  if (/\/FlateDecode/.test(record.dict) && !/\/DecodeParms\s*<</.test(record.dict)) {
    try { return await inflate(data); } catch (_) { /* fall through */ }
  }
  return data;
}

function bboxOf(loops) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const loop of loops) {
    for (const [x, y] of loop) {
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
    }
  }
  return { minX, minY, maxX, maxY, width: maxX - minX, height: maxY - minY };
}

// A content stream's path coordinates are user space transformed by the CTM.
// What differs between writers is whether the resulting page space is y-up
// (PDF default) or y-down (a writer that bakes the flip into the path matrix,
// like ours does). Decide once per document by checking which orientation puts
// the artwork inside the page box.
function fitsPage(boxes, pageWidth, pageHeight) {
  let inside = 0, total = 0;
  for (const b of boxes) {
    if (!isFinite(b.minX) || !isFinite(b.minY)) continue;
    total++;
    const padX = pageWidth * 0.25, padY = pageHeight * 0.25;
    if (b.minX >= -padX && b.minY >= -padY && b.maxX <= pageWidth + padX && b.maxY <= pageHeight + padY) inside++;
  }
  return total ? inside / total : 0;
}

// ------------------------------------------------------------- page
function resolveRef(value, objects) {
  const m = /^(\d+)\s+\d+\s+R$/.exec(String(value || '').trim());
  return m ? Number(m[1]) : null;
}

function findPages(text, objects) {
  const pages = [];
  for (const [num, obj] of objects) {
    const type = /\/Type\s*\/Page\b(?!s)/.exec(obj.body);
    if (!type) continue;
    const box = /\/MediaBox\s*\[([^\]]+)\]/.exec(obj.body);
    const contents = /\/Contents\s+(\d+)\s+\d+\s+R/.exec(obj.body) || /\/Contents\s*\[([^\]]+)\]/.exec(obj.body);
    let contentNums = [];
    if (contents) {
      if (/^\d+$/.test(contents[1].trim())) contentNums = [Number(contents[1].trim())];
      else contentNums = [...contents[1].matchAll(/(\d+)\s+\d+\s+R/g)].map((x) => Number(x[1]));
    }
    const resourcesRef = resolveRef((/\/Resources\s+(\d+\s+\d+\s+R)/.exec(obj.body) || [])[1], objects);
    const inlineResources = /\/Resources\s*<</.exec(obj.body);
    let inlineResourcesDict = '';
    if (inlineResources) {
      const start = obj.body.indexOf('<<', inlineResources.index + inlineResources[0].length - 2);
      let depth = 0, j = start;
      while (j < obj.body.length) {
        if (obj.body[j] === '<' && obj.body[j + 1] === '<') { depth++; j += 2; continue; }
        if (obj.body[j] === '>' && obj.body[j + 1] === '>') { depth--; j += 2; if (!depth) break; continue; }
        j++;
      }
      inlineResourcesDict = obj.body.slice(start, j);
    }
    pages.push({
      num,
      body: obj.body,
      mediaBox: box ? box[1].trim().split(/\s+/).map(Number) : null,
      contentNums,
      resourcesNum: resourcesRef,
      resourcesDict: inlineResourcesDict,
      hasInlineResources: Boolean(inlineResources),
    });
  }
  return pages;
}

function resourcesDict(page, objects) {
  if (page.resourcesNum && objects.has(page.resourcesNum)) return objects.get(page.resourcesNum).body;
  if (page.resourcesDict) return page.resourcesDict;
  return page.body;
}

// /XObject << /Name 12 0 R >> or /XObject 5 0 R -> object 5
function xobjectMap(resDict, objects) {
  const map = new Map();
  let src = resDict;
  const ref = /\/XObject\s+(\d+)\s+\d+\s+R/.exec(resDict);
  if (ref && objects.has(Number(ref[1]))) src = objects.get(Number(ref[1])).body;
  let dictText = '';
  const inline = /\/XObject\s*<<([\s\S]*?)>>/.exec(src);
  if (inline) dictText = inline[1];
  else if (src !== resDict) dictText = src;
  for (const m of dictText.matchAll(/\/([^\s/<>\[\]()]+)\s+(\d+)\s+\d+\s+R/g)) {
    map.set(m[1], Number(m[2]));
  }
  return map;
}

// ------------------------------------------------------------- content stream
function decodePdfString(str) {
  let out = '';
  for (let i = 0; i < str.length; i++) {
    const c = str[i];
    if (c === '\\') {
      const n = str[i + 1];
      const map = { n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', '(': '(', ')': ')', '\\': '\\' };
      if (map[n] !== undefined) { out += map[n]; i++; continue; }
      if (/[0-7]/.test(n)) {
        let oct = '';
        while (oct.length < 3 && /[0-7]/.test(str[i + 1])) { oct += str[i + 1]; i++; }
        out += String.fromCharCode(parseInt(oct, 8));
        continue;
      }
      continue;
    }
    out += c;
  }
  return out;
}

// Tokenise and interpret the subset of operators our own writer emits (plus
// common Illustrator/Acrobat output): q Q cm re m l c v y h S s f F f* B b n
// w J j gs Do BDC BMC EMC.
function parseContent(src) {
  const ops = [];
  const stack = [];
  let i = 0;
  const n = src.length;
  let ctm = [1, 0, 0, 1, 0, 0];
  const gstack = [];
  let lineWidth = 1;
  let pending = [];
  let path = [];
  let pos = [0, 0];

  const mul = (a, b) => [
    a[0] * b[0] + a[2] * b[1], a[1] * b[0] + a[3] * b[1],
    a[0] * b[2] + a[2] * b[3], a[1] * b[2] + a[3] * b[3],
    a[0] * b[4] + a[2] * b[5] + a[4], a[1] * b[4] + a[3] * b[5] + a[5],
  ];
  const tp = (x, y) => [ctm[0] * x + ctm[2] * y + ctm[4], ctm[1] * x + ctm[3] * y + ctm[5]];
  const raw = (x, y) => [x, y];
  const flushPath = (mode) => {
    if (mode !== 'n' && path.length) {
      for (const sub of path) {
        if (sub.points.length >= 2) {
          ops.push({
            type: 'path', mode, points: sub.points,
            rawPoints: sub.rawPoints,
            lineWidth: lineWidth * Math.hypot(ctm[0], ctm[1]),
          });
        }
      }
    }
    path = [];
  };
  const pushPoint = (x, y) => {
    if (!path.length) path.push({ points: [], rawPoints: [] });
    const sub = path[path.length - 1];
    sub.points.push(tp(x, y));
    sub.rawPoints.push(raw(x, y));
    pos = [x, y];
  };

  while (i < n) {
    const c = src[i];
    if (isWhitespace(c)) { i++; continue; }
    if (c === '%') { while (i < n && src[i] !== '\n') i++; continue; }
    if (c === '(') {
      let depth = 1, j = i + 1, raw = '';
      while (j < n && depth > 0) {
        const ch = src[j];
        if (ch === '\\') { raw += ch + (src[j + 1] || ''); j += 2; continue; }
        if (ch === '(') depth++;
        else if (ch === ')') { depth--; if (!depth) break; }
        raw += ch; j++;
      }
      pending.push({ str: decodePdfString(raw) });
      i = j + 1; continue;
    }
    if (c === '<' && src[i + 1] === '<') { // dictionary, skip
      let depth = 0, j = i;
      while (j < n) {
        if (src[j] === '<' && src[j + 1] === '<') { depth++; j += 2; continue; }
        if (src[j] === '>' && src[j + 1] === '>') { depth--; j += 2; if (!depth) break; continue; }
        j++;
      }
      i = j; continue;
    }
    if (c === '<') { // hex string
      const j = src.indexOf('>', i);
      pending.push({ str: '' });
      i = j < 0 ? n : j + 1; continue;
    }
    if (c === '[') { // array of numbers
      const j = src.indexOf(']', i);
      const inner = src.slice(i + 1, j < 0 ? n : j);
      pending.push({ array: inner.trim().split(/[\s,]+/).filter(Boolean).map(Number) });
      i = j < 0 ? n : j + 1; continue;
    }
    if (c === '/') { // name: the '/' itself is a delimiter, so start after it
      let j = i + 1;
      while (j < n && !isWhitespace(src[j]) && !isDelimiter(src[j])) j++;
      pending.push({ name: src.slice(i + 1, j) });
      i = j; continue;
    }
    if (c === ']' || c === '>' || c === ')' || c === '}' || c === '{') { i++; continue; }
    // number or operator
    let j = i;
    while (j < n && !isWhitespace(src[j]) && !isDelimiter(src[j])) j++;
    const tok = src.slice(i, j);
    i = j;
    if (/^[-+]?(\d+\.?\d*|\.\d+)$/.test(tok)) { pending.push(Number(tok)); continue; }

    const nums = pending.filter((p) => typeof p === 'number');
    const last = pending[pending.length - 1] || {};
    switch (tok) {
      case 'q': gstack.push({ ctm: ctm.slice(), lineWidth }); break;
      case 'Q': {
        const st = gstack.pop();
        if (st) { ctm = st.ctm; lineWidth = st.lineWidth; }
        break;
      }
      case 'cm': if (nums.length >= 6) ctm = mul(ctm, nums.slice(-6)); break;
      case 'w': if (nums.length) lineWidth = nums[nums.length - 1]; break;
      case 'm': if (nums.length >= 2) {
        path.push({ points: [], rawPoints: [] });
        pushPoint(nums[0], nums[1]);
      } break;
      case 'l': if (nums.length >= 2) pushPoint(nums[0], nums[1]); break;
      case 'c': if (nums.length >= 6) {
        // Sample the cubic so outlines stay polygonal like the rest of the pipeline.
        const [x0, y0] = pos, [x1, y1, x2, y2, x3, y3] = nums.slice(-6);
        for (let t = 1; t <= 8; t++) {
          const u = t / 8, v = 1 - u;
          const bx = v * v * v * x0 + 3 * v * v * u * x1 + 3 * v * u * u * x2 + u * u * u * x3;
          const by = v * v * v * y0 + 3 * v * v * u * y1 + 3 * v * u * u * y2 + u * u * u * y3;
          pushPoint(bx, by);
        }
      } break;
      case 'v': case 'y': if (nums.length >= 4) {
        const [x1, y1, x2, y2] = nums.slice(-4);
        const [x0, y0] = pos;
        const cx = tok === 'v' ? [x0, y0, x1, y1, x2, y2] : [x1, y1, x2, y2, x2, y2];
        for (let t = 1; t <= 8; t++) {
          const u = t / 8, v = 1 - u;
          const bx = v * v * v * x0 + 3 * v * v * u * cx[0] + 3 * v * u * u * cx[2] + u * u * u * cx[4];
          const by = v * v * v * y0 + 3 * v * v * u * cx[1] + 3 * v * u * u * cx[3] + u * u * u * cx[5];
          pushPoint(bx, by);
        }
      } break;
      case 'h': if (path.length) {
        const sub = path[path.length - 1];
        if (sub.length) pos = [0, 0];
      } break;
      case 're': if (nums.length >= 4) {
        const [x, y, w, h] = nums.slice(-4);
        const corners = [[x, y], [x + w, y], [x + w, y + h], [x, y + h]];
        path.push({
          points: corners.map(([u, v]) => tp(u, v)),
          rawPoints: corners.map(([u, v]) => raw(u, v)),
        });
      } break;
      case 'S': case 's': flushPath('S'); break;
      case 'f': case 'F': case 'f*': flushPath('f'); break;
      case 'B': case 'B*': case 'b': case 'b*': flushPath('B'); break;
      case 'n': flushPath('n'); break;
      case 'Do': if (last.name) ops.push({ type: 'image', name: last.name, ctm: ctm.slice() }); break;
      default: break;
    }
    pending = [];
  }
  return ops;
}

// ------------------------------------------------------------- images
function imageInfo(objectBody) {
  const num = (key) => {
    const m = new RegExp(`/${key}\\s+(-?[\\d.]+)`).exec(objectBody);
    return m ? Number(m[1]) : null;
  };
  const filter = (/\/Filter\s*(\[[^\]]*\]|\/\w+)/.exec(objectBody) || [])[1] || '';
  return {
    width: num('Width'),
    height: num('Height'),
    colorSpace: (/\/ColorSpace\s*(\/\w+)/.exec(objectBody) || [])[1] || null,
    bits: num('BitsPerComponent'),
    filter,
    hasSMask: /\/SMask\s+\d+\s+\d+\s+R/.test(objectBody),
  };
}

function ascii85Decode(bytes) {
  const text = latin1(bytes).replace(/\s+/g, '');
  const out = [];
  let group = [];
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '~') break;
    if (c === 'z' && group.length === 0) { out.push(0, 0, 0, 0); continue; }
    const v = text.charCodeAt(i) - 33;
    if (v < 0 || v > 84) continue;
    group.push(v);
    if (group.length === 5) {
      let num = 0;
      for (const g of group) num = num * 85 + g;
      out.push((num >>> 24) & 255, (num >>> 16) & 255, (num >>> 8) & 255, num & 255);
      group = [];
    }
  }
  if (group.length) {
    const pad = 5 - group.length;
    for (let k = 0; k < pad; k++) group.push(84);
    let num = 0;
    for (const g of group) num = num * 85 + g;
    const bytes4 = [(num >>> 24) & 255, (num >>> 16) & 255, (num >>> 8) & 255, num & 255];
    out.push(...bytes4.slice(0, 4 - pad));
  }
  return new Uint8Array(out);
}

async function imageToPngBlob(bytes, text, record, info) {
  if (!info.width || !info.height) throw new Error('PDF 이미지 크기를 읽지 못했습니다.');
  // Only PNG-friendly encodings are wrapped directly; the rest are rebuilt.
  const isFlate = /FlateDecode/.test(info.filter);
  const isDCT = /DCTDecode/.test(info.filter);
  const isA85 = /ASCII85Decode/.test(info.filter);
  if (isDCT) {
    let data = streamBytes(bytes, text, record);
    if (isA85) data = ascii85Decode(data);
    return new Blob([data], { type: 'image/jpeg' });
  }
  if (!isFlate) throw new Error('지원하지 않는 PDF 이미지 압축입니다 (DCTDecode 없음).');

  let raw = await inflate(streamBytes(bytes, text, record));
  const channels = info.colorSpace === '/DeviceRGB' ? 3
    : info.colorSpace === '/DeviceCMYK' ? 4
    : info.colorSpace === '/DeviceGray' ? 1 : 0;
  if (!channels) throw new Error('지원하지 않는 PDF 이미지 색공간: ' + (info.colorSpace || 'unknown'));

  let data = raw;
  if (info.bits !== 8) {
    if (info.bits === 1 && channels === 1) {
      // 1-bit gray -> 8-bit RGBA
      const stride = Math.ceil(info.width / 8);
      const out = new Uint8Array(info.width * info.height * 4);
      for (let y = 0; y < info.height; y++) {
        for (let x = 0; x < info.width; x++) {
          const bit = (raw[y * stride + (x >> 3)] >> (7 - (x & 7))) & 1;
          const v = bit ? 255 : 0, o = (y * info.width + x) * 4;
          out[o] = out[o + 1] = out[o + 2] = v; out[o + 3] = 255;
        }
      }
      return encodePng(out, info.width, info.height);
    }
    throw new Error(`지원하지 않는 bits per component: ${info.bits}`);
  }
  if (info.bits === 8 && info.colorSpace === '/DeviceGray' && info.hasSMask) {
    // alpha comes from a separate SMask; caller merges it
  }
  const out = new Uint8Array(info.width * info.height * 4);
  const px = info.width * info.height;
  for (let i = 0; i < px; i++) {
    const o = i * 4;
    if (channels === 4) {
      const c = raw[i * 4], m = raw[i * 4 + 1], y = raw[i * 4 + 2], k = raw[i * 4 + 3];
      out[o] = 255 - Math.min(255, c + k);
      out[o + 1] = 255 - Math.min(255, m + k);
      out[o + 2] = 255 - Math.min(255, y + k);
    } else if (channels === 3) {
      out[o] = raw[i * 3]; out[o + 1] = raw[i * 3 + 1]; out[o + 2] = raw[i * 3 + 2];
    } else {
      const v = raw[i];
      out[o] = out[o + 1] = out[o + 2] = v;
    }
    out[o + 3] = 255;
  }
  return encodePng(out, info.width, info.height);
}

// Minimal PNG encoder (stored deflate blocks, no filtering).
function encodePng(rgba, width, height) {
  const crcTable = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c >>> 0;
    }
    return t;
  })();
  const crc = (bytes) => {
    let c = 0xFFFFFFFF;
    for (let i = 0; i < bytes.length; i++) c = crcTable[(c ^ bytes[i]) & 255] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
  };
  const chunk = (type, data) => {
    const out = new Uint8Array(12 + data.length);
    const dv = new DataView(out.buffer);
    dv.setUint32(0, data.length);
    out.set([...type].map((c) => c.charCodeAt(0)), 4);
    out.set(data, 8);
    const body = out.subarray(4, 8 + data.length);
    dv.setUint32(8 + data.length, crc(body));
    return out;
  };
  const stride = width * 4;
  const raw = new Uint8Array((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    raw.set(rgba.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1);
  }
  // adler32 for a single stored zlib block stream
  let a = 1, b = 0;
  for (let i = 0; i < raw.length; i++) { a = (a + raw[i]) % 65521; b = (b + a) % 65521; }
  const blocks = Math.ceil(raw.length / 65535);
  const z = new Uint8Array(2 + raw.length + blocks * 5 + 4);
  z[0] = 0x78; z[1] = 0x01;
  let off = 2;
  for (let i = 0; i < blocks; i++) {
    const len = Math.min(65535, raw.length - i * 65535);
    const last = i === blocks - 1;
    z[off++] = last ? 1 : 0;
    z[off++] = len & 255; z[off++] = (len >> 8) & 255;
    z[off++] = ~len & 255; z[off++] = (~len >> 8) & 255;
    z.set(raw.subarray(i * 65535, i * 65535 + len), off);
    off += len;
  }
  z[off++] = (b << 8 | a) >>> 24 & 255;
  z[off++] = (b << 8 | a) >>> 16 & 255;
  z[off++] = (b << 8 | a) >>> 8 & 255;
  z[off++] = (b << 8 | a) & 255;
  const ihdr = new Uint8Array(13);
  const dv = new DataView(ihdr.buffer);
  dv.setUint32(0, width); dv.setUint32(4, height);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const parts = [
    new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr), chunk('IDAT', z), chunk('IEND', new Uint8Array(0)),
  ];
  const total = parts.reduce((s, p) => s + p.length, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return new Blob([out], { type: 'image/png' });
}

// ------------------------------------------------------------- public API
async function inspect(arrayBuffer) {
  const bytes = new Uint8Array(arrayBuffer);
  const text = latin1(bytes);
  if (!text.startsWith('%PDF')) throw new Error('PDF 파일이 아닙니다.');
  const objects = parseObjectTable(text);
  const pages = findPages(text, objects);
  if (!pages.length) throw new Error('PDF에서 페이지를 찾지 못했습니다.');
  const page = pages[0];
  const box = page.mediaBox || [0, 0, 595.28, 841.89];
  const [x0, y0, x1, y1] = box;
  const widthMm = (x1 - x0) / PT_PER_MM;
  const heightMm = (y1 - y0) / PT_PER_MM;

  let content = '';
  for (const num of page.contentNums) {
    const obj = objects.get(num);
    if (!obj) continue;
    const record = objectStreamOf(obj, text);
    if (!record) continue;
    const decoded = await decodeStream(bytes, text, record);
    content += latin1(decoded) + '\n';
  }
  const ops = parseContent(content);

  const resDict = resourcesDict(page, objects);
  const xobjects = xobjectMap(resDict, objects);
  const images = [];
  for (const op of ops) {
    if (op.type !== 'image') continue;
    const num = xobjects.get(op.name);
    if (!num) continue;
    const obj = objects.get(num);
    if (!obj) continue;
    const record = objectStreamOf(obj, text);
    if (!record) continue;
    images.push({ name: op.name, num, ctm: op.ctm, info: imageInfo(record.dict), record });
  }

  return { bytes, text, objects, page, widthMm, heightMm, ops, images, xobjects };
}

// Pure model extraction (no DOM): pixel-space paths + image placements.
async function extractItemModel(arrayBuffer, options = {}) {
  const doc = await inspect(arrayBuffer);
  const ppm = Number(options.pixelsPerMm) || 12; // 12 px/mm ≈ 305 dpi
  const scale = ppm / PT_PER_MM;
  const W = Math.max(1, Math.round(doc.widthMm * ppm));
  const H = Math.max(1, Math.round(doc.heightMm * ppm));
  const pageWidthPt = doc.widthMm * PT_PER_MM;
  const pageHeightPt = doc.heightMm * PT_PER_MM;
  const pathOps = doc.ops.filter((o) => o.type === 'path');

  // Candidate A: standard PDF user space in points, y up.
  const toPxUp = (x, y) => [x * scale, (pageHeightPt - y) * scale];
  // Candidate B: some writers (including ours) bake the flip into the path
  // matrix, so the coordinates are already in artwork pixels, y down.
  // Normalise that bbox onto the page box so any pixel scale works.
  const allPts = pathOps.flatMap((op) => op.points);
  const box = allPts.length
    ? { minX: Math.min(...allPts.map((p) => p[0])), maxX: Math.max(...allPts.map((p) => p[0])),
        minY: Math.min(...allPts.map((p) => p[1])), maxY: Math.max(...allPts.map((p) => p[1])) }
    : null;
  const bw = box ? box.maxX - box.minX : 0, bh = box ? box.maxY - box.minY : 0;
  const toPxBaked = (x, y) => [
    bw > 0 ? (x - box.minX) * (W / bw) : x,
    bh > 0 ? (y - box.minY) * (H / bh) : y,
  ];
  const scoreFor = (fn) => fitsPage(
    pathOps.map((op) => bboxOf([op.points.map(([x, y]) => fn(x, y))])),
    W, H,
  );
  // Prefer the PDF-standard interpretation when it fits the page.
  const userToPx = scoreFor(toPxUp) >= 0.999 ? toPxUp : (scoreFor(toPxBaked) >= scoreFor(toPxUp) ? toPxBaked : toPxUp);

  const cutPaths = [];
  const whitePaths = [];
  for (const op of pathOps) {
    const loop = op.points.map(([x, y]) => userToPx(x, y));
    if (loop.length < 3) continue;
    if (op.mode === 'S') cutPaths.push(loop);
    else whitePaths.push(loop);
  }
  if (!cutPaths.length) cutPaths.push([[0, 0], [W, 0], [W, H], [0, H]]);
  if (!whitePaths.length) for (const loop of cutPaths) whitePaths.push(loop.map((p) => [p[0], p[1]]));

  const images = [];
  for (const op of doc.ops.filter((o) => o.type === 'image')) {
    const found = doc.images.find((im) => im.name === op.name);
    if (!found) continue;
    images.push({ name: op.name, ctm: op.ctm, record: found.record, info: found.info });
  }

  return {
    doc, ppm, W, H,
    widthMm: doc.widthMm,
    heightMm: doc.heightMm,
    cutPaths, whitePaths, images,
    userToPx,
    bytes: doc.bytes,
    text: doc.text,
  };
}

// Convert a PDF into a nesting item: painted artwork canvas + cut/white paths in
// the same pixel space the PNG pipeline uses.
async function toNestingItem(arrayBuffer, options = {}) {
  const model = await extractItemModel(arrayBuffer, options);
  const { W, H, ppm, userToPx } = model;
  const name = options.name || 'pdf-artwork';
  const makeCanvas = options.createCanvas || ((w, h) => {
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    return c;
  });
  const decodeImage = options.decodeImage || ((blob) => createImageBitmap(blob));
  const canvas = makeCanvas(W, H);
  const ctx = canvas.getContext('2d');

  // Artwork: paint each image through its own cm matrix.
  for (const im of model.images) {
    let bitmap;
    try {
      const blob = await imageToPngBlob(model.bytes, model.text, im.record, im.info);
      bitmap = await decodeImage(blob);
    } catch (_) { continue; }
    const m = im.ctm;
    const corners = [[0, 0], [1, 0], [1, 1], [0, 1]].map(([u, v]) => {
      const x = m[0] * u + m[2] * v + m[4];
      const y = m[1] * u + m[3] * v + m[5];
      return userToPx(x, y);
    });
    const [p0, p1, , p3] = corners;
    ctx.save();
    ctx.setTransform(
      (p1[0] - p0[0]) / bitmap.width, (p1[1] - p0[1]) / bitmap.width,
      (p3[0] - p0[0]) / bitmap.height, (p3[1] - p0[1]) / bitmap.height,
      p0[0], p0[1],
    );
    ctx.drawImage(bitmap, 0, 0);
    ctx.restore();
    if (bitmap.close) bitmap.close();
  }

  // Fallback artwork when the PDF carries no raster image (pure vector file):
  // paint the white/art polygons so the preview is not blank.
  if (!model.images.length) {
    ctx.fillStyle = 'rgba(160,175,200,0.35)';
    for (const loop of model.whitePaths) {
      ctx.beginPath();
      loop.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
      ctx.closePath();
      ctx.fill('evenodd');
    }
  }

  return {
    name,
    artwork: canvas,
    width: W,
    height: H,
    pixelsPerMm: ppm,
    widthMm: model.widthMm,
    heightMm: model.heightMm,
    cutPaths: model.cutPaths,
    whitePaths: model.whitePaths,
    pageCount: model.doc.page ? 1 : 0,
    sourcePdf: true,
  };
}

if (typeof module !== 'undefined') {
  module.exports = { inspect, extractItemModel, toNestingItem, parseContent, encodePng, PT_PER_MM, imageInfo };
}
if (typeof window !== 'undefined') {
  window.OutlinePdfImport = { inspect, extractItemModel, toNestingItem, parseContent, encodePng, PT_PER_MM };
}
