// engine/checkpoints.mjs (ENGINE): checkpoint bit-packing, the stride rule and the facade's CheckpointStore
// (explorer-spec §8.3-§8.4).
//
// A Checkpoint (core/types.mjs) packs cells lo..hi LSB-first at bitsPerCell bits (1 for m = 2, 2 for m <= 4,
// 4 for m <= 16); a fresh head cell is stored as 0. Engine-internal extra fields ride along:
//   sdir  sim.py direction (+1/-1) of the last move, or of the start configuration (dir is 0 on the start row)
//   rec, recL  records (LR, L only) with step <= t; s0 the run's start step
import { LIMITS } from '../core/protocol.mjs';

export function bitsPerCell(m) { return m <= 2 ? 1 : m <= 4 ? 2 : 4; }
export function packedBytes(len, b) { return Math.ceil((len * b) / 8); }

/** Pack src[i0 .. i0+len) at b bits per cell into a new ArrayBuffer. */
export function pack(src, i0, len, b) {
  const out = new Uint8Array(packedBytes(len, b));
  if (b === 1) {
    const full = len >> 3;
    let i = i0;
    for (let k = 0; k < full; k++, i += 8) {
      out[k] = src[i] | (src[i + 1] << 1) | (src[i + 2] << 2) | (src[i + 3] << 3)
        | (src[i + 4] << 4) | (src[i + 5] << 5) | (src[i + 6] << 6) | (src[i + 7] << 7);
    }
    for (let j = full << 3; j < len; j++) out[j >> 3] |= src[i0 + j] << (j & 7);
  } else if (b === 2) {
    const full = len >> 2;
    let i = i0;
    for (let k = 0; k < full; k++, i += 4) out[k] = src[i] | (src[i + 1] << 2) | (src[i + 2] << 4) | (src[i + 3] << 6);
    for (let j = full << 2; j < len; j++) out[j >> 2] |= src[i0 + j] << ((j & 3) << 1);
  } else {
    const full = len >> 1;
    let i = i0;
    for (let k = 0; k < full; k++, i += 2) out[k] = src[i] | (src[i + 1] << 4);
    if (len & 1) out[full] = src[i0 + len - 1];
  }
  return out.buffer;
}

/** Unpack len cells from bits (ArrayBuffer|Uint8Array) into dst[o .. o+len). */
export function unpack(bits, b, len, dst, o) {
  const src = bits instanceof Uint8Array ? bits : new Uint8Array(bits);
  if (b === 1) {
    const full = len >> 3;
    let i = o;
    for (let k = 0; k < full; k++, i += 8) {
      const v = src[k];
      dst[i] = v & 1; dst[i + 1] = (v >> 1) & 1; dst[i + 2] = (v >> 2) & 1; dst[i + 3] = (v >> 3) & 1;
      dst[i + 4] = (v >> 4) & 1; dst[i + 5] = (v >> 5) & 1; dst[i + 6] = (v >> 6) & 1; dst[i + 7] = v >> 7;
    }
    for (let j = full << 3; j < len; j++) dst[o + j] = (src[j >> 3] >> (j & 7)) & 1;
  } else if (b === 2) {
    const full = len >> 2;
    let i = o;
    for (let k = 0; k < full; k++, i += 4) {
      const v = src[k];
      dst[i] = v & 3; dst[i + 1] = (v >> 2) & 3; dst[i + 2] = (v >> 4) & 3; dst[i + 3] = v >> 6;
    }
    for (let j = full << 2; j < len; j++) dst[o + j] = (src[j >> 2] >> ((j & 3) << 1)) & 3;
  } else {
    const full = len >> 1;
    let i = o;
    for (let k = 0; k < full; k++, i += 2) { const v = src[k]; dst[i] = v & 15; dst[i + 1] = v >> 4; }
    if (len & 1) dst[o + len - 1] = src[full] & 15;
  }
  return dst;
}

/** Initial stride exponent c for a run of `steps` steps (§8.3 step 1): c = 16 at 1e8, 19 at 1e9. */
export function initialStride(steps, limits = LIMITS) {
  const want = Math.ceil(Math.log2(Math.max(1, steps) / limits.ckptMaxCount));
  return Math.max(limits.ckptC0Min, Number.isFinite(want) ? want : limits.ckptC0Min);
}

/** The stride rule: does a store with `count` checkpoints of `bytes` total need c += 1? */
export function overBudget(count, bytes, limits = LIMITS) {
  return count > limits.ckptMaxCount || bytes > limits.ckptBudgetBytes;
}

/** Facade-side store: checkpoints sorted by t, with their overview rows and engine extras. */
export class CheckpointStore {
  constructor(s0) {
    this.s0 = s0;
    this.c = 0;
    this.list = [];          // Checkpoint objects, ascending t
    this.bytes = 0;
  }
  add(ck) {
    const L = this.list;
    if (L.length && L[L.length - 1].t >= ck.t) {
      // out-of-order or duplicate (should not happen): insert in place
      const i = this.indexAtOrBefore(ck.t);
      if (i >= 0 && L[i].t === ck.t) { this.bytes -= L[i].bits.byteLength; L[i] = ck; this.bytes += ck.bits.byteLength; return; }
      L.splice(i + 1, 0, ck);
    } else L.push(ck);
    this.bytes += ck.bits.byteLength;
  }
  /** Drop checkpoints whose t - s0 is not a multiple of 2^c; returns the dropped ones. */
  setStride(c) {
    this.c = c;
    const step = 2 ** c, keep = [], dropped = [];
    for (const ck of this.list) {
      if ((ck.t - this.s0) % step === 0) keep.push(ck); else { dropped.push(ck); this.bytes -= ck.bits.byteLength; }
    }
    this.list = keep;
    return dropped;
  }
  get count() { return this.list.length; }
  last() { return this.list[this.list.length - 1] || null; }
  /** Index of the latest checkpoint with ck.t <= t, or -1. */
  indexAtOrBefore(t) {
    const L = this.list;
    let a = 0, b = L.length - 1, r = -1;
    while (a <= b) {
      const mid = (a + b) >> 1;
      if (L[mid].t <= t) { r = mid; a = mid + 1; } else b = mid - 1;
    }
    return r;
  }
  atOrBefore(t) { const i = this.indexAtOrBefore(t); return i >= 0 ? this.list[i] : null; }
  byId(id) {
    for (const ck of this.list) if (ck.id === id) return ck;
    return null;
  }
}

/** SeekRef (wire form, §7) for a checkpoint; bits attached by the caller when the worker lacks them. */
export function seekRef(sid, ck, withBits) {
  const r = {
    ckptId: ck.id, sid, t: ck.t, q: ck.q, pos: ck.pos, lo: ck.lo, hi: ck.hi, dir: ck.dir, fresh: ck.fresh, tr: ck.tr,
    bitsPerCell: ck.bitsPerCell, sdir: ck.sdir, s0: ck.s0, rec: ck.rec, recL: ck.recL, nbytes: ck.bits.byteLength,
  };
  if (withBits) r.bits = ck.bits;
  return r;
}
