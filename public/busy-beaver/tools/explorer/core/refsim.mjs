// core/refsim.mjs (ENGINE): naive reference simulator with tools/sim.py semantics. Deliberately simple and
// independent of engine/sim.mjs: it is the oracle in the unit tests and the core of engine/stub-client.mjs.
//
// Semantics (README-sim): a step is one transition, including the halting one; '---' acts as 1RZ (write 1, move R,
// halt); the span [lo, hi] = the start configuration's cells plus every visited cell; a step that moves the head
// outside the span is a record (side L/R) and leaves the head FRESH (on a never-read cell, which holds 0).
import { N_UNDEF } from './machine.mjs';
import { STATES } from './machine.mjs';

export class RefSim {
  /** @param machine Machine (core/machine.mjs); @param cfg Config (core/config.mjs) */
  constructor(machine, cfg) {
    this.M = machine;
    const L = cfg.tape.length;
    this.cap = Math.max(64, 2 * L + 64);
    this.buf = new Uint8Array(this.cap);
    this.org = ((this.cap - L) >> 1) - cfg.lo;          // buffer index of cell 0
    this.buf.set(cfg.tape, this.org + cfg.lo);
    this.pos = cfg.lo + cfg.head;
    this.lo = cfg.lo;
    this.hi = cfg.lo + L - 1;
    this.q = STATES.indexOf(cfg.state);
    this.sdir = cfg.dir === 'L' ? -1 : 1;               // sim.py dir
    this.t = cfg.step;
    this.s0 = cfg.step;
    this.fresh = false;
    this.tr = -1;
    this.halted = false;
    this.haltFrom = -1; this.haltRead = -1; this.haltKind = null;
    this.rec = 0; this.recL = 0;
  }
  _ensure(p) {
    let i = p + this.org;
    if (i >= 0 && i < this.cap) return;
    const ncap = this.cap * 2 + Math.abs(p) * 2;
    const nb = new Uint8Array(ncap);
    const shift = ((ncap - this.cap) >> 1);
    nb.set(this.buf, shift);
    this.buf = nb; this.org += shift; this.cap = ncap;
  }
  read(p) { return p >= this.lo && p <= this.hi ? this.buf[p + this.org] : 0; }
  /** read = in the span and not a fresh head cell (BBD defined()) */
  isRead(p) { return p >= this.lo && p <= this.hi && !(this.fresh && p === this.pos); }
  get dir() { return this.t === this.s0 ? 0 : this.sdir; }
  get state() { return this.halted ? 'Z' : STATES[this.q]; }
  /** next transition index q*m+s, or -1 when halted */
  get next() { return this.halted ? -1 : this.q * this.M.m + this.read(this.pos); }
  /** One step. Returns {tr, side} (side 'L'|'R'|null), or null if already halted. */
  step() {
    if (this.halted) return null;
    const M = this.M, m = M.m;
    const s = this.read(this.pos), k = this.q * m + s;
    const nq = M.N[k];
    const w = nq === N_UNDEF ? 1 : M.W[k];
    const d = nq === N_UNDEF ? 1 : M.D[k];
    this._ensure(this.pos);
    this.buf[this.pos + this.org] = w;
    this.pos += d;
    this.t += 1;
    this.sdir = d;
    this.tr = k;
    if (nq < 0) {
      this.halted = true; this.haltFrom = this.q; this.haltRead = s; this.haltKind = nq === N_UNDEF ? 'undefined' : 'halt-state';
      this.q = -1;
    } else this.q = nq;
    let side = null;
    if (this.pos < this.lo) { this._ensure(this.pos); this.lo = this.pos; this.buf[this.pos + this.org] = 0; side = 'L'; }
    else if (this.pos > this.hi) { this._ensure(this.pos); this.hi = this.pos; this.buf[this.pos + this.org] = 0; side = 'R'; }
    this.fresh = side !== null;
    if (side) { this.rec++; if (side === 'L') this.recL++; }
    return { tr: k, side };
  }
  /** Run up to n steps (stops at a halt); returns steps done. */
  run(n) { let i = 0; while (i < n && this.step()) i++; return i; }
  /** Cells a..b (inclusive) as stored (0 outside the span). */
  window(a, b) {
    const out = new Uint8Array(Math.max(0, b - a + 1));
    for (let p = a; p <= b; p++) out[p - a] = this.read(p);
    return out;
  }
  span() { return this.buf.slice(this.lo + this.org, this.hi + this.org + 1); }
  nonzeros() { let c = 0; for (let p = this.lo; p <= this.hi; p++) if (this.buf[p + this.org]) c++; return c; }
  clone() {
    const c = Object.create(RefSim.prototype);
    Object.assign(c, this);
    c.buf = this.buf.slice();
    return c;
  }
}
