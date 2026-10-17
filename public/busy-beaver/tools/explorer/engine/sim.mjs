// engine/sim.mjs (ENGINE): the simulator behind every worker job (explorer-spec §8.2).
//
// Tape: Uint8Array with the origin near the middle; never-read cells hold SENT = m, the two buffer ends hold
// GUARD = m + 1. Generated code (engine/codegen.mjs) runs until it reads a cell >= m or meets a halting
// transition; this class handles those traps outside the hot loop:
//   SENT  -> the step just executed moved onto a new cell: it becomes 0, the span grows, a record is counted
//            (side L/R) and the head is FRESH until the next step reads it;
//   GUARD -> the buffer doubles and recentres, then as SENT;
//   halting transition ('---' or a halt state) -> one table step (stepOne) with sim.py semantics ('---' = 1RZ).
// Invariant between calls: the head is never on SENT/GUARD, and [lo, hi] (sim.py's span) includes the head.
//
// Exactness: runTo(T) runs generated code for T - t - 1 steps and then exactly one stepOne(), so dir, tr and
// FRESH are exact at every row and checkpoint. After a watch exit they are exact too (dir = D[ev], tr = ev);
// after a records stop dir = the record side and tr is -1 (unknown; rows do not need it).
import { compile } from './codegen.mjs';
import { pack, unpack, bitsPerCell } from './checkpoints.mjs';
import { N_UNDEF, STATES } from '../core/machine.mjs';
import { LIMITS, UNREAD } from '../core/protocol.mjs';

const MAX_CALL = 2 ** 30;            // keep the generated loop counter a small integer

export class Sim {
  constructor(M, opts = {}) {
    this.M = M; this.m = M.m; this.n = M.n;
    this.W = M.W; this.D = M.D; this.N = M.N;
    this.SENT = M.m; this.GUARD = M.m + 1;
    this.spanCap = opts.spanCap ?? LIMITS.spanCap;
    // fields read and written by generated code
    this.tape = new Uint8Array(0); this.h = 0; this.q = 0; this.cnt = null; this.ev = -1;
    // geometry
    this.org = 0; this.loI = 0; this.hiI = 0;
    // run state
    this.t = 0; this.s0 = 0;
    this.sdir = 1; this.tr = -1; this.fresh = false; this.exact = true;
    this.halted = false; this.haltFrom = -1; this.haltRead = -1; this.haltKind = null;
    this.capped = false;
    this.rec = 0; this.recL = 0;
    this.onRecord = null;            // (t, side 0=L|1=R) => void
    this.rwSide = -1; this.rwLeft = 0;   // records watch: side 0 L, 1 R, 2 LR; remaining count
    this.watchMask = null;
    this.fnPlain = compile(M, 'plain');
    this.fnCount = null;
  }

  // ---------------------------------------------------------------------------------------- setup
  _alloc(len) {
    const cap = Math.max(4096, 2 * len + 2048);
    if (this.tape.length >= cap && this.tape.length <= 4 * cap) this.tape.fill(this.SENT);
    else this.tape = new Uint8Array(cap).fill(this.SENT);
    const T = this.tape;
    T[0] = this.GUARD; T[T.length - 1] = this.GUARD;
    return (T.length - len) >> 1;
  }
  /** Start from a Config (core/config.mjs) at step cfg.step. */
  loadConfig(cfg) {
    const len = cfg.tape.length;
    const o = this._alloc(len);
    this.tape.set(cfg.tape, o);
    this.loI = o; this.hiI = o + len - 1; this.org = o - cfg.lo;
    this.h = this.org + cfg.lo + cfg.head;
    this.q = STATES.indexOf(cfg.state);
    this.t = cfg.step; this.s0 = cfg.step;
    this.sdir = cfg.dir === 'L' ? -1 : 1; this.tr = -1; this.fresh = false; this.exact = true;
    this.halted = false; this.haltFrom = -1; this.haltRead = -1; this.haltKind = null; this.capped = false;
    this.rec = 0; this.recL = 0;
    return this;
  }
  /** Restore a checkpoint / SeekRef (with its bits). */
  restore(ref, bits) {
    const len = ref.hi - ref.lo + 1;
    const o = this._alloc(len);
    unpack(bits || ref.bits, ref.bitsPerCell, len, this.tape, o);
    this.loI = o; this.hiI = o + len - 1; this.org = o - ref.lo;
    this.h = ref.pos + this.org;
    this.q = ref.q; this.t = ref.t; this.s0 = ref.s0;
    this.sdir = ref.sdir; this.tr = ref.tr; this.fresh = !!ref.fresh; this.exact = true;
    this.halted = false; this.haltFrom = -1; this.haltRead = -1; this.haltKind = null; this.capped = false;
    this.rec = ref.rec || 0; this.recL = ref.recL || 0;
    return this;
  }
  /** Checkpoint of the current configuration (caller makes sure the last step was exact: use runTo). */
  checkpoint(id) {
    const len = this.hiI - this.loI + 1, b = bitsPerCell(this.m);
    return {
      id, t: this.t, q: this.q, pos: this.h - this.org, lo: this.loI - this.org, hi: this.hiI - this.org,
      dir: this.t === this.s0 ? 0 : this.sdir, fresh: this.fresh, tr: this.tr, bitsPerCell: b,
      bits: pack(this.tape, this.loI, len, b), sdir: this.sdir, s0: this.s0, rec: this.rec, recL: this.recL,
    };
  }

  // ---------------------------------------------------------------------------------------- views
  get pos() { return this.h - this.org; }
  get lo() { return this.loI - this.org; }
  get hi() { return this.hiI - this.org; }
  get dir() { return this.t === this.s0 ? 0 : this.sdir; }
  get stateName() { return this.halted ? 'Z' : STATES[this.q]; }
  /** q*m+s about to fire, -1 when halted */
  get next() { return this.halted || this.capped ? -1 : this.q * this.m + this.tape[this.h]; }
  /** read cells = span minus a fresh head cell (BBD defined()) */
  cell(p) { return this.tape[p + this.org]; }
  /** absolute cells x0..x1, UNREAD where not read */
  cellsAbs(x0, x1) {
    const out = new Uint8Array(Math.max(0, x1 - x0 + 1)).fill(UNREAD);
    const [a, b] = this.defined();
    const s = Math.max(a, x0), e = Math.min(b, x1);
    for (let p = s; p <= e; p++) out[p - x0] = this.tape[p + this.org];
    return out;
  }
  /** [lo, hi] of read cells (BBD defined(): drop the fresh head cell when it is at an edge) */
  defined() {
    let lo = this.lo, hi = this.hi;
    if (this.fresh) { const p = this.pos; if (p === lo) lo++; else if (p === hi) hi--; }
    return [lo, hi];
  }
  nonzeros() {
    const T = this.tape; let c = 0;
    for (let i = this.loI; i <= this.hiI; i++) if (T[i] !== 0) c++;
    return c;
  }
  spanView() { return this.tape.subarray(this.loI, this.hiI + 1); }

  // ---------------------------------------------------------------------------------------- traps
  _grow() {
    const spanLen = this.hiI - this.loI + 1;
    const ncap = Math.max(this.tape.length * 2, spanLen * 2 + 4096);
    const nt = new Uint8Array(ncap).fill(this.SENT);
    nt[0] = this.GUARD; nt[ncap - 1] = this.GUARD;
    const o = (ncap - spanLen) >> 1;
    nt.set(this.tape.subarray(this.loI, this.hiI + 1), o);
    const shift = o - this.loI;
    this.h += shift; this.loI += shift; this.hiI += shift; this.org += shift;
    this.tape = nt;
  }
  /** The step just executed moved the head onto a never-read cell (SENT or GUARD). */
  _land() {
    if (this.tape[this.h] === this.GUARD) this._grow();
    this.tape[this.h] = 0;
    let side;
    if (this.h < this.loI) { this.loI = this.h; side = 0; } else { this.hiI = this.h; side = 1; }
    this.fresh = true;
    this.sdir = side ? 1 : -1;
    this.rec++;
    if (side === 0) this.recL++;
    if (this.onRecord !== null) this.onRecord(this.t, side);
    if (this.rwSide >= 0 && (this.rwSide === 2 || this.rwSide === side)) this.rwLeft--;
    if (this.hiI - this.loI + 1 > this.spanCap) this.capped = true;
    return side;
  }

  /** One exact table-driven step (any transition, including a halt). Returns false if halted/capped. */
  stepOne() {
    if (this.halted || this.capped) return false;
    const T = this.tape, m = this.m, h = this.h, s = T[h];
    const k = this.q * m + s;
    const nq = this.N[k];
    let w, d;
    if (nq === N_UNDEF) { w = 1; d = 1; } else { w = this.W[k]; d = this.D[k]; }
    T[h] = w;
    this.h = h + d;
    this.t += 1;
    this.sdir = d; this.tr = k; this.fresh = false; this.exact = true;
    if (nq < 0) {
      this.halted = true; this.haltFrom = this.q; this.haltRead = s; this.haltKind = nq === N_UNDEF ? 'undefined' : 'halt-state';
      this.q = -1;
    } else this.q = nq;
    if (this.tape[this.h] >= m) this._land();
    return true;
  }

  /** Drive a compiled function for up to `budget` steps. mode 0 plain, 1 count (into this.cnt), 2 watch
   *  (this.watchMask; stops right after a watched firing, this.ev = its index). Stops at a halt, the span cap,
   *  or when a records watch (rwSide/rwLeft) is satisfied. Returns steps executed. */
  _drive(budget, fn, mode) {
    let left = budget, done = 0;
    const m = this.m;
    this.ev = -1;
    while (left > 0 && !this.halted && !this.capped) {
      const ran = fn(this, left > MAX_CALL ? MAX_CALL : left);
      if (ran > 0) { left -= ran; done += ran; this.t += ran; this.fresh = false; this.tr = -1; this.exact = false; }
      const s = this.tape[this.h];
      if (s >= m) {
        this._land();
        if (this.ev >= 0) break;
        if (this.rwSide >= 0 && this.rwLeft <= 0) break;
        continue;
      }
      if (this.ev >= 0) break;
      if (left === 0) break;
      // fn stopped on a real symbol with budget left: a halting transition (fn never executes those)
      const k = this.q * m + s;
      if (this.N[k] >= 0) continue;           // only when the call was capped at MAX_CALL
      if (mode === 1) this.cnt[k] += 1;
      this.stepOne(); left--; done++;
      if (mode === 2 && this.watchMask[k]) this.ev = k;
      break;
    }
    if (this.ev >= 0) { this.tr = this.ev; this.sdir = this.D[this.ev] || 1; this.exact = true; }
    return done;
  }

  /** Run up to n steps with the plain variant (dir/tr not exact afterwards unless the last step trapped). */
  run(n) { return this._drive(n, this.fnPlain, 0); }
  /** Exactly to step T (or the halt / span cap before it). The last step is a stepOne. Returns t === T. */
  runTo(T) {
    const n = T - this.t;
    if (n < 0) throw new Error(`runTo(${T}) from ${this.t}`);
    if (n === 0) return true;
    if (n > 1) this._drive(n - 1, this.fnPlain, 0);
    if (this.t === T - 1) this.stepOne();
    return this.t === T;
  }
  /** Count variant: firing counts of the next n steps (fewer at a halt) are added into cnt. */
  runCount(n, cnt) {
    if (!this.fnCount) this.fnCount = compile(this.M, 'count');
    this.cnt = cnt;
    const d = this._drive(n, this.fnCount, 1);
    this.cnt = null;
    return d;
  }
  /** Watch variant: run up to n steps, stopping right after the first firing of a transition in mask.
   *  Returns steps executed; this.ev >= 0 iff stopped on a firing. */
  runWatch(n, mask, fn) {
    this.watchMask = mask;
    const d = this._drive(n, fn || compile(this.M, 'watch', mask), 2);
    this.watchMask = null;
    return d;
  }
  /** Run up to n steps, stopping right after `count` records of side (0 L, 1 R, 2 LR). Returns steps executed;
   *  this.rwLeft === 0 iff the goal was met. */
  runRecords(n, count, side) {
    this.rwSide = side; this.rwLeft = count;
    const d = count > 0 ? this._drive(n, this.fnPlain, 0) : 0;
    this.rwSide = -1;
    return d;
  }
}
