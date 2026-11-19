/*
 * Outline Studio PDF writer.
 * The artwork is kept as an RGB image with a soft alpha mask. White and cutline
 * are vector paths in real, independently named PDF Separation color spaces.
 * Everything is generated in the browser; no files are uploaded.
 */
(() => {
  'use strict';
  const encode = (s) => new TextEncoder().encode(s);
  const pdfNumber = (n) => {
    if (!Number.isFinite(n)) throw new Error('PDF 좌표가 올바르지 않습니다.');
    const value = Math.round(n * 1000000) / 1000000;
    return Object.is(value, -0) ? '0' : String(value);
  };
  const pdfName = (value) => {
    const forbidden = new Set([35, 37, 40, 41, 47, 60, 62, 91, 93, 123, 125]);
    return '/' + Array.from(encode(value), (b) => {
      if (b >= 33 && b <= 126 && !forbidden.has(b)) return String.fromCharCode(b);
      return '#' + b.toString(16).toUpperCase().padStart(2, '0');
    }).join('');
  };
  // PDF text strings in UTF-16BE, for the optional-content layer labels.
  const pdfString = (value) => {
    let hex = 'FEFF';
    for (let i = 0; i < value.length; i++) hex += value.charCodeAt(i).toString(16).toUpperCase().padStart(4, '0');
    return '<' + hex + '>';
  };
  function vectorPath(paths) {
    return paths.filter((p) => p.length >= 3).map((path) => {
      const head = `${pdfNumber(path[0][0])} ${pdfNumber(path[0][1])} m`;
      return head + '\n' + path.slice(1).map((p) => `${pdfNumber(p[0])} ${pdfNumber(p[1])} l`).join('\n') + '\nh';
    }).join('\n');
  }
  async function encodeStream(bytes) {
    if (typeof CompressionStream === 'function') {
      try {
        const compressed = new Blob([bytes]).stream().pipeThrough(new CompressionStream('deflate'));
        return { bytes: new Uint8Array(await new Response(compressed).arrayBuffer()), filter: ' /Filter /FlateDecode' };
      } catch (_) { /* A valid uncompressed PDF is a safe offline fallback. */ }
    }
    return { bytes, filter: '' };
  }
  class PDFWriter {
    constructor() { this.objects = []; }
    reserve() { this.objects.push(null); return this.objects.length; }
    set(id, parts) {
      this.objects[id - 1] = (Array.isArray(parts) ? parts : [parts]).map((part) => typeof part === 'string' ? encode(part) : part);
    }
    stream(id, dictionary, data) {
      this.set(id, [`<< ${dictionary} /Length ${data.length} >>\nstream\n`, data, '\nendstream']);
    }
    finish(rootId, infoId) {
      const parts = [], offsets = [0];
      let length = 0;
      const push = (part) => { const b = typeof part === 'string' ? encode(part) : part; parts.push(b); length += b.byteLength; };
      push(new Uint8Array([37,80,68,70,45,49,46,55,10,37,226,227,207,211,10]));
      this.objects.forEach((object, i) => {
        if (!object) throw new Error('PDF 오브젝트가 비어 있습니다.');
        offsets.push(length);
        push(`${i + 1} 0 obj\n`);
        object.forEach(push);
        push('\nendobj\n');
      });
      const startXref = length;
      push(`xref\n0 ${this.objects.length + 1}\n0000000000 65535 f \n`);
      offsets.slice(1).forEach((offset) => push(`${String(offset).padStart(10, '0')} 00000 n \n`));
      push(`trailer\n<< /Size ${this.objects.length + 1} /Root ${rootId} 0 R /Info ${infoId} 0 R >>\nstartxref\n${startXref}\n%%EOF\n`);
      return new Blob(parts, { type: 'application/pdf' });
    }
  }
  async function create({ artwork, width, height, pixelsPerMm, whitePaths, cutPaths, whiteName, cutName }) {
    if (!artwork || !width || !height || !pixelsPerMm) throw new Error('PDF에 필요한 이미지 정보가 없습니다.');
    if (!whitePaths.length) throw new Error('화이트 영역이 없습니다. 작은 조각 제거 기준을 확인해 주세요.');
    if (!cutPaths.length) throw new Error('칼선이 비어 있습니다.');
    const pointScale = 72 / (25.4 * pixelsPerMm);
    const pageWidth = width * pointScale, pageHeight = height * pointScale;
    const pixels = artwork.getContext('2d').getImageData(0, 0, width, height).data;
    const rgb = new Uint8Array(width * height * 3), alpha = new Uint8Array(width * height);
    for (let i = 0, p = 0, q = 0; i < alpha.length; i++, p += 4, q += 3) {
      rgb[q] = pixels[p]; rgb[q + 1] = pixels[p + 1]; rgb[q + 2] = pixels[p + 2]; alpha[i] = pixels[p + 3];
    }
    const [rgbStream, alphaStream] = await Promise.all([encodeStream(rgb), encodeStream(alpha)]);
    const scale = pdfNumber(pointScale), w = pdfNumber(pageWidth), h = pdfNumber(pageHeight);
    const artCmd = `/OC /ArtLayer BDC\nq\n/ArtOverprint gs\n${w} 0 0 ${h} 0 0 cm\n/Artwork Do\nQ\nEMC`;
    // White is painted as a named overprinting spot after the artwork.
    // A normal blend preserves the process plates in separating RIPs.
    // Use an overprint-aware viewer; actual ink order is set in the RIP.
    const whiteCmd = `/OC /WhiteLayer BDC\nq\n/WhiteOverprint gs\n${scale} 0 0 -${scale} 0 ${h} cm\n/WhiteSpot cs\n1 scn\n${vectorPath(whitePaths)}\nf*\nQ\nEMC`;
    const cutCmd = `/OC /CutLayer BDC\nq\n/CutOverprint gs\n${scale} 0 0 -${scale} 0 ${h} cm\n/CutSpot CS\n1 SCN\n${pdfNumber(0.2 * pixelsPerMm)} w\n1 J 1 j\n${vectorPath(cutPaths)}\nS\nQ\nEMC`;
    const contents = await encodeStream(encode(`${artCmd}\n${whiteCmd}\n${cutCmd}\n`));
    const pdf = new PDFWriter();
    const catalog = pdf.reserve(), pages = pdf.reserve(), page = pdf.reserve(), contentId = pdf.reserve();
    const imageId = pdf.reserve(), alphaId = pdf.reserve(), artLayer = pdf.reserve(), whiteLayer = pdf.reserve(), cutLayer = pdf.reserve(), info = pdf.reserve();
    const layerRefs = `${artLayer} 0 R ${whiteLayer} 0 R ${cutLayer} 0 R`;
    pdf.set(catalog, `<< /Type /Catalog /Pages ${pages} 0 R /OCProperties << /OCGs [${layerRefs}] /D << /Name (Outline Studio) /BaseState /ON /ON [${layerRefs}] /Order [${layerRefs}] >> >> >>`);
    pdf.set(pages, `<< /Type /Pages /Kids [${page} 0 R] /Count 1 >>`);
    const colorSpaces = `/WhiteSpot [/Separation ${pdfName(whiteName)} /DeviceCMYK << /FunctionType 2 /Domain [0 1] /C0 [0 0 0 0] /C1 [0 0 0 0] /N 1 >>] /CutSpot [/Separation ${pdfName(cutName)} /DeviceCMYK << /FunctionType 2 /Domain [0 1] /C0 [0 0 0 0] /C1 [0 1 0 0] /N 1 >>]`;
    const states = `/ArtOverprint << /Type /ExtGState /OP true /op true /OPM 1 >> /WhiteOverprint << /Type /ExtGState /OP true /op true /OPM 1 >> /CutOverprint << /Type /ExtGState /OP true /op true /OPM 1 >>`;
    const resources = `<< /XObject << /Artwork ${imageId} 0 R >> /ColorSpace << ${colorSpaces} >> /ExtGState << ${states} >> /Properties << /ArtLayer ${artLayer} 0 R /WhiteLayer ${whiteLayer} 0 R /CutLayer ${cutLayer} 0 R >> >>`;
    pdf.set(page, `<< /Type /Page /Parent ${pages} 0 R /MediaBox [0 0 ${w} ${h}] /Resources ${resources} /Contents ${contentId} 0 R >>`);
    pdf.stream(contentId, contents.filter, contents.bytes);
    pdf.stream(imageId, `/Type /XObject /Subtype /Image /Width ${width} /Height ${height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /SMask ${alphaId} 0 R${rgbStream.filter}`, rgbStream.bytes);
    pdf.stream(alphaId, `/Type /XObject /Subtype /Image /Width ${width} /Height ${height} /ColorSpace /DeviceGray /BitsPerComponent 8${alphaStream.filter}`, alphaStream.bytes);
    const layer = (name) => `<< /Type /OCG /Name ${pdfString(name)} /Usage << /View << /ViewState /ON >> /Print << /PrintState /ON >> >> >>`;
    pdf.set(artLayer, layer('Artwork'));
    pdf.set(whiteLayer, layer(`White spot: ${whiteName}`));
    pdf.set(cutLayer, layer(`Cutline spot: ${cutName}`));
    pdf.set(info, `<< /Producer (Outline Studio) /Creator (Outline Studio) >>`);
    return pdf.finish(catalog, info);
  }
  // Nesting sheet: one 400x300mm page with many placed items plus slit bases.
  // items: [{artwork,width,height,pixelsPerMm,whitePaths,cutPaths,xMm,yMm,widthMm,heightMm,rot}]
  //   whitePaths/cutPaths are pixel-space loops of the *unrotated* artwork;
  //   rot is the 0/90/180/270 orientation chosen by the packer.
  // bases: [{xMm,yMm,outer,slit}] outer/slit are mm-space point arrays.
  // Packing origin is top-left (y down); PDF origin is bottom-left (y up).
  // The item matrix maps artwork pixels -> sheet mm and mirrors placementMatrix()
  // in nesting.js so the sheet matches the on-screen preview exactly.
  async function createSheet({ sheetWidthMm = 400, sheetHeightMm = 300, items, bases = [], whiteName, cutName }) {
    if (!Array.isArray(items) || !items.length) throw new Error('네스팅 시트에 배치할 이미지가 없습니다.');
    if (!whiteName || !cutName) throw new Error('화이트·칼선 스팟 이름이 없습니다.');
    const ptPerMm = 72 / 25.4;
    const pageW = sheetWidthMm * ptPerMm, pageH = sheetHeightMm * ptPerMm;
    const prepared = [];
    for (const it of items) {
      if (!it.artwork || !it.width || !it.height || !it.pixelsPerMm) throw new Error('PDF에 필요한 이미지 정보가 없습니다.');
      if (!it.whitePaths || !it.whitePaths.length) throw new Error('화이트 영역이 없습니다. 작은 조각 제거 기준을 확인해 주세요.');
      if (!it.cutPaths || !it.cutPaths.length) throw new Error('칼선이 비어 있습니다.');
      const pixels = it.artwork.getContext('2d').getImageData(0, 0, it.width, it.height).data;
      const rgb = new Uint8Array(it.width * it.height * 3), alpha = new Uint8Array(it.width * it.height);
      for (let i = 0, p = 0, q = 0; i < alpha.length; i++, p += 4, q += 3) {
        rgb[q] = pixels[p]; rgb[q + 1] = pixels[p + 1]; rgb[q + 2] = pixels[p + 2]; alpha[i] = pixels[p + 3];
      }
      const [rgbStream, alphaStream] = await Promise.all([encodeStream(rgb), encodeStream(alpha)]);
      prepared.push({ ...it, rgbStream, alphaStream });
    }
    // Sheet-mm -> PDF-point matrix (y flip) for a placement, incl. its rotation.
    function placementMatrixPt(it) {
      const rot = ((Number(it.rot) || 0) % 360 + 360) % 360;
      const ppm = it.pixelsPerMm;
      const bw = it.widthMm, bh = it.heightMm;
      // artwork px -> sheet mm (y down), identical to nesting.js placementMatrix()
      let m;
      switch (rot) {
        case 90: m = [0, 1 / ppm, -1 / ppm, 0, it.xMm + bw, it.yMm]; break;
        case 180: m = [-1 / ppm, 0, 0, -1 / ppm, it.xMm + bw, it.yMm + bh]; break;
        case 270: m = [0, -1 / ppm, 1 / ppm, 0, it.xMm, it.yMm + bh]; break;
        default: m = [1 / ppm, 0, 0, 1 / ppm, it.xMm, it.yMm];
      }
      // sheet mm (y down) -> PDF pt (y up)
      const flip = [ptPerMm, 0, 0, -ptPerMm, 0, sheetHeightMm * ptPerMm];
      const mul = (a, b) => [
        a[0] * b[0] + a[2] * b[1], a[1] * b[0] + a[3] * b[1],
        a[0] * b[2] + a[2] * b[3], a[1] * b[2] + a[3] * b[3],
        a[0] * b[4] + a[2] * b[5] + a[4], a[1] * b[4] + a[3] * b[5] + a[5],
      ];
      const out = mul(flip, m);
      return out.map((v) => pdfNumber(v)).join(' ');
    }
    const cmds = [];
    prepared.forEach((it, i) => {
      const xPt = it.xMm * ptPerMm;
      const yTopPt = (sheetHeightMm - it.yMm) * ptPerMm;
      const s = ptPerMm / it.pixelsPerMm;
      const mat = placementMatrixPt(it);
      // Artwork is clipped to the cut outline. Without this, art that spills past
      // the cut (a halo drawn outside the MediaBox, bleed left in the source PDF)
      // would print outside the item and overlap its neighbours on the sheet.
      cmds.push(`/OC /ArtLayer BDC\nq\n/ArtOverprint gs\n${mat} cm\n${vectorPath(it.cutPaths)}\nW* n\n/Artwork${i} Do\nQ\nEMC`);
      cmds.push(`/OC /WhiteLayer BDC\nq\n/WhiteOverprint gs\n${mat} cm\n/WhiteSpot cs\n1 scn\n${vectorPath(it.whitePaths)}\nf*\nQ\nEMC`);
      cmds.push(`/OC /CutLayer BDC\nq\n/CutOverprint gs\n${mat} cm\n/CutSpot CS\n1 SCN\n${pdfNumber(0.2 * it.pixelsPerMm)} w\n1 J 1 j\n${vectorPath(it.cutPaths)}\nS\nQ\nEMC`);
    });
    for (const b of bases) {
      const xPt = b.xMm * ptPerMm;
      const yTopPt = (sheetHeightMm - b.yMm) * ptPerMm;
      cmds.push(`/OC /CutLayer BDC\nq\n/CutOverprint gs\n${pdfNumber(ptPerMm)} 0 0 ${pdfNumber(-ptPerMm)} ${pdfNumber(xPt)} ${pdfNumber(yTopPt)} cm\n/CutSpot CS\n1 SCN\n${pdfNumber(0.2)} w\n1 J 1 j\n${vectorPath([b.outer, b.slit])}\nS\nQ\nEMC`);
    }
    const contents = await encodeStream(encode(cmds.join('\n') + '\n'));
    const pdf = new PDFWriter();
    const catalog = pdf.reserve(), pages = pdf.reserve(), page = pdf.reserve(), contentId = pdf.reserve();
    const artLayer = pdf.reserve(), whiteLayer = pdf.reserve(), cutLayer = pdf.reserve(), info = pdf.reserve();
    const imageIds = prepared.map(() => ({ img: pdf.reserve(), alpha: pdf.reserve() }));
    const layerRefs = `${artLayer} 0 R ${whiteLayer} 0 R ${cutLayer} 0 R`;
    pdf.set(catalog, `<< /Type /Catalog /Pages ${pages} 0 R /OCProperties << /OCGs [${layerRefs}] /D << /Name (Outline Studio Nesting) /BaseState /ON /ON [${layerRefs}] /Order [${layerRefs}] >> >> >>`);
    pdf.set(pages, `<< /Type /Pages /Kids [${page} 0 R] /Count 1 >>`);
    const colorSpaces = `/WhiteSpot [/Separation ${pdfName(whiteName)} /DeviceCMYK << /FunctionType 2 /Domain [0 1] /C0 [0 0 0 0] /C1 [0 0 0 0] /N 1 >>] /CutSpot [/Separation ${pdfName(cutName)} /DeviceCMYK << /FunctionType 2 /Domain [0 1] /C0 [0 0 0 0] /C1 [0 1 0 0] /N 1 >>]`;
    const states = `/ArtOverprint << /Type /ExtGState /OP true /op true /OPM 1 >> /WhiteOverprint << /Type /ExtGState /OP true /op true /OPM 1 >> /CutOverprint << /Type /ExtGState /OP true /op true /OPM 1 >>`;
    const xobjects = prepared.map((_, i) => `/Artwork${i} ${imageIds[i].img} 0 R`).join(' ');
    const resources = `<< /XObject << ${xobjects} >> /ColorSpace << ${colorSpaces} >> /ExtGState << ${states} >> /Properties << /ArtLayer ${artLayer} 0 R /WhiteLayer ${whiteLayer} 0 R /CutLayer ${cutLayer} 0 R >> >>`;
    pdf.set(page, `<< /Type /Page /Parent ${pages} 0 R /MediaBox [0 0 ${pdfNumber(pageW)} ${pdfNumber(pageH)}] /Resources ${resources} /Contents ${contentId} 0 R >>`);
    pdf.stream(contentId, contents.filter, contents.bytes);
    prepared.forEach((it, i) => {
      pdf.stream(imageIds[i].img, `/Type /XObject /Subtype /Image /Width ${it.width} /Height ${it.height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /SMask ${imageIds[i].alpha} 0 R${it.rgbStream.filter}`, it.rgbStream.bytes);
      pdf.stream(imageIds[i].alpha, `/Type /XObject /Subtype /Image /Width ${it.width} /Height ${it.height} /ColorSpace /DeviceGray /BitsPerComponent 8${it.alphaStream.filter}`, it.alphaStream.bytes);
    });
    const layer = (name) => `<< /Type /OCG /Name ${pdfString(name)} /Usage << /View << /ViewState /ON >> /Print << /PrintState /ON >> >> >>`;
    pdf.set(artLayer, layer('Artwork'));
    pdf.set(whiteLayer, layer(`White spot: ${whiteName}`));
    pdf.set(cutLayer, layer(`Cutline spot: ${cutName}`));
    pdf.set(info, `<< /Producer (Outline Studio) /Creator (Outline Studio Nesting) >>`);
    return pdf.finish(catalog, info);
  }
  window.OutlinePDF = { create, createSheet };
})();
