/* Automatic center-scaffold sizing and selection of scaffold-only fragments. */
((root, factory) => {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.ScaffoldRules = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, () => {
  'use strict';
  function chooseWidth(outlineWidthMm) {
    const w = Number(outlineWidthMm);
    if (!Number.isFinite(w) || w <= 0) throw new Error('아웃라인 폭을 계산할 수 없습니다.');
    let width, tier;
    if (w < 50) { width = w * 0.6; tier = 'W < 50'; }
    else if (w < 100) { width = 30; tier = '50 ≤ W < 100'; }
    else if (w < 150) { width = 50; tier = '100 ≤ W < 150'; }
    else if (w < 200) { width = 70; tier = '150 ≤ W < 200'; }
    else { width = 90; tier = 'W ≥ 200'; }
    if (!(width > 0 && width < w)) throw new Error('스캐폴드 폭이 아웃라인 폭보다 작아야 합니다.');
    return { outlineWidthMm: w, scaffoldWidthMm: width, tier };
  }

  // The outline is NEVER subtracted from the result. Only (rectangle minus
  // outline) is split into 8-connected fragments; any whole fragment touching
  // the upper-third band is discarded, and the rest are unioned with outline.
  function selectFragments(outline, rectangle, w, h, upperEnd) {
    const n = w * h;
    if (!Number.isInteger(w) || !Number.isInteger(h) || w <= 0 || h <= 0 ||
        outline.length !== n || rectangle.length !== n || !Number.isFinite(upperEnd)) {
      throw new Error('스캐폴드 분할 입력이 올바르지 않습니다.');
    }
    const result = outline.slice(), seen = new Uint8Array(n), queue = new Int32Array(n);
    let kept = 0, dropped = 0;
    for (let start = 0; start < n; start++) {
      if (!rectangle[start] || outline[start] || seen[start]) continue;
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
          if (!seen[q] && rectangle[q] && !outline[q]) { seen[q] = 1; queue[tail++] = q; }
        }
      }
      if (touchesUpperThird) dropped++;
      else { kept++; for (let i = 0; i < tail; i++) result[queue[i]] = 1; }
    }
    return { mask: result, kept, dropped };
  }
  return { chooseWidth, selectFragments };
});
