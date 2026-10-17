// UI development stand-in for the ENGINE facade (spec §6), used when ui/engine-client.mjs (ENG) is missing or
// with ?engine=mock. Same interface as the real engine; everything runs on the main thread in time slices of
// <= 8 ms. Semantics follow tools/sim.py (spec §8.1 S1-S8); performance is not a goal (cap MOCK_MAX_STEPS).
import {
  PROTOCOL_VERSION, TILE, F_FRESH, F_NOHEAD, F_HALTED, F_ABSENT, F_PENDING, F_START, UNREAD, LIMITS, ERR, tileKey, rowsKey,
} from '../core/protocol.mjs';

const MOCK_MAX_STEPS = 4e8;
const SLICE_MS = 7;
const err = (code, message) => ({ code, message });

// ------------------------------------------------------------------------------------------ machine (S1)
export function parseMachine(text) {
  let s = String(text || '').trim().toUpperCase();
  if (s.includes('/')) s = s.replace(/\/+$/, '').split('/').pop();
  const rows = s.split('_');
  const n = rows.length;
  if (!s || n < 1 || n > LIMITS.maxStates) throw err(ERR.PARSE, `bad machine "${s}": ${n} states (max ${LIMITS.maxStates})`);
  const width = rows[0].length;
  if (width % 3 || width / 3 < 2 || width / 3 > LIMITS.maxSymbols || rows.some((r) => r.length !== width))
    throw err(ERR.PARSE, `bad machine "${s}": every state needs 3·m characters, 2 ≤ m ≤ ${LIMITS.maxSymbols}`);
  const m = width / 3;
  const W = new Uint8Array(n * m), D = new Int8Array(n * m), N = new Int8Array(n * m), names = [], acts = [];
  for (let q = 0; q < n; q++) for (let k = 0; k < m; k++) {
    const t = rows[q].slice(3 * k, 3 * k + 3), i = q * m + k;
    names.push(String.fromCharCode(65 + q) + k);
    acts.push(t);
    if (t === '---') { N[i] = -1; W[i] = 1; D[i] = 1; continue; }
    const mo = /^([0-9])([LR])([A-Z])$/.exec(t);
    if (!mo) throw err(ERR.PARSE, `bad transition "${t}" at ${names[i]}`);
    const w = +mo[1];
    if (w >= m) throw err(ERR.PARSE, `transition ${t} writes symbol ${w} in a ${m}-symbol machine`);
    let nx = mo[3].charCodeAt(0) - 65;
    if (nx >= n) { if (!'ZH'.includes(mo[3])) throw err(ERR.PARSE, `transition ${t} goes to ${mo[3]}, not a state (halt: Z or ---)`); nx = -2; }
    W[i] = w; D[i] = mo[2] === 'R' ? 1 : -1; N[i] = nx;
  }
  const reach = new Array(n).fill(false); reach[0] = true;
  const stack = [0];
  while (stack.length) { const q = stack.pop(); for (let k = 0; k < m; k++) { const nx = N[q * m + k]; if (nx >= 0 && !reach[nx]) { reach[nx] = true; stack.push(nx); } } }
  return { text: s, n, m, W, D, N, names, acts, reachable: reach };
}

// ------------------------------------------------------------------------------------------ configs (S2)
function evalExpr(src, vars) {
  let i = 0;
  const s = src.replace(/\s+/g, '');
  const peek = () => s[i];
  function atom() {
    if (peek() === '(') { i++; const v = add(); if (s[i++] !== ')') throw new Error('expected )'); return v; }
    if (peek() === '-') { i++; return -atom(); }
    let mo = /^\d+/.exec(s.slice(i));
    if (mo) { i += mo[0].length; let v = +mo[0]; const id = /^[A-Za-z_]\w*/.exec(s.slice(i)); if (id) { i += id[0].length; v *= look(id[0]); } return v; }
    mo = /^[A-Za-z_]\w*/.exec(s.slice(i));
    if (mo) { i += mo[0].length; return look(mo[0]); }
    throw new Error(`bad expression ${src}`);
  }
  function look(name) { if (!(name in vars)) throw new Error(`unbound variable ${name}`); return vars[name]; }
  function pow() { const a = atom(); if (s.startsWith('**', i)) { i += 2; return a ** pow(); } return a; }
  function mul() {
    let a = pow();
    for (;;) {
      if (s.startsWith('//', i)) { i += 2; a = Math.floor(a / pow()); }
      else if (peek() === '*') { i++; a *= pow(); }
      else if (peek() === '%') { i++; const b = pow(); a = ((a % b) + b) % b; }
      else return a;
    }
  }
  function add() { let a = mul(); for (;;) { if (peek() === '+') { i++; a += mul(); } else if (peek() === '-') { i++; a -= mul(); } else return a; } }
  const v = add();
  if (i !== s.length) throw new Error(`bad expression ${src}`);
  return v;
}

/** sim.Config.parse subset: -> {cells (lo..hi), lo, pos, q, dir} with q as letter. */
export function parseConfig(text, vars = {}, pos = 0) {
  let t = String(text).replace(/∞/g, 'inf');
  let out = '', depth = 0;
  for (const ch of t) { if (ch === '(') depth++; else if (ch === ')') depth--; if (depth > 0 && /\s/.test(ch)) continue; out += ch; }
  const toks = out.split(/\s+/).filter(Boolean);
  const left = [], right = [];
  let state = null, dir = null;
  toks.forEach((tok, idx) => {
    let mo = /^<([A-Z])$|^([A-Z])>$/.exec(tok);
    if (mo) {
      if (state) throw err(ERR.CONFIG, `two state tokens in "${text}"`);
      state = mo[1] || mo[2]; dir = mo[1] ? 'L' : 'R';
      return;
    }
    mo = /^(?:\((\d+)\)|(\d+))(?:\^(.+))?$/.exec(tok);
    if (!mo) throw err(ERR.CONFIG, `cannot parse token "${tok}"`);
    const block = (mo[1] || mo[2]).split('').map(Number);
    let count = 1;
    const raw = mo[3];
    if (raw === 'inf') {
      if (block.length !== 1 || block[0] !== 0) throw err(ERR.CONFIG, `only 0^inf is supported as an infinite part, got ${tok}`);
      if (!((idx === 0 && !state) || (idx === toks.length - 1 && state))) throw err(ERR.CONFIG, `0^inf must be the first or last token`);
      return;
    }
    if (raw !== undefined) {
      try { count = /^\d+$/.test(raw) ? +raw : evalExpr(raw.replace(/^\((.*)\)$/, '$1'), vars); } catch (e) { throw err(ERR.CONFIG, e.message); }
    }
    if (!(count >= 0)) throw err(ERR.CONFIG, `negative exponent in ${tok}`);
    if (block.length * count > LIMITS.spanCap) throw err(ERR.CONFIG, `config too long`);
    const dst = state ? right : left;
    for (let c = 0; c < count; c++) for (const b of block) dst.push(b);
  });
  if (!state) throw err(ERR.CONFIG, `no state token (<X or X>) in "${text}"`);
  let head;
  if (dir === 'L') { if (!left.length) left.push(0); head = left.length - 1; }
  else { if (!right.length) right.push(0); head = left.length; }
  const cells = Uint8Array.from(left.concat(right));
  return { cells, lo: pos - head, pos, q: state, dir };
}

/** bbchallenge parse_initial_tape: digits are cells; a state letter sets state, head on the next digit. */
export function parseSiteTape(tape, M) {
  const raw = [];
  let q = 0, pos = 0;
  for (const ch of String(tape)) {
    const c = ch.charCodeAt(0);
    if (c >= 48 && c < 48 + M.m) raw.push(c - 48);
    else if ((c >= 65 && c < 65 + M.n) || (c >= 97 && c < 97 + M.n)) { q = (c - 1) % 32; pos = raw.length; }
  }
  if (!raw.length) raw.push(0);
  if (pos >= raw.length) raw.push(0);
  return { cells: Uint8Array.from(raw), lo: -pos, pos: 0, q: String.fromCharCode(65 + q), dir: 'R' };
}

function rleTokens(cells) {
  const out = [];
  for (let i = 0; i < cells.length;) {
    let j = i + 1;
    while (j < cells.length && cells[j] === cells[i]) j++;
    out.push(j - i === 1 ? `${cells[i]}` : `${cells[i]}^${j - i}`);
    i = j;
  }
  return out;
}

/** sim.py Config.dh(rle=True, trim) of a snapshot {cells(lo..hi), lo, pos, q, dir}. */
export function dhOf(snap, trim = true) {
  const t = snap.cells, h = snap.pos - snap.lo, st = snap.q < 0 ? 'Z' : String.fromCharCode(65 + snap.q);
  const d = snap.dir < 0 ? 'L' : 'R';
  let left, right, tok;
  if (d === 'R') { left = Array.from(t.subarray(0, h)); right = Array.from(t.subarray(h)); tok = `${st}>`; }
  else { left = Array.from(t.subarray(0, h + 1)); right = Array.from(t.subarray(h + 1)); tok = `<${st}`; }
  if (trim) {
    while (left.length && left[0] === 0) left.shift();
    while (right.length && right[right.length - 1] === 0) right.pop();
  }
  return ['0^inf', ...rleTokens(left), tok, ...rleTokens(right), '0^inf'].join(' ');
}

// ------------------------------------------------------------------------------------------ simulator
class Sim {
  constructor(M) {
    this.M = M; this.tape = new Uint8Array(1 << 12); this.org = 1 << 11;
    this.q = 0; this.t = 0; this.pos = 0; this.lo = 0; this.hi = 0; this.dir = 0; this.fresh = false; this.tr = -1;
    this.halted = false; this.halt = null; this.ev = -1;
  }
  load(c) {
    const span = c.hi - c.lo + 1;
    if (this.tape.length < span * 2 + 64) { this.tape = new Uint8Array(Math.max(1 << 12, 2 ** Math.ceil(Math.log2(span * 2 + 64)))); }
    else this.tape.fill(0);
    this.org = Math.floor(this.tape.length / 2) - Math.floor((c.lo + c.hi) / 2);
    this.tape.set(c.cells, c.lo + this.org);
    if (c.fresh) this.tape[c.pos + this.org] = 0;
    Object.assign(this, { q: c.q, t: c.t, pos: c.pos, lo: c.lo, hi: c.hi, dir: c.dir, fresh: c.fresh, tr: c.tr, halted: c.halted, halt: c.halt });
    return this;
  }
  snap() {
    return { t: this.t, q: this.q, pos: this.pos, lo: this.lo, hi: this.hi, dir: this.dir, fresh: this.fresh, tr: this.tr,
      halted: this.halted, halt: this.halt, cells: this.tape.slice(this.lo + this.org, this.hi + this.org + 1) };
  }
  grow() {
    const old = this.tape, span = this.hi - this.lo + 1;
    const nt = new Uint8Array(Math.max(old.length * 2, span * 4));
    const norg = Math.floor(nt.length / 2) - Math.floor((this.lo + this.hi) / 2);
    nt.set(old.subarray(this.lo + this.org, this.hi + this.org + 1), this.lo + norg);
    this.tape = nt; this.org = norg;
  }
  read(p) { return p < this.lo || p > this.hi || (this.fresh && p === this.pos) ? -1 : this.tape[p + this.org]; }
  /** Run up to n steps. counts: Float64Array(n*m) accumulated; onRec(t, side 0=L 1=R); watch: Uint8Array mask. */
  run(n, counts, onRec, watch) {
    if (this.halted || n <= 0) return 0;
    const M = this.M, W = M.W, D = M.D, NN = M.N, m = M.m;
    let tape = this.tape, org = this.org, q = this.q, pos = this.pos, lo = this.lo, hi = this.hi, t = this.t, tr = this.tr, fresh = this.fresh;
    let done = 0;
    this.ev = -1;
    while (done < n) {
      const idx = pos + org;
      if (idx <= 1 || idx >= tape.length - 2) {
        Object.assign(this, { q, pos, lo, hi, t, tr, fresh });
        if (hi - lo + 1 >= LIMITS.spanCap) { this.spanCap = true; break; }
        this.grow(); tape = this.tape; org = this.org;
      }
      const s = tape[pos + org], i = q * m + s, nq = NN[i];
      tape[pos + org] = W[i];
      pos += D[i]; t++; done++; tr = i;
      if (counts) counts[i]++;
      if (pos < lo) { lo = pos; fresh = true; if (onRec) onRec(t, 0); }
      else if (pos > hi) { hi = pos; fresh = true; if (onRec) onRec(t, 1); }
      else fresh = false;
      if (nq < 0) {
        this.halted = true;
        this.halt = { step: t, from: M.names[i], read: s, kind: nq === -1 ? 'undefined' : 'halt-state' };
        q = -1;
        break;
      }
      q = nq;
      if (watch && watch[i]) { this.ev = i; break; }
    }
    this.q = q; this.pos = pos; this.lo = lo; this.hi = hi; this.t = t; this.tr = tr; this.fresh = fresh;
    if (tr >= 0) this.dir = D[tr];
    return done;
  }
}

function startSnap(M, spec) {
  const st = spec.start || { kind: 'blank' };
  let c;
  if (st.kind === 'blank') c = { cells: new Uint8Array(1), lo: 0, pos: 0, q: 'A', dir: 'R' };
  else if (st.kind === 'site') c = parseSiteTape(st.tape, M);
  else {
    if (!st.dh) throw err(ERR.CONFIG, 'empty start configuration');
    c = parseConfig(st.dh, st.vars || {}, st.pos || 0);
    for (const v of c.cells) if (v >= M.m) throw err(ERR.CONFIG, `symbol ${v} in a ${M.m}-symbol machine`);
  }
  const q = c.q.charCodeAt(0) - 65;
  if (q >= M.n) throw err(ERR.CONFIG, `start state ${c.q} is not a state of this machine`);
  return { t: spec.s0 || 0, q, pos: c.pos, lo: c.lo, hi: c.lo + c.cells.length - 1, dir: 0, fresh: false, tr: -1, halted: false, halt: null, cells: c.cells };
}

// ------------------------------------------------------------------------------------------ growable arrays
class F64 {
  constructor() { this.a = new Float64Array(1024); this.n = 0; }
  push(v) { if (this.n === this.a.length) { const b = new Float64Array(this.a.length * 2); b.set(this.a); this.a = b; } this.a[this.n++] = v; }
  get(i) { return this.a[i]; }
}
function upperBound(arr, n, v) { let lo = 0, hi = n; while (lo < hi) { const mid = (lo + hi) >> 1; if (arr[mid] <= v) lo = mid + 1; else hi = mid; } return lo; }

// ------------------------------------------------------------------------------------------ scheduler
class Sched {
  constructor() {
    this.tasks = []; this.scheduled = false;
    this.ch = typeof MessageChannel !== 'undefined' ? new MessageChannel() : null;
    if (this.ch) this.ch.port1.onmessage = () => this.tick();
    this.rr = 0;
  }
  add(task) { this.tasks.push(task); this.kick(); return task; }
  remove(pred) { this.tasks = this.tasks.filter((t) => !pred(t)); }
  kick() {
    if (this.scheduled) return;
    this.scheduled = true;
    if (this.ch) this.ch.port2.postMessage(0); else setTimeout(() => this.tick(), 0);
  }
  tick() {
    this.scheduled = false;
    const t0 = performance.now();
    while (this.tasks.length && performance.now() - t0 < SLICE_MS) {
      // alternate: run tasks get every other turn, tile tasks in priority order
      const runs = this.tasks.filter((t) => t.kind === 'run' && !t.paused), jobs = this.tasks.filter((t) => t.kind !== 'run');
      if (!runs.length && !jobs.length) break;
      let task;
      this.rr++;
      if (runs.length && (this.rr % 2 === 0 || !jobs.length)) task = runs[this.rr % runs.length];
      else task = jobs.sort((a, b) => (b.prio || 0) - (a.prio || 0))[0];
      let r;
      try { r = task.gen.next(); } catch (e) { console.error(e); r = { done: true }; if (task.onError) task.onError(e); }
      if (r.done) this.tasks = this.tasks.filter((t) => t !== task);
    }
    if (this.tasks.some((t) => !(t.kind === 'run' && t.paused))) this.kick();
  }
}

// ------------------------------------------------------------------------------------------ engine
export function createEngine(opts = {}) { return new MockEngine(opts); }

class MockEngine {
  constructor(opts) {
    this.opts = opts; this.sched = new Sched(); this.sessions = new Map(); this.nextSid = 1;
    this.cache = new Map(); this.cacheBytes = 0; this.live = new Map(); this.disposed = false; this.mock = true;
  }

  async open(spec) {
    if (this.disposed) throw err(ERR.CLOSED, 'engine disposed');
    const M = parseMachine(spec.tm);
    const s0snap = startSnap(M, spec);
    const sid = 's' + this.nextSid++;
    const S = new MockSession(this, sid, M, spec, s0snap);
    this.sessions.set(sid, S);
    S.startRun();
    return S;
  }

  _sess(sid) { const S = this.sessions.get(sid); if (!S || S.closed) throw err(ERR.CLOSED, `session ${sid} closed`); return S; }

  tiles(req, onTile) {
    const S = this.sessions.get(req.sid);
    let cancelled = false;
    if (!S || S.closed) return { cancel() {} };
    // supersede older live requests for this sid
    const prev = this.live.get(req.sid);
    if (prev && prev.req.gen < req.gen) { prev.cancelled = true; this.sched.remove((t) => t.sid === req.sid && t.kind === 'tile' && t.reqGen < req.gen); }
    const live = { req, onTile, cancelled: false, pending: new Set() };
    this.live.set(req.sid, live);
    const byBand = new Map();
    let prio = 1e6;
    for (const [ty, tx] of req.tiles) {
      const key = tileKey(req, ty, tx);
      const hit = this.cache.get(key);
      if (hit && hit.final) { this.cache.delete(key); this.cache.set(key, hit); queueMicrotask(() => { if (!live.cancelled && !cancelled) onTile(key, hit, true); }); continue; }
      if (!byBand.has(ty)) byBand.set(ty, { txs: [], prio: prio-- });
      byBand.get(ty).txs.push(tx);
    }
    for (const [ty, band] of byBand) this._queueBand(S, live, ty, band.txs, band.prio);
    return { cancel: () => { cancelled = true; live.cancelled = true; this.sched.remove((t) => t.live === live); } };
  }

  _queueBand(S, live, ty, txs, prio) {
    const req = live.req;
    const it = S.bandJob(req, ty, txs, (tile, final) => {
      if (live.cancelled) return;
      if (final) this._cachePut(tile.key, tile); else live.pending.add(`${ty},${tile.tx}`);
      live.onTile(tile.key, tile, final);
    });
    this.sched.add({ kind: 'tile', sid: req.sid, reqGen: req.gen, prio, live, gen: it });
  }

  _cachePut(key, tile) {
    const bytes = tile.kind === 'exact' ? 70000 : 256 * 256 * (2 + Object.keys(tile.planes).length * 2);
    this.cache.set(key, tile); this.cacheBytes += bytes; tile._bytes = bytes;
    while (this.cacheBytes > LIMITS.tileCacheBytes && this.cache.size) {
      const k = this.cache.keys().next().value, t = this.cache.get(k);
      this.cache.delete(k); this.cacheBytes -= t._bytes || 0;
    }
  }

  /** Called by a session at progress: re-run live requests whose tiles had pending rows. */
  _refreshLive(S) {
    const live = this.live.get(S.sid);
    if (!live || live.cancelled || !live.pending.size) return;
    const req = live.req, bands = new Map();
    for (const k of live.pending) { const [ty, tx] = k.split(',').map(Number); if (!bands.has(ty)) bands.set(ty, []); bands.get(ty).push(tx); }
    live.pending.clear();
    if (this.sched.tasks.some((t) => t.live === live)) return;      // still working; next progress retries
    let prio = 5e5;
    for (const [ty, txs] of bands) this._queueBand(S, live, ty, txs, prio--);
  }

  overview(sid) { const S = this.sessions.get(sid); return S && !S.closed ? S.overview() : null; }

  async probe(sid, step, x0, x1) {
    const S = this._sess(sid);
    if (step < S.s0 || step > S.sim.t) throw err(ERR.RANGE, `step ${step} outside ${S.s0}…${S.sim.t}`);
    const sim = await S.seekAsync(step);
    return S.probeResult(sim, x0, x1);
  }

  async usage(sid, t0, t1) {
    const S = this._sess(sid);
    const a = await S.cumAt(Math.max(S.s0, Math.min(t0, S.sim.t))), b = await S.cumAt(Math.max(S.s0, Math.min(t1, S.sim.t)));
    const counts = new Float64Array(a.length);
    for (let i = 0; i < a.length; i++) counts[i] = b[i] - a[i];
    return { t0, t1, counts };
  }

  async eventCount(sid, rows) { const S = this._sess(sid); return { count: S.eventTotal(rows), complete: S.status !== 'running' }; }
  async stepOfEvent(sid, rows, i) { const S = this._sess(sid); return S.stepOfEvent(rows, i); }
  async eventAtStep(sid, rows, step) { const S = this._sess(sid); return S.eventAtStep(rows, step); }

  async cursor(sid, step) {
    const S = this._sess(sid);
    const sim = new Sim(S.M).load((await S.seekAsync(Math.min(step, S.sim.t))).snap());
    const mk = (fired) => S.frameOf(sim, fired);
    const cur = {
      frame: mk(new Float64Array(S.M.n * S.M.m)),
      advance: async (n) => {
        const counts = new Float64Array(S.M.n * S.M.m);
        const lim = Math.max(0, Math.min(n, S.sim.t - sim.t));
        sim.run(lim, counts);
        cur.frame = mk(counts);
        return cur.frame;
      },
      seek: async (st) => {
        const src = await S.seekAsync(Math.max(S.s0, Math.min(st, S.sim.t)));
        sim.load(src.snap());
        cur.frame = mk(new Float64Array(S.M.n * S.M.m));
        return cur.frame;
      },
      close() {},
    };
    return cur;
  }

  async diverge(sidA, sidB, maxSteps) {
    const A = this._sess(sidA), B = this._sess(sidB);
    const same = JSON.stringify(A.spec.start) === JSON.stringify(B.spec.start) && (A.s0 === B.s0);
    if (!same) return { step: null, reason: 'different starts' };
    if (A.M.n !== B.M.n || A.M.m !== B.M.m) return { step: null, reason: 'different machine sizes' };
    const watch = new Uint8Array(A.M.n * A.M.m);
    let any = false;
    for (let i = 0; i < watch.length; i++) if (A.M.acts[i] !== B.M.acts[i]) { watch[i] = 1; any = true; }
    if (!any) return { step: null, reason: 'identical machines' };
    const sim = new Sim(A.M).load(A.start);
    let left = Math.min(maxSteps, MOCK_MAX_STEPS);
    while (left > 0) {
      const ran = sim.run(Math.min(left, 1 << 20), null, null, watch);
      left -= ran;
      if (sim.ev >= 0) { const i = sim.ev; return { step: sim.t, tr: A.M.names[i], a: A.M.acts[i], b: B.M.acts[i] }; }
      if (sim.halted || ran === 0) break;
      await new Promise((r) => setTimeout(r, 0));
    }
    return { step: null, reason: sim.halted ? 'A halted first' : `no difference within ${maxSteps} steps` };
  }

  async blockStats(sid, step, k) {
    const S = this._sess(sid);
    const sim = await S.seekAsync(Math.max(S.s0, Math.min(step, S.sim.t)));
    const out = [];
    for (let p = 0; p < k; p++) {
      const map = new Map();
      let x = sim.lo + ((((p - sim.lo) % k) + k) % k);
      for (; x + k - 1 <= sim.hi; x += k) {
        let w = '', ok = true;
        for (let u = 0; u < k; u++) { const v = sim.read(x + u); if (v < 0) { ok = false; break; } w += v; }
        if (ok) map.set(w, (map.get(w) || 0) + 1);
      }
      out.push({ p, words: [...map.entries()].sort((a, b) => b[1] - a[1]) });
    }
    return out;
  }

  stats() {
    let ck = 0; for (const S of this.sessions.values()) ck += S.ckptBytes;
    return { workers: 0, queued: this.sched.tasks.length, running: 0, tileBytes: this.cacheBytes, ckptBytes: ck, recBytes: 0, rate: 0, mock: true };
  }

  dispose() { this.disposed = true; for (const S of this.sessions.values()) S.close(); this.sched.tasks = []; }
}

class MockSession {
  constructor(E, sid, M, spec, start) {
    this.E = E; this.sid = sid; this.M = M; this.spec = { ...spec, steps: Math.min(spec.steps, MOCK_MAX_STEPS) };
    this.requested = spec.steps;
    this.s0 = spec.s0 || 0; this.start = start;
    this.machine = { text: M.text, n: M.n, m: M.m, W: M.W, D: M.D, N: M.N, names: M.names, acts: M.acts, reachable: M.reachable };
    this.sim = new Sim(M).load(start);
    this.listeners = { progress: new Set(), overview: new Set(), done: new Set(), error: new Set() };
    this.status = 'running'; this.closed = false; this.rate = 0; this.t0wall = performance.now();
    this.c = Math.max(LIMITS.ckptC0Min, Math.ceil(Math.log2(Math.max(1, this.spec.steps / 2048))));
    this.ckpts = []; this.cum = new Float64Array(M.n * M.m); this.ckptBytes = 0;
    this.recAll = new F64(); this.recL = new F64(); this.recR = new F64();
    this.extent = { lo: start.lo, hi: start.hi };
    this.pushCkpt();
    this.startRow = this.probeResult(this.sim, start.lo - 8, start.hi + 8);
    this.ov = null; this.lastEmit = 0;
  }
  info() {
    const s = this.sim;
    return {
      sid: this.sid, tm: this.M.text, n: this.M.n, m: this.M.m, start: this.spec.start, s0: this.s0,
      t: s.t, target: this.spec.steps + this.s0, rate: this.rate, status: this.status,
      state: s.q < 0 ? 'Z' : String.fromCharCode(65 + s.q), pos: s.pos, lo: s.lo, hi: s.hi,
      extent: { ...this.extent }, halt: s.halt ? { ...s.halt } : null,
      ckpt: { c: this.c, count: this.ckpts.length, bytes: this.ckptBytes }, rec: { count: this.recAll.n, r: 0 },
      elapsed: this.elapsed, mock: true, capped: this.requested > MOCK_MAX_STEPS ? MOCK_MAX_STEPS : null,
      ...(this.error ? { error: this.error } : {}),
    };
  }
  on(type, cb) { this.listeners[type].add(cb); return () => this.listeners[type].delete(cb); }
  emit(type, v) { for (const cb of this.listeners[type]) { try { cb(v); } catch (e) { console.error(e); } } }
  pushCkpt() {
    const sn = this.sim.snap();
    sn.cum = this.cum.slice(); sn.recN = this.recAll.n; sn.recLN = this.recL.n; sn.recRN = this.recR.n;
    this.ckpts.push(sn); this.ckptBytes += sn.cells.length + 200;
    if (this.ckpts.length > LIMITS.ckptMaxCount || this.ckptBytes > LIMITS.ckptBudgetBytes) {
      this.c++;
      const step = 2 ** this.c;
      this.ckpts = this.ckpts.filter((k) => (k.t - this.s0) % step === 0);
      this.ckptBytes = this.ckpts.reduce((a, k) => a + k.cells.length + 200, 0);
      this.ov = null;
    }
  }
  startRun() {
    const self = this;
    const onRec = (t, side) => {
      if (self.recAll.n >= 4e6) return;
      self.recAll.push(t); (side ? self.recR : self.recL).push(t);
    };
    function* gen() {
      const target = () => self.s0 + self.spec.steps;
      let lastT = self.sim.t, lastWall = performance.now();
      while (!self.closed) {
        if (self.sim.t >= target() || self.sim.halted || self.sim.spanCap) {
          self.finish();
          return;
        }
        const stride = 2 ** self.c;
        const nextC = self.s0 + (Math.floor((self.sim.t - self.s0) / stride) + 1) * stride;
        const chunk = Math.min(nextC - self.sim.t, target() - self.sim.t, 1 << 19);
        self.sim.run(chunk, self.cum, onRec);
        self.extent.lo = Math.min(self.extent.lo, self.sim.lo); self.extent.hi = Math.max(self.extent.hi, self.sim.hi);
        if ((self.sim.t - self.s0) % stride === 0 || self.sim.halted) self.pushCkpt();
        const now = performance.now();
        if (now - lastWall > 250) {
          const r = (self.sim.t - lastT) / ((now - lastWall) / 1000);
          self.rate = self.rate ? 0.7 * self.rate + 0.3 * r : r;
          lastT = self.sim.t; lastWall = now;
          self.emit('progress', self.info());
          self.emit('overview', null);
          self.E._refreshLive(self);
        }
        yield;
      }
    }
    this.task = this.E.sched.add({ kind: 'run', sid: this.sid, gen: gen() });
  }
  finish() {
    if (this.sim.halted) this.status = 'halted'; else if (this.sim.spanCap) { this.status = 'span-cap'; this.error = err(ERR.SPANCAP, 'span cap reached'); } else this.status = 'done';
    this.elapsed = (performance.now() - this.t0wall) / 1000;
    if (!this.ckpts.length || this.ckpts[this.ckpts.length - 1].t !== this.sim.t) this.pushCkpt();
    const info = this.info();
    this.emit('progress', info);
    this.emit('overview', null);
    this.emit('done', info);
    this.E._refreshLive(this);
  }
  extend(total) {
    this.spec.steps = Math.min(total, MOCK_MAX_STEPS); this.requested = total;
    if (this.status === 'done') { this.status = 'running'; this.startRun(); }
  }
  pause() { if (this.task) this.task.paused = true; if (this.status === 'running') this.status = 'paused'; this.emit('progress', this.info()); }
  resume() { if (this.task) this.task.paused = false; if (this.status === 'paused') this.status = 'running'; this.E.sched.kick(); this.emit('progress', this.info()); }
  close() { this.closed = true; this.E.sched.remove((t) => t.sid === this.sid); this.E.sessions.delete(this.sid); }

  ckptIndex(t) { return Math.max(0, upperBound(this.ckpts.map((c) => c.t), this.ckpts.length, t) - 1); }
  ckptAt(t) {
    // binary search on ckpts by t
    let lo = 0, hi = this.ckpts.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (this.ckpts[mid].t <= t) lo = mid + 1; else hi = mid; }
    return this.ckpts[Math.max(0, lo - 1)];
  }
  /** A Sim at step t (synchronous; t <= sim.t). */
  seek(t, sim) {
    const ck = this.ckptAt(t);
    if (!sim) sim = new Sim(this.M);
    if (!(sim.t <= t && sim.t >= ck.t && !sim.halted)) sim.load(ck);
    sim.run(t - sim.t);
    return sim;
  }
  async seekAsync(t) {
    const sim = new Sim(this.M).load(this.ckptAt(t));
    while (sim.t < t && !sim.halted) { sim.run(Math.min(t - sim.t, 1 << 21)); if (sim.t < t) await new Promise((r) => setTimeout(r, 0)); }
    return sim;
  }
  async cumAt(t) {
    const ck = this.ckptAt(t);
    const sim = new Sim(this.M).load(ck);
    const counts = ck.cum.slice();
    while (sim.t < t && !sim.halted) { sim.run(Math.min(t - sim.t, 1 << 21), counts); if (sim.t < t) await new Promise((r) => setTimeout(r, 0)); }
    return counts;
  }
  watchMask(rows) {
    const M = this.M, mask = new Uint8Array(M.n * M.m);
    if (rows.kind === 'state') {
      const q = rows.q.charCodeAt(0) - 65;
      for (let i = 0; i < mask.length; i++) if (M.N[i] === q && (!rows.dir || (rows.dir === 'L' ? M.D[i] < 0 : M.D[i] > 0))) mask[i] = 1;
    } else if (rows.kind === 'trans') {
      const i = M.names.indexOf(rows.tr);
      if (i >= 0) mask[i] = 1;
    }
    return mask;
  }
  evFromCum(cum, mask) { let s = 0; for (let i = 0; i < mask.length; i++) if (mask[i]) s += cum[i]; return s; }
  recArr(side) { return side === 'L' ? this.recL : side === 'R' ? this.recR : this.recAll; }
  /** Number of base rows of an event mode up to sim.t (records include the start row). */
  eventTotal(rows) {
    if (rows.kind === 'records') return this.recArr(rows.side).n + 1;
    return this.evFromCum(this.cum, this.watchMask(rows));
  }
  /** Step of base row i (sync for records; state/trans count with watch from the nearest checkpoint). */
  stepOfEventSync(rows, i, simHint) {
    if (rows.kind === 'records') {
      if (i === 0) return this.s0;
      const A = this.recArr(rows.side);
      return i - 1 < A.n ? A.get(i - 1) : NaN;
    }
    const mask = this.watchMask(rows);
    if (i >= this.evFromCum(this.cum, mask)) return NaN;
    // find last checkpoint whose cumulative events <= i
    let lo = 0, hi = this.ckpts.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (this.evFromCum(this.ckpts[mid].cum, mask) <= i) lo = mid + 1; else hi = mid; }
    const ck = this.ckpts[Math.max(0, lo - 1)];
    let have = this.evFromCum(ck.cum, mask);
    let sim = simHint;
    if (!(sim && sim._ev !== undefined && sim._mask === rows && sim._ev <= i && sim.t >= ck.t)) {
      sim = simHint || new Sim(this.M); sim.load(ck); sim._ev = have; sim._mask = rows;
    }
    have = sim._ev;
    while (have <= i) {
      sim.run(1e15, null, null, mask);
      if (sim.ev < 0) return NaN;
      have++;
    }
    sim._ev = have;
    return sim.t;
  }
  async stepOfEvent(rows, i) { const v = this.stepOfEventSync(rows, i); if (Number.isNaN(v)) throw err(ERR.RANGE, `event ${i} not reached`); return v; }
  async eventAtStep(rows, step) {
    if (rows.kind === 'records') { const A = this.recArr(rows.side); return upperBound(A.a, A.n, step); }
    const mask = this.watchMask(rows);
    const counts = await this.cumAt(Math.min(step, this.sim.t));
    return this.evFromCum(counts, mask) - 1;
  }

  /** Generator: compute tiles (ty, txs) for req; calls deliver(tile, final). */
  *bandJob(req, ty, txs, deliver) {
    const M = this.M, m = M.m, rows = req.rows, kt = req.kt, kx = req.kx, per = 2 ** -kt, cx = 2 ** -kx;
    const event = rows.kind !== 'auto' && rows.kind !== 'every';
    const running = this.status === 'running' || this.status === 'paused';
    const end = this.sim.t, halted = this.sim.halted, haltStep = halted ? this.sim.halt.step : null;
    const tiles = txs.map((tx) => this.newTile(req, ty, tx, event));
    const sim = new Sim(M);
    let lastEvRow = -1, lastRegularEvent = event ? this.eventTotal(rows) - 1 : -1;
    let tStart = performance.now(), hadPending = false;
    for (let i = 0; i < TILE; i++) {
      const b = (TILE * ty + i) * per;
      let step = NaN, ev = null, haltRow = false;
      if (!event) {
        const s = rows.kind === 'auto' ? b : b * rows.k + (rows.o || 0);
        if (s < this.s0) step = NaN;
        else if (halted && s >= haltStep) {
          const prevS = rows.kind === 'auto' ? b - per : (b - per) * rows.k + (rows.o || 0);
          if (s === haltStep || prevS < haltStep) { step = haltStep; haltRow = true; } else step = NaN;
        } else if (s > end) { step = running ? -1 : NaN; }
        else step = s;
      } else {
        ev = b;
        if (b < 0) step = NaN;
        else if (b <= lastRegularEvent) step = this.stepOfEventSync(rows, b, sim);
        else if (halted && b === lastRegularEvent + 1) { step = haltStep; haltRow = true; }
        else step = running ? -1 : NaN;
        if (haltRow && rows.kind !== 'records') {
          // the last event may itself be the halting step
          const lastS = lastRegularEvent >= 0 ? this.stepOfEventSync(rows, lastRegularEvent) : -1;
          if (lastS === haltStep) { step = NaN; haltRow = false; }
        }
      }
      if (step === -1) { hadPending = true; for (const T of tiles) this.markRow(T, i, F_NOHEAD | F_PENDING); continue; }
      if (Number.isNaN(step)) { for (const T of tiles) this.markRow(T, i, F_NOHEAD | F_ABSENT); continue; }
      // seek
      if (!(sim.t <= step && sim.t >= this.ckptAt(step).t && !sim.halted) || sim.M !== M) sim.load(this.ckptAt(step));
      sim.run(step - sim.t);
      for (const T of tiles) this.extractRow(T, i, sim, req, ev, haltRow);
      if (performance.now() - tStart > 4) { yield; tStart = performance.now(); }
    }
    for (const T of tiles) { T.final = !hadPending; deliver(T, !hadPending); }
  }

  newTile(req, ty, tx, event) {
    const key = tileKey(req, ty, tx), base = {
      key, sid: this.sid, ty, tx, kt: req.kt, m: this.M.m, n: TILE,
      meta: new Int32Array(8 * TILE), steps: new Float64Array(TILE).fill(NaN), ev: event ? new Float64Array(TILE).fill(NaN) : null,
      next: new Int16Array(TILE).fill(-1), final: false,
    };
    if (req.kx === 0) {
      base.kind = 'exact'; base.cells = new Uint8Array(TILE * TILE); base.off = new Float64Array(TILE + 1);
      for (let i = 0; i <= TILE; i++) base.off[i] = TILE * i;
    } else {
      const cx = 2 ** -req.kx;
      base.kind = 'pooled'; base.kx = req.kx; base.cx = cx; base.cols = TILE; base.headCol = new Int16Array(TILE).fill(-1);
      base.dtype = cx <= 32768 ? 'u16' : 'u32';
      const A = cx <= 32768 ? Uint16Array : Uint32Array;
      base.planes = { vis: new A(TILE * TILE), near: new Uint8Array(TILE * TILE).fill(UNREAD) };
      for (let k = 1; k < this.M.m; k++) base.planes['cnt:' + k] = new A(TILE * TILE);
      for (const p of req.patterns || []) base.planes['pat:' + p] = new A(TILE * TILE);
      if (req.blk) base.planes[`blk:${req.blk.k}.${req.blk.p}.${req.blk.words.join('+')}`] = new A(TILE * TILE);
    }
    return base;
  }
  markRow(T, i, flags) { const b = 8 * i; T.meta[b + 2] = flags; T.meta[b] = -1; T.meta[b + 7] = 0; T.steps[i] = NaN; T.next[i] = -1; }

  extractRow(T, i, sim, req, ev, haltRow) {
    const M = this.M, b = 8 * i, frame = req.frame;
    let pos = sim.pos, lo = sim.lo, hi = sim.hi, fresh = sim.fresh, flags = 0;
    let fixCell = null;
    if (sim.halted && haltRow) {
      flags |= F_HALTED;
      if (req.halt === 'site' && sim.halt.kind === 'undefined') {
        const p = pos - 1;
        if (fresh) hi -= 1;
        fixCell = [p, sim.halt.read];
        pos = p; fresh = false; flags |= F_NOHEAD;
      }
    }
    if (fresh) flags |= F_FRESH;
    if (sim.t === this.s0) flags |= F_START;
    const anchor = frame === 'head' ? pos : frame === 'left' ? lo : frame === 'right' ? hi : 0;
    const q = sim.halted ? -1 : sim.q;
    const dir = sim.tr < 0 ? 0 : sim.dir;
    T.steps[i] = sim.t; if (T.ev) T.ev[i] = ev;
    const read = (p) => {
      if (fixCell && p === fixCell[0]) return fixCell[1];
      if (p < lo || p > hi || (fresh && p === pos)) return -1;
      return sim.tape[p + sim.org];
    };
    T.next[i] = q >= 0 ? q * M.m + Math.max(0, read(pos)) : -1;
    if (T.kind === 'exact') {
      const a = Math.max(lo, anchor + TILE * T.tx), z = Math.min(hi, anchor + TILE * T.tx + TILE - 1);
      const len = z >= a ? z - a + 1 : 0;
      const o = TILE * i;
      for (let p = a; p <= z; p++) { const v = read(p); T.cells[o + p - a] = v < 0 ? 0 : v; }
      T.meta.set([q, dir, flags, pos, lo, hi, len ? a : anchor + TILE * T.tx, len], b);
      return;
    }
    const cx = T.cx, u0 = TILE * T.tx * cx, P = T.planes, row = TILE * i;
    T.meta.set([q, dir, flags, pos, lo, hi, anchor + u0, TILE * cx], b);
    let d0 = lo, d1 = hi;
    if (fresh) { if (pos === lo) d0++; else if (pos === hi) d1--; }
    const a = Math.max(d0, anchor + u0), z = Math.min(d1, anchor + u0 + TILE * cx - 1);
    const vis = P.vis, near = P.near, cnt = [];
    for (let k = 1; k < M.m; k++) cnt[k] = P['cnt:' + k];
    for (let p = a; p <= z; p++) {
      const v = read(p); if (v < 0) continue;
      const u = p - anchor, c = Math.floor(u / cx) - TILE * T.tx, idx = row + c;
      vis[idx]++;
      if (v > 0) cnt[v][idx]++;
      if (u >= 0) { if (near[idx] === UNREAD) near[idx] = v; } else near[idx] = v;
    }
    for (const pat of req.patterns || []) {
      const mo = /^([0-9]+)(?:@(\d+)\.(\d+))?$/.exec(pat), W = mo[1], k = mo[2] ? +mo[2] : 1, ph = mo[3] ? +mo[3] : 0, L = W.length;
      const plane = P['pat:' + pat];
      for (let x = a; x <= z; x++) {
        if (k > 1 && (((x - ph) % k) + k) % k !== 0) continue;
        if (x + L - 1 > d1) break;
        let ok = true;
        for (let j = 0; j < L; j++) { const v = read(x + j); if (v !== W.charCodeAt(j) - 48) { ok = false; break; } }
        if (ok) plane[row + Math.floor((x - anchor) / cx) - TILE * T.tx]++;
      }
    }
    if (req.blk) {
      const { k, p: ph, words } = req.blk, plane = P[`blk:${k}.${ph}.${words.join('+')}`], set = new Set(words);
      let x = a + ((((ph - a) % k) + k) % k);
      for (; x <= z; x += k) {
        if (x + k - 1 > d1) break;
        let w = '', ok = true;
        for (let j = 0; j < k; j++) { const v = read(x + j); if (v < 0) { ok = false; break; } w += v; }
        if (ok && !set.has(w)) plane[row + Math.floor((x - anchor) / cx) - TILE * T.tx]++;
      }
    }
    if (!(flags & F_NOHEAD)) {
      const c = Math.floor((pos - anchor) / cx) - TILE * T.tx;
      T.headCol[i] = c >= 0 && c < TILE ? c : -1;
    }
  }

  probeResult(sim, x0, x1) {
    const M = this.M, cells = new Uint8Array(Math.max(0, x1 - x0 + 1));
    for (let p = x0; p <= x1; p++) { const v = sim.read(p); cells[p - x0] = v < 0 ? UNREAD : v; }
    const q = sim.halted ? -1 : sim.q;
    const s = q >= 0 ? Math.max(0, sim.read(sim.pos)) : 0;
    const snap = sim.snap();
    return {
      step: sim.t, state: q < 0 ? 'Z' : String.fromCharCode(65 + q), dir: sim.tr < 0 ? 0 : sim.dir, pos: sim.pos, lo: sim.lo, hi: sim.hi,
      fresh: sim.fresh, halted: sim.halted, x0, cells,
      next: q >= 0 ? { tr: M.names[q * M.m + s], act: M.acts[q * M.m + s] } : null,
      prev: sim.tr >= 0 ? { tr: M.names[sim.tr], act: M.acts[sim.tr] } : null,
      dh: dhOf(snap, true), dhExact: dhOf(snap, false),
    };
  }
  frameOf(sim, fired) {
    const r = this.probeResult(sim, sim.pos - 64, sim.pos + 64);
    delete r.dh; delete r.dhExact;
    r.fired = fired;
    return r;
  }

  overview() {
    if (!this.ckpts.length) return null;
    const ext = this.extent, width = ext.hi - ext.lo + 1;
    let j = 0;
    while (width / 2 ** j > LIMITS.ovMaxCols) j++;
    const u0 = Math.floor(ext.lo / 2 ** j) * 2 ** j, cols = Math.floor((ext.hi - u0) / 2 ** j) + 1;
    const key = `${j}|${u0}|${cols}|${this.ckpts.length}|${this.c}`;
    if (this.ov && this.ov.key === key) return this.ov.data;
    const rowsN = this.ckpts.length, m = this.M.m, sz = rowsN * cols;
    // reuse earlier rows when only new checkpoints were added
    const prev = this.ov && this.ov.j === j && this.ov.u0 === u0 && this.ov.cols === cols && this.ov.c === this.c ? this.ov : null;
    const data = {
      t: new Float64Array(rowsN), j, u0, cols, cnt: [], vis: new Uint32Array(sz), near: new Uint8Array(sz).fill(UNREAD),
      lo: new Float64Array(rowsN), hi: new Float64Array(rowsN), pos: new Float64Array(rowsN),
    };
    for (let k = 1; k < m; k++) data.cnt.push(new Uint32Array(sz));
    let from = 0;
    if (prev) {
      from = prev.rows;
      data.t.set(prev.data.t.subarray(0, from)); data.lo.set(prev.data.lo.subarray(0, from)); data.hi.set(prev.data.hi.subarray(0, from)); data.pos.set(prev.data.pos.subarray(0, from));
      data.vis.set(prev.data.vis.subarray(0, from * cols)); data.near.set(prev.data.near.subarray(0, from * cols));
      for (let k = 0; k < m - 1; k++) data.cnt[k].set(prev.data.cnt[k].subarray(0, from * cols));
    }
    const S = 2 ** j;
    for (let r = from; r < rowsN; r++) {
      const ck = this.ckpts[r];
      data.t[r] = ck.t; data.lo[r] = ck.lo; data.hi[r] = ck.hi; data.pos[r] = ck.pos;
      const base = r * cols;
      for (let p = ck.lo; p <= ck.hi; p++) {
        if (ck.fresh && p === ck.pos) continue;
        const v = ck.cells[p - ck.lo], u = p, c = Math.floor((u - u0) / S), idx = base + c;
        data.vis[idx]++;
        if (v > 0) data.cnt[v - 1][idx]++;
        if (u >= 0) { if (data.near[idx] === UNREAD) data.near[idx] = v; } else data.near[idx] = v;
      }
    }
    this.ov = { key, j, u0, cols, c: this.c, rows: rowsN, data };
    return data;
  }
}

export const MOCK = true;
export { PROTOCOL_VERSION, rowsKey };
