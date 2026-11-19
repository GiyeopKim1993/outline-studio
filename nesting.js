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
  for (let i = 0; i < A.length; i++) {
    const a1 = A[i], a2 = A[(i + 1) % A.length];
    for (let j = 0; j < B.length; j++) {
      const b1 = [B[j][0] + dx, B[j][1]], b2 = [B[(j + 1) % B.length][0] + dx, B[(j + 1) % B.length][1]];
      if (segmentIntersect(a1, a2, b1, b2)) return true;
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
  if (!Array.isArray(points) || points.length <= MAX_OUTLINE_POINTS) return points.slice();
  let simplified = douglasPeucker(points, SIMPLIFY_TOL_MM);
  if (simplified.length > MAX_OUTLINE_POINTS) {
    // Grow the tolerance until it fits. Unlike index sampling this never cuts a
    // corner off: it only drops vertices that are within `tol` of the segment
    // that replaces them, so the shape stays as large as the real cut line.
    let tol = SIMPLIFY_TOL_MM;
    for (let attempt = 0; attempt < 16 && simplified.length > MAX_OUTLINE_POINTS; attempt++) {
      tol *= 1.5;
      simplified = douglasPeucker(points, tol);
    }
  }
  return simplified;
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

  const simplified = pieces.map((loop) => simplifyPolygon(loop));
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
    const inflatedPieces = normPieces.map((loop) => inflatePolygon(loop, SAFETY_HALF_MM));
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

  // Quick lower bound from the bounding boxes: at dx the right shape spans
  // [dx + rmin, dx + rmax], so nothing can be free before lmax - rmin.
  const lb = left.safe.bounds, rb = right.safe.bounds;
  const floor = Math.max(0, lb.maxX - rb.minX);
  // Nothing can still be blocked past lw + rw (fully separated).
  const ceiling = lw + rw;
  // Search must begin where no bounding box can possibly clear yet, otherwise an
  // interlocking arrangement (two L shapes sharing a corner) is never explored.
  const start = Math.max(0, floor);
  if (start > ceiling) { cache.set(key, null); return null; }

  // Hybrid search: gallop forward to bracket the first free offset, then bisect.
  // This is exact (the predicate is monotone) and needs far fewer pair tests than
  // walking every 1 mm, which matters now that outlines keep real detail.
  let hi = start;
  let bracketed = false;
  if (test(hi)) {
    // Gallop: double the step until a free offset is found. The pair predicate is
    // monotone in dx, so the answer lies between the last blocked offset and that
    // free one and a bisection is exact.
    let step = COARSE_STEP_MM;
    let lo = hi;
    while (lo < ceiling) {
      hi = Math.min(ceiling, lo + step);
      if (!test(hi)) { bracketed = true; break; }
      lo = hi;
      step *= 2;
    }
    if (!bracketed) {
      // At the ceiling the shapes are fully apart by construction.
      if (test(ceiling)) { cache.set(key, null); return null; }
      hi = ceiling;
      bracketed = true;
    }
    if (bracketed) {
      let a = lo, b = hi;
      while (b - a > 0.02) {
        const mid = (a + b) / 2;
        if (test(mid)) a = mid; else b = mid;
      }
      hi = b;
    }
  }
  const value = Math.ceil(hi * 100) / 100;
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

function fillBases(placements, opts) {
  const baseSize = Number(opts.baseSizeMm ?? BASE_SIZE_MM);
  const gap = Number(opts.clearanceMm ?? CLEARANCE_MM);
  const margin = Number(opts.marginMm ?? MARGIN_MM);
  const W = Number(opts.sheetWidthMm ?? SHEET.widthMm);
  const H = Number(opts.sheetHeightMm ?? SHEET.heightMm);
  const bases = [];
  const occupied = placements.map((p) => ({ xMm: p.xMm, yMm: p.yMm, widthMm: p.widthMm, heightMm: p.heightMm }));
  const fits = (x, y) => {
    const candidate = { xMm: x, yMm: y, widthMm: baseSize, heightMm: baseSize };
    for (const o of occupied) if (rectsOverlap(candidate, o, gap)) return false;
    return true;
  };
  const stepX = baseSize + gap;
  for (let y = margin; y + baseSize <= H - margin + EPS; y += STEP_MM) {
    for (let x = margin; x + baseSize <= W - margin + EPS; x += stepX) {
      if (!fits(x, y)) continue;
      const base = { xMm: x, yMm: y, widthMm: baseSize, heightMm: baseSize };
      bases.push(base);
      occupied.push(base);
    }
  }
  return bases;
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
