// engine/pool.mjs (ENGINE): pooled planes for kx < 0 tiles (explorer-spec §5.4), also used by the overview.
//
// Texel c of tile tx covers anchor-relative cells u in [(256*tx + c)*cx, (256*tx + c + 1)*cx) (floor-aligned at the
// anchor). Only READ cells count: the span minus a fresh head cell (BBD defined()); unread = cx - vis.
//   vis        read cells in the texel
//   cnt:k      read cells holding symbol k (k = 1..m-1)
//   near       symbol of the read cell nearest the anchor (smallest u if u >= 0, largest u if u < 0); UNREAD if none
//   pat:W      x in the texel with cells x..x+|W|-1 all read and equal to W (overlapping occurrences count)
//   pat:W@k.p  as pat:W, only x = p (mod k) in ABSOLUTE cells
//   blk:k.p.W1+W2  k-blocks [x, x+k), x = p (mod k) absolute, x in the texel, all read, word not in {W1, W2, ...}
import { TILE, UNREAD, LIMITS } from '../core/protocol.mjs';

const mod = (a, k) => ((a % k) + k) % k;

/** 'W' or 'W@k.p' -> {key:'pat:...', w:Uint8Array, k, p} or throws a message string */
export function parsePattern(s, m) {
  const mo = /^([0-9]{1,8})(?:@([0-9]+)\.([0-9]+))?$/.exec(String(s));
  if (!mo) throw new Error(`bad pattern ${JSON.stringify(s)} (W or W@k.p, |W| <= ${LIMITS.maxPatternLen})`);
  const w = Uint8Array.from(mo[1], (c) => c.charCodeAt(0) - 48);
  if (w.some((d) => d >= m)) throw new Error(`pattern ${s} uses a symbol >= ${m}`);
  const k = mo[2] === undefined ? 1 : +mo[2], p = mo[3] === undefined ? 0 : +mo[3];
  if (k < 1 || p >= k) throw new Error(`pattern ${s}: need k >= 1 and 0 <= p < k`);
  return { key: `pat:${s}`, w, k, p };
}

/** Parse a request's pattern list, dropping duplicates (same plane key). */
export function parsePatterns(list, m) {
  const out = [], seen = new Set();
  for (const s of list || []) {
    const pt = parsePattern(s, m);
    if (!seen.has(pt.key)) { seen.add(pt.key); out.push(pt); }
  }
  return out;
}

export function blkKey(blk) { return `blk:${blk.k}.${blk.p}.${blk.words.join('+')}`; }

/** {k, p, words} -> {key, k, p, bg:Uint8Array(m^k) with 1 = background word} or throws */
export function parseBlk(blk, m) {
  const k = blk.k | 0, p = blk.p | 0;
  if (k < 1 || k > LIMITS.maxBlockK || p < 0 || p >= k) throw new Error(`bad k-block k=${blk.k} p=${blk.p}`);
  const bg = new Uint8Array(m ** k);
  for (const wd of blk.words || []) {
    if (typeof wd !== 'string' || wd.length !== k || ![...wd].every((c) => c >= '0' && c < String.fromCharCode(48 + m))) {
      throw new Error(`bad k-block word ${JSON.stringify(wd)}`);
    }
    let code = 0;
    for (const c of wd) code = code * m + (c.charCodeAt(0) - 48);
    bg[code] = 1;
  }
  return { key: blkKey(blk), k, p, bg };
}

export function pooledDtype(cx) { return cx <= 32768 ? 'u16' : 'u32'; }

/** Plane arrays for `rows` rows of 256 texels. */
export function makePlanes(m, cx, pats, blk, rows = TILE) {
  const T = pooledDtype(cx) === 'u16' ? Uint16Array : Uint32Array;
  const N = rows * TILE;
  const planes = { vis: new T(N) };
  for (let k = 1; k < m; k++) planes[`cnt:${k}`] = new T(N);
  planes.near = new Uint8Array(N).fill(UNREAD);
  for (const pt of pats) planes[pt.key] = new T(N);
  if (blk) planes[blk.key] = new T(N);
  return planes;
}

/**
 * Pool one configuration row into planes[row*256 ..]. The configuration is read from `tape` with `org`
 * (tape[p + org] = cell p); read cells are dlo..dhi. W0 = absolute first cell of texel 0; texel c is "u >= 0"
 * iff c0 + c >= 0 where c0 = the texel index of texel 0 relative to the anchor (256*tx for tiles).
 */
export function poolRow(tape, org, dlo, dhi, W0, c0, cx, m, planes, row, pats, blk, ncols = TILE) {
  const base = row * ncols;
  const vis = planes.vis, near = planes.near;
  const Wend = W0 + ncols * cx - 1;
  const xa = Math.max(W0, dlo), xb = Math.min(Wend, dhi);
  if (xa > xb) return;
  const ca = Math.floor((xa - W0) / cx), cb = Math.floor((xb - W0) / cx);
  if (m === 2) {
    const c1 = planes['cnt:1'];
    for (let c = ca; c <= cb; c++) {
      const ts = W0 + c * cx;
      const a = ts > dlo ? ts : dlo, b = ts + cx - 1 < dhi ? ts + cx - 1 : dhi;
      let ones = 0;
      for (let i = a + org, e = b + org; i <= e; i++) ones += tape[i];
      vis[base + c] = b - a + 1;
      c1[base + c] = ones;
      near[base + c] = c0 + c >= 0 ? tape[a + org] : tape[b + org];
    }
  } else {
    const cnts = [];
    for (let k = 1; k < m; k++) cnts.push(planes[`cnt:${k}`]);
    const hist = new Float64Array(m);
    for (let c = ca; c <= cb; c++) {
      const ts = W0 + c * cx;
      const a = ts > dlo ? ts : dlo, b = ts + cx - 1 < dhi ? ts + cx - 1 : dhi;
      hist.fill(0);
      for (let i = a + org, e = b + org; i <= e; i++) hist[tape[i]]++;
      vis[base + c] = b - a + 1;
      for (let k = 1; k < m; k++) cnts[k - 1][base + c] = hist[k];
      near[base + c] = c0 + c >= 0 ? tape[a + org] : tape[b + org];
    }
  }
  for (const pt of pats) {
    const P = planes[pt.key], w = pt.w, L = w.length;
    let x = xa;
    const xe = Math.min(Wend, dhi - L + 1);
    if (pt.k > 1) x += mod(pt.p - x, pt.k);
    const step = pt.k, w0 = w[0];
    for (; x <= xe; x += step) {
      const i = x + org;
      if (tape[i] !== w0) continue;
      let ok = true;
      for (let j = 1; j < L; j++) if (tape[i + j] !== w[j]) { ok = false; break; }
      if (ok) P[base + Math.floor((x - W0) / cx)]++;
    }
  }
  if (blk) {
    const P = planes[blk.key], k = blk.k, bg = blk.bg;
    let x = xa + mod(blk.p - xa, k);
    const xe = Math.min(Wend, dhi - k + 1);
    for (; x <= xe; x += k) {
      const i = x + org;
      let code = 0;
      for (let j = 0; j < k; j++) code = code * m + tape[i + j];
      if (!bg[code]) P[base + Math.floor((x - W0) / cx)]++;
    }
  }
}

// ------------------------------------------------------------------------------------------------
// Overview (explorer-spec §5.5, §8.3 step 4): one pooled abs-frame row per checkpoint
// ------------------------------------------------------------------------------------------------

/** Smallest j whose texel range over [lo, hi] has <= maxCols columns. */
export function overviewLevel(lo, hi, maxCols = LIMITS.ovMaxCols) {
  let j = 0;
  while (Math.floor(hi / 2 ** j) - Math.floor(lo / 2 ** j) + 1 > maxCols) j++;
  return j;
}

/** Overview row of a Sim's configuration: {j, u0, cols, cnt:[ArrayBuffer...], vis, near} (u32 planes). */
export function overviewRow(sim, maxCols = LIMITS.ovMaxCols) {
  const lo = sim.lo, hi = sim.hi, m = sim.m;
  const j = overviewLevel(lo, hi, maxCols), cx = 2 ** j;
  const a0 = Math.floor(lo / cx), cols = Math.floor(hi / cx) - a0 + 1, u0 = a0 * cx;
  const planes = { vis: new Uint32Array(cols), near: new Uint8Array(cols).fill(UNREAD) };
  for (let k = 1; k < m; k++) planes[`cnt:${k}`] = new Uint32Array(cols);
  const [dlo, dhi] = sim.defined();
  poolRow(sim.tape, sim.org, dlo, dhi, u0, a0, cx, m, planes, 0, [], null, cols);
  const cnt = [];
  for (let k = 1; k < m; k++) cnt.push(planes[`cnt:${k}`].buffer);
  return { j, u0, cols, cnt, vis: planes.vis.buffer, near: planes.near.buffer };
}

/**
 * Facade-side overview: rows at level J in a fixed window of CAP = 2*ovMaxCols texels starting at absolute texel B.
 * Rows arriving at a finer level are merged up; a coarser row (or a row outside the window) re-buckets the store
 * by exact pair merges (alignment at absolute 0). `near` keeps the texel nearer the origin. The run's extent fits
 * in ovMaxCols texels at the run worker's level, so with the window centred at each re-layout no shift is needed
 * until the level changes.
 */
export class OverviewStore {
  constructor(m, maxCols = LIMITS.ovMaxCols) {
    this.m = m; this.CAP = 2 * maxCols;
    this.J = -1; this.B = 0;
    this.rows = 0; this.rcap = 0;
    this.t = new Float64Array(0); this.lo = new Float64Array(0); this.hi = new Float64Array(0); this.pos = new Float64Array(0);
    this.vis = new Uint32Array(0); this.near = new Uint8Array(0); this.cnt = [];
    for (let k = 1; k < m; k++) this.cnt.push(new Uint32Array(0));
    this.version = 0;
    this._view = null;
  }
  get bytes() { return this.rcap * (32 + this.CAP * (4 * this.m + 1)); }
  _alloc(rcap) {
    const C = this.CAP;
    const g = (a, T, fill) => { const b = new T(rcap * C); if (fill !== undefined) b.fill(fill); b.set(a.subarray(0, this.rows * C)); return b; };
    const g1 = (a) => { const b = new Float64Array(rcap); b.set(a.subarray(0, this.rows)); return b; };
    this.vis = g(this.vis, Uint32Array); this.near = g(this.near, Uint8Array, UNREAD);
    this.cnt = this.cnt.map((a) => g(a, Uint32Array));
    this.t = g1(this.t); this.lo = g1(this.lo); this.hi = g1(this.hi); this.pos = g1(this.pos);
    this.rcap = rcap;
  }
  /** Re-bucket all rows to level J2 with window start B2 (texel index at J2). */
  _relayout(J2, B2) {
    const C = this.CAP, R = this.rows, f = 2 ** (J2 - this.J);
    const vis = new Uint32Array(this.rcap * C), near = new Uint8Array(this.rcap * C).fill(UNREAD);
    const cnt = this.cnt.map(() => new Uint32Array(this.rcap * C));
    for (let r = 0; r < R; r++) {
      const o = r * C;
      for (let c = 0; c < C; c++) {
        const v = this.vis[o + c], nv = this.near[o + c];
        if (v === 0 && nv === UNREAD) continue;
        const a = this.B + c, a2 = Math.floor(a / f), c2 = a2 - B2;
        if (c2 < 0 || c2 >= C) throw new Error('overview relayout lost data');
        const i2 = o + c2;
        vis[i2] += v;
        for (let k = 0; k < cnt.length; k++) cnt[k][i2] += this.cnt[k][o + c];
        if (nv !== UNREAD) { if (a2 < 0) near[i2] = nv; else if (near[i2] === UNREAD) near[i2] = nv; }
      }
    }
    this.vis = vis; this.near = near; this.cnt = cnt; this.J = J2; this.B = B2;
  }
  /** Add one overview row (ov from the run worker; planes as ArrayBuffers or typed arrays) at step t. */
  add(t, ov, lo, hi, pos) {
    const C = this.CAP;
    const j = ov.j, a0 = ov.u0 / 2 ** j, cols = ov.cols;
    let J2 = Math.max(this.J, j);
    const span = (J) => [Math.floor(a0 / 2 ** (J - j)), Math.floor((a0 + cols - 1) / 2 ** (J - j))];
    const [x0, x1] = span(J2);
    if (this.J < 0) { this.J = J2; this.B = Math.floor((x0 + x1) / 2) - (C >> 1); }
    else if (J2 !== this.J || x0 < this.B || x1 >= this.B + C) {
      // the new window must hold the new row and every stored row's data
      let J3 = J2, B3;
      for (;;) {
        const f = 2 ** (J3 - j), g = 2 ** (J3 - this.J);
        const ra = Math.min(Math.floor(a0 / f), this._dataLo(g)), rb = Math.max(Math.floor((a0 + cols - 1) / f), this._dataHi(g));
        if (rb - ra + 1 <= C) { B3 = Math.floor((ra + rb) / 2) - (C >> 1); break; }
        J3++;
      }
      this._relayout(J3, B3);
      J2 = J3;
    }
    if (this.rows === this.rcap) this._alloc(Math.max(64, this.rcap * 2));
    const r = this.rows++, o = r * C, f = 2 ** (this.J - j);
    const vis = new Uint32Array(ov.vis.buffer || ov.vis), near = new Uint8Array(ov.near.buffer || ov.near);
    const cnt = ov.cnt.map((b) => new Uint32Array(b.buffer || b));
    for (let c = 0; c < cols; c++) {
      const a = a0 + c, a2 = Math.floor(a / f), i2 = o + a2 - this.B;
      this.vis[i2] += vis[c];
      for (let k = 0; k < cnt.length; k++) this.cnt[k][i2] += cnt[k][c];
      const nv = near[c];
      if (nv !== UNREAD) { if (a2 < 0) this.near[i2] = nv; else if (this.near[i2] === UNREAD) this.near[i2] = nv; }
    }
    this.t[r] = t; this.lo[r] = lo; this.hi[r] = hi; this.pos[r] = pos;
    this.version++; this._view = null;
  }
  // smallest / largest texel (at level J*g) holding data in the store; +/-Infinity if empty
  _dataLo(g) {
    const C = this.CAP;
    for (let c = 0; c < C; c++) for (let r = 0; r < this.rows; r++) if (this.vis[r * C + c] || this.near[r * C + c] !== UNREAD) return Math.floor((this.B + c) / g);
    return Infinity;
  }
  _dataHi(g) {
    const C = this.CAP;
    for (let c = C - 1; c >= 0; c--) for (let r = 0; r < this.rows; r++) if (this.vis[r * C + c] || this.near[r * C + c] !== UNREAD) return Math.floor((this.B + c) / g);
    return -Infinity;
  }
  /** Keep only rows whose step is in keep (a Set of steps). */
  retain(keepFn) {
    const C = this.CAP;
    let w = 0;
    for (let r = 0; r < this.rows; r++) {
      if (!keepFn(this.t[r])) continue;
      if (w !== r) {
        this.vis.copyWithin(w * C, r * C, r * C + C); this.near.copyWithin(w * C, r * C, r * C + C);
        for (const a of this.cnt) a.copyWithin(w * C, r * C, r * C + C);
        this.t[w] = this.t[r]; this.lo[w] = this.lo[r]; this.hi[w] = this.hi[r]; this.pos[w] = this.pos[r];
      }
      w++;
    }
    for (let r = w; r < this.rows; r++) {
      this.vis.fill(0, r * C, r * C + C); this.near.fill(UNREAD, r * C, r * C + C);
      for (const a of this.cnt) a.fill(0, r * C, r * C + C);
    }
    if (w !== this.rows) { this.rows = w; this.version++; this._view = null; }
  }
  /** Overview (core/types.mjs) as views into the store; valid until the next add/retain. */
  view() {
    if (this.J < 0) return null;
    if (this._view) return this._view;
    const N = this.rows * this.CAP;
    this._view = {
      t: this.t.subarray(0, this.rows), j: this.J, u0: this.B * 2 ** this.J, cols: this.CAP,
      cnt: this.cnt.map((a) => a.subarray(0, N)), vis: this.vis.subarray(0, N), near: this.near.subarray(0, N),
      lo: this.lo.subarray(0, this.rows), hi: this.hi.subarray(0, this.rows), pos: this.pos.subarray(0, this.rows),
      version: this.version,
    };
    return this._view;
  }
}

// ------------------------------------------------------------------------------------------------
// Background-period detection (atlas/explorer-research.md §2.5): the period whose shifted copy mismatches least,
// reduced to the primitive root of its dominant word; the phase where that word's blocks are most frequent.
// ------------------------------------------------------------------------------------------------

function primitiveRootStr(w) {
  const n = w.length;
  for (let d = 1; d < n; d++) if (n % d === 0 && w.slice(0, d).repeat(n / d) === w) return w.slice(0, d);
  return w;
}

/**
 * cells[i] = symbol of absolute cell x0 + i (all read). Returns
 *   {k, p, word, words, rates, best, confident, coverage}
 *   rates[q] = share of x with cell(x) != cell(x+q), q = 1..maxP (rates[0] = NaN)
 *   best = argmin rate; word = primitive root of the dominant best-length window, as read at phase p (absolute
 *   x = p mod k) where its blocks are most frequent; words = its distinct rotations (the k-block background set);
 *   confident = the minimum stands out (<= 0.01, or < 1/4 of the mean rate); coverage = share of phase-p k-blocks
 *   that are background words.
 */
export function backgroundOf(cells, x0, maxP = 8) {
  const n = cells.length;
  const rates = new Float64Array(maxP + 1).fill(NaN);
  let best = 0;
  for (let q = 1; q <= maxP && q < n; q++) {
    let mis = 0;
    for (let i = 0; i + q < n; i++) if (cells[i] !== cells[i + q]) mis++;
    rates[q] = mis / (n - q);
    if (!best || rates[q] < rates[best]) best = q;
  }
  if (!best) return { k: 1, p: 0, word: n ? String(cells[0]) : '0', words: [n ? String(cells[0]) : '0'], rates, best: 0, confident: false, coverage: 0 };
  let mean = 0, cntR = 0;
  for (let q = 1; q <= maxP; q++) if (rates[q] === rates[q]) { mean += rates[q]; cntR++; }
  mean /= cntR || 1;
  // dominant window of length best
  const counts = new Map();
  for (let i = 0; i + best <= n; i++) {
    let w = '';
    for (let j = 0; j < best; j++) w += String.fromCharCode(48 + cells[i + j]);
    counts.set(w, (counts.get(w) || 0) + 1);
  }
  let top = '', topN = -1;
  for (const [w, c] of counts) if (c > topN || (c === topN && w < top)) { top = w; topN = c; }
  const root = primitiveRootStr(top), k = root.length;
  const rots = [];
  for (let r = 0; r < k; r++) { const w = root.slice(r) + root.slice(0, r); if (!rots.includes(w)) rots.push(w); }
  // phase with the most background blocks; word = the most frequent rotation at that phase
  let bestPh = 0, bestCov = -1, bestWord = root;
  for (let ph = 0; ph < k; ph++) {
    const c = new Map();
    let blocks = 0;
    for (let i = ((ph - x0) % k + k) % k; i + k <= n; i += k) {
      let w = '';
      for (let j = 0; j < k; j++) w += String.fromCharCode(48 + cells[i + j]);
      blocks++;
      if (rots.includes(w)) c.set(w, (c.get(w) || 0) + 1);
    }
    let bg = 0, tw = root, tn = -1;
    for (const [w, v] of c) { bg += v; if (v > tn || (v === tn && w < tw)) { tw = w; tn = v; } }
    const cov = blocks ? bg / blocks : 0;
    const share = tn / Math.max(1, blocks);
    if (share > bestCov) { bestCov = share; bestPh = ph; bestWord = tw; }
  }
  const words = [bestWord, ...rots.filter((w) => w !== bestWord)];
  let bgBlocks = 0, all = 0;
  for (let i = ((bestPh - x0) % k + k) % k; i + k <= n; i += k) {
    let w = '';
    for (let j = 0; j < k; j++) w += String.fromCharCode(48 + cells[i + j]);
    all++; if (words.includes(w)) bgBlocks++;
  }
  const confident = rates[best] <= 0.01 || rates[best] < 0.25 * mean;
  return { k, p: bestPh, word: bestWord, words, rates, best, confident, coverage: all ? bgBlocks / all : 0 };
}
