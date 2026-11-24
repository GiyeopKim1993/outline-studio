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
  // Marked content (`/OC /Name BDC ... EMC`) is how print files label their
  // layers. Without it a white plate, which is a solid silhouette of the whole
  // figure, is indistinguishable from artwork and gets painted on top of it.
  let markStack = [];
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
            mark: markStack[markStack.length - 1] || null,
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
      // `Do` is resolved to an Image or a Form later (see flattenForms): the
      // content stream alone cannot tell them apart, only the /XObject dict can.
      case 'BDC': case 'BMC': {
        // `/OC /MCWhite BDC` leaves /MCWhite as the last name token.
        markStack.push(typeof last.name === 'string' ? last.name.slice(1) : '');
        break;
      }
      case 'EMC': markStack.pop(); break;
      case 'Do': if (last.name) ops.push({ type: 'xobject', name: last.name, ctm: ctm.slice(), mark: markStack[markStack.length - 1] || null }); break;
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
  // Colour spaces come in two shapes. A name (`/DeviceRGB`) is easy; an array
  // (`[/Separation /spot_0 /DeviceCMYK 14 0 R]`, `[/ICCBased 3 0 R]`,
  // `[/Indexed /DeviceRGB 255 4 0 R]`) is what print-ready files actually use,
  // and a `/\w+` match either fails or catches the *first* name inside the array,
  // which is the family, not the channel count. Resolve the array properly.
  const csMatch = /\/ColorSpace\s*(\[[^\]]*\]|\/\w+)/.exec(objectBody);
  let colorSpace = null;
  let channels = 0;
  let kind = 'other';
  if (csMatch) {
    if (csMatch[1].startsWith('/')) {
      colorSpace = csMatch[1];
      channels = colorSpace === '/DeviceRGB' ? 3 : colorSpace === '/DeviceCMYK' ? 4
        : colorSpace === '/DeviceGray' ? 1 : 0;
      kind = colorSpace === '/DeviceGray' ? 'gray' : 'color';
    } else {
      const family = (/^\[\s*\/(\w+)/.exec(csMatch[1]) || [])[1] || '';
      colorSpace = '[' + family + ']';
      if (family === 'Separation' || family === 'DeviceN') {
        // One ink: device space is irrelevant, there is a single tint channel.
        channels = 1;
        kind = 'spot';
      } else if (family === 'ICCBased') {
        // /N lives in the ICC stream's dict; 3 → RGB, 4 → CMYK, 1 → gray.
        const ref = /\/ICCBased\s+(\d+)\s+\d+\s+R/.exec(csMatch[1]);
        colorSpace = ref ? '[/ICCBased ' + ref[1] + ']' : '[/ICCBased]';
        channels = 0;
        kind = 'color';
      } else if (family === 'Indexed' || family === 'I') {
        channels = 1;
        kind = 'color';
      }
    }
  }
  const smask = /\/SMask\s+(\d+)\s+\d+\s+R/.exec(objectBody);
  return {
    width: num('Width'),
    height: num('Height'),
    colorSpace,
    channels,
    kind,
    bits: num('BitsPerComponent'),
    filter,
    hasSMask: Boolean(smask),
    smaskNum: smask ? Number(smask[1]) : null,
    iccNum: (/ICCBased\s+(\d+)/.exec(colorSpace || '') || [])[1] ? Number(/ICCBased\s+(\d+)/.exec(colorSpace)[1]) : null,
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

async function imageToPngBlob(bytes, text, record, info, ctx = {}) {
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

  let channels = info.channels;
  // An ICC-based stream stores its channel count in the profile dict, not in the
  // image dict, so it is resolved lazily here where the object table is in reach.
  if (!channels && info.iccNum && ctx.objects) {
    const icc = ctx.objects.get(info.iccNum);
    if (icc) {
      const n = (/\/N\s+(\d+)/.exec(icc.body) || [])[1];
      if (n) channels = Number(n);
    }
  }
  if (!channels) throw new Error('지원하지 않는 PDF 이미지 색공간: ' + (info.colorSpace || 'unknown'));

  const raw = await inflate(streamBytes(bytes, text, record));
  const px = info.width * info.height;

  if (info.bits !== 8) {
    if (info.bits === 1 && channels === 1) {
      // 1-bit gray -> 8-bit RGBA
      const stride = Math.ceil(info.width / 8);
      const out = new Uint8Array(px * 4);
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

  // Decoder must consume exactly what the stream holds. Writers may emit a
  // Flate stream whose payload is larger than width*height*channels (progressive
  // scanline restarts, predictor leftovers); trusting the header alone yields a
  // half-painted, banded image.
  const need = px * channels;
  // Emit at the size the page actually needs. A print plate can be 5301x8135,
  // but the item canvas is a few hundred pixels across; encoding the full raster
  // produced a 172MB PNG (a stored-deflate stream) that no decoder will take
  // happily. Nearest-neighbour subsampling here is exact at integer ratios and
  // cheap at any ratio.
  const outW = Math.max(1, Math.min(info.width, Math.round(ctx.targetW || info.width)));
  const outH = Math.max(1, Math.min(info.height, Math.round(ctx.targetH || info.height)));
  const out = new Uint8Array(outW * outH * 4);
  const rows = info.height;
  const colSrc = new Int32Array(outW);
  for (let x = 0; x < outW; x++) colSrc[x] = Math.min(info.width - 1, Math.floor((x * info.width) / outW));
  const rowMap = new Int32Array(outH);
  for (let y = 0; y < outH; y++) rowMap[y] = rows - 1 - Math.min(rows - 1, Math.floor((y * rows) / outH));
  const strideIn = raw.length >= need ? channels : Math.max(1, Math.floor(raw.length / (rows * info.width) + 0.5));
  const stride = info.width * (raw.length >= need ? channels : strideIn);

  // PDF image space has v = 0 at the *bottom*, while the stream stores row 0 at
  // the *top* of the picture. Writing the rows out in stream order and then
  // drawing with v = 0 at the origin mirrors every imported artwork vertically.
  // (Verified against an independent renderer: the figure came out upside down.)
  for (let y = 0; y < outH; y++) {
    const srcRow = rowMap[y] * stride;
    const dstRow = y;
    for (let x = 0; x < outW; x++) {
      const o = (dstRow * outW + x) * 4;
      const si = srcRow + colSrc[x] * strideIn;
      if (info.kind === 'spot') {
        // A single ink tint: show it as dark ink density on white.
        const t = raw[si];
        out[o] = out[o + 1] = out[o + 2] = 255 - t;
      } else if (strideIn === 4) {
        const c = raw[si], m = raw[si + 1], yy = raw[si + 2], k = raw[si + 3];
        out[o] = 255 - Math.min(255, c + k);
        out[o + 1] = 255 - Math.min(255, m + k);
        out[o + 2] = 255 - Math.min(255, yy + k);
      } else if (strideIn === 3) {
        out[o] = raw[si]; out[o + 1] = raw[si + 1]; out[o + 2] = raw[si + 2];
      } else {
        const v = raw[si];
        out[o] = out[o + 1] = out[o + 2] = v;
      }
      out[o + 3] = 255;
    }
  }

  // Composite a separate /SMask (soft matte) as alpha, streamed row by row so a
  // 5301x8135 artwork does not need a second full-size buffer.
  if (info.hasSMask && info.smaskNum && ctx.objects && ctx.text && ctx.bytes) {
    try {
      const smObj = ctx.objects.get(info.smaskNum);
      const smRecord = smObj ? objectStreamOf(smObj, ctx.text) : null;
      if (smRecord) {
        const smRaw = await inflate(streamBytes(ctx.bytes, ctx.text, smRecord));
        const smChannels = (/\/ColorSpace\s*\/DeviceGray/.test(smRecord.dict) ? 1
          : (/\/ColorSpace\s*\/DeviceRGB/.test(smRecord.dict) ? 3 : 1));
        const smW = Number((/\/Width\s+(\d+)/.exec(smRecord.dict) || [])[1]) || info.width;
        const smH = Number((/\/Height\s+(\d+)/.exec(smRecord.dict) || [])[1]) || info.height;
        if (smW === info.width && smH === info.height) {
          for (let y = 0; y < outH; y++) {
            const sRow = rowMap[y] * info.width * smChannels;
            for (let x = 0; x < outW; x++) {
              out[(y * outW + x) * 4 + 3] = smRaw[sRow + colSrc[x] * smChannels];
            }
          }
        }
      }
    } catch (_) { /* no matte: keep the image opaque rather than fail the import */ }
  }

  // At native size the PNG round-trip is pure waste: encodePng stores the raster
  // uncompressed, so a 1440 dpi plate means a 172 MB blob plus JS-side CRC and
  // adler loops, only to be decoded straight back into a canvas. Hand the pixels
  // over directly; the PNG path remains for downsampled targets and tests.
  // The raw hand-off needs a DOM (ImageData/putImageData); headless tests decode
  // the PNG through their own hook instead.
  if (ctx.rawPixels && outW === info.width && outH === info.height && typeof ImageData === 'function') {
    return { rgba: out, width: outW, height: outH };
  }
  return encodePng(out, outW, outH);
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
  // adler32 is (b << 16) | a, written big-endian. Shifting by 8 instead of 16
  // packs the two halves on top of each other, so the trailer is garbage and a
  // strict decoder (every browser) rejects the whole image with "incorrect data
  // check". That silently killed the artwork of every imported PDF.
  z[off++] = (b >>> 8) & 255;
  z[off++] = b & 255;
  z[off++] = (a >>> 8) & 255;
  z[off++] = a & 255;
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
  const xobjects = xobjectMap(resourcesDict(page, objects), objects);
  const doc = { bytes, text, objects, page, widthMm, heightMm, ops, images: [], xobjects, spots: collectSpotNames(text, page, objects) };

  // A finished artwork is usually wrapped in Form XObjects, one per layer
  // (`WhiteForm`, `RasterForm`, `OutlineForm` in our own writer, `/Fm0` etc.
  // elsewhere), and the page content only says `/Name Do`. Reading the page
  // stream alone therefore sees no artwork and no cut line: the shapes live one
  // level down, in the form's own stream with its own `/Resources`. Inline the
  // forms by descending into every `/Name Do` that resolves to a Form XObject,
  // applying the form's /Matrix the same way a viewer does.
  const flat = await flattenForms(doc);
  return Object.assign(doc, flat);
}



/**
 * Every `/Separation` or `/DeviceN` name declared anywhere in the file, with the
 * layers it appears on. Nested-sheet jobs need the individual PDFs to share one
 * spot naming scheme, so this is what the app compares and rewrites.
 */
function collectSpotNames(text, page, objects) {
  const found = new Map();
  const add = (name, where) => {
    if (!name) return;
    const key = String(name);
    if (!found.has(key)) found.set(key, { name: key, layers: new Set() });
    found.get(key).layers.add(where);
  };
  // /Separation /Name ... and /DeviceN [/Name ...] ... anywhere in an object.
  for (const [, obj] of objects) {
    for (const m of obj.body.matchAll(/\/Separation\s*\/([^\s\/<>\[\]()]+)/g)) add(m[1], 'object');
    for (const m of obj.body.matchAll(/\/DeviceN\s*\[\s*\/([^\s\/<>\[\]()]+)/g)) add(m[1], 'object');
  }
  return [...found.values()].map((v) => ({ name: v.name, layers: [...v.layers] }));
}

/**
 * Resolve the layer an imported image belongs to, using the OCG names the file
 * itself declares (`/OC /MCWhite BDC` points at an /OCG whose /Name is readable
 * text such as "White spot: rdg_white"). Falls back to the marked-content tag.
 */
function resolveLayerName(mark, ocgNames) {
  if (!mark) return null;
  return ocgNames && ocgNames.get(mark) ? ocgNames.get(mark) : mark;
}

/**
 * Decide whether an image is the visible artwork or a production plate.
 *
 * A die-cut PDF carries three stacked layers: a white plate (a solid silhouette
 * printed behind the art so the piece is opaque), the process artwork, and the
 * cut line. The white plate is a *single spot ink* and its name says so; painting
 * it as art would bury the figure under a solid blob, and painting the cut plate
 * would do the same in magenta.
 */
function classifyImageRole(op, info, dict) {
  const hay = `${op.mark || ''} ${op.name || ''} ${info.colorSpace || ''} ${
    (/\/Name\s*\/([^\s/<>]+)/.exec(dict) || [])[1] || ''}`;
  if (!/\bArtwork\b/i.test(hay) && /white|whiteform|imwhite|milk|opaque|base\s*white/i.test(hay)) return 'white';
  if (!/\bArtwork\b/i.test(hay) && /cut|cutline|cutcontour|outline|die|kiss/i.test(hay)) return 'cut';
  // A single-ink plate is never the process artwork.
  if (info.kind === 'spot') return 'white';
  return 'art';
}

/** Multiply two PDF matrices (row-vector convention, same as `cm`). */
function mulMatrix(a, b) {
  return [
    a[0] * b[0] + a[2] * b[1], a[1] * b[0] + a[3] * b[1],
    a[0] * b[2] + a[2] * b[3], a[1] * b[2] + a[3] * b[3],
    a[0] * b[4] + a[2] * b[5] + a[4], a[1] * b[4] + a[3] * b[5] + a[5],
  ];
}

function parseMatrix(body) {
  const m = /\/Matrix\s*\[([^\]]*)\]/.exec(body);
  if (!m) return [1, 0, 0, 1, 0, 0];
  const v = m[1].trim().split(/\s+/).map(Number);
  return v.length === 6 && v.every((x) => Number.isFinite(x)) ? v : [1, 0, 0, 1, 0, 0];
}

/**
 * Walk every Form XObject reachable from the page and return the page's ops with
 * the forms inlined. Each inlined op carries the full CTM (page `cm` × form
 * `/Matrix` × form content `cm`), so a viewer and this reader agree on where the
 * ink lands.
 */
async function flattenForms(doc, options = {}) {
  const maxDepth = options.maxDepth ?? 8;
  const { bytes, text, objects, page } = doc;
  const opList = [];
  const images = [];
  const seen = new Set();

  const resolveName = (map, name) => {
    const num = map.get(name);
    if (!num) return null;
    const obj = objects.get(num);
    if (!obj) return null;
    const record = objectStreamOf(obj, text);
    return record ? { num, obj, record } : null;
  };

  const walk = async (ops, xobjects, depth, visited) => {
    for (const op of ops) {
      if (op.type === 'xobject') {
        const hit = resolveName(xobjects, op.name);
        if (!hit) continue;
        const isImage = /\/Subtype\s*\/Image\b/.test(hit.record.dict);
        if (isImage) {
          const info = imageInfo(hit.record.dict);
          const role = classifyImageRole(op, info, hit.record.dict);
          opList.push(Object.assign({}, op, { type: 'image', role }));
          if (!images.some((im) => im.num === hit.num)) {
            images.push({ name: op.name, num: hit.num, ctm: op.ctm, role, info, record: hit.record });
          }
          continue;
        }
        // Form XObject: descend.
        op.type = 'form';
      }
      if (op.type !== 'form') { opList.push(op); continue; }
      const hit = resolveName(xobjects, op.name);
      if (!hit || depth >= maxDepth || visited.has(hit.num)) continue;
      const inner = await decodeStream(bytes, text, hit.record);
      const innerOps = parseContent(latin1(inner));
      const matrix = mulMatrix(op.ctm, parseMatrix(hit.record.dict));
      for (const o of innerOps) {
        if (o.ctm) o.ctm = mulMatrix(matrix, o.ctm);
        else o.ctm = matrix.slice();
        if (o.points) o.points = o.points.map(([x, y]) => [matrix[0] * x + matrix[2] * y + matrix[4], matrix[1] * x + matrix[3] * y + matrix[5]]);
        if (o.widths) { /* line width is in form space; the art pass only needs paths */ }
      }
      const innerRes = /\/Resources\s*<<[\s\S]*>>/.exec(hit.record.dict);
      const innerXObj = xobjectMap(innerRes ? innerRes[0] : hit.record.dict, objects);
      const next = new Set(visited); next.add(hit.num);
      await walk(innerOps, innerXObj, depth + 1, next);
    }
  };

  const pageXObjects = doc.xobjects;
  await walk(doc.ops, pageXObjects, 0, seen);
  return { ops: opList, images };
}

// Press rasters arrive at the printer's own addressability (1440 dpi is common),
// so re-sampling them onto a fixed 300 dpi grid threw away most of the paid-for
// detail. Read the embedded raster's density instead: pixels over the physical
// size it is placed at. Vector-only files carry no raster, hence no native
// density: the caller then falls back to the cap, which is free for vectors.
const MAX_PPM = 1440 / 25.4; // press addressability, and the memory safety cap
function detectNativePpm(doc, capPpm = MAX_PPM) {
  const pageArea = (doc.widthMm || 0) * (doc.heightMm || 0);
  let best = 0;
  for (const im of (doc && doc.images) || []) {
    const info = im.info || {};
    const ctm = im.ctm || [];
    if (!info.width || !info.height || ctm.length < 6) continue;
    const wMm = (Math.abs(ctm[0]) + Math.abs(ctm[2])) / PT_PER_MM;
    const hMm = (Math.abs(ctm[1]) + Math.abs(ctm[3])) / PT_PER_MM;
    if (wMm <= 0 || hMm <= 0) continue;
    if (pageArea > 0 && wMm * hMm < pageArea * 0.25) continue; // skip tiny logos
    best = Math.max(best, info.width / wMm, info.height / hMm);
  }
  return best ? Math.min(best, capPpm) : null;
}

// A source white plate is usually drawn flush with (or proud of) the silhouette,
// while the artwork we re-emit is clipped to the cut line - reused as-is, the
// plate visibly overhangs the printed image. Give imported plates the same
// treatment the PNG pipeline gives its own: 0.3 mm erosion plus a 0.15 mm
// opening, so the white always ends up smaller than the artwork.
function chokeWhitePaths(paths, ppm, clipPaths = null, chokeMm = 0.3, openMm = 0.15) {
  if (typeof ClipperLib === 'undefined' || !paths || !paths.length) return paths || [];
  const scale = 1000;
  let subject = paths.map((r) => r.map(([x, y]) => ({ X: Math.round(x * scale), Y: Math.round(y * scale) })));
  // Source plates are sometimes drawn a touch proud of the source's own cut
  // line; the artwork we emit is clipped to that cut, so clip the plate first -
  // otherwise the overhang survives any erosion smaller than the bleed.
  if (clipPaths && clipPaths.length) {
    const clip = clipPaths.map((r) => r.map(([x, y]) => ({ X: Math.round(x * scale), Y: Math.round(y * scale) })));
    const c = new ClipperLib.Clipper();
    c.AddPaths(subject, ClipperLib.PolyType.ptSubject, true);
    c.AddPaths(clip, ClipperLib.PolyType.ptClip, true);
    const inter = new ClipperLib.Paths();
    if (c.Execute(ClipperLib.ClipType.ctIntersection, inter, ClipperLib.PolyFillType.pftEvenOdd, ClipperLib.PolyFillType.pftEvenOdd)) {
      if (inter.length) subject = inter;
    }
  }
  const run = (ps, delta) => {
    const off = new ClipperLib.ClipperOffset(2, 25);
    const out = new ClipperLib.Paths();
    off.AddPaths(ps, ClipperLib.JoinType.jtRound, ClipperLib.EndType.etClosedPolygon);
    off.Execute(out, delta);
    return out.filter((r) => r.length >= 3);
  };
  let result = run(subject, -chokeMm * ppm * scale);
  if (openMm > 0 && result.length) {
    const shrunk = run(result, -openMm * ppm * scale);
    if (shrunk.length) result = run(shrunk, openMm * ppm * scale);
  }
  return result.map((r) => r.map((p) => [p.X / scale, p.Y / scale]));
}

// Pure model extraction (no DOM): pixel-space paths + image placements.
async function extractItemModel(arrayBuffer, options = {}) {
  const doc = await inspect(arrayBuffer);
  const nativePpm = detectNativePpm(doc);
  const asked = options.pixelsPerMm;
  // 'native' asks for the source density; anything else keeps the old fixed grid.
  const ppm = asked === 'native'
    ? nativePpm || MAX_PPM
    : Number(asked) || 12; // 12 px/mm ≈ 305 dpi
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

  // Use the flattened list as-is: it already carries the role tag (art / white /
  // cut) and the object number, both of which a rebuild from `doc.ops` loses.
  const images = doc.images.map((im) => ({
    name: im.name, num: im.num, ctm: im.ctm, role: im.role || 'art', record: im.record, info: im.info, mark: im.mark,
  }));
  // Which spot does this file use for its white plate and its cut line? A nested
  // sheet has to settle on one naming scheme for the whole job, so report both.
  const spots = doc.spots || [];
  const spotNames = spots.map((sp) => sp.name);
  const whitePlate = images.find((im) => im.role === 'white');
  const whiteSpot = whitePlate && whitePlate.info.colorSpace && whitePlate.info.colorSpace.startsWith('[')
    ? (doc.objects && whitePlateSpotName(doc, whitePlate)) : null;

  return {
    doc, ppm, nativePpm, W, H,
    widthMm: doc.widthMm,
    heightMm: doc.heightMm,
    cutPaths, whitePaths: chokeWhitePaths(whitePaths, ppm, cutPaths), images,
    spots: spotNames,
    whiteSpot: whiteSpot || null,
    cutSpot: pickCutSpot(spots),
    userToPx,
    bytes: doc.bytes,
    text: doc.text,
  };
}


function whitePlateSpotName(doc, image) {
  // The image's own colour space array names the spot: [/Separation /spot_0 ...]
  const body = image.record && image.record.dict ? image.record.dict : '';
  const m = /\/ColorSpace\s*\[\s*\/Separation\s*\/([^\s\/<>\[\]()]+)/.exec(body);
  return m ? m[1] : null;
}

/**
 * Pick the name this file uses for its cut line. Print shops are wildly
 * inconsistent here (`CutContour`, `Cut`, `Die`, `Kiss`, `Through-cut`), so match
 * on the usual words rather than an exact string, and fall back to the only spot
 * that is not the white plate.
 */
function pickCutSpot(spots) {
  const names = (spots || []).map((sp) => sp.name);
  const cut = names.find((n) => /cut|die|kiss|through|outline/i.test(n));
  if (cut) return cut;
  const white = names.find((n) => /white|milk|opaque|spot_0/i.test(n));
  const rest = names.filter((n) => n !== white);
  return rest.length === 1 ? rest[0] : null;
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

  // Artwork: paint each image through its own cm matrix. Plates are ordered so
  // the white silhouette lands first and the process artwork covers it; skipping
  // the plates entirely would also be defensible, but drawing the white keeps the
  // piece opaque exactly as it prints.
  const paintOrder = model.images.slice().sort((a, b) => {
    const rank = (r) => (r === 'white' ? 0 : r === 'art' ? 1 : 2);
    return rank(a.role) - rank(b.role);
  });
  for (const im of paintOrder) {
    let bitmap;
    try {
      // Ask for a raster no larger than the item canvas: the plate and the page
      // box share an aspect ratio, so the target box is a safe upper bound.
      const decoded = await imageToPngBlob(model.bytes, model.text, im.record, im.info, {
        objects: model.doc.objects, text: model.text, bytes: model.bytes,
        targetW: W, targetH: H, rawPixels: true,
      });
      if (decoded && decoded.rgba) {
        // Native size: the pixels are already decoded, so a 172 MB stored-PNG
        // blob and its re-decode would be pure overhead. Put them straight into
        // a scratch canvas the placement transform below can draw.
        const scratch = makeCanvas(decoded.width, decoded.height);
        const clamped = new Uint8ClampedArray(decoded.rgba.buffer, decoded.rgba.byteOffset, decoded.rgba.length);
        scratch.getContext('2d').putImageData(new ImageData(clamped, decoded.width, decoded.height), 0, 0);
        bitmap = scratch;
      } else {
        bitmap = await decodeImage(decoded);
      }
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
    // Which spot names this file uses, so a mixed job can be reconciled before the
    // sheet is written with one naming scheme.
    spots: model.spots,
    whiteSpot: model.whiteSpot,
    cutSpot: model.cutSpot,
    pageCount: model.doc.page ? 1 : 0,
    sourcePdf: true,
  };
}

if (typeof module !== 'undefined') {
  module.exports = {
    inspect, extractItemModel, toNestingItem, parseContent, encodePng, PT_PER_MM, imageInfo,
    detectNativePpm, MAX_PPM, chokeWhitePaths,
    // Exposed for the naming tests only.
    __test_pickCutSpot: pickCutSpot,
  };
}
if (typeof window !== 'undefined') {
  window.OutlinePdfImport = { inspect, extractItemModel, toNestingItem, parseContent, encodePng, PT_PER_MM, detectNativePpm, MAX_PPM, chokeWhitePaths };
}
