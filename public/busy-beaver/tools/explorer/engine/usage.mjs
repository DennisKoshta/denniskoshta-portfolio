// engine/usage.mjs (ENGINE): the UsageIndex (explorer-spec §8.6): per checkpoint interval, the firing counts of all
// n*m transitions, computed lazily by `usage` jobs (count variant) over the tile pool; prefix sums give the event
// count at every checkpoint for state and transition rows, and exact usage(t0, t1) tables.
//
// Intervals are stored as pieces keyed by their start step (t0 -> {t1, counts}); an interval between two current
// checkpoints is the chain of pieces from t0 to t1, so pieces survive stride changes (pairwise merges) unchanged.

export class UsageIndex {
  constructor(nm) {
    this.nm = nm;
    this.pieces = new Map();       // t0 -> [{t1, counts}] (a few lengths per start)
    this.inflight = new Set();     // `${t0}:${t1}`
  }
  put(t0, t1, counts) {
    let a = this.pieces.get(t0);
    if (!a) this.pieces.set(t0, (a = []));
    if (!a.some((p) => p.t1 === t1)) a.push({ t1, counts });
    this.inflight.delete(`${t0}:${t1}`);
  }
  /** Firing counts in (t0, t1] from stored pieces, or null if not covered. */
  get(t0, t1) {
    if (t0 === t1) return new Float64Array(this.nm);
    const direct = (this.pieces.get(t0) || []).find((p) => p.t1 === t1);
    if (direct) return direct.counts;
    // chain: greedy longest piece not overshooting t1, with backtracking-free fallback
    const out = new Float64Array(this.nm);
    let t = t0;
    while (t < t1) {
      const a = this.pieces.get(t);
      if (!a) return null;
      let best = null;
      for (const p of a) if (p.t1 <= t1 && (!best || p.t1 > best.t1)) best = p;
      if (!best) return null;
      for (let i = 0; i < this.nm; i++) out[i] += best.counts[i];
      t = best.t1;
    }
    return out;
  }
  has(t0, t1) { return this.get(t0, t1) !== null; }
  /** Missing intervals among consecutive checkpoint steps ts[] (ascending), not in flight. */
  missing(ts) {
    const out = [];
    for (let i = 0; i + 1 < ts.length; i++) {
      const a = ts[i], b = ts[i + 1];
      if (!this.has(a, b) && !this.inflight.has(`${a}:${b}`)) out.push([a, b]);
    }
    return out;
  }
  covered(ts) {
    for (let i = 0; i + 1 < ts.length; i++) if (!this.has(ts[i], ts[i + 1])) return false;
    return true;
  }
  /** Prefix event counts at checkpoints: E[i] = sum over (ts[0], ts[i]] of counts . mask; null if not covered. */
  prefix(ts, mask) {
    const E = new Float64Array(ts.length);
    let acc = 0;
    for (let i = 1; i < ts.length; i++) {
      const c = this.get(ts[i - 1], ts[i]);
      if (!c) return null;
      for (let k = 0; k < this.nm; k++) if (mask[k]) acc += c[k];
      E[i] = acc;
    }
    return E;
  }
  /** Prefix event counts over the longest covered prefix of ts: Float64Array of length >= 1 (E[0] = 0). */
  prefixPartial(ts, mask) {
    const E = [0];
    let acc = 0;
    for (let i = 1; i < ts.length; i++) {
      const c = this.get(ts[i - 1], ts[i]);
      if (!c) break;
      for (let k = 0; k < this.nm; k++) if (mask[k]) acc += c[k];
      E.push(acc);
    }
    return Float64Array.from(E);
  }
  get bytes() { let n = 0; for (const a of this.pieces.values()) n += a.length * (this.nm * 8 + 16); return n; }
}

/** Events selected by mask in a counts table. */
export function maskedSum(counts, mask) {
  let s = 0;
  for (let k = 0; k < mask.length; k++) if (mask[k]) s += counts[k];
  return s;
}
