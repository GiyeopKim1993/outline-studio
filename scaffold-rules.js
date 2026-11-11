/* Fixed scaffold shapes and selection of scaffold-only fragments. */
((root, factory) => {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.ScaffoldRules = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, () => {
  'use strict';
  const SQRT3 = Math.sqrt(3);
  const NOMINAL_MM = 50;
  // Shared R1 radius for both scaffold shapes.
  const CORNER_RADIUS_MM = 1;

  // The 50 mm side is measured between the *virtual sharp* vertices. Rounding
  // cuts each 60-degree corner back; it cannot preserve both that side length
  // and a physical outside width of 50 mm for a positive corner radius.
  function roundedTriangleDimensions(side = NOMINAL_MM, radius = CORNER_RADIUS_MM) {
    side = Number(side); radius = Number(radius);
    if (!Number.isFinite(side) || side <= 0 || !Number.isFinite(radius) || radius < 0 || radius > side * SQRT3 / 6) {
      throw new Error('삼각형 변 길이 또는 둥글림 반경이 올바르지 않습니다.');
    }
    const virtualHeight = side * SQRT3 / 2;
    return {
      virtualSideMm: side,
      virtualHeightMm: virtualHeight,
      cornerRadiusMm: radius,
      straightSideMm: side - 2 * SQRT3 * radius,
      roundedWidthMm: side - 2 * radius * (SQRT3 - 1),
      roundedHeightMm: virtualHeight - radius
    };
  }

  // W is the outline bounding width after offset/reinforcement, before merging.
  function chooseWidth(outlineWidthMm) {
    const w = Number(outlineWidthMm);
    if (!Number.isFinite(w) || w <= 0) throw new Error('아웃라인 폭을 계산할 수 없습니다.');
    const isTriangle = w < NOMINAL_MM;
    const triangle = isTriangle ? roundedTriangleDimensions() : null;
    return {
      outlineWidthMm: w,
      shape: isTriangle ? 'triangle' : 'rounded_rectangle',
      tier: isTriangle ? 'W < 50' : 'W ≥ 50',
      nominalDimensionMm: NOMINAL_MM,
      cornerRadiusMm: CORNER_RADIUS_MM,
      // Continuous, before rasterization or the Boolean fragment selection.
      scaffoldWidthMm: triangle ? triangle.roundedWidthMm : NOMINAL_MM,
      triangle
    };
  }

  // A filleted equilateral triangle is the Minkowski sum of its inset triangle
  // (the three arc centres) and a disk of the fillet radius. Pixel centres are
  // tested analytically; the virtual base is at bottom, and the point is up.
  function roundedTriangleMask(w, h, cx, bottom, ppm, sideMm = NOMINAL_MM, radiusMm = CORNER_RADIUS_MM) {
    if (!Number.isInteger(w) || !Number.isInteger(h) || w <= 0 || h <= 0 ||
        !Number.isFinite(cx) || !Number.isFinite(bottom) || !Number.isFinite(ppm) || ppm <= 0) {
      throw new Error('삼각형 마스크 입력이 올바르지 않습니다.');
    }
    roundedTriangleDimensions(sideMm, radiusMm); // validates mm values
    const out = new Uint8Array(w * h);
    const side = sideMm * ppm, r = radiusMm * ppm, half = side / 2;
    const height = side * SQRT3 / 2, top = bottom - height;
    const innerTop = top + 2 * r, innerBottom = bottom - r;
    const innerHeight = innerBottom - innerTop, innerHalf = half - SQRT3 * r;
    const x0 = Math.max(0, Math.floor(cx - half));
    const x1 = Math.min(w - 1, Math.ceil(cx + half));
    const y0 = Math.max(0, Math.floor(top));
    const y1 = Math.min(h - 1, Math.ceil(bottom));
    const r2 = r * r;

    function segmentDistanceSquared(x, y, ax, ay, bx, by) {
      const dx = bx - ax, dy = by - ay, length2 = dx * dx + dy * dy;
      const t = length2 ? Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / length2)) : 0;
      const ox = x - (ax + t * dx), oy = y - (ay + t * dy);
      return ox * ox + oy * oy;
    }
    for (let y = y0; y <= y1; y++) {
      const py = y + .5;
      const fraction = (py - top) / height;
      if (fraction < 0 || fraction > 1) continue;
      const sharpExtent = half * fraction;
      for (let x = x0; x <= x1; x++) {
        const px = x + .5;
        if (Math.abs(px - cx) > sharpExtent) continue;
        let inside = false;
        if (innerHeight > 1e-9) {
          const innerFraction = (py - innerTop) / innerHeight;
          inside = innerFraction >= 0 && innerFraction <= 1 &&
                   Math.abs(px - cx) <= innerHalf * innerFraction;
        }
        if (!inside && r > 0) {
          const left = cx - innerHalf, right = cx + innerHalf;
          inside = segmentDistanceSquared(px, py, cx, innerTop, left, innerBottom) <= r2 ||
                   segmentDistanceSquared(px, py, cx, innerTop, right, innerBottom) <= r2 ||
                   segmentDistanceSquared(px, py, left, innerBottom, right, innerBottom) <= r2;
        }
        if (inside) out[y * w + x] = 1;
      }
    }
    return out;
  }

  // Preserve the product: split only (scaffold minus outline) into 8-connected
  // fragments. Discard a whole fragment if it touches the upper-third band;
  // union the remaining fragments with the unmodified outline.
  function selectFragments(outline, scaffold, w, h, upperEnd) {
    const n = w * h;
    if (!Number.isInteger(w) || !Number.isInteger(h) || w <= 0 || h <= 0 ||
        outline.length !== n || scaffold.length !== n || !Number.isFinite(upperEnd)) {
      throw new Error('스캐폴드 분할 입력이 올바르지 않습니다.');
    }
    const result = outline.slice(), seen = new Uint8Array(n), queue = new Int32Array(n);
    let kept = 0, dropped = 0;
    for (let start = 0; start < n; start++) {
      if (!scaffold[start] || outline[start] || seen[start]) continue;
      let head = 0, tail = 0, touchesUpperThird = false;
      queue[tail++] = start; seen[start] = 1;
      while (head < tail) {
        const p = queue[head++], x = p % w, y = (p - x) / w;
        if (y <= upperEnd) touchesUpperThird = true;
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
          if (!dx && !dy) continue;
          const xx = x + dx, yy = y + dy;
          if (xx < 0 || xx >= w || yy < 0 || yy >= h) continue;
          const q = yy * w + xx;
          if (!seen[q] && scaffold[q] && !outline[q]) { seen[q] = 1; queue[tail++] = q; }
        }
      }
      if (touchesUpperThird) dropped++;
      else { kept++; for (let i = 0; i < tail; i++) result[queue[i]] = 1; }
    }
    return { mask: result, kept, dropped };
  }
  return { chooseWidth, roundedTriangleDimensions, roundedTriangleMask, selectFragments };
});
