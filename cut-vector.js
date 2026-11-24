/* Plan B cut-line vectorization.
 *
 * The raster pipeline still produces the pixel mask used for rendering and the
 * white spot, but the exported cut contour no longer comes from tracing that
 * mask (which yields a staircase of ~1 px steps). Instead:
 *   1. the silhouette loops (after offset/neck reinforcement, BEFORE scaffold
 *      and tab are applied) are simplified with Ramer-Douglas-Peucker at a
 *      physical millimetre tolerance, and
 *   2. scaffold and center tab are emitted as analytic parametric
 *      polygons (arcs segmented at a ~0.01 mm chord tolerance), so their shape
 *      stays exactly at the design values.
 * Booleans run in Clipper at 1000 units/mm. All coordinates are millimetres in
 * mask space (y down), converted to pixels by the caller.
 */
((root, factory) => {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.CutVector = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, () => {
  'use strict';
  const SQRT3 = Math.sqrt(3);
  const SCALE = 1000;              // clipper integer units per mm
  const ARC_TOL_MM = 0.01;         // chord tolerance for analytic arcs
  const SIMPLIFY_TOL_MM = 0.1;     // RDP tolerance for the silhouette loops
  const FIT_TOL_MM = 0.15;         // cubic-fit deviation budget for the final contour
  const FIT_CORNER_TURN = 0.7;     // rad; windowed turns above this stay exact anchors
  const FIT_MIN_POINTS = 64;       // loops below this stay exact polylines (tabs, bars)

  // ---- Ramer-Douglas-Peucker -------------------------------------------------
  function rdpOpen(pts, tol) {
    if (pts.length < 3) return pts.slice();
    const keep = new Uint8Array(pts.length); keep[0] = keep[pts.length - 1] = 1;
    const stack = [[0, pts.length - 1]];
    while (stack.length) {
      const [a, b] = stack.pop();
      if (b - a < 2) continue;
      const ax = pts[a][0], ay = pts[a][1], bx = pts[b][0], by = pts[b][1];
      const dx = bx - ax, dy = by - ay, len2 = dx * dx + dy * dy;
      let worst = -1, wi = -1;
      for (let i = a + 1; i < b; i++) {
        const px = pts[i][0], py = pts[i][1];
        let t = 0;
        if (len2 > 0) t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2));
        const ox = px - (ax + t * dx), oy = py - (ay + t * dy);
        const d = ox * ox + oy * oy;
        if (d > worst) { worst = d; wi = i; }
      }
      if (worst > tol * tol) { keep[wi] = 1; stack.push([a, wi], [wi, b]); }
    }
    const out = [];
    for (let i = 0; i < pts.length; i++) if (keep[i]) out.push(pts[i]);
    return out;
  }

  // Closed-loop RDP: split at the two most distant points, simplify both chains.
  function simplifyLoop(loop, tol = SIMPLIFY_TOL_MM) {
    const n = loop.length;
    if (n < 4) return loop.slice();
    let i0 = 0;
    for (let i = 1; i < n; i++) if (loop[i][0] < loop[i0][0]) i0 = i;
    let i1 = i0, best = -1;
    for (let i = 0; i < n; i++) {
      const dx = loop[i][0] - loop[i0][0], dy = loop[i][1] - loop[i0][1], d = dx * dx + dy * dy;
      if (d > best) { best = d; i1 = i; }
    }
    if (i1 === i0) return loop.slice();
    const chainA = [], chainB = [];
    for (let k = i0; ; k = (k + 1) % n) { chainA.push(loop[k]); if (k === i1) break; }
    for (let k = i1; ; k = (k + 1) % n) { chainB.push(loop[k]); if (k === i0) break; }
    const a = rdpOpen(chainA, tol), b = rdpOpen(chainB, tol);
    return a.slice(0, a.length - 1).concat(b.slice(0, b.length - 1));
  }

  // True perpendicular deviation of the original loop against the simplified one.
  function loopDeviation(orig, simp) {
    let worst = 0;
    const m = simp.length;
    for (const p of orig) {
      let d = Infinity;
      for (let i = 0; i < m; i++) {
        const a = simp[i], b = simp[(i + 1) % m];
        const dx = b[0] - a[0], dy = b[1] - a[1], len2 = dx * dx + dy * dy;
        let t = 0;
        if (len2 > 0) t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2));
        const ox = p[0] - (a[0] + t * dx), oy = p[1] - (a[1] + t * dy);
        const dd = ox * ox + oy * oy;
        if (dd < d) d = dd;
      }
      if (d > worst) worst = d;
    }
    return Math.sqrt(worst);
  }

  // ---- analytic shape polygons (mm, y down) ----------------------------------
  function arcPts(cx, cy, r, a0, a1, ccw) {
    const step = 2 * Math.acos(Math.max(-1, Math.min(1, 1 - ARC_TOL_MM / r)));
    let span = a1 - a0;
    if (ccw && span < 0) span += 2 * Math.PI;
    if (!ccw && span > 0) span -= 2 * Math.PI;
    const n = Math.max(1, Math.ceil(Math.abs(span) / step));
    const out = [];
    for (let i = 0; i <= n; i++) {
      const a = a0 + span * i / n;
      out.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]);
    }
    return out;
  }

  // Filleted equilateral triangle, virtual base at `bottom`, apex up — the
  // Minkowski sum of the inset triangle and the fillet disk (same convention as
  // ScaffoldRules.roundedTriangleMask).
  function roundedTrianglePoly(cx, bottom, side = 47, r = 1) {
    const height = side * SQRT3 / 2, top = bottom - height;
    const innerTop = top + 2 * r, innerBottom = bottom - r;
    const innerHalf = side / 2 - SQRT3 * r;
    const V = [[cx, innerTop], [cx - innerHalf, innerBottom], [cx + innerHalf, innerBottom]];
    return offsetTrianglePoly(V, r);
  }

  function offsetTrianglePoly(V, r) {
    // Outward edge normals are validated against the centroid so the winding
    // of V never matters; each corner arc sweeps the short way between the two
    // adjacent edge normals (Minkowski sum with the fillet disk).
    const cx0 = (V[0][0] + V[1][0] + V[2][0]) / 3, cy0 = (V[0][1] + V[1][1] + V[2][1]) / 3;
    const normals = [];
    for (let i = 0; i < 3; i++) {
      const a = V[i], b = V[(i + 1) % 3];
      const dx = b[0] - a[0], dy = b[1] - a[1], L = Math.hypot(dx, dy);
      let n = [dy / L, -dx / L];
      const mx = (a[0] + b[0]) / 2 - cx0, my = (a[1] + b[1]) / 2 - cy0;
      if (n[0] * mx + n[1] * my < 0) n = [-n[0], -n[1]];
      normals.push(n);
    }
    const poly = [];
    for (let i = 0; i < 3; i++) {
      const nIn = normals[(i + 2) % 3], nOut = normals[i];
      const a0 = Math.atan2(nIn[1], nIn[0]);
      let span = Math.atan2(nOut[1], nOut[0]) - a0;
      while (span > Math.PI) span -= 2 * Math.PI;
      while (span < -Math.PI) span += 2 * Math.PI;
      poly.push(...arcPts(V[i][0], V[i][1], r, a0, a0 + span, span > 0));
    }
    return poly;
  }

  function roundedRectPoly(cx, top, bottom, width, r = 1) {
    const half = width / 2, left = cx - half, right = cx + half;
    r = Math.min(r, half, (bottom - top) / 2);
    const poly = [];
    poly.push(...arcPts(right - r, top + r, r, -Math.PI / 2, 0, true));
    poly.push(...arcPts(right - r, bottom - r, r, 0, Math.PI / 2, true));
    poly.push(...arcPts(left + r, bottom - r, r, Math.PI / 2, Math.PI, true));
    poly.push(...arcPts(left + r, top + r, r, Math.PI, 3 * Math.PI / 2, true));
    return poly;
  }

  // Concave root fillet where a tab flank meets the bar/product bottom line:
  // arc of radius `rootR` tangent to both edges, clamped so the two tangent
  // points stay on their edges (flank room left after the tip arc).
  function tabRootParams(depth, width, taper, tipR, rootR) {
    const half = width / 2;
    const rTip = Math.min(tipR, depth / 2, half - taper);
    // The flank edge is the chord top-corner -> (half-taper, depth-rTip); the
    // tip arcTo consumes rTip of it at the bottom (90 deg corner there).
    const Lf = Math.hypot(taper, depth - rTip);
    const cosPhi = -taper / Lf;                 // angle between bottom-out and flank-down
    const phi = Math.acos(Math.max(-1, Math.min(1, cosPhi)));
    const tanHalf = Math.tan(phi / 2);
    const r = Math.max(0, Math.min(rootR, (Lf - rTip - 0.1) * tanHalf));
    const t = r / tanHalf;
    return { r, t, phi, Lf, tanHalf, rTip };
  }
  const TAB_ROOT_RADIUS_MM = 0;   // user decision: V1/V2 tab-bar junctions stay sharp

  // Center tab: vector twin of addTab(). Symmetric trapezoid (top `width`,
  // flanks reaching `width-2*taper` at y1-r) whose tip corners are radius-`tipR`
  // arcs tangent to the vertical flank end-line and the tip line — exactly the
  // arcTo(rightBottom, bottom+depth / rightBottom-r, bottom+depth) construction
  // — plus concave root fillets of `rootR` where the flanks meet the top line.
  function tabPoly(cx, top, depth, width, taper, tipR, rootR = TAB_ROOT_RADIUS_MM) {
    const half = width / 2;
    const r = Math.min(tipR, depth / 2, half - taper);
    const y1 = top + depth;
    const cR = [cx + half - taper - r, y1 - r];
    const cL = [cx - half + taper + r, y1 - r];
    const rp = tabRootParams(depth, width, taper, tipR, rootR);
    const root = side => {
      if (rp.r <= 0) return null;
      const sgn = side === 'R' ? 1 : -1;
      const corner = [cx + sgn * half, top];
      const e1 = [sgn, 0];
      const e2 = [-sgn * taper / rp.Lf, (depth - rp.rTip) / rp.Lf];
      const bx = e1[0] + e2[0], by = e1[1] + e2[1], bl = Math.hypot(bx, by);
      const dC = rp.r / Math.sin(rp.phi / 2);
      const C = [corner[0] + bx / bl * dC, corner[1] + by / bl * dC];
      const T1 = [corner[0] + e1[0] * rp.t, corner[1]];
      const T2 = [corner[0] + e2[0] * rp.t, corner[1] + e2[1] * rp.t];
      const a1 = Math.atan2(T1[1] - C[1], T1[0] - C[0]);
      const a2 = Math.atan2(T2[1] - C[1], T2[0] - C[0]);
      let span = a2 - a1;
      while (span > Math.PI) span -= 2 * Math.PI;
      while (span < -Math.PI) span += 2 * Math.PI;
      return { C, T1, T2, a1, a2: a1 + span, ccw: span > 0 };
    };
    const rR = root('R'), rL = root('L');
    const poly = [];
    if (rR) poly.push(...arcPts(rR.C[0], rR.C[1], rp.r, rR.a1, rR.a2, rR.ccw));
    else poly.push([cx + half, top]);
    poly.push([cx + half - taper, y1 - r]);
    poly.push(...arcPts(cR[0], cR[1], r, 0, Math.PI / 2, true));
    poly.push(...arcPts(cL[0], cL[1], r, Math.PI / 2, Math.PI, true));
    if (rL) poly.push(...arcPts(rL.C[0], rL.C[1], rp.r, rL.a2, rL.a1, !rL.ccw));
    else poly.push([cx - half, top]);
    return poly;
  }

  // ---- cubic Bézier fitting (Schneider-style) --------------------------------
  // Fits a closed polyline with G1-continuous cubics within `tol` mm so the
  // exported contour keeps its shape with a fraction of the anchors. Returns a
  // command loop: [[x,y], ['C',c1x,c1y,c2x,c2y,x,y], ...] (bare points = lines).
  function fitLoopCubics(ptsIn, tol, preTol = 0.12, cornerTurn = 0.6, datumY = null) {
    // de-staircase first: quantisation zig-zag (<=0.11 mm) is below any useful
    // fit tolerance and would force per-point lines otherwise
    const pre = preTol > 0 ? simplifyLoop(ptsIn, preTol) : ptsIn;
    // drop consecutive duplicates (union artifacts) — they destroy tangents
    const pts = [];
    for (const p of pre) {
      const q = pts[pts.length - 1];
      if (!q || Math.hypot(p[0] - q[0], p[1] - q[1]) > 1e-7) pts.push(p);
    }
    while (pts.length > 1 && Math.hypot(pts[0][0] - pts[pts.length - 1][0], pts[0][1] - pts[pts.length - 1][1]) <= 1e-7) pts.pop();
    const n = pts.length;
    if (n < 3) return pts.map(p => p.slice());
    // True corners stay exact anchors (sharp chain boundaries); smooth runs
    // between them become G1 cubics. Turn is measured over a ~0.8 mm window on
    // each side, so 1 px staircase steps (which look like 90 deg between
    // immediate neighbours) average out and do not register as corners.
    const winDir = (i, dir) => {
      let j = i, acc = 0;
      while (acc < 0.8) {
        const k = (j + dir + n) % n;
        if (k === i) break;
        acc += Math.hypot(pts[k][0] - pts[j][0], pts[k][1] - pts[j][1]);
        j = k;
      }
      const dx = pts[j][0] - pts[i][0], dy = pts[j][1] - pts[i][1];
      const L = Math.hypot(dx, dy);
      return L > 1e-9 ? [dir * dx / L, dir * dy / L] : null;
    };
    const corners = [];
    if (cornerTurn < Math.PI) {
      const kept = new Set(simplifyLoop(pts, 0.3).map(p => p[0] + ',' + p[1]));
      for (let i = 0; i < n; i++) {
        if (!kept.has(pts[i][0] + ',' + pts[i][1])) continue;
        const bf = winDir(i, -1), fw = winDir(i, 1);
        if (!bf || !fw) continue;
        const ang = Math.acos(Math.max(-1, Math.min(1, bf[0] * fw[0] + bf[1] * fw[1])));
        if (ang > cornerTurn) corners.push(i);
      }
    }
    // Functional datum rows (the seating plane): a straight run that lies on
    // the datum must become its own chain even when it joins a fillet or arc
    // tangentially. Corner detection cannot see a tangent junction, and a
    // cubic that spans datum-run + fillet splits its least-squares error
    // across both, bowing the run off the datum by up to the fit tolerance.
    // Anchoring the run ends keeps the run exactly straight (a cubic with
    // collinear endpoints and collinear tangents IS the line) while the
    // fillet keeps its own smooth chain.
    if (datumY != null) {
      const on = i2 => Math.abs(pts[i2][1] - datumY) <= 0.02;
      for (let i2 = 0; i2 < n; i2++) {
        if (!on(i2)) continue;
        const prevOn = on((i2 - 1 + n) % n), nextOn = on((i2 + 1) % n);
        if (prevOn && nextOn) continue;              // interior of the run
        // run end: measure the run length along consecutive datum points
        let len = 0, j2 = i2, k2 = i2, seen = 0;
        while (seen < n) { const k3 = (k2 + 1) % n; if (!on(k3)) break; len += Math.hypot(pts[k3][0] - pts[k2][0], pts[k3][1] - pts[k2][1]); k2 = k3; seen++; }
        j2 = i2; let seen2 = 0;
        while (seen2 < n) { const j3 = (j2 - 1 + n) % n; if (!on(j3)) break; len += Math.hypot(pts[j2][0] - pts[j3][0], pts[j2][1] - pts[j3][1]); j2 = j3; seen2++; }
        if (len >= 1.5) { corners.push(i2); corners.push(k2); }
      }
      corners.sort((a, b) => a - b);
      const ded = [];
      for (const c of corners) if (ded[ded.length - 1] !== c) ded.push(c);
      corners.length = 0;
      for (const c of ded) corners.push(c);
    }
    if (!corners.length) corners.push(0);
    const winSeq = (seq, k) => {
      // tangent over a ~0.8 mm window, at least one segment each side
      let i1 = Math.min(seq.length - 1, k + 1), acc = 0;
      while (i1 + 1 < seq.length && acc < 0.8) { acc += Math.hypot(pts[seq[i1 + 1]][0] - pts[seq[i1]][0], pts[seq[i1 + 1]][1] - pts[seq[i1]][1]); i1++; }
      let j1 = Math.max(0, k - 1); acc = 0;
      while (j1 - 1 >= 0 && acc < 0.8) { acc += Math.hypot(pts[seq[j1]][0] - pts[seq[j1 - 1]][0], pts[seq[j1]][1] - pts[seq[j1 - 1]][1]); j1--; }
      const p = pts[seq[j1]], q = pts[seq[i1]];
      let dx = q[0] - p[0], dy = q[1] - p[1];
      const L = Math.hypot(dx, dy) || 1;
      return [dx / L, dy / L];
    };
    const bez = (p0, c1, c2, p1, t) => {
      const u = 1 - t;
      return [u * u * u * p0[0] + 3 * u * u * t * c1[0] + 3 * u * t * t * c2[0] + t * t * t * p1[0],
              u * u * u * p0[1] + 3 * u * u * t * c1[1] + 3 * u * t * t * c2[1] + t * t * t * p1[1]];
    };
    const segs = [];
    function fitChain(seq, u0, u1, depth) {
      // open chain: seq = point indices, endpoints seq[0]/seq[last]
      const a = 0, b = seq.length - 1;
      const p0 = pts[seq[a]], p1 = pts[seq[b]];
      if (b - a < 2 || depth > 26) { segs.push([p0, p1]); return; }
      const ts = [0];
      let acc = 0;
      for (let i = 1; i <= b; i++) { acc += Math.hypot(pts[seq[i]][0] - pts[seq[i - 1]][0], pts[seq[i]][1] - pts[seq[i - 1]][1]); ts.push(acc); }
      if (acc === 0) { segs.push([p0, p1]); return; }
      for (let i = 0; i < ts.length; i++) ts[i] /= acc;
      const u1v = [-u1[0], -u1[1]];
      let A11 = 0, A12 = 0, A22 = 0, B1 = 0, B2 = 0;
      for (let k = 1; k < b; k++) {
        const t = ts[k], u = 1 - t;
        const b1 = [u0[0] * 3 * t * u * u, u0[1] * 3 * t * u * u];
        const b2 = [u1v[0] * 3 * t * t * u, u1v[1] * 3 * t * t * u];
        const B0 = bez(p0, p0, p1, p1, t);
        const d = [pts[seq[k]][0] - B0[0], pts[seq[k]][1] - B0[1]];
        A11 += b1[0] * b1[0] + b1[1] * b1[1];
        A12 += b1[0] * b2[0] + b1[1] * b2[1];
        A22 += b2[0] * b2[0] + b2[1] * b2[1];
        B1 += b1[0] * d[0] + b1[1] * d[1];
        B2 += b2[0] * d[0] + b2[1] * d[1];
      }
      const det = A11 * A22 - A12 * A12;
      let al = null, be = null;
      if (Math.abs(det) > 1e-12) { al = (B1 * A22 - B2 * A12) / det; be = (A11 * B2 - A12 * B1) / det; }
      const chord = Math.hypot(p1[0] - p0[0], p1[1] - p0[1]);
      if (al === null || al < 0 || be < 0 || al > chord * 3 || be > chord * 3) { al = chord / 3; be = chord / 3; }
      const c1 = [p0[0] + u0[0] * al, p0[1] + u0[1] * al];
      const c2 = [p1[0] + u1v[0] * be, p1[1] + u1v[1] * be];
      let worst = 0, wi = -1;
      for (let k = 1; k < b; k++) {
        const B = bez(p0, c1, c2, p1, ts[k]);
        const dd = Math.hypot(pts[seq[k]][0] - B[0], pts[seq[k]][1] - B[1]);
        if (dd > worst) { worst = dd; wi = k; }
      }
      // reverse direction: the curve itself must stay near the chain polyline.
      // Point-wise deviation alone accepts cusps/loops that swing out between
      // the input points; this rejects them and forces a split.
      let rv = 0, rt = 0.5;
      for (let i = 1; i < 16; i++) {
        const B = bez(p0, c1, c2, p1, i / 16);
        let dd = Infinity;
        for (let k = 0; k < b; k++) {
          const q0 = pts[seq[k]], q1 = pts[seq[k + 1]];
          const dx = q1[0] - q0[0], dy = q1[1] - q0[1], l2 = dx * dx + dy * dy;
          let t = 0;
          if (l2 > 0) t = Math.max(0, Math.min(1, ((B[0] - q0[0]) * dx + (B[1] - q0[1]) * dy) / l2));
          const ox = B[0] - (q0[0] + t * dx), oy = B[1] - (q0[1] + t * dy);
          dd = Math.min(dd, ox * ox + oy * oy);
        }
        if (Math.sqrt(dd) > rv) { rv = Math.sqrt(dd); rt = i / 16; }
      }
      // cusp guard: a cubic whose derivative vanishes or whose direction
      // reverses inside the segment folds back into a hairpin spike (the
      // source outline can contain 1 px zero-width slits). Reject it so the
      // chain splits and follows such slits with collinear lines instead.
      let cusp = false, pv = null, psp = 0;
      for (let i = 0; i <= 32 && !cusp; i++) {
        const t = i / 32, u = 1 - t;
        const dx = 3 * (u * u * (c1[0] - p0[0]) + 2 * u * t * (c2[0] - c1[0]) + t * t * (p1[0] - c2[0]));
        const dy = 3 * (u * u * (c1[1] - p0[1]) + 2 * u * t * (c2[1] - c1[1]) + t * t * (p1[1] - c2[1]));
        const sp = Math.hypot(dx, dy);
        if (sp < 1e-7 * Math.max(chord, 1e-6)) { cusp = true; break; }
        if (pv && (pv[0] * dx + pv[1] * dy) / (psp * sp) < -0.178) cusp = true; // >100 deg turn in one 1/32 step
        pv = [dx, dy]; psp = sp;
      }
      if (!cusp && worst <= tol && rv <= tol) { segs.push([p0, c1, c2, p1]); return; }
      if (rv > worst) {
        let bi = a + 1;
        for (let k = 1; k < b; k++) if (Math.abs(ts[k] - rt) < Math.abs(ts[bi] - rt)) bi = k;
        wi = bi;
      }
      if (wi <= a || wi >= b) wi = Math.floor((a + b) / 2);
      const tMid = winSeq(seq, wi);
      fitChain(seq.slice(0, wi + 1), u0, tMid, depth + 1);
      fitChain(seq.slice(wi), tMid, u1, depth + 1);
    }
    // chains between consecutive corners; a single corner means one full loop
    for (let c = 0; c < corners.length; c++) {
      const i0 = corners[c];
      const i1 = corners.length === 1 ? i0 + n : (c + 1 === corners.length ? corners[0] + n : corners[c + 1]);
      const seq = [];
      for (let i = i0; i <= i1; i++) seq.push(i % n);
      fitChain(seq, winSeq(seq, 0), winSeq(seq, seq.length - 1), 0);
    }
    const out = [segs[0][0].slice()];
    for (const sg of segs) {
      if (sg.length === 2) out.push([sg[1][0], sg[1][1]]);
      else out.push(['C', sg[1][0], sg[1][1], sg[2][0], sg[2][1], sg[3][0], sg[3][1]]);
    }
    return out;
  }
  function fitLoopsCubics(loops, tol = FIT_TOL_MM, preTol = 0, cornerTurn = FIT_CORNER_TURN) { return loops.map(l => fitLoopCubics(l, tol, preTol, cornerTurn)); }
  // True when the (flattened) command loop crosses itself. A cut path must be
  // a simple polygon: self-intersections would make the laser cut a hook.
  function loopSelfIntersects(loop, per = 24) {
    const P = flattenCubics(loop, per), n = P.length;
    const A = P, B = P.map((p, i) => P[(i + 1) % n]);
    const bx = new Array(n), by = new Array(n);
    for (let i = 0; i < n; i++) {
      bx[i] = [Math.min(A[i][0], B[i][0]), Math.max(A[i][0], B[i][0])];
      by[i] = [Math.min(A[i][1], B[i][1]), Math.max(A[i][1], B[i][1])];
    }
    const E = 1e-9;
    const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
    for (let i = 0; i < n; i++) {
      for (let j = i + 2; j < n; j++) {
        if (i === 0 && j === n - 1) continue;
        if (bx[i][1] < bx[j][0] - E || bx[j][1] < bx[i][0] - E || by[i][1] < by[j][0] - E || by[j][1] < by[i][0] - E) continue;
        const d1 = cross(A[j], B[j], A[i]), d2 = cross(A[j], B[j], B[i]);
        const d3 = cross(A[i], B[i], A[j]), d4 = cross(A[i], B[i], B[j]);
        if (((d1 > E && d2 < -E) || (d1 < -E && d2 > E)) && ((d3 > E && d4 < -E) || (d3 < -E && d4 > E))) return true;
      }
    }
    return false;
  }
  // Fit only the silhouette-scale loops; parametric tabs/bars/mid loops stay
  // exact polylines so slot fits and analytic radii are untouched. Shorter
  // chains (lower cornerTurn) cannot overshoot into hooks, so retry with more
  // forced corners until the fitted loop is simple; fall back to the exact
  // polyline rather than ever exporting a self-intersecting cut path.
  function fitSelectLoops(loops, tol = FIT_TOL_MM, cornerTurn = FIT_CORNER_TURN, datumY = null) {
    return loops.map((l) => {
      if (l.length < FIT_MIN_POINTS) return l;
      for (const ct of [cornerTurn, 0.5, 0.3, 0.15]) {
        const f = fitLoopCubics(l, tol, 0, ct, datumY);
        if (!loopSelfIntersects(f)) return f;
      }
      return l;
    });
  }
  function loopStats(loops) {
    let anchors = 0, curves = 0;
    for (const l of loops) { anchors += l.length; curves += l.filter(e => e[0] === 'C').length; }
    return { anchors, curves };
  }
  // Dense flatten, for tests and QA overlays.
  function flattenCubics(loop, per = 16) {
    const out = [];
    let cur = loop[0];
    out.push(cur.slice());
    for (const el of loop.slice(1)) {
      if (el[0] === 'C') {
        const c1 = [el[1], el[2]], c2 = [el[3], el[4]], p1 = [el[5], el[6]];
        for (let i = 1; i <= per; i++) {
          const t = i / per, u = 1 - t;
          out.push([u * u * u * cur[0] + 3 * u * u * t * c1[0] + 3 * u * t * t * c2[0] + t * t * t * p1[0],
                    u * u * u * cur[1] + 3 * u * u * t * c1[1] + 3 * u * t * t * c2[1] + t * t * t * p1[1]]);
        }
        cur = p1;
      } else { out.push([el[0], el[1]]); cur = el; }
    }
    return out;
  }

  // Translate a command loop. Bezier entries carry six coordinates, so the
  // naive [x,y] destructure every polygon-only consumer used to apply turns
  // them into NaN garbage (sheet pack, preview, PDF writer).
  function shiftLoops(loops, dx, dy) {
    return (loops || []).map((loop) => loop.map((p) => (p[0] === 'C'
      ? ['C', p[1] + dx, p[2] + dy, p[3] + dx, p[4] + dy, p[5] + dx, p[6] + dy]
      : [p[0] + dx, p[1] + dy])));
  }

  // ---- clipper helpers --------------------------------------------------------
  function toClip(loop) { return loop.map(p => ({ X: Math.round(p[0] * SCALE), Y: Math.round(p[1] * SCALE) })); }
  function fromClip(path) { return path.map(p => [p.X / SCALE, p.Y / SCALE]); }

  function boole(op, subjects, clips, C) {
    const c = new C.Clipper();
    for (const s of subjects) c.AddPath(toClip(s), C.PolyType.ptSubject, true);
    for (const k of clips) c.AddPath(toClip(k), C.PolyType.ptClip, true);
    const out = new C.Paths();
    if (!c.Execute(op, out, C.PolyFillType.pftNonZero, C.PolyFillType.pftNonZero)) return [];
    return out.map(fromClip);
  }
  function unionAll(loops, C) { return boole(C.ClipType.ctUnion, loops, [], C); }
  function difference(a, b, C) { return boole(C.ClipType.ctDifference, a, b, C); }
  function intersect(a, b, C) { return boole(C.ClipType.ctIntersection, a, b, C); }

  function offsetRound(loops, delta, C) {
    const co = new C.ClipperOffset(2, ARC_TOL_MM * SCALE);
    for (const l of loops) co.AddPath(toClip(l), C.JoinType.jtRound, C.EndType.etClosedPolygon);
    const out = new C.Paths();
    co.Execute(out, delta * SCALE);
    return out.map(fromClip);
  }
  function closing(loops, r, C) { return offsetRound(offsetRound(loops, r, C), -r, C); }

  function outerLoops(loops, C) {
    return loops.filter(l => C.Clipper.Area(toClip(l)) > 0);
  }
  function loopArea(loop) {
    let a = 0;
    for (let i = 0; i < loop.length; i++) { const p = loop[i], q = loop[(i + 1) % loop.length]; a += p[0] * q[1] - q[0] * p[1]; }
    return a / 2;
  }
  function bbox(loop) {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const p of loop) { if (p[0] < x0) x0 = p[0]; if (p[0] > x1) x1 = p[0]; if (p[1] < y0) y0 = p[1]; if (p[1] > y1) y1 = p[1]; }
    return { minX: x0, minY: y0, maxX: x1, maxY: y1 };
  }
  function circlePoly(cx, cy, r) { return arcPts(cx, cy, r, 0, 2 * Math.PI, true); }

  // ---- full chain -------------------------------------------------------------
  // cfg: { outlineLoopsMm, cxMm, topMm, bottomMm, upperEndMm, scaffold:{shape,
  //   scaffoldWidthMm, nominalDimensionMm, cornerRadiusMm}, gapMm, speckMm2,
  //   tab:{width,depth,taper,tipR}, blendRadiusMm=5, blendSmoothMm=1.5 }
  function buildCutVector(cfg, C) {
    const simp = cfg.outlineLoopsMm.map(l => simplifyLoop(l, cfg.simplifyTolMm || SIMPLIFY_TOL_MM));
    let base = outerLoops(unionAll(simp, C), C);
    const sc = cfg.scaffold;
    // The tab hangs directly off the silhouette bottom row; the scaffold
    // rectangle stops at the same line so no shelf fragment survives there.
    const tabTopMm = cfg.tabTopMm ?? cfg.bottomMm;
    const scaffoldPoly = sc.shape === 'triangle'
      ? roundedTrianglePoly(cfg.cxMm, cfg.bottomMm, sc.nominalDimensionMm, sc.cornerRadiusMm)
      : roundedRectPoly(cfg.cxMm, cfg.topMm, tabTopMm, sc.scaffoldWidthMm, sc.cornerRadiusMm);
    // 8-connected raster fragments can hang together by a corner; close each
    // vector fragment at 0.12 mm so such pinches merge and the pocket between
    // the arms becomes an enclosed hole (filled below), like fillHoles does.
    const frags = difference([scaffoldPoly], base, C)
      .map(f => closing([f], 0.2, C))
      .flat();
    const kept = [];
    let keptCells = 0, droppedCells = 0;
    for (const f of frags) {
      const bb = bbox(f);
      if (Math.abs(loopArea(f)) < 1e-6) continue;
      if (bb.minY <= cfg.upperEndMm) droppedCells++;
      else { keptCells++; kept.push(f); }
    }
    let cur = unionAll(base.concat(kept), C);
    // Morphological closing, vector form: only the concave gap-fill patches
    // are unioned back, so convex silhouette vertices never sprout offset arcs
    // and the point count stays minimal. When the caller supplies patches
    // traced from the raster closing they are used verbatim (exact parity with
    // the shipped mask behaviour, including its pixel-centred fill threshold);
    // otherwise the closing is reproduced with round joins.
    const tol = cfg.simplifyTolMm || SIMPLIFY_TOL_MM;
    // Traced+simplified patches can self-intersect at 1 px slivers; resolve
    // them before the union so no needle artifacts enter the cut contour.
    // Self-intersections from simplifying 1 px slivers are resolved, but the
    // patch shape itself is kept verbatim: it IS the raster morphology delta.
    const cleanPatches = list => (list || [])
      .map(p => C.Clipper.SimplifyPolygon(toClip(p), C.PolyFillType.pftNonZero).map(fromClip))
      .flat()
      .filter(p => {
        if (p.length < 3 || Math.abs(loopArea(p)) < 0.02) return false;
        const bb = bbox(p);
        // 1 px hairline slivers of the raster morphology only reproduce staircase
        // quantisation; real gap fills are thicker than a mask pixel.
        return Math.min(bb.maxX - bb.minX, bb.maxY - bb.minY) >= 0.16;
      });
    if (cfg.closingPatches && cfg.closingPatches.length) {
      cur = unionAll(cur.concat(cleanPatches(cfg.closingPatches)), C);
    } else if (cfg.gapMm > 0) {
      const bridges = difference(closing(cur, cfg.gapMm / 2, C), cur, C)
        .filter(b => Math.abs(loopArea(b)) > 1e-6)
        .map(b => simplifyLoop(b, tol));
      if (bridges.length) cur = unionAll(cur.concat(bridges), C);
    }
    // junction blend: inside 5 mm disks at the scaffold-edge crossings the
    // raster chain substitutes a 1.5 mm closing. The added slivers are passed
    // in as patches (traced from the raster blend) or reproduced here.
    if (cfg.blendPatches && cfg.blendPatches.length) {
      cur = unionAll(cur.concat(cleanPatches(cfg.blendPatches)), C);
    } else {
      const xs = [cfg.cxMm - sc.scaffoldWidthMm / 2, cfg.cxMm + sc.scaffoldWidthMm / 2];
      const disks = [];
      for (const x of xs) {
        const probe = [[x - 0.01, cfg.topMm - 50], [x + 0.01, cfg.topMm - 50], [x + 0.01, cfg.bottomMm + 50], [x - 0.01, cfg.bottomMm + 50]];
        const hits = intersect(cur, [probe], C);
        for (const hb of hits) {
          const bb = bbox(hb);
          disks.push(circlePoly(x, bb.minY, cfg.blendRadiusMm || 5), circlePoly(x, bb.maxY, cfg.blendRadiusMm || 5));
        }
      }
      if (disks.length) {
        const smoothInDisks = intersect(closing(cur, cfg.blendSmoothMm || 1.5, C), disks, C);
        const add = difference(smoothInDisks, cur, C)
          .filter(b => Math.abs(loopArea(b)) > 1e-6)
          .map(b => simplifyLoop(b, tol));
        if (add.length) cur = unionAll(cur.concat(add), C);
      }
    }
    if (cfg.barRectMm) {
      // Last-resort 1 px bridge row, only when the raster needed it too.
      cur = unionAll(cur.concat([roundedRectPoly(cfg.cxMm, cfg.barRectMm.top, cfg.barRectMm.bottom, sc.scaffoldWidthMm, Math.min(0.5, sc.cornerRadiusMm))]), C);
    }
    const tab = tabPoly(cfg.cxMm, tabTopMm, cfg.tab.depth, cfg.tab.width, cfg.tab.taper, cfg.tab.tipR);
    cur = unionAll(cur.concat([tab]), C);
    let outers = outerLoops(cur, C).filter(l => Math.abs(loopArea(l)) >= (cfg.speckMm2 || 1));
    // The seating plane (the row the tab hangs off, tabTopMm — the same line
    // the scaffold rectangle and the tab top use) is a functional datum: its
    // straight runs stay their own fit chains so no cubic can bow them off
    // the line (a bow rests on the base top beside the slot and stops the
    // tab from seating). See the datum-run anchoring in fitLoopCubics.
    if (cfg.fitTolMm > 0) outers = fitSelectLoops(outers, cfg.fitTolMm, cfg.fitCornerTurn == null ? FIT_CORNER_TURN : cfg.fitCornerTurn, tabTopMm);
    return { loops: outers, keptCells, droppedCells, simplifiedFrom: cfg.outlineLoopsMm.reduce((a, l) => a + l.length, 0), prefit: cur };
  }

  return {
    SCALE, ARC_TOL_MM, SIMPLIFY_TOL_MM, FIT_TOL_MM, FIT_CORNER_TURN, FIT_MIN_POINTS,
    rdpOpen, simplifyLoop, loopDeviation, fitLoopCubics, fitLoopsCubics, fitSelectLoops, loopStats, loopSelfIntersects, flattenCubics, shiftLoops,
    roundedTrianglePoly, roundedRectPoly, tabPoly, tabRootParams, TAB_ROOT_RADIUS_MM, circlePoly,
    unionAll, difference, intersect, offsetRound, closing, outerLoops, loopArea, bbox,
    buildCutVector
  };
});
