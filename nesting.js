'use strict';

/*
 * Outline-based row nesting engine (Illupdf `row_packing` semantics, browser port).
 *
 * Sheet : 400 x 300 mm landscape, artwork origin top-left, x right, y down.
 * Row 1 : starts at (1, 1), runs right until x = 399, then the next row starts.
 * Row N : starts at x = 1, y = previous row bottom + 0.25 mm, until y = 299.
 *
 * Every item is normalised so its long side is vertical (portrait), then 180°
 * flipped; the engine searches item order and orientation and keeps the row that
 * holds the most items with the earliest end coordinate.
 *
 * Spacing is guaranteed on the real cut outline, not the bounding box: each
 * outline is inflated by SAFETY_HALF_MM (0.125) so two neighbours can never be
 * closer than 0.25 mm, while still being allowed to interlock.
 *
 * Leftover space is filled with 35 x 35 mm slit bases.
 */

const SHEET = Object.freeze({ widthMm: 400, heightMm: 300 });
const MARGIN_MM = 1;              // 1열은 (1,1)에서 시작해 x=399에서 끝난다
const CLEARANCE_MM = 0.25;        // 아이템 외곽선 사이 최소 간격
const BASE_SIZE_MM = 35;
const STEP_MM = 0.5;              // 베이스 충전 Y 스텝
const COARSE_STEP_MM = 1;         // 페어 오프셋 1차 탐색 스텝
const SAFETY_HALF_MM = 0.125;     // 외곽선 인플레이트 → 최소 0.25mm 간격 보장
const DEFAULT_BEAM_WIDTH = 3;
const DEFAULT_CANDIDATE_LIMIT = 16;
const MAX_PAIR_PROBE_MM = 60;     // 밀착 탐색 시작점 (긴 쪽 폭 기준)
const EPS = 1e-9;

// ---------------------------------------------------------------- Clipper
let clipperLib = null;
function getClipper() {
  if (clipperLib) return clipperLib;
  const roots = [];
  try { if (typeof ClipperLib !== 'undefined' && ClipperLib) roots.push(ClipperLib); } catch (_) {}
  try { if (typeof window !== 'undefined' && window.ClipperLib) roots.push(window.ClipperLib); } catch (_) {}
  try { if (typeof globalThis !== 'undefined' && globalThis.ClipperLib) roots.push(globalThis.ClipperLib); } catch (_) {}
  // ClipperLib only publishes itself to `window` when a DOM exists; exposeClipper()
  // lets a host inject the module it loaded without a document.
  try { if (typeof window !== 'undefined' && window.__clipperModule) roots.push(window.__clipperModule); } catch (_) {}
  for (const candidate of roots) {
    if (candidate && typeof candidate.ClipperOffset === 'function' && candidate.Paths) {
      clipperLib = candidate;
      return clipperLib;
    }
  }
  try {
    if (typeof require === 'function') {
      const mod = require('./vendor/clipper.js');
      if (mod && mod.ClipperOffset) { clipperLib = mod; return clipperLib; }
    }
  } catch (_) { /* no bundler */ }
  // Never return a half-working object: no offset is better than a silent no-op.
  return null;
}

// Host hook: inject the loaded ClipperLib module explicitly.
function exposeClipper(moduleRef) {
  if (moduleRef && moduleRef.ClipperOffset && moduleRef.Paths) {
    clipperLib = moduleRef;
    return true;
  }
  return false;
}


function inflatePolygon(points, deltaMm) {
  const C = getClipper();
  if (!C || !deltaMm || !Array.isArray(points) || points.length < 3) return points;
  const scale = 1000;
  try {
    // ClipperLib.Paths() is a bare prototype object, so paths must be pushed.
    const subject = new C.Paths();
    subject.push(points.map((p) => ({ X: Math.round(p[0] * scale), Y: Math.round(p[1] * scale) })));
    const co = new C.ClipperOffset(2, 0.25);
    co.AddPaths(subject, C.JoinType.jtRound, C.EndType.etClosedPolygon);
    const out = new C.Paths();
    co.Execute(out, deltaMm * scale);
    if (!out.length) return points;
    let best = null, bestArea = -1;
    for (const path of out) {
      const area = Math.abs(C.Clipper.Area(path));
      if (area > bestArea) { bestArea = area; best = path; }
    }
    if (!best) return points;
    return best.map((p) => [p.X / scale, p.Y / scale]);
  } catch (_) { return points; }
}

// ---------------------------------------------------------------- geometry
function polygonArea(points) {
  let a = 0;
  for (let i = 0, n = points.length; i < n; i++) {
    const [x0, y0] = points[i], [x1, y1] = points[(i + 1) % n];
    a += x0 * y1 - x1 * y0;
  }
  return a / 2;
}

function bounds(points) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const [x, y] of points) {
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
  }
  return { minX, minY, maxX, maxY };
}

// Rotate by rot degrees in a y-down space (positive = clockwise on screen).
function rotatePoint(x, y, rot, cx = 0, cy = 0) {
  const a = (rot * Math.PI) / 180, cos = Math.cos(a), sin = Math.sin(a);
  const dx = x - cx, dy = y - cy;
  return [cx + dx * cos - dy * sin, cy + dx * sin + dy * cos];
}

function rotatePolygon(points, rot) {
  if (!rot) return points.map((p) => [p[0], p[1]]);
  return points.map(([x, y]) => rotatePoint(x, y, rot));
}

// Translate so the polygon starts at (0,0); returns normalised points + size.
function normalizePolygon(points) {
  const b = bounds(points);
  const dx = -b.minX, dy = -b.minY;
  return {
    points: points.map(([x, y]) => [x + dx, y + dy]),
    widthMm: b.maxX - b.minX,
    heightMm: b.maxY - b.minY,
  };
}

function orient(a, b, c) {
  return (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
}

function onSegment(a, b, p) {
  return Math.abs(orient(a, b, p)) < 1e-9 &&
    p[0] >= Math.min(a[0], b[0]) - 1e-9 && p[0] <= Math.max(a[0], b[0]) + 1e-9 &&
    p[1] >= Math.min(a[1], b[1]) - 1e-9 && p[1] <= Math.max(a[1], b[1]) + 1e-9;
}

// Segment intersection including touching and collinear overlap, so degenerate
// (zero-width) rectangles still count as colliding.
function segmentIntersect(p1, p2, p3, p4) {
  const d1 = orient(p3, p4, p1), d2 = orient(p3, p4, p2);
  const d3 = orient(p1, p2, p3), d4 = orient(p1, p2, p4);
  if (((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))) return true;
  return onSegment(p3, p4, p1) || onSegment(p3, p4, p2) || onSegment(p1, p2, p3) || onSegment(p1, p2, p4);
}

function pointInPolygon(pt, poly) {
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    if (onSegment(poly[j], poly[i], pt)) return true;
  }
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    if ((yi > pt[1]) !== (yj > pt[1]) && pt[0] < ((xj - xi) * (pt[1] - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

// Do two normalised polygons overlap when the right one is shifted by dx?
function polygonPairOverlap(A, B, dx) {
  // Bounding-box rejection first: at most offsets a neighbouring shape only
  // overlaps along a narrow band, so this skips almost every segment pair.
  let aMinX = Infinity, aMaxX = -Infinity, aMinY = Infinity, aMaxY = -Infinity;
  for (const [x, y] of A) {
    if (x < aMinX) aMinX = x; if (x > aMaxX) aMaxX = x;
    if (y < aMinY) aMinY = y; if (y > aMaxY) aMaxY = y;
  }
  let bMinX = Infinity, bMaxX = -Infinity, bMinY = Infinity, bMaxY = -Infinity;
  for (const [x, y] of B) {
    if (x < bMinX) bMinX = x; if (x > bMaxX) bMaxX = x;
    if (y < bMinY) bMinY = y; if (y > bMaxY) bMaxY = y;
  }
  if (aMaxX <= bMinX + dx || bMaxX + dx <= aMinX) return false;
  if (aMaxY <= bMinY || bMaxY <= aMinY) return false;

  // Bucket B's segments into vertical slabs so each A segment only tests the
  // slab ranges it can actually reach. Slab size is tied to the shape, so the
  // bucketing cost stays proportional to the outline.
  const spanX = Math.max(aMaxX, bMaxX + dx) - Math.min(aMinX, bMinX + dx);
  const slabCount = Math.max(4, Math.min(64, Math.ceil(spanX / 2)));
  const slabW = (spanX || 1) / slabCount;
  const originX = Math.min(aMinX, bMinX + dx);
  const slabs = new Array(slabCount);
  for (let j = 0; j < B.length; j++) {
    const b1 = B[j], b2 = B[(j + 1) % B.length];
    const x1 = b1[0] + dx, x2 = b2[0] + dx;
    let lo = Math.floor((Math.min(x1, x2) - originX) / slabW);
    let hi = Math.floor((Math.max(x1, x2) - originX) / slabW);
    if (lo < 0) lo = 0; if (hi >= slabCount) hi = slabCount - 1;
    for (let sIdx = lo; sIdx <= hi; sIdx++) (slabs[sIdx] || (slabs[sIdx] = [])).push(j);
  }

  const bYMin = B.map(([x, y]) => y);
  const bXMin = B.map(([x]) => x);
  for (let i = 0; i < A.length; i++) {
    const a1 = A[i], a2 = A[(i + 1) % A.length];
    let lo = Math.floor((Math.min(a1[0], a2[0]) - originX) / slabW);
    let hi = Math.floor((Math.max(a1[0], a2[0]) - originX) / slabW);
    if (lo < 0) lo = 0; if (hi >= slabCount) hi = slabCount - 1;
    const aYLo = Math.min(a1[1], a2[1]), aYHi = Math.max(a1[1], a2[1]);
    for (let sIdx = lo; sIdx <= hi; sIdx++) {
      const bucket = slabs[sIdx];
      if (!bucket) continue;
      for (let k = 0; k < bucket.length; k++) {
        const j = bucket[k];
        if (bXMin[j] === undefined) { bXMin[j] = B[j][0]; bYMin[j] = B[j][1]; }
        const b1 = B[j], b2 = B[(j + 1) % B.length];
        // Cheap y rejection before the segment test.
        if (Math.max(b1[1], b2[1]) <= aYLo || Math.min(b1[1], b2[1]) >= aYHi) {
          // Still could be equal-height; fall through only on strict separation.
          if (Math.max(b1[1], b2[1]) <= aYLo || Math.min(b1[1], b2[1]) >= aYHi) continue;
        }
        if (segmentIntersect(a1, a2, [b1[0] + dx, b1[1]], [b2[0] + dx, b2[1]])) return true;
      }
    }
  }
  if (pointInPolygon([B[0][0] + dx, B[0][1]], A)) return true;
  if (pointInPolygon([A[0][0] - dx, A[0][1]], B)) return true;
  return false;
}

// Do two normalised shapes overlap when the right one is shifted by dx?
// A shape is every piece the cutter will follow, so a detached halo or a loose
// prop blocks a neighbour exactly like the body does.
function polygonsOverlap(left, right, dx) {
  const lx = left.bounds, rx = right.bounds;
  if (lx.maxX + dx <= rx.minX + EPS || rx.maxX + dx <= lx.minX + EPS) return false;
  if (lx.maxY <= rx.minY + EPS || rx.maxY <= lx.minY + EPS) return false;
  const leftPieces = left.pieces || [left.points];
  const rightPieces = right.pieces || [right.points];
  for (const A of leftPieces) {
    for (const B of rightPieces) {
      if (polygonPairOverlap(A, B, dx)) return true;
    }
  }
  return false;
}

// ---------------------------------------------------------------- simplify
// Collision tests run per pair and per offset step, so outlines are reduced to a
// small set of points that stays within SIMPLIFY_TOL_MM of the real cutline.
const SIMPLIFY_TOL_MM = 0.03;
// Outlines from a 300dpi artwork carry thousands of points. Index-sampling them
// down used to drop detail and UNDERSTATE the shape, so two items could be packed
// closer than their real cut lines allow. Never sample: raise the simplification
// tolerance instead, which only removes points that are already near-collinear.
// Douglas-Peucker at a few tenths of a millimetre keeps the measured size
// bit-for-bit while cutting 3000 points down to ~200, which is what the pair
// search actually needs. Index sampling was the mistake: it discarded real
// geometry and made the item look smaller than its cut line.
const MAX_OUTLINE_POINTS = 96;

function douglasPeucker(points, tol) {
  if (points.length <= 4) return points.slice();
  const keep = new Array(points.length).fill(false);
  keep[0] = keep[points.length - 1] = true;
  const stack = [[0, points.length - 1]];
  const distToSegment = (p, a, b) => {
    const dx = b[0] - a[0], dy = b[1] - a[1];
    const len2 = dx * dx + dy * dy;
    if (len2 < 1e-12) return Math.hypot(p[0] - a[0], p[1] - a[1]);
    let t = ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2;
    t = Math.max(0, Math.min(1, t));
    return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy));
  };
  while (stack.length) {
    const [start, end] = stack.pop();
    let maxDist = -1, index = -1;
    for (let i = start + 1; i < end; i++) {
      const d = distToSegment(points[i], points[start], points[end]);
      if (d > maxDist) { maxDist = d; index = i; }
    }
    if (maxDist > tol && index > 0) {
      keep[index] = true;
      stack.push([start, index], [index, end]);
    }
  }
  return points.filter((_, i) => keep[i]);
}

function simplifyPolygon(points) {
  if (!Array.isArray(points)) return { points: [], tol: 0 };
  if (points.length <= MAX_OUTLINE_POINTS) return { points: points.slice(), tol: 0 };
  let tol = SIMPLIFY_TOL_MM;
  let simplified = douglasPeucker(points, tol);
  for (let attempt = 0; attempt < 16 && simplified.length > MAX_OUTLINE_POINTS; attempt++) {
    // Grow the tolerance until it fits. Unlike index sampling this never cuts a
    // corner off: it only drops vertices that are within `tol` of the segment
    // that replaces them, so the shape stays as large as the real cut line.
    tol *= 1.5;
    simplified = douglasPeucker(points, tol);
  }
  // The caller needs the tolerance that actually survived, otherwise the safety
  // offset cannot be sized to cover the incurred error.
  return { points: simplified, tol };
}

function shapeKey(variant) {
  const p = variant.points;
  let h = 2166136261;
  for (let i = 0; i < p.length; i++) {
    h = (h ^ Math.round(p[i][0] * 100)) * 16777619 >>> 0;
    h = (h ^ Math.round(p[i][1] * 100)) * 16777619 >>> 0;
  }
  return `${variant.rot}:${p.length}:${h}`;
}

// ---------------------------------------------------------------- items
// Every cut loop of the item, as one non-overlapping region.
//
// A character standee is usually several loops: the body plus a detached halo,
// a floating prop or a loose strand. Taking only the largest loop made the
// packer believe the item was smaller than it is, so rows were too short and
// bases landed on the part it could not see. Unioning the loops keeps the true
// footprint while still letting a real hole stay a hole.
function cutOutlineOf(item) {
  const loops = Array.isArray(item.cutPaths) ? item.cutPaths.filter((p) => Array.isArray(p) && p.length >= 3) : [];
  if (!loops.length) return null;

  const C = getClipper();
  if (C) {
    try {
      const scale = 1000;
      const subject = new C.Paths();
      for (const loop of loops) {
        subject.push(loop.map(([x, y]) => ({ X: Math.round(x * scale), Y: Math.round(y * scale) })));
      }
      // Even-odd fill: loops inside another loop are genuine holes, kept as holes.
      const tree = C.Clipper.SimplifyPolygons(subject, C.PolyFillType.pftEvenOdd);
      const unioned = C.Clipper.Union(tree, C.PolyFillType.pftEvenOdd);
      if (unioned && unioned.length) {
        // The dominant loop defines the outline used for collision, but every
        // loop still contributes to the bounding size below.
        let best = null, bestArea = -1;
        for (const path of unioned) {
          const area = Math.abs(C.Clipper.Area(path));
          if (area > bestArea) { bestArea = area; best = path; }
        }
        if (best) {
          const outer = best.map((p) => [p.X / scale, p.Y / scale]);
          // Keep the full region too, so the true footprint is never underestimated.
          outer.fullRegion = unioned.map((path) => path.map((p) => [p.X / scale, p.Y / scale]));
          return outer;
        }
      }
    } catch (_) { /* fall through to the plain union below */ }
  }
  // No Clipper (or it failed): fall back to the largest loop, never smaller than
  // any single loop, and remember the rest so the size stays honest.
  let best = loops[0], bestArea = Math.abs(polygonArea(loops[0]));
  for (const loop of loops.slice(1)) {
    const area = Math.abs(polygonArea(loop));
    if (area > bestArea) { best = loop; bestArea = area; }
  }
  const copy = best.map(([x, y]) => [x, y]);
  copy.fullRegion = loops.map((loop) => loop.map(([x, y]) => [x, y]));
  return copy;
}

function ppmOf(item) {
  const ppm = Number(item.pixelsPerMm);
  return ppm > 0 ? ppm : 1;
}

// Portrait-normalise then 180°: the long side becomes the height.
function orientationRots(sourceWidthMm, sourceHeightMm) {
  const base = sourceHeightMm + EPS >= sourceWidthMm ? 0 : 90;
  return [base, (base + 180) % 360];
}

function buildVariants(item, index, opts) {
  const ppm = ppmOf(item);
  const srcW = item.widthMm > 0 ? item.widthMm : (item.width || 0) / ppm;
  const srcH = item.heightMm > 0 ? item.heightMm : (item.height || 0) / ppm;
  if (!(srcW > 0) || !(srcH > 0)) throw new Error(`아이템 크기가 올바르지 않습니다: ${item.name || index}`);

  const outline = cutOutlineOf(item);
  // Every separate piece the cutter will follow. Collision and size must both be
  // derived from this full set, otherwise detached parts are invisible to packing.
  const pieces = outline
    ? (outline.fullRegion && outline.fullRegion.length ? outline.fullRegion : [outline])
        .map((loop) => loop.map(([x, y]) => [x / ppm, y / ppm]))
    : [[[0, 0], [srcW, 0], [srcW, srcH], [0, srcH]]];

  const rots = orientationRots(srcW, srcH).slice();
  if (opts.allowLandscape !== false) rots.push((rots[0] + 90) % 360, (rots[1] + 90) % 360);

  const simplifiedResults = pieces.map((loop) => simplifyPolygon(loop));
  const simplified = simplifiedResults.map((r) => r.points);
  const simplifyTol = simplifiedResults.reduce((a, r) => Math.max(a, r.tol), 0);
  const allRaw = simplified.flat();
  const minX = Math.min(...allRaw.map((p) => p[0]));
  const minY = Math.min(...allRaw.map((p) => p[1]));
  const variants = [];
  for (const rot of rots) {
    const rotated = simplified.map((loop) => rotatePolygon(loop, rot));
    // Normalise all pieces by the SAME offset so their relative positions survive.
    const allPoints = rotated.flat();
    const norm = normalizePolygon(allPoints);
    const shift = [-bounds(allPoints).minX, -bounds(allPoints).minY];
    const normPieces = rotated.map((loop) => loop.map(([x, y]) => [x + shift[0], y + shift[1]]));
    // Do NOT re-normalise the inflated outline: its -0.125 offset is what
    // guarantees the 0.25 mm gap between two neighbouring items.
    // Inflate every piece so the 0.25 mm gap applies around the whole item.
    // ClipperLib's positive delta is outward for a positively-oriented loop, so
    // +SAFETY_HALF_MM grows the outline by 0.125mm on every side. Verified: a
    // 46.15mm shape becomes 46.40mm, giving the two neighbours a 0.25mm gap.
    // The safety offset has to cover the simplification error as well: the shapes
    // the collision test sees are the simplified ones, and a chord that cuts a
    // corner inward shrinks them by up to SIMPLIFY_TOL_MM. Without this the real
    // gap between printed outlines can drop below the promised clearance.
    const inflatedPieces = normPieces.map((loop) => inflatePolygon(loop, SAFETY_HALF_MM + simplifyTol));
    const inflated = inflatedPieces.reduce((a, b) => (Math.abs(polygonArea(b)) > Math.abs(polygonArea(a)) ? b : a), inflatedPieces[0]);
    // The size covers every piece, so row height and the base filler can never
    // end up inside artwork the packer did not account for.
    const pieceBounds = normPieces.map((loop) => bounds(loop));
    const widthMm = Math.max(...pieceBounds.map((b) => b.maxX)) - Math.min(...pieceBounds.map((b) => b.minX));
    const heightMm = Math.max(...pieceBounds.map((b) => b.maxY)) - Math.min(...pieceBounds.map((b) => b.minY));
    variants.push({
      rot,
      widthMm,
      heightMm,
      // Pixel-space shift that moves the raw outline onto the normalised frame.
      outlineShift: [-minX * ppm, -minY * ppm],
      points: norm.points,
      pieces: normPieces,
      inflated,
      safe: {
        points: inflated,
        pieces: inflatedPieces,
        bounds: {
          minX: Math.min(...inflatedPieces.map((p) => bounds(p).minX)),
          minY: Math.min(...inflatedPieces.map((p) => bounds(p).minY)),
          maxX: Math.max(...inflatedPieces.map((p) => bounds(p).maxX)),
          maxY: Math.max(...inflatedPieces.map((p) => bounds(p).maxY)),
        },
      },
    });
  }
  return { item, index, srcW, srcH, ppm, variants };
}

// matrix (px -> sheet mm) for a placement, matching SVG matrix(a b c d e f)
function placementMatrix(placement) {
  const { rot, pixelsPerMm: ppm, width, height, xMm, yMm, widthMm: bw, heightMm: bh } = placement;
  const s = 1 / ppm;
  const W = width, H = height;
  switch (rot % 360) {
    case 0: return [s, 0, 0, s, xMm, yMm];
    case 90: return [0, s, -s, 0, xMm + bw, yMm];
    case 180: return [-s, 0, 0, -s, xMm + bw, yMm + bh];
    case 270: return [0, -s, s, 0, xMm, yMm + bh];
    default: return [s, 0, 0, s, xMm, yMm];
  }
}

// ---------------------------------------------------------------- row search
function minOffset(left, right, cache) {
  const key = `${shapeKey(left)}|${shapeKey(right)}`;
  if (cache.has(key)) return cache.get(key);
  const lw = left.widthMm, rw = right.widthMm;
  const test = (dx) => polygonsOverlap(left.safe, right.safe, dx);

  // Nothing is blocked past lw + rw (the shapes are fully apart by construction).
  const ceiling = lw + rw;
  // The search must start at 0. Bounding-box separation is NOT a valid lower
  // bound: two curved outlines interlock long before their boxes part, so
  // starting at lmax - rmin silently turns the packer into a box packer.
  if (!test(0)) { cache.set(key, 0); return 0; }

  // Monotone predicate (blocked for small dx, free after), so read the shape of
  // the blocking band with a coarse index scan first and bisect inside the one
  // interval that contains the answer. The scan step shrinks automatically when
  // the band turns out to be narrow, so nothing is skipped.
  const coarse = COARSE_STEP_MM;
  let step = coarse;
  let scan = [];
  for (;;) {
    scan = [];
    for (let dx = 0; dx <= ceiling + EPS; dx += step) scan.push({ dx: Math.min(dx, ceiling), blocked: test(Math.min(dx, ceiling)) });
    const lastBlocked = scan.filter((p) => p.blocked).pop();
    if (!lastBlocked || lastBlocked.dx < ceiling) break;
    // Everything is blocked up to the ceiling: refine only if the step can shrink.
    if (step <= 0.25) { cache.set(key, null); return null; }
    step /= 2;
    if (step < 0.5) step = 0.5;
  }
  const lastBlocked = scan.filter((p) => p.blocked).pop();
  if (!lastBlocked) { cache.set(key, 0); return 0; }
  const firstFree = scan.find((p) => !p.blocked && p.dx > lastBlocked.dx);
  let a = lastBlocked.dx, b = firstFree ? firstFree.dx : ceiling;
  if (!test(b)) {
    while (b - a > 0.02) {
      const mid = (a + b) / 2;
      if (test(mid)) a = mid; else b = mid;
    }
  }
  const value = Math.ceil(b * 100) / 100;
  cache.set(key, value);
  return value;
}

function bestPlacement(built, variant, placed, usableWidth, cache) {
  let x = 0;
  for (const p of placed) {
    const dx = minOffset(p.variant, variant, cache);
    if (dx === null) return null;
    x = Math.max(x, p.xMm + dx);
  }
  if (x + variant.widthMm > usableWidth + EPS) return null;
  return { xMm: x, variant, widthMm: variant.widthMm, heightMm: variant.heightMm };
}

function buildRow(pool, usableWidth, cache, opts) {
  const beamWidth = Math.max(1, opts.beamWidth || DEFAULT_BEAM_WIDTH);
  const limit = Math.max(1, opts.candidateLimit || DEFAULT_CANDIDATE_LIMIT);
  let beam = [{ placed: [], widthMm: 0, heightMm: 0 }];

  for (let step = 0; step < pool.length; step++) {
    const expanded = [];
    for (const state of beam) {
      const used = new Set(state.placed.map((p) => p.built.index));
      const candidates = pool.filter((b) => !used.has(b.index)).slice(0, limit);
      for (const built of candidates) {
        for (const variant of built.variants) {
          if (opts.maxHeightMm && variant.heightMm > opts.maxHeightMm + EPS) continue;
          const placed = bestPlacement(built, variant, state.placed, usableWidth, cache);
          if (!placed) continue;
          expanded.push({
            placed: state.placed.concat([{
              built,
              variant,
              xMm: placed.xMm,
              widthMm: variant.widthMm,
              heightMm: variant.heightMm,
            }]),
            widthMm: Math.max(state.widthMm, placed.xMm + variant.widthMm),
            heightMm: Math.max(state.heightMm, variant.heightMm),
          });
        }
      }
    }
    if (!expanded.length) break;
    expanded.sort((a, b) => (b.placed.length - a.placed.length) || (a.widthMm - b.widthMm) || (a.heightMm - b.heightMm));
    beam = expanded.slice(0, Math.max(1, beamWidth));
  }

  // 개수 우선, 그 다음 열의 끝 좌표가 짧은 쪽.
  beam.sort((a, b) => (b.placed.length - a.placed.length) || (a.widthMm - b.widthMm) || (a.heightMm - b.heightMm));
  return beam[0];
}

// ---------------------------------------------------------------- bases
function rectsOverlap(a, b, gap) {
  return a.xMm < b.xMm + b.widthMm + gap - EPS && b.xMm < a.xMm + a.widthMm + gap - EPS &&
    a.yMm < b.yMm + b.heightMm + gap - EPS && b.yMm < a.yMm + a.heightMm + gap - EPS;
}

// ---------------------------------------------------------------- bases
// Base placement is a pure 2D occupancy problem, so it is solved as one: the
// artwork (grown by the clearance) is rasterised once into an obstacle mask and
// summed into an integral image. Any 35mm square can then be validated with four
// array reads instead of thousands of segment tests.
const BASE_RASTER_MM = 0.25;

function buildObstacleGrid(placements, opts) {
  const gap = Number(opts.clearanceMm ?? CLEARANCE_MM);
  const W = Number(opts.sheetWidthMm ?? SHEET.widthMm);
  const H = Number(opts.sheetHeightMm ?? SHEET.heightMm);
  const r = BASE_RASTER_MM;
  const cols = Math.ceil(W / r) + 2;
  const rowsN = Math.ceil(H / r) + 2;
  const mask = new Uint8Array(cols * rowsN);

  const grow = gap + r; // covers cell quantisation and the inflate tolerance
  for (const p of placements) {
    const loops = Array.isArray(p.cutPaths) ? p.cutPaths : [];
    const shift = p.outlineShift || [0, 0];
    const m = p.matrix || [1, 0, 0, 1, p.xMm || 0, p.yMm || 0];
    const polys = [];
    for (const loop of loops) {
      if (!Array.isArray(loop) || loop.length < 3) continue;
      polys.push(loop.map(([x, y]) => {
        const px = x + shift[0], py = y + shift[1];
        return [m[0] * px + m[2] * py + m[4], m[1] * px + m[3] * py + m[5]];
      }));
    }
    if (!polys.length) {
      polys.push([[p.xMm, p.yMm], [p.xMm + p.widthMm, p.yMm],
        [p.xMm + p.widthMm, p.yMm + p.heightMm], [p.xMm, p.yMm + p.heightMm]]);
    }
    for (const poly of polys) {
      const pts = poly;
      // Dilate in raster space instead of inflating the polygon: offsetting a
      // 3000-point outline is expensive and its rounded joins are then filled
      // again per scanline. One separable pass is both faster and simpler.
      // (grow is applied below as a cell radius.)
      // Scanline fill, then a separable dilation by `grow` cells covers the gap.
      let minY = Infinity, maxY = -Infinity;
      for (const [, y] of pts) { if (y < minY) minY = y; if (y > maxY) maxY = y; }
      const y0 = Math.max(0, Math.floor(minY / r) - 1);
      const y1 = Math.min(rowsN - 1, Math.ceil(maxY / r) + 1);
      for (let gy = y0; gy <= y1; gy++) {
        const wy = (gy + 0.5) * r;
        const xs = [];
        for (let i = 0; i < pts.length; i++) {
          const a = pts[i], b = pts[(i + 1) % pts.length];
          if ((a[1] > wy) === (b[1] > wy)) continue;
          xs.push(a[0] + ((wy - a[1]) * (b[0] - a[0])) / (b[1] - a[1]));
        }
        if (!xs.length) continue;
        xs.sort((p1, p2) => p1 - p2);
        for (let k = 0; k + 1 < xs.length; k += 2) {
          const gx0 = Math.max(0, Math.floor(xs[k] / r));
          const gx1 = Math.min(cols - 1, Math.ceil(xs[k + 1] / r));
          for (let gx = gx0; gx <= gx1; gx++) mask[gy * cols + gx] = 1;
        }
      }
    }
  }

  // Separable dilation by the required clearance (in cells).
  dilateMask(mask, cols, rowsN, Math.max(1, Math.round(grow / r)));

  // Integral image: 1 + one cell of padding so queries never need bounds checks.
  const stride = cols + 1;
  const integral = new Int32Array((rowsN + 1) * stride);
  for (let y = 0; y < rowsN; y++) {
    let run = 0;
    for (let x = 0; x < cols; x++) {
      run += mask[y * cols + x];
      integral[(y + 1) * stride + (x + 1)] = integral[y * stride + (x + 1)] + run;
    }
  }
  return { integral, mask, cols, rowsN, stride, r, W, H };
}

/** Binary dilation with a square structuring element, one axis at a time. */
function dilateMask(mask, cols, rowsN, radius) {
  if (radius <= 0) return mask;
  const tmp = new Uint8Array(mask.length);
  for (let y = 0; y < rowsN; y++) {
    const row = y * cols;
    for (let x = 0; x < cols; x++) {
      if (!mask[row + x]) continue;
      const lo = Math.max(0, x - radius), hi = Math.min(cols - 1, x + radius);
      for (let k = lo; k <= hi; k++) tmp[row + k] = 1;
    }
  }
  for (let y = 0; y < rowsN; y++) {
    for (let x = 0; x < cols; x++) {
      if (!tmp[y * cols + x]) continue;
      const lo = Math.max(0, y - radius), hi = Math.min(rowsN - 1, y + radius);
      for (let k = lo; k <= hi; k++) mask[k * cols + x] = 1;
    }
  }
  return mask;
}

function makeSiteTester(grid, baseSize) {
  const { integral, stride, r, cols, rowsN } = grid;
  return (x, y) => {
    // Anything already burned in (a placed base) rejects the site outright.
    if (hitsBurnedRect(grid, x, y, baseSize)) return false;
    // Cells fully inside the square; rounding inward keeps the check conservative.
    const gx0 = Math.ceil((x + 1e-6) / r);
    const gy0 = Math.ceil((y + 1e-6) / r);
    const gx1 = Math.floor((x + baseSize - 1e-6) / r);
    const gy1 = Math.floor((y + baseSize - 1e-6) / r);
    if (gx0 < 0 || gy0 < 0 || gx1 >= cols || gy1 >= rowsN || gx1 < gx0 || gy1 < gy0) return false;
    const sum = integral[(gy1 + 1) * stride + (gx1 + 1)]
      - integral[gy0 * stride + (gx1 + 1)]
      - integral[(gy1 + 1) * stride + gx0]
      + integral[gy0 * stride + gx0];
    return sum === 0;
  };
}

function overlapsPlacedBase(bases, x, y, size, gap) {
  for (const b of bases) {
    if (x < b.xMm + b.widthMm + gap - EPS && b.xMm < x + size + gap - EPS &&
        y < b.yMm + b.heightMm + gap - EPS && b.yMm < y + size + gap - EPS) return true;
  }
  return false;
}

function cloneGrid(grid) {
  return {
    integral: Int32Array.from(grid.integral),
    mask: grid.mask ? Uint8Array.from(grid.mask) : null,
    cols: grid.cols,
    rowsN: grid.rowsN,
    stride: grid.stride,
    r: grid.r,
    W: grid.W,
    H: grid.H,
    // Burned rectangles are copied so a strategy can be evaluated without
    // mutating the grid the other strategy will reuse.
    burned: grid.burned ? grid.burned.slice() : [],
  };
}

/**
 * Burn a rectangle (grown by `gap`) into the grid so later queries reject it.
 *
 * Patching the integral image in place is a trap. A prefix sum carries a vertical
 * accumulation as well as a horizontal one, so the old "raise this cell and
 * everything to its right by 1" trick was correct for its own row and stale for
 * every row below it. It happened to look fine for the tiny shadows used during
 * packing, where the next probe sits in the same row, but a 35mm base spans ~140
 * raster rows: the top and bottom edges of its shadow cancelled out and the square
 * read as free, so each band dropped a base on top of the previous one.
 *
 * The grid therefore keeps a list of burned rectangles and answers from it
 * directly. That is exact (no prefix bookkeeping to go stale), O(placed) per
 * query instead of O(1), and the list only ever holds the bases placed so far, so
 * the cost stays trivial next to the artwork integral test that runs first.
 */
function burnRect(grid, x, y, size, gap) {
  if (!grid.burned) grid.burned = [];
  grid.burned.push([x - gap, y - gap, x + size + gap, y + size + gap]);
}

/** True when an axis-aligned rectangle touches anything burned into the grid. */
function hitsBurnedRect(grid, x, y, size) {
  const list = grid.burned;
  if (!list || !list.length) return false;
  const x2 = x + size, y2 = y + size;
  for (let i = 0; i < list.length; i++) {
    const b = list[i];
    if (x < b[2] - EPS && b[0] < x2 - EPS && y < b[3] - EPS && b[1] < y2 - EPS) return true;
  }
  return false;
}

/** Back-compat shim: burn a rectangle and keep `mask` visually in sync. */
function shadowRect(grid, x, y, size, gap) {
  burnRect(grid, x, y, size, gap);
  const { mask, cols, rowsN, r } = grid;
  if (!mask || mask.length !== cols * rowsN) return;
  const gx0 = Math.max(0, Math.ceil((x - gap) / r));
  const gy0 = Math.max(0, Math.ceil((y - gap) / r));
  const gx1 = Math.min(cols - 1, Math.floor((x + size + gap) / r));
  const gy1 = Math.min(rowsN - 1, Math.floor((y + size + gap) / r));
  for (let gy = gy0; gy <= gy1; gy++) {
    const rowBase = gy * cols;
    for (let gx = gx0; gx <= gx1; gx++) mask[rowBase + gx] = 1;
  }
}

/**
 * Strategy A: keep a regular lattice (bases stay aligned, which reads cleanly on
 * the sheet) but stop anchoring it to the margin. Both lattice offsets are
 * searched so the grid slides down onto the artwork instead of leaving the first
 * column empty.
 */
function fillBasesLattice(opts, grid) {
  const baseSize = Number(opts.baseSizeMm ?? BASE_SIZE_MM);
  const gap = Number(opts.clearanceMm ?? CLEARANCE_MM);
  const margin = Number(opts.marginMm ?? MARGIN_MM);
  const W = Number(opts.sheetWidthMm ?? SHEET.widthMm);
  const H = Number(opts.sheetHeightMm ?? SHEET.heightMm);
  const fits = makeSiteTester(grid, baseSize);
  const step = baseSize + gap;

  const build = (ox, oy) => {
    const bases = [];
    for (let y = margin + oy; y + baseSize <= H - margin + EPS; y += step) {
      for (let x = margin + ox; x + baseSize <= W - margin + EPS; x += step) {
        if (!fits(x, y)) continue;
        bases.push({ xMm: x, yMm: y, widthMm: baseSize, heightMm: baseSize });
      }
    }
    return bases;
  };

  // Offset search in two passes: a coarse sweep finds the promising region, then
  // a fine sweep around it. Sweeping the full resolution everywhere costs dozens
  // of times more for the same answer.
  let best = [], bestOx = 0, bestOy = 0;
  const sweep = (from, to, stepSize) => {
    for (let oy = from; oy < to - EPS; oy += stepSize) {
      for (let ox = from; ox < to - EPS; ox += stepSize) {
        if (ox >= step - EPS || oy >= step - EPS) continue;
        const bases = build(ox, oy);
        if (bases.length > best.length) { best = bases; bestOx = ox; bestOy = oy; }
      }
    }
  };
  const coarse = 2;
  sweep(0, step, coarse);
  const lo = Math.max(0, Math.min(bestOx, bestOy) - coarse);
  const hi = Math.min(step, Math.max(bestOx, bestOy) + coarse + coarse);
  for (let oy = lo; oy <= hi + EPS; oy += BASE_RASTER_MM) {
    for (let ox = lo; ox <= hi + EPS; ox += BASE_RASTER_MM) {
      if (ox >= step - EPS || oy >= step - EPS) continue;
      const bases = build(ox, oy);
      if (bases.length > best.length) { best = bases; bestOx = ox; bestOy = oy; }
    }
  }
  return best;
}

/**
 * Strategy B: no lattice. Work in horizontal bands one base tall; inside each
 * band keep the y that fits the most bases, then burn that strip into the mask so
 * later bands cannot overlap it. Committing to the first legal y instead
 * fragments the remaining area and yields fewer bases.
 */
function fillBasesDense(opts, grid) {
  const baseSize = Number(opts.baseSizeMm ?? BASE_SIZE_MM);
  const gap = Number(opts.clearanceMm ?? CLEARANCE_MM);
  const margin = Number(opts.marginMm ?? MARGIN_MM);
  const W = Number(opts.sheetWidthMm ?? SHEET.widthMm);
  const H = Number(opts.sheetHeightMm ?? SHEET.heightMm);
  const work = cloneGrid(grid);
  const fits = makeSiteTester(work, baseSize);
  const bases = [];

  const bandStep = baseSize + gap;
  for (let bandY = margin; bandY + baseSize <= H - margin + EPS; bandY += bandStep) {
    let bestRow = null, bestY = null;
    const yLimit = Math.min(bandY + bandStep, H - margin - baseSize);
    for (let y = bandY; y <= yLimit + EPS; y += BASE_RASTER_MM) {
      const row = [];
      let cursor = margin;
      while (cursor + baseSize <= W - margin + EPS) {
        let found = null;
        for (let x = cursor; x + baseSize <= W - margin + EPS; x += BASE_RASTER_MM) {
          if (fits(x, y)) { found = x; break; }
        }
        if (found === null) break;
        row.push({ xMm: found, yMm: y, widthMm: baseSize, heightMm: baseSize });
        cursor = found + baseSize + gap;
      }
      if (!bestRow || row.length > bestRow.length) { bestRow = row; bestY = y; }
    }
    if (!bestRow || !bestRow.length) continue;
    for (const b of bestRow) {
      bases.push(b);
      shadowRect(work, b.xMm, b.yMm, baseSize, gap);
    }
  }
  return bases;
}

function fillBases(placements, opts) {
  const grid = buildObstacleGrid(placements, opts);
  const lattice = fillBasesLattice(opts, grid);
  let dense = [];
  try { dense = fillBasesDense(opts, grid); } catch (_) { dense = []; }
  const candidates = [lattice, dense];
  // Both strategies are legal; ship whichever wastes less paper.
  return candidates.sort((a, b) => b.length - a.length)[0];
}

// ---------------------------------------------------------------- packing
function packNesting(items, options = {}) {
  if (!Array.isArray(items) || !items.length) throw new Error('네스팅할 이미지가 없습니다.');
  const opts = {
    sheetWidthMm: Number(options.sheetWidthMm ?? SHEET.widthMm),
    sheetHeightMm: Number(options.sheetHeightMm ?? SHEET.heightMm),
    marginMm: Number(options.marginMm ?? MARGIN_MM),
    clearanceMm: Number(options.clearanceMm ?? CLEARANCE_MM),
    baseSizeMm: Number(options.baseSizeMm ?? BASE_SIZE_MM),
    fillBases: options.fillBases !== false,
    beamWidth: Number(options.beamWidth ?? DEFAULT_BEAM_WIDTH),
    candidateLimit: Number(options.candidateLimit ?? DEFAULT_CANDIDATE_LIMIT),
    allowLandscape: options.allowLandscape !== false,
  };
  if (!(opts.sheetWidthMm > 0) || !(opts.sheetHeightMm > 0)) throw new Error('시트 크기가 올바르지 않습니다.');
  if (!(opts.clearanceMm >= 0)) throw new Error('간격(clearance)이 올바르지 않습니다.');

  const built = items.map((item, i) => {
    if (!item || !(item.widthMm > 0 || (item.width > 0 && item.pixelsPerMm > 0))) {
      throw new Error(`아이템 크기가 올바르지 않습니다: ${item && item.name ? item.name : 'unknown'}`);
    }
    return buildVariants(item, i, opts);
  });

  const usableWidth = opts.sheetWidthMm - opts.marginMm * 2;
  const usableBottom = opts.sheetHeightMm - opts.marginMm;
  const usableHeight = usableBottom - opts.marginMm;
  const cache = new Map();
  const pool = built.slice();
  const unplaced = [];
  const placements = [];
  const rows = [];

  let cursorYm = opts.marginMm;
  let guard = 0;
  while (pool.length && guard++ < 64) {
    const rowAvail = pool.filter((b) => b.variants.some((v) => v.heightMm <= usableHeight + EPS));
    const fitsAny = pool.filter((b) => b.variants.some((v) => v.heightMm <= usableBottom - cursorYm + EPS));
    if (!fitsAny.length) break;
    // 남은 높이에 들어가는 변형만 사용한다.
    const room = usableBottom - cursorYm;
    const usable = rowAvail.filter((b) => b.variants.some((v) => v.heightMm <= room + EPS));
    if (!usable.length) break;

    const row = buildRow(usable, usableWidth, cache, { ...opts, maxHeightMm: room });
    if (!row || !row.placed.length) break;

    rows.push({ index: rows.length, yMm: cursorYm, heightMm: row.heightMm, widthMm: row.widthMm, endXMm: opts.marginMm + row.widthMm, count: row.placed.length });

    for (const p of row.placed) {
      const b = p.built;
      const xMm = opts.marginMm + p.xMm;
      // The packer normalises each outline to its own bounding box. The placement
      // hands raw pixel loops to the preview and the PDF, so shift them by the
      // same amount or every drawn cut line is offset from its declared box.
      const outlineShift = p.variant.outlineShift || [0, 0];
      placements.push({
        name: b.item.name,
        _idx: b.index,
        xMm,
        yMm: cursorYm,
        widthMm: p.widthMm,
        heightMm: p.heightMm,
        rot: p.variant.rot,
        rowIndex: rows.length - 1,
        sourceWidthMm: b.srcW,
        sourceHeightMm: b.srcH,
        pixelsPerMm: b.ppm,
        width: b.item.width,
        height: b.item.height,
        artwork: b.item.artwork,
        whitePaths: b.item.whitePaths,
        cutPaths: b.item.cutPaths,
        outlineShift,
      });
      const at = pool.indexOf(b);
      if (at >= 0) pool.splice(at, 1);
    }
    cursorYm += row.heightMm + opts.clearanceMm;
  }

  for (const b of pool) {
    const wide = b.variants.some((v) => v.widthMm > usableWidth + EPS);
    unplaced.push({ name: b.item.name, _idx: b.index, widthMm: b.srcW, heightMm: b.srcH, reason: wide ? 'sheet-size' : 'sheet-full' });
  }

  for (const p of placements) p.matrix = placementMatrix(p);

  const bases = opts.fillBases ? fillBases(placements, opts) : [];
  const basisAvailable = opts.sheetWidthMm * opts.sheetHeightMm;
  const itemArea = placements.reduce((s, p) => s + p.widthMm * p.heightMm, 0);
  const baseArea = bases.length * opts.baseSizeMm * opts.baseSizeMm;
  const usedHeightMm = rows.length ? rows[rows.length - 1].yMm + rows[rows.length - 1].heightMm - opts.marginMm : 0;

  return {
    sheetWidthMm: opts.sheetWidthMm,
    sheetHeightMm: opts.sheetHeightMm,
    marginMm: opts.marginMm,
    clearanceMm: opts.clearanceMm,
    baseSizeMm: opts.baseSizeMm,
    rows,
    rowCount: rows.length,
    placements,
    bases,
    unplaced,
    usedHeightMm,
    utilization: basisAvailable ? (itemArea + baseArea) / basisAvailable : 0,
    itemUtilization: basisAvailable ? itemArea / basisAvailable : 0,
  };
}

// ---------------------------------------------------------------- preview
function escapeXml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function pathData(points) {
  if (!Array.isArray(points) || points.length < 3) return '';
  const r = (v) => Math.round(v * 1000) / 1000;
  return 'M' + points.map((p) => `${r(p[0])} ${r(p[1])}`).join('L') + 'Z';
}

function nestingPreviewSvg(result, opts = {}) {
  const W = result.sheetWidthMm, H = result.sheetHeightMm;
  const geo = opts.baseGeometry || null;
  const thumbs = opts.thumbnails || null;
  const margin = result.marginMm ?? MARGIN_MM;
  const parts = [];
  parts.push(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="100%" role="img" aria-label="네스팅 배치 미리보기">`);
  parts.push(`<rect x="0" y="0" width="${W}" height="${H}" fill="#ffffff" stroke="#94a3b8" stroke-width="0.8"/>`);
  parts.push(`<rect x="${margin}" y="${margin}" width="${W - margin * 2}" height="${H - margin * 2}" fill="none" stroke="#cbd5e1" stroke-width="0.2" stroke-dasharray="2 2"/>`);

  for (const b of result.bases) {
    if (geo) {
      const outerD = pathData(geo.outer.map(([x, y]) => [x + b.xMm, y + b.yMm]));
      const slitD = pathData(geo.slit.map(([x, y]) => [x + b.xMm, y + b.yMm]));
      parts.push(`<g><path d="${outerD}" fill="#fdf2f8" stroke="#f21a9b" stroke-width="0.15"/><path d="${slitD}" fill="#ffffff" stroke="#f21a9b" stroke-width="0.15"/></g>`);
    } else {
      parts.push(`<rect x="${b.xMm}" y="${b.yMm}" width="${b.widthMm}" height="${b.heightMm}" fill="#fdf2f8" stroke="#f21a9b" stroke-width="0.3"/>`);
    }
  }

  result.placements.forEach((p, i) => {
    const label = (opts.labels && opts.labels[p._idx]) || p.name || `#${i + 1}`;
    const m = p.matrix || [1, 0, 0, 1, p.xMm, p.yMm];
    const thumb = thumbs && thumbs[p._idx];
    const srcW = p.width || 1, srcH = p.height || 1;
    const inner = [];
    if (thumb) inner.push(`<image href="${thumb}" x="0" y="0" width="${srcW}" height="${srcH}" preserveAspectRatio="none" opacity="0.9"/>`);
    // Every loop is drawn, shifted onto the same normalised frame the packer sized.
    const shift = p.outlineShift || [0, 0];
    const cut = Array.isArray(p.cutPaths) && p.cutPaths.length
      ? p.cutPaths.map((loop) => pathData(loop.map(([x, y]) => [x + shift[0], y + shift[1]]))).join('')
      : '';
    if (cut) inner.push(`<path d="${cut}" fill="none" stroke="#3465e8" stroke-width="${0.2 * (p.pixelsPerMm || 1)}" stroke-linejoin="round"/>`);
    // 방향 표시: 180° 회전하면 표시가 반대쪽 모서리로 간다.
    inner.push(`<path d="M0 0 L${8 * (p.pixelsPerMm || 1)} 0 L0 ${8 * (p.pixelsPerMm || 1)} Z" fill="#3465e8" opacity="0.45"/>`);
    parts.push(`<g transform="matrix(${m.map((v) => Math.round(v * 1e6) / 1e6).join(' ')})">${inner.join('')}</g>`);
    parts.push(`<rect x="${p.xMm}" y="${p.yMm}" width="${p.widthMm}" height="${p.heightMm}" fill="none" stroke="#93a7d8" stroke-width="0.12" stroke-dasharray="1 1"/>`);
    parts.push(`<text x="${p.xMm + 1.2}" y="${p.yMm + 3.6}" font-size="3.2" fill="#315fd8" font-weight="700">${escapeXml(String(i + 1))}</text>`);
  });

  // 행 경계선
  for (const row of result.rows || []) {
    parts.push(`<line x1="${margin}" y1="${row.yMm + row.heightMm + 0.125}" x2="${W - margin}" y2="${row.yMm + row.heightMm + 0.125}" stroke="#e2e8f0" stroke-width="0.15" stroke-dasharray="3 1.5"/>`);
  }
  parts.push('</svg>');
  return parts.join('');
}

if (typeof module !== 'undefined') {
  module.exports = {
    SHEET, MARGIN_MM, CLEARANCE_MM, BASE_SIZE_MM, STEP_MM,
    packNesting, nestingPreviewSvg, placementMatrix, polygonsOverlap, minOffset, rotatePolygon,
    exposeClipper, getClipper,
  };
}
if (typeof window !== 'undefined') {
  window.OutlineNesting = {
    SHEET, MARGIN_MM, CLEARANCE_MM, BASE_SIZE_MM, STEP_MM,
    packNesting, nestingPreviewSvg, placementMatrix,
    exposeClipper, getClipper,
  };
}
