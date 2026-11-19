'use strict';

/*
 * Binary mask run-length coding.
 * Packed form: [initialValue, varint run, varint run, ...] with alternating values.
 * Single responsibility: mask <-> bytes. No canvas, no DOM, no geometry.
 */

function packMask(mask) {
  if (!mask || !mask.length) return Uint8Array.of(0, 0);
  const out = [mask[0] ? 1 : 0];
  let value = mask[0] ? 1 : 0;
  let run = 0;
  const flush = () => {
    let n = run;
    while (n >= 128) { out.push((n % 128) | 128); n = Math.floor(n / 128); }
    out.push(n);
  };
  for (let i = 0; i < mask.length; i++) {
    const v = mask[i] ? 1 : 0;
    if (v === value) { run++; continue; }
    flush();
    value = v;
    run = 1;
  }
  flush();
  return Uint8Array.from(out);
}

function unpackMask(bytes, length) {
  const out = new Uint8Array(length);
  if (!bytes || !bytes.length) return out;
  let value = bytes[0] ? 1 : 0;
  let i = 1;
  let pos = 0;
  while (i < bytes.length && pos < length) {
    let n = 0;
    let mul = 1;
    let b;
    do {
      b = bytes[i++];
      n += (b & 127) * mul;
      mul *= 128;
    } while ((b & 128) && i < bytes.length);
    out.fill(value, pos, Math.min(length, pos + n));
    pos += n;
    value = value ? 0 : 1;
  }
  return out;
}

if (typeof module !== 'undefined') module.exports = { packMask, unpackMask };
if (typeof window !== 'undefined') window.OutlineRle = { packMask, unpackMask };
