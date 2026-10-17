// engine/stub-client.mjs (ENGINE): the §6 facade on core/refsim.mjs, on the main thread, for runs of at most
// LIMITS.stubMaxSteps (2e6) steps. Same API as ui/engine-client.mjs (swap = one import line; ?engine=stub).
//
// Deliberately written independently of the real engine (no engine/sim.mjs, rows.mjs strip logic or pool.mjs
// counting): rows, events and pooled planes are computed by brute force from RefSim snapshots and per-step
// transition logs, so the facade-parity tests cross-check two implementations of the same spec.
import { TILE, F_FRESH, F_NOHEAD, F_HALTED, F_ABSENT, F_PENDING, F_START, UNREAD, LIMITS, ERR, tileKey } from '../core/protocol.mjs';
import { parseMachine, transInfo, machineDiff, STATES } from '../core/machine.mjs';
import { startConfig, dhCells } from '../core/config.mjs';
import { compressText } from '../core/compress.mjs';
import { backgroundOf } from './pool.mjs';
import { RefSim } from '../core/refsim.mjs';
import { initialStride, overBudget, bitsPerCell, packedBytes } from './checkpoints.mjs';
import { rowsInfo, checkRequest, emptyTile, tileBytes, startProbe } from './rows.mjs';

const E = (code, message) => ({ code, message });
const asErr = (e) => (e && e.code ? { code: e.code, message: e.message } : E(ERR.INTERNAL, String((e && e.message) || e)));
const CHUNK = 1 << 16;
const SNAP_BUDGET = 64 << 20;

export function createEngine(opts = {}) { return new StubEngine(opts); }

class StubSession {
  constructor(eng, sid, spec, M, cfg, target) {
    this._e = eng; this.sid = sid; this.machine = M; this.cfg = cfg; this.s0 = cfg.step;
    this.spec = { tm: M.text, start: spec.start || { kind: 'blank' }, s0: cfg.step, steps: target - cfg.step };
    this.startRow = startProbe(cfg, M);
    this.listeners = new Map();
    this.closed = false;
    this.sim = new RefSim(M, cfg);
    this.trAt = new Uint8Array(Math.max(1, target - cfg.step));
    this.recSteps = []; this.recSides = [];
    this.snaps = [{ t: cfg.step, sim: this.sim.clone() }]; this.snapStride = 1 << 12; this.snapBytes = 0;
    this.c = initialStride(target - cfg.step, eng.limits); this.ck = [{ t: cfg.step, bytes: packedBytes(this.sim.hi - this.sim.lo + 1, bitsPerCell(M.m)) }];
    this.ovRows = [this._ovRow(this.sim)];
    this.events = new Map();
    this.live = null;
    this._info = {
      sid, tm: M.text, n: M.n, m: M.m, start: this.spec.start, s0: cfg.step, t: cfg.step, target, rate: 0,
      status: 'running', state: cfg.state, pos: this.sim.pos, lo: this.sim.lo, hi: this.sim.hi,
      extent: { lo: this.sim.lo, hi: this.sim.hi }, halt: null, ckpt: { c: this.c, count: 1, bytes: this.ck[0].bytes },
      rec: { count: 0, r: 0 },
    };
    this.timer = null;
  }
  info() { return this._info; }
  on(type, cb) { let s = this.listeners.get(type); if (!s) this.listeners.set(type, (s = new Set())); s.add(cb); return () => s.delete(cb); }
  _emit(type, arg) { const s = this.listeners.get(type); if (s) for (const cb of [...s]) { try { cb(arg); } catch (e) { /* ignore */ } } }
  _set(p) { this._info = { ...this._info, ...p }; return this._info; }

  _ovRow(sim) {
    // brute-force overview row at the minimal level j: per abs texel [u0 + c*2^j, ...)
    const lo = sim.lo, hi = sim.hi;
    let j = 0;
    while (Math.floor(hi / 2 ** j) - Math.floor(lo / 2 ** j) + 1 > this._e.limits.ovMaxCols) j++;
    return { t: sim.t, lo, hi, pos: sim.pos, j, snap: sim.clone() };
  }
  _schedule() {
    if (this.timer || this.closed || this._info.status !== 'running') return;
    this.timer = setTimeout(() => { this.timer = null; this._chunk(); }, 0);
  }
  _chunk() {
    if (this.closed || this._info.status !== 'running') return;
    const sim = this.sim, M = this.machine, target = this._info.target;
    const end = Math.min(target, sim.t + CHUNK);
    let newOv = false;
    while (sim.t < end && !sim.halted) {
      const r = sim.step();
      this.trAt[sim.t - this.s0 - 1] = r.tr;
      if (r.side) { this.recSteps.push(sim.t); this.recSides.push(r.side === 'L' ? 0 : 1); }
      if ((sim.t - this.s0) % this.snapStride === 0) {
        this.snaps.push({ t: sim.t, sim: sim.clone() });
        this.snapBytes += sim.cap;
        if (this.snapBytes > SNAP_BUDGET) {
          this.snapStride *= 2;
          this.snaps = this.snaps.filter((s) => (s.t - this.s0) % this.snapStride === 0);
          this.snapBytes = this.snaps.reduce((a, s) => a + s.sim.cap, 0);
        }
      }
      if (!sim.halted && (sim.t - this.s0) % 2 ** this.c === 0) {
        this.ck.push({ t: sim.t, bytes: packedBytes(sim.hi - sim.lo + 1, bitsPerCell(M.m)) });
        this.ovRows.push(this._ovRow(sim));
        newOv = true;
        while (overBudget(this.ck.length, this.ck.reduce((a, c) => a + c.bytes, 0), this._e.limits)) {
          this.c++;
          const S = 2 ** this.c;
          this.ck = this.ck.filter((c) => (c.t - this.s0) % S === 0);
          this.ovRows = this.ovRows.filter((o) => (o.t - this.s0) % S === 0);
        }
      }
    }
    this.events.clear();
    const recL = this.recSides.reduce((a, s) => a + (s === 0 ? 1 : 0), 0);
    this.recL = recL;
    const patch = {
      t: sim.t, state: sim.state, pos: sim.pos, lo: sim.lo, hi: sim.hi, extent: { lo: sim.lo, hi: sim.hi },
      rec: { count: this.recSteps.length, r: 0 }, ckpt: { c: this.c, count: this.ck.length, bytes: this.ck.reduce((a, c) => a + c.bytes, 0) },
    };
    const done = sim.halted || sim.t >= target;
    if (sim.halted) {
      patch.halt = { step: sim.t, from: STATES[sim.haltFrom], read: sim.haltRead, kind: sim.haltKind, rec: sim.fresh ? (sim.sdir > 0 ? 'R' : 'L') : null };
      patch.status = 'halted';
    } else if (done) patch.status = 'done';
    this._set(patch);
    if (newOv) this._ovView = null, this._emit('overview', this._e.overview(this.sid));
    this._emit('progress', this._info);
    if (done) this._emit('done', this._info);
    this._e._refresh(this);
    if (!done) this._schedule();
  }
  extend(totalSteps) {
    if (this.closed) return;
    const target = Math.min(this.s0 + totalSteps, this.s0 + this._e.limits.stubMaxSteps);
    if (!(target > this._info.target)) return;
    const n = new Uint8Array(target - this.s0); n.set(this.trAt); this.trAt = n;
    const st = this._info.status;
    this._set({ target, status: st === 'done' ? 'running' : st });
    this._e._dropEnd(this);
    this._schedule();
  }
  pause() { if (this._info.status === 'running') { this._set({ status: 'paused' }); this._emit('progress', this._info); this._e._refresh(this); } }
  resume() { if (this._info.status === 'paused') { this._set({ status: 'running' }); this._e._dropEnd(this); this._schedule(); } }
  close() { this._e._close(this); }

  /** RefSim at step T (<= info.t), from the nearest snapshot. */
  at(T) {
    let best = this.snaps[0];
    for (const s of this.snaps) if (s.t <= T && s.t > best.t) best = s;
    const r = best.sim.clone();
    r.run(T - r.t);
    return r;
  }
  /** Steps of the events of a rows mode (records: index j-1 = j-th record), computed from the logs. */
  eventSteps(ri) {
    const key = ri.mode === 'rec' ? `rec:${ri.side}` : `w:${Array.from(ri.mask).join('')}`;
    let a = this.events.get(key);
    if (a) return a;
    a = [];
    const n = this._info.t - this.s0;
    if (ri.mode === 'rec') {
      for (let i = 0; i < this.recSteps.length; i++) if (ri.sideCode === 2 || this.recSides[i] === ri.sideCode) a.push(this.recSteps[i]);
    } else {
      for (let i = 0; i < n; i++) if (ri.mask[this.trAt[i]]) a.push(this.s0 + i + 1);
    }
    this.events.set(key, a);
    return a;
  }
}

class StubEngine {
  constructor(opts) {
    this.limits = { ...LIMITS, ...(opts.limits || {}) };
    this.sessions = new Map();
    this.sidSeq = 1;
    this.disposed = false;
    this.cache = new Map(); this.cacheBytes = 0;
  }
  open(spec) {
    return new Promise((resolve, reject) => {
      if (this.disposed) return reject(E(ERR.CLOSED, 'engine disposed'));
      let M, cfg;
      try { M = parseMachine(spec && spec.tm); cfg = startConfig(spec.start || { kind: 'blank' }, M, spec.s0 || 0); } catch (e) { return reject(asErr(e)); }
      const steps = Math.min(spec.steps === undefined ? this.limits.defaultSteps : spec.steps, this.limits.stubMaxSteps);
      const sid = `stub${this.sidSeq++}`;
      const s = new StubSession(this, sid, spec, M, cfg, cfg.step + Math.floor(steps));
      this.sessions.set(sid, s);
      s._schedule();
      resolve(s);
    });
  }
  _sess(sid) {
    const s = this.sessions.get(sid);
    if (!s || s.closed || this.disposed) throw E(ERR.CLOSED, `no open session ${sid}`);
    return s;
  }
  _close(s) {
    if (s.closed) return;
    s.closed = true;
    clearTimeout(s.timer);
    this.sessions.delete(s.sid);
    for (const [k, e] of this.cache) if (e.sid === s.sid) { this.cache.delete(k); this.cacheBytes -= e.bytes; }
    if (s.live) s.live.cancelled = true;
  }

  // ---------------------------------------------------------------------------------------------- tiles
  tiles(req, onTile) {
    const s = this._sess(req && req.sid);
    const ri = rowsInfo(req.rows, s.machine);
    const { pats, blk } = checkRequest(req, s.machine);
    if (s.live) s.live.cancelled = true;
    const R = { req, ri, pats, blk, onTile, cancelled: false, keys: new Map(), finalSent: new Set() };
    s.live = R;
    for (const [ty, tx] of req.tiles) R.keys.set(tileKey(req, ty, tx), [ty, tx]);
    queueMicrotask(() => this._fill(s, R));
    return { cancel: () => { R.cancelled = true; if (s.live === R) s.live = null; } };
  }
  _refresh(s) { if (s.live && !s.live.cancelled) this._fill(s, s.live); }
  _dropEnd(s) { for (const [k, e] of this.cache) if (e.sid === s.sid && e.endAbsent) { this.cache.delete(k); this.cacheBytes -= e.bytes; } if (s.live) s.live.finalSent.clear(); }
  _fill(s, R) {
    if (R.cancelled || s.closed) return;
    for (const [key, [ty, tx]] of R.keys) {
      let ent = this.cache.get(key);
      if (!ent || !ent.tile.final) {
        const tile = emptyTile(key, R.req, ty, tx, s.machine, R.ri.kind === 'events', R.pats, R.blk);
        const res = this._compute(s, R, tile);
        tile.final = !res.pending;
        ent = { tile, sid: s.sid, bytes: tileBytes(tile), endAbsent: res.endAbsent };
        if (this.cache.has(key)) this.cacheBytes -= this.cache.get(key).bytes;
        this.cache.set(key, ent); this.cacheBytes += ent.bytes;
      }
      if (ent.tile.final) { if (R.finalSent.has(key)) continue; R.finalSent.add(key); }
      try { R.onTile(key, ent.tile, ent.tile.final); } catch (e) { /* ignore */ }
    }
    for (const [k, e] of this.cache) { if (this.cacheBytes <= this.limits.tileCacheBytes) break; this.cache.delete(k); this.cacheBytes -= e.bytes; }
  }

  /** Brute-force tile: returns {pending, endAbsent}. */
  _compute(s, R, tile) {
    const { req, ri } = R, info = s._info, M = s.machine, s0 = s.s0;
    const S = 2 ** -req.kt, running = info.status === 'running';
    const H = info.halt ? info.halt.step : NaN, halted = H === H;
    // per level row: {kind:'row', step, ord} | {kind:'absent'} | {kind:'pending'}
    const rows = [];
    const evs = ri.kind === 'events' ? s.eventSteps(ri) : null;
    const haltIsEvent = evs && halted && evs.length && evs[evs.length - 1] === H;
    for (let i = 0; i < TILE; i++) {
      const Rr = tile.ty * TILE + i, b = Rr * S;
      let st, ord = NaN;
      if (ri.kind === 'steps') {
        st = b * ri.K + ri.O;
        // previous level row's step (to place the halting row right after the last regular row)
        const prevSt = (Rr - 1) * S * ri.K + ri.O;
        if (st < s0) { rows.push({ kind: 'absent' }); continue; }
        if (halted && st >= H) {
          if (Rr === 0 || prevSt < H) rows.push({ kind: 'row', step: H, ord: NaN });
          else rows.push({ kind: 'absent' });
          continue;
        }
        if (st > info.t) { rows.push({ kind: running ? 'pending' : 'absent', end: true }); continue; }
        rows.push({ kind: 'row', step: st, ord: NaN });
        continue;
      }
      // events: e = b + off; records ordinal 0 = start
      const e = b + ri.off;
      ord = b;
      if (e === 0) { rows.push({ kind: 'row', step: s0, ord: 0 }); continue; }
      if (e <= evs.length) { rows.push({ kind: 'row', step: evs[e - 1], ord: b }); continue; }
      if (halted) {
        const prevE = e - S;
        // the halting row follows the last regular row; when the halting step is itself the last event, the previous
        // level row showing exactly that event already was the halting row
        if (prevE < evs.length || (!haltIsEvent && prevE === evs.length)) rows.push({ kind: 'row', step: H, ord: NaN });
        else rows.push({ kind: 'absent' });
        continue;
      }
      rows.push({ kind: running ? 'pending' : 'absent', end: true });
    }
    let pending = false, endAbsent = false;
    let sim = null;
    for (let i = 0; i < TILE; i++) {
      const r = rows[i];
      if (r.kind !== 'row') {
        const flag = r.kind === 'pending' ? F_PENDING : F_ABSENT;
        if (r.kind === 'pending') pending = true;
        if (r.end && r.kind === 'absent') endAbsent = true;
        const b = 8 * i;
        tile.meta[b] = -1; tile.meta[b + 1] = 0; tile.meta[b + 2] = F_NOHEAD | flag; tile.meta[b + 3] = 0; tile.meta[b + 4] = 0;
        tile.meta[b + 5] = 0; tile.meta[b + 6] = 0; tile.meta[b + 7] = 0;
        tile.steps[i] = NaN; tile.next[i] = -1; if (tile.ev) tile.ev[i] = NaN;
        continue;
      }
      if (!sim || sim.t > r.step) sim = s.at(r.step); else sim.run(r.step - sim.t);
      this._putRow(s, R, tile, i, sim, r.ord);
    }
    return { pending, endAbsent };
  }
  _putRow(s, R, tile, i, sim, ord) {
    const req = R.req, M = s.machine;
    // geometry (diagram.py Row + _fix_halt for the site's '---' display)
    let state = sim.halted ? -1 : sim.q, dir = sim.dir, pos = sim.pos, lo = sim.lo, hi = sim.hi;
    let flags = (sim.fresh ? F_FRESH : 0) | (sim.t === s.s0 ? F_START : 0);
    let fixP = null, fixV = 0;
    if (sim.halted) {
      flags |= F_HALTED;
      if (req.halt === 'site' && sim.haltKind === 'undefined') {
        if (sim.fresh) hi -= 1;
        fixP = pos - 1; fixV = sim.haltRead; pos -= 1;
        flags = (flags & ~F_FRESH) | F_NOHEAD;
      }
    }
    const cell = (p) => (p === fixP ? fixV : sim.read(p));
    const isRead = (p) => p >= lo && p <= hi && !((flags & F_FRESH) && p === pos);
    const anchor = req.frame === 'head' ? pos : req.frame === 'left' ? lo : req.frame === 'right' ? hi : 0;
    const b = 8 * i;
    tile.meta[b] = state; tile.meta[b + 1] = dir; tile.meta[b + 2] = flags; tile.meta[b + 3] = pos; tile.meta[b + 4] = lo; tile.meta[b + 5] = hi;
    tile.steps[i] = sim.t;
    tile.next[i] = sim.halted ? -1 : sim.q * M.m + sim.read(sim.pos);
    if (tile.ev) tile.ev[i] = ord;
    if (tile.kind === 'exact') {
      const wlo = anchor + TILE * tile.tx;
      let a = Math.max(wlo, lo), e = Math.min(wlo + TILE - 1, hi);
      if (a > e) { tile.meta[b + 6] = wlo; tile.meta[b + 7] = 0; return; }
      tile.meta[b + 6] = a; tile.meta[b + 7] = e - a + 1;
      for (let p = a; p <= e; p++) tile.cells[TILE * i + p - a] = cell(p);
      return;
    }
    const cx = tile.cx, W0 = anchor + TILE * tile.tx * cx;
    tile.meta[b + 6] = W0; tile.meta[b + 7] = TILE * cx;
    const P = tile.planes;
    for (let c = 0; c < TILE; c++) {
      const ts = W0 + c * cx, u0 = (TILE * tile.tx + c) * cx;
      let vis = 0, nearV = UNREAD;
      const cnt = new Array(M.m).fill(0);
      // brute force over the texel cells (skip texels entirely outside the span)
      if (ts + cx - 1 >= lo && ts <= hi) {
        for (let p = Math.max(ts, lo); p <= Math.min(ts + cx - 1, hi); p++) {
          if (!isRead(p)) continue;
          vis++; cnt[cell(p)]++;
          if (u0 >= 0) { if (nearV === UNREAD) nearV = cell(p); } else nearV = cell(p);
        }
        for (const pt of R.pats) {
          let n = 0;
          for (let x = Math.max(ts, lo); x <= Math.min(ts + cx - 1, hi); x++) {
            if (((x % pt.k) + pt.k) % pt.k !== pt.p) continue;
            let ok = true;
            for (let j = 0; j < pt.w.length; j++) if (!isRead(x + j) || cell(x + j) !== pt.w[j]) { ok = false; break; }
            if (ok) n++;
          }
          P[pt.key][TILE * i + c] = n;
        }
        if (R.blk) {
          const k = R.blk.k;
          let n = 0;
          for (let x = Math.max(ts, lo); x <= Math.min(ts + cx - 1, hi); x++) {
            if (((x % k) + k) % k !== R.blk.p) continue;
            let ok = true, code = 0;
            for (let j = 0; j < k; j++) { if (!isRead(x + j)) { ok = false; break; } code = code * M.m + cell(x + j); }
            if (ok && !R.blk.bg[code]) n++;
          }
          P[R.blk.key][TILE * i + c] = n;
        }
      }
      P.vis[TILE * i + c] = vis;
      for (let k = 1; k < M.m; k++) P[`cnt:${k}`][TILE * i + c] = cnt[k];
      P.near[TILE * i + c] = nearV;
    }
    if (!(flags & F_NOHEAD)) {
      const c = Math.floor((pos - W0) / cx);
      tile.headCol[i] = c >= 0 && c < TILE ? c : -1;
    }
  }

  overview(sid) {
    const s = this.sessions.get(sid);
    if (!s) return null;
    if (s._ovView) return s._ovView;
    const rows = s.ovRows, m = s.machine.m;
    const j = Math.max(...rows.map((r) => r.j));
    const cx = 2 ** j;
    const lo = Math.min(...rows.map((r) => r.lo)), hi = Math.max(...rows.map((r) => r.hi));
    const a0 = Math.floor(lo / cx), cols = Math.floor(hi / cx) - a0 + 1;
    const N = rows.length * cols;
    const ov = {
      t: Float64Array.from(rows.map((r) => r.t)), j, u0: a0 * cx, cols,
      cnt: Array.from({ length: m - 1 }, () => new Uint32Array(N)), vis: new Uint32Array(N), near: new Uint8Array(N).fill(UNREAD),
      lo: Float64Array.from(rows.map((r) => r.lo)), hi: Float64Array.from(rows.map((r) => r.hi)), pos: Float64Array.from(rows.map((r) => r.pos)),
    };
    rows.forEach((r, ri) => {
      const sim = r.snap;
      for (let p = sim.lo; p <= sim.hi; p++) {
        if (!sim.isRead(p)) continue;
        const a = Math.floor(p / cx), c = a - a0, i = ri * cols + c, v = sim.read(p);
        ov.vis[i]++;
        if (v > 0) ov.cnt[v - 1][i]++;
        if (a >= 0) { if (ov.near[i] === UNREAD) ov.near[i] = v; } else ov.near[i] = v;
      }
    });
    s._ovView = ov;
    return ov;
  }

  // ---------------------------------------------------------------------------------------------- other calls
  async probe(sid, step, x0, x1, opts = {}) {
    const s = this._sess(sid);
    if (!(step >= s.s0 && step <= s._info.t)) throw E(ERR.RANGE, `step ${step} outside [${s.s0}, ${s._info.t}]`);
    const sim = s.at(step), M = s.machine;
    const cells = new Uint8Array(Math.max(0, x1 - x0 + 1)).fill(UNREAD);
    for (let p = x0; p <= x1; p++) if (sim.isRead(p)) cells[p - x0] = sim.read(p);
    const span = sim.span(), h = sim.pos - sim.lo;
    return {
      step: sim.t, state: sim.state, dir: sim.dir, pos: sim.pos, lo: sim.lo, hi: sim.hi, fresh: sim.fresh, halted: sim.halted,
      x0, cells, next: sim.halted ? null : transInfo(M, sim.next), prev: sim.tr >= 0 ? transInfo(M, sim.tr) : null,
      dh: dhCells(span, 0, span.length, h, sim.state, sim.sdir), dhExact: dhCells(span, 0, span.length, h, sim.state, sim.sdir, { trim: false }),
      dhc: span.length <= (opts.compress === true ? 1 << 18 : opts.compress === false ? -1 : 4096) ? compressText(span, 0, span.length, h, sim.state, sim.sdir) : null,
    };
  }
  async usage(sid, t0, t1) {
    const s = this._sess(sid), M = s.machine;
    const a = Math.max(s.s0, Math.floor(t0)), b = Math.min(s._info.t, Math.floor(t1));
    const counts = new Float64Array(M.n * M.m);
    for (let t = a + 1; t <= b; t++) counts[s.trAt[t - s.s0 - 1]]++;
    return { t0: a, t1: Math.max(a, b), counts };
  }
  async eventCount(sid, rows) {
    const s = this._sess(sid), ri = rowsInfo(rows, s.machine), info = s._info;
    const complete = info.status !== 'running' && info.status !== 'paused';
    let count;
    if (ri.mode === 'auto') count = info.t + 1;
    else if (ri.mode === 'every') count = info.t >= ri.O ? Math.floor((info.t - ri.O) / ri.K) + 1 : 0;
    else count = s.eventSteps(ri).length + (ri.mode === 'rec' ? 1 : 0);
    let extra = 0;
    const h = info.halt;
    if (h) {
      if (ri.kind === 'steps') extra = ri.mode === 'auto' || (h.step - ri.O) % ri.K === 0 ? 0 : 1;
      else { const ev = s.eventSteps(ri); extra = ev.length && ev[ev.length - 1] === h.step ? 0 : 1; }
    }
    return { count, complete, rows: count + extra };
  }
  async stepOfEvent(sid, rows, i) {
    const s = this._sess(sid), ri = rowsInfo(rows, s.machine);
    if (!Number.isSafeInteger(i) || i < 0) throw E(ERR.RANGE, `bad event index ${i}`);
    if (ri.kind === 'steps') return i * ri.K + ri.O;
    const e = i + ri.off;
    if (e === 0) return s.s0;
    const ev = s.eventSteps(ri);
    if (e > ev.length) throw E(ERR.RANGE, `event ${i} not reached`);
    return ev[e - 1];
  }
  async eventAtStep(sid, rows, step) {
    const s = this._sess(sid), ri = rowsInfo(rows, s.machine);
    if (ri.kind === 'steps') return step >= ri.O ? Math.floor((step - ri.O) / ri.K) : -1;
    if (step < s.s0) return -1;
    const ev = s.eventSteps(ri);
    let n = 0;
    while (n < ev.length && ev[n] <= step) n++;
    return n - ri.off;
  }
  async cursor(sid, step) {
    const s = this._sess(sid), M = s.machine;
    if (!(step >= s.s0 && step <= s._info.t)) throw E(ERR.RANGE, `step ${step} outside the run`);
    let sim = s.at(step), closed = false;
    const frame = (fired) => {
      const cells = new Uint8Array(129).fill(UNREAD);
      for (let p = sim.pos - 64; p <= sim.pos + 64; p++) if (sim.isRead(p)) cells[p - sim.pos + 64] = sim.read(p);
      return {
        step: sim.t, state: sim.state, dir: sim.dir, pos: sim.pos, lo: sim.lo, hi: sim.hi, fresh: sim.fresh, halted: sim.halted,
        x0: sim.pos - 64, cells, next: sim.halted ? null : transInfo(M, sim.next), prev: sim.tr >= 0 ? transInfo(M, sim.tr) : null, fired,
      };
    };
    const cur = {
      frame: frame(new Float64Array(M.n * M.m)),
      advance: async (n) => {
        if (closed) throw E(ERR.CLOSED, 'cursor closed');
        const fired = new Float64Array(M.n * M.m);
        let k = Math.max(0, Math.min(Math.floor(n), s._info.t - sim.t));
        while (k-- > 0 && !sim.halted) { const r = sim.step(); fired[r.tr]++; }
        return (cur.frame = frame(fired));
      },
      seek: async (t) => {
        if (closed) throw E(ERR.CLOSED, 'cursor closed');
        if (!(t >= s.s0 && t <= s._info.t)) throw E(ERR.RANGE, `step ${t} outside the run`);
        sim = s.at(t);
        return (cur.frame = frame(new Float64Array(M.n * M.m)));
      },
      close: () => { closed = true; },
    };
    return cur;
  }
  async diverge(sidA, sidB, maxSteps) {
    const A = this._sess(sidA), B = this._sess(sidB);
    if (A.s0 !== B.s0 || JSON.stringify(A.spec.start) !== JSON.stringify(B.spec.start)) return { step: null, reason: 'different starts' };
    const d = machineDiff(A.machine, B.machine);
    if (!d.ok) return { step: null, reason: d.reason };
    // brute-force lockstep oracle: compare the transition each machine is about to execute
    const a = new RefSim(A.machine, A.cfg);
    const n = maxSteps === undefined ? A._info.target - A.s0 : maxSteps;
    for (let i = 0; i < n; i++) {
      if (a.halted) return { step: null, reason: `A halts at step ${a.t} before any difference` };
      const k = a.next;
      const actA = A.machine.acts[k], actB = k < B.machine.n * B.machine.m ? B.machine.acts[k] : '---';
      if (actA !== actB) return { step: a.t + 1, tr: A.machine.names[k], a: actA, b: actB };
      a.step();
    }
    return { step: null, reason: `no difference within ${n} steps` };
  }
  async background(sid, step, maxP = 8) {
    const s = this._sess(sid);
    if (!(step >= s.s0 && step <= s._info.t)) throw E(ERR.RANGE, `step ${step} outside the run`);
    const sim = s.at(step);
    let lo = sim.lo, hi = sim.hi;
    if (sim.fresh) { if (sim.pos === lo) lo++; else if (sim.pos === hi) hi--; }
    const cells = sim.window(lo, hi);
    return { ...backgroundOf(cells, lo, Math.max(1, Math.min(16, Math.floor(maxP)))), step: sim.t, lo, hi };
  }
  async blockStats(sid, step, k) {
    const s = this._sess(sid);
    if (!(step >= s.s0 && step <= s._info.t)) throw E(ERR.RANGE, `step ${step} outside the run`);
    const sim = s.at(step), out = [];
    for (let p = 0; p < k; p++) {
      const counts = new Map();
      for (let x = sim.lo; x + k - 1 <= sim.hi; x++) {
        if (((x % k) + k) % k !== p) continue;
        let ok = true, w = '';
        for (let j = 0; j < k; j++) { if (!sim.isRead(x + j)) { ok = false; break; } w += sim.read(x + j); }
        if (ok) counts.set(w, (counts.get(w) || 0) + 1);
      }
      out.push({ p, words: [...counts.entries()].sort((x, y) => y[1] - x[1] || (x[0] < y[0] ? -1 : 1)) });
    }
    return out;
  }
  stats() {
    let rate = 0;
    for (const s of this.sessions.values()) rate += s._info.rate;
    return { workers: 0, queued: 0, running: 0, tileBytes: this.cacheBytes, ckptBytes: 0, recBytes: 0, rate, respawns: 0 };
  }
  dispose() {
    for (const s of [...this.sessions.values()]) this._close(s);
    this.disposed = true;
    this.cache.clear(); this.cacheBytes = 0;
  }
}

