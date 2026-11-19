'use strict';

// Millimetre-space geometry shared by the nesting preview and PDF exporter.
const BASE = Object.freeze({ sizeMm: 35, cornerRadiusMm: 3, slotLengthMm: 33, nominalSlotWidthMm: 3, angleDeg: 45 });

function roundedRectPath(size = BASE.sizeMm, radius = BASE.cornerRadiusMm, segments = 8) {
  if (!(size > 0) || radius < 0 || radius > size / 2) throw new RangeError('Invalid base dimensions');
  const pts = [];
  const corners = [[size-radius,radius,-90],[size-radius,size-radius,0],[radius,size-radius,90],[radius,radius,180]];
  for (const [cx,cy,start] of corners) {
    for (let i=0;i<=segments;i++) {
      const a=(start+i*90/segments)*Math.PI/180;
      pts.push([cx+radius*Math.cos(a),cy+radius*Math.sin(a)]);
    }
  }
  return pts;
}

function capsulePath(length, width, angleDeg = 45, centerX = 17.5, centerY = 17.5, segments = 12) {
  if (!(length > width && width > 0)) throw new RangeError('Slot length must exceed positive slot width');
  const r=width/2, straight=length/2-r, a=angleDeg*Math.PI/180;
  const ux=Math.cos(a), uy=Math.sin(a), nx=-uy, ny=ux, pts=[];
  // Clockwise round ends; polygon is closed by the caller.
  for(let i=0;i<=segments;i++){
    const t=-Math.PI/2+i*Math.PI/segments;
    const along=straight+r*Math.cos(t), across=r*Math.sin(t);
    pts.push([centerX+ux*along+nx*across,centerY+uy*along+ny*across]);
  }
  for(let i=0;i<=segments;i++){
    const t=Math.PI/2+i*Math.PI/segments;
    const along=-straight+r*Math.cos(t), across=r*Math.sin(t);
    pts.push([centerX+ux*along+nx*across,centerY+uy*along+ny*across]);
  }
  return pts;
}

function createBaseGeometry(toleranceMm = 0.3) {
  const tolerance=Number(toleranceMm);
  if (!Number.isFinite(tolerance) || tolerance < 0 || tolerance >= BASE.nominalSlotWidthMm) {
    throw new RangeError('Tolerance must be at least 0 and less than 3 mm');
  }
  const slotWidthMm=BASE.nominalSlotWidthMm-tolerance;
  return {
    widthMm: BASE.sizeMm, heightMm: BASE.sizeMm,
    outer: roundedRectPath(),
    slit: capsulePath(BASE.slotLengthMm,slotWidthMm,BASE.angleDeg),
    slotWidthMm, slotLengthMm: BASE.slotLengthMm, angleDeg: BASE.angleDeg,
    cornerRadiusMm: BASE.cornerRadiusMm,
  };
}

if (typeof module !== 'undefined') module.exports={BASE,roundedRectPath,capsulePath,createBaseGeometry};
if (typeof window !== 'undefined') window.OutlineNestingGeometry={BASE,roundedRectPath,capsulePath,createBaseGeometry};
