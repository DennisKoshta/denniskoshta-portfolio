// engine/records.mjs (ENGINE): the record index with a byte budget and decimation (explorer-spec §8.3 step 5).
//
// Record ordinal 0 = the start configuration; ordinal j >= 1 = the j-th record (a step that moved the head onto a
// new cell, side L or R). While entries * BYTES_PER_ENTRY <= recBudgetBytes every record is kept (r = 0); beyond
// that r += 1 and every 2nd stored entry is dropped, so stored entry e is ordinal e * 2^r.
//   RecordBatcher (run worker): collects (step, side) of kept ordinals and posts `records` / `recStride`.
//   RecordIndex   (facade):     the stored entries; exact steps per side while r = 0.
import { LIMITS } from '../core/protocol.mjs';

export const BYTES_PER_ENTRY = 9;      // Float64 step + Uint8 side

function grow(a, n) {
  if (n <= a.length) return a;
  const b = new a.constructor(Math.max(n, a.length * 2, 256));
  b.set(a);
  return b;
}

export class RecordBatcher {
  /** post(msg) sends a message object; transfer handled by the caller via msg.transfer */
  constructor(sid, post, limits = LIMITS) {
    this.sid = sid; this.post = post;
    this.budget = limits.recBudgetBytes;
    this.r = 0;
    this.count = 0;          // records seen (LR)
    this.countL = 0;
    this.steps = new Float64Array(256); this.sides = new Uint8Array(256); this.n = 0;
    this.from = 1;           // stored-entry index of the first pending entry (entry 0 = start, kept by the facade)
  }
  /** called for every record: t = step, side 0 = L, 1 = R */
  add(t, side) {
    const o = ++this.count;
    if (side === 0) this.countL++;
    if (o % 2 ** this.r !== 0) return;
    if (this.n === this.steps.length) { this.steps = grow(this.steps, this.n + 1); this.sides = grow(this.sides, this.n + 1); }
    this.steps[this.n] = t; this.sides[this.n] = side; this.n++;
    const entries = Math.floor(this.count / 2 ** this.r) + 1;
    if (entries * BYTES_PER_ENTRY > this.budget) {
      this.flush();
      this.r += 1;
      this.from = Math.floor(this.count / 2 ** this.r) + 1;
      this.post({ type: 'recStride', sid: this.sid, r: this.r });
    }
  }
  flush() {
    if (!this.n) return;
    const steps = this.steps.slice(0, this.n), sides = this.sides.slice(0, this.n);
    this.post({ type: 'records', sid: this.sid, r: this.r, from: this.from, steps, sides }, [steps.buffer, sides.buffer]);
    this.from += this.n;
    this.n = 0;
  }
}

export class RecordIndex {
  constructor(s0) {
    this.r = 0;
    this.steps = new Float64Array(1024); this.sides = new Uint8Array(1024);
    this.steps[0] = s0; this.sides[0] = 2;
    this.len = 1;
    this.side = { L: null, R: null };     // r = 0 per-side lookup: Float64Array of steps, ordinal j -> [j]
    this.sideLen = { L: 1, R: 1 }; this.scanned = { L: 1, R: 1 };
  }
  get bytes() { return this.len * BYTES_PER_ENTRY; }
  append(msg) {
    if (msg.r !== this.r || msg.from !== this.len) {
      throw Object.assign(new Error(`record index out of sync (r ${msg.r}/${this.r}, from ${msg.from}/${this.len})`), { code: 'E_INTERNAL' });
    }
    const n = msg.steps.length;
    this.steps = grow(this.steps, this.len + n); this.sides = grow(this.sides, this.len + n);
    this.steps.set(msg.steps, this.len); this.sides.set(msg.sides, this.len);
    this.len += n;
  }
  setStride(r) {
    while (this.r < r) {
      let k = 0;
      for (let e = 0; e < this.len; e += 2) { this.steps[k] = this.steps[e]; this.sides[k] = this.sides[e]; k++; }
      this.len = k; this.r++;
    }
    this.side = { L: null, R: null };
  }
  /** Step of LR ordinal b if stored, else NaN. */
  stepLR(b) {
    const S = 2 ** this.r;
    if (b % S !== 0) return NaN;
    const e = b / S;
    return e < this.len ? this.steps[e] : NaN;
  }
  _sideIndex(sd) {
    // r = 0 only: steps of the side's records in order, index j = ordinal j (index 0 = start)
    const code = sd === 'L' ? 0 : 1;
    let a = this.side[sd];
    if (!a) { a = this.side[sd] = new Float64Array(Math.max(256, this.len)); a[0] = this.steps[0]; this.sideLen[sd] = 1; this.scanned[sd] = 1; }
    let n = this.sideLen[sd];
    for (let e = this.scanned[sd]; e < this.len; e++) {
      if (this.sides[e] === code) { if (n === a.length) { a = this.side[sd] = grow(a, n + 1); } a[n++] = this.steps[e]; }
    }
    this.sideLen[sd] = n; this.scanned[sd] = this.len;
    return a;
  }
  /** Step of ordinal b of the side ('LR'|'L'|'R'), or NaN if not stored / not known. */
  step(side, b) {
    if (side === 'LR' || side === undefined) return this.stepLR(b);
    if (this.r !== 0) return NaN;
    const a = this._sideIndex(side);
    return b < this.sideLen[side] ? a[b] : NaN;
  }
  /** Number of stored ordinals of the side (r = 0), incl. the start: last ordinal + 1. */
  countKnown(side) {
    if (side === 'LR' || side === undefined) return this.r === 0 ? this.len : NaN;
    if (this.r !== 0) return NaN;
    this._sideIndex(side);
    return this.sideLen[side];
  }
  /** Last ordinal of the side with step <= t (r = 0), -1 never (ordinal 0 = start). */
  ordinalAtStep(side, t) {
    let a, n;
    if (side === 'LR' || side === undefined) { a = this.steps; n = this.len; }
    else { a = this._sideIndex(side); n = this.sideLen[side]; }
    let lo = 0, hi = n - 1, r = -1;
    while (lo <= hi) { const mid = (lo + hi) >> 1; if (a[mid] <= t) { r = mid; lo = mid + 1; } else hi = mid - 1; }
    return r;
  }
}
