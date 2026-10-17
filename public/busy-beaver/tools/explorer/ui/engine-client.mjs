// ui/engine-client.mjs (ENGINE): the engine facade (explorer-spec §6). The ONLY module that creates engine workers.
// engine/stub-client.mjs exports the same API on the main thread (refsim, <= 2e6 steps).
//
//   createEngine(opts = {}) -> Engine
//     opts: {workers?, tileCacheBytes?, ckptBudgetBytes?, limits?: Partial<LIMITS>, workerFactory?: (kind) => Worker}
//
//   Engine.open(spec: OpenSpec) -> Promise<Session>     rejects {code:E_PARSE|E_CONFIG, message}
//     OpenSpec.steps counts steps after s0: the run stops at step s0 + steps (RunInfo.target = s0 + steps).
//   Session { sid, machine, startRow, info(), on(type, cb) -> unsubscribe, extend(totalSteps), pause(), resume(), close() }
//     events: 'progress'(RunInfo, <= 4 Hz) | 'overview'(Overview) | 'done'(RunInfo) | 'error'({code, message})
//     extend(totalSteps): new total, counted after s0 like OpenSpec.steps.
//   Engine.tiles(req: TileRequest, onTile(key, tile, final)) -> {cancel()}
//     TileRequest = {sid, gen, rows, frame, kt <= 0, kx <= 0, patterns, blk, halt: 'site'|'sim', tiles: [[ty, tx], ...]}
//     kind 'exact' iff kx == 0. Cache hits arrive in a microtask with final=true; a key may arrive several times with
//     final=false (strips landing, PENDING rows) and final=true exactly once per request unless cancelled. The most
//     recent request per sid stays LIVE while the run is running (PENDING rows are recomputed as progress passes
//     them); a new tiles() call for the sid supersedes it and cancel() drops it. Throws {code:E_CLOSED|E_RANGE}.
//   Engine.overview(sid) -> Overview | null
//   Engine.probe(sid, step, x0, x1) -> Promise<ProbeResult>        E_RANGE if step < s0 or > info().t
//   Engine.usage(sid, t0, t1) -> Promise<UsageTable>                exact firings in (t0, t1]
//   Engine.eventCount(sid, rows) -> Promise<{count, complete, rows}>  base rows up to info().t (+ a halting row in `rows`)
//   Engine.stepOfEvent(sid, rows, i) -> Promise<number>             step of base row i (records ordinal 0 = s0)
//   Engine.eventAtStep(sid, rows, step) -> Promise<number>          last base row with step <= step (-1 if none)
//   Engine.cursor(sid, step) -> Promise<Cursor>  Cursor {frame, advance(n), seek(step), close()}
//   Engine.diverge(sidA, sidB, maxSteps) -> Promise<{step|null, tr?, a?, b?, reason?}>
//   Engine.blockStats(sid, step, k) -> Promise<[{p, words: [[word, count], ...]}]>
//   Engine.background(sid, step, maxP = 8) -> Promise<{k, p, word, words, rates, best, confident, coverage}>  (extension)
//   Engine.probe(sid, step, x0, x1, {compress}) -> ProbeResult also carries `dhc`: tools/compress.py's compressed text
//     of the span (compress: true -> up to 2^18 cells; default -> spans up to 4,096 cells; false -> never; else null). (extension)
//   Engine.stats() -> {workers, queued, running, tileBytes, ckptBytes, recBytes, rate, respawns}
//   Engine.dispose()
// Every promise resolves or rejects with {code, message}; nothing hangs after dispose() or close() (E_CLOSED).
import { PROTOCOL_VERSION, TILE, STRIP, F_PENDING, LIMITS, ERR, tileKey } from '../core/protocol.mjs';
import { parseMachine } from '../core/machine.mjs';
import { startConfig } from '../core/config.mjs';
import { CheckpointStore, seekRef } from '../engine/checkpoints.mjs';
import { RecordIndex } from '../engine/records.mjs';
import { UsageIndex, maskedSum } from '../engine/usage.mjs';
import { OverviewStore } from '../engine/pool.mjs';
import { rowsInfo, checkRequest, emptyTile, tileBytesFor, assembleStrip, startProbe } from '../engine/rows.mjs';

const V = PROTOCOL_VERSION;
const STRIPS = TILE / STRIP;
const E = (code, message) => ({ code, message });
const asErr = (e) => (e && e.code ? { code: e.code, message: e.message } : E(ERR.INTERNAL, String((e && e.message) || e)));
const nowMs = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

function defaultFactory(kind) {
  const url = new URL(kind === 'run' ? '../engine/run-worker.mjs' : '../engine/tile-worker.mjs', import.meta.url);
  return new Worker(url, { type: 'module' });
}

export function createEngine(opts = {}) { return new Engine(opts); }

// ================================================================================================
class Session {
  constructor(engine, sid, spec, machine, cfg, target) {
    this._e = engine;
    this.sid = sid;
    this.machine = machine;
    this.spec = { tm: machine.text, start: spec.start || { kind: 'blank' }, s0: cfg.step, steps: target - cfg.step };
    this.s0 = cfg.step;
    this.cfg = cfg;
    this.startRow = startProbe(cfg, machine);
    this.closed = false;
    this.listeners = new Map();
    this.store = new CheckpointStore(cfg.step);
    this.recIdx = new RecordIndex(cfg.step);
    this.ov = new OverviewStore(machine.m, engine.limits.ovMaxCols);
    this.usage = new UsageIndex(machine.n * machine.m);
    this.usageWait = [];
    this.blocked = [];
    this.live = null;
    this.jobs = new Set();          // general jobs (for E_CLOSED on close)
    this.recL = 0;
    this._info = {
      sid, tm: machine.text, n: machine.n, m: machine.m, start: this.spec.start, s0: cfg.step,
      t: cfg.step, target, rate: 0, status: 'running', state: cfg.state,
      pos: cfg.lo + cfg.head, lo: cfg.lo, hi: cfg.lo + cfg.tape.length - 1,
      extent: { lo: cfg.lo, hi: cfg.lo + cfg.tape.length - 1 }, halt: null,
      ckpt: { c: 0, count: 0, bytes: 0 }, rec: { count: 0, r: 0 },
    };
  }
  info() { return this._info; }
  on(type, cb) {
    let s = this.listeners.get(type);
    if (!s) this.listeners.set(type, (s = new Set()));
    s.add(cb);
    return () => s.delete(cb);
  }
  _emit(type, arg) {
    const s = this.listeners.get(type);
    if (s) for (const cb of [...s]) { try { cb(arg); } catch (e) { /* listener errors never break the engine */ } }
  }
  _set(patch) { this._info = { ...this._info, ...patch }; return this._info; }
  extend(totalSteps) {
    if (this.closed) return;
    const target = this.s0 + totalSteps;
    if (!(target > this._info.target)) return;
    this._e._post(this, { type: 'extend', sid: this.sid, steps: target });
    const st = this._info.status;
    this._set({ target, status: st === 'done' ? 'running' : st });
    this._e._reopenEnd(this);
  }
  pause() {
    if (this.closed || this._info.status !== 'running') return;
    this._e._post(this, { type: 'pause', sid: this.sid });
    this._set({ status: 'paused' });
    this._emit('progress', this._info);
    this._e._refresh(this, true);
  }
  resume() {
    if (this.closed || this._info.status !== 'paused') return;
    this._e._post(this, { type: 'resume', sid: this.sid });
    this._set({ status: 'running' });
    this._emit('progress', this._info);
    this._e._reopenEnd(this);
  }
  close() { this._e._closeSession(this); }
}

// ================================================================================================
class Engine {
  constructor(opts) {
    this.limits = { ...LIMITS, ...(opts.limits || {}) };
    if (opts.tileCacheBytes) this.limits.tileCacheBytes = opts.tileCacheBytes;
    if (opts.ckptBudgetBytes) this.limits.ckptBudgetBytes = opts.ckptBudgetBytes;
    const hc = (typeof navigator !== 'undefined' && navigator.hardwareConcurrency) || 4;
    this.P = Math.max(1, Math.min(16, opts.workers || Math.min(8, Math.max(2, hc - 2))));
    this.factory = opts.workerFactory || defaultFactory;
    this.pool = [];
    this.sessions = new Map();
    this.queue = [];
    this.pending = new Map();
    this.cache = new Map(); this.cacheBytes = 0;
    this.seq = 1; this.sidSeq = 1;
    this.rate = 2e5;                  // steps per ms (EMA over strip jobs)
    this.disposed = false;
    this.pumpQueued = false;
    this.respawns = 0;
  }

  // ---------------------------------------------------------------------------------------------- workers
  _spawnTile(i) {
    const w = this.factory('tile');
    const tw = { i, w, inflight: 0, jobs: new Set(), mirror: new Map(), mirrorBytes: 0, cursors: 0, dead: false };
    w.onmessage = (e) => this._onTileMsg(tw, e.data);
    w.onerror = (e) => this._onTileCrash(tw, e);
    w.postMessage({ type: 'init', v: V, limits: this.limits });
    this.pool[i] = tw;
    return tw;
  }
  _onTileCrash(tw, e) {
    if (tw.dead) return;
    const err = E(ERR.INTERNAL, `tile worker crashed: ${(e && e.message) || e}`);
    this._killWorker(tw, err);
  }
  _killWorker(tw, err) {
    tw.dead = true;
    try { tw.w.terminate(); } catch (x) { /* ignore */ }
    for (const job of tw.jobs) { this.pending.delete(job.jid); this._fail(job, err); }
    tw.jobs.clear();
    if (!this.disposed) { this.respawns++; this._spawnTile(tw.i); }
    this._schedulePump();
  }
  _send(tw, job, msg, transfer) {
    tw.inflight++;
    tw.jobs.add(job);
    job.tw = tw;
    job.started = nowMs();
    this.pending.set(job.jid, job);
    tw.w.postMessage(msg, transfer || []);
  }
  _onTileMsg(tw, msg) {
    if (tw.dead) return;
    if (!msg || msg.v !== V) {
      for (const s of this.sessions.values()) s._emit('error', E(ERR.VERSION, 'engine/UI version mismatch: press Ctrl+F5'));
      return;
    }
    const job = this.pending.get(msg.jid);
    if (!job) return;
    this.pending.delete(msg.jid);
    tw.inflight--;
    tw.jobs.delete(job);
    if (msg.type === 'error') this._fail(job, E(msg.code, msg.message));
    else {
      try { job.done(msg); } catch (e) { this._fail(job, asErr(e)); }
    }
    this._schedulePump();
  }
  _fail(job, err) {
    if (job.type === 'strip') {
      for (const e of job.entries) if (e.st[job.si] === 1) e.st[job.si] = 0;
      if (err.code !== ERR.CANCELLED && !job.obsolete) {
        const s = job.sess;
        if (s && !s.closed) s._emit('error', err);
      } else if (job.sess && !job.sess.closed && !job.obsolete) {
        // cancelled by gen but still needed (should not happen): reschedule through the live request
        this._refresh(job.sess, true);
      }
      return;
    }
    if (job.sess) job.sess.jobs.delete(job);
    if (job.reject) job.reject(err);
  }

  /** Reference a checkpoint for a job on worker tw: bits only if the worker does not hold it (mirror). */
  _ref(tw, sess, ck, need) {
    const key = `${sess.sid}|${ck.id}`;
    need.add(key);
    const have = tw.mirror.get(key);
    if (have !== undefined) { tw.mirror.delete(key); tw.mirror.set(key, have); return seekRef(sess.sid, ck, false); }
    const b = ck.bits.byteLength;
    tw.mirror.set(key, b); tw.mirrorBytes += b;
    return seekRef(sess.sid, ck, true);
  }
  _evict(tw, need) {
    const drops = new Map();
    for (const [key, b] of tw.mirror) {
      if (tw.mirrorBytes <= this.limits.workerCkptCacheBytes) break;
      if (need.has(key)) continue;
      tw.mirror.delete(key); tw.mirrorBytes -= b;
      const [sid, id] = key.split('|');
      if (!drops.has(sid)) drops.set(sid, []);
      drops.get(sid).push(+id);
    }
    for (const [sid, ids] of drops) tw.w.postMessage({ type: 'dropCkpt', v: V, sid, ids });
  }
  _dropMirror(sid, ids) {
    for (const tw of this.pool) {
      if (!tw || tw.dead) continue;
      const gone = [];
      for (const id of ids) {
        const key = `${sid}|${id}`, b = tw.mirror.get(key);
        if (b !== undefined) { tw.mirror.delete(key); tw.mirrorBytes -= b; gone.push(id); }
      }
      if (gone.length) tw.w.postMessage({ type: 'dropCkpt', v: V, sid, ids: gone });
    }
  }

  _schedulePump() {
    if (this.pumpQueued || this.disposed) return;
    this.pumpQueued = true;
    queueMicrotask(() => { this.pumpQueued = false; this._pump(); });
  }
  _pump() {
    if (this.disposed) return;
    for (;;) {
      if (!this.queue.length) return;
      let tw = null;
      for (const w of this.pool) if (w && !w.dead && w.inflight === 0) { tw = w; break; }
      if (!tw && this.pool.length < this.P) tw = this._spawnTile(this.pool.length);
      if (!tw) return;
      let bi = 0;
      for (let i = 1; i < this.queue.length; i++) if (this.queue[i].prio < this.queue[bi].prio) bi = i;
      const job = this.queue.splice(bi, 1)[0];
      if (job.sess && job.sess.closed) { this._fail(job, E(ERR.CLOSED, 'session closed')); continue; }
      const need = new Set();
      let built;
      try { built = job.build(tw, need); } catch (e) { this._fail(job, asErr(e)); continue; }
      if (built === 'blocked') { job.sess.blocked.push(job); continue; }
      this._evict(tw, need);
      this._send(tw, job, built.msg, built.transfer);
    }
  }
  _general(sess, type, prio, buildMsg, done) {
    return new Promise((resolve, reject) => {
      if (this.disposed) return reject(E(ERR.CLOSED, 'engine disposed'));
      if (sess && sess.closed) return reject(E(ERR.CLOSED, 'session closed'));
      const job = {
        jid: this.seq++, type, sess, prio, resolve, reject,
        build: (tw, need) => buildMsg(job, tw, need),
        done: (msg) => { if (sess) sess.jobs.delete(job); resolve(done(msg)); },
      };
      if (sess) sess.jobs.add(job);
      this.queue.push(job);
      this._schedulePump();
    });
  }

  // ---------------------------------------------------------------------------------------------- sessions
  open(spec) {
    return new Promise((resolve, reject) => {
      if (this.disposed) return reject(E(ERR.CLOSED, 'engine disposed'));
      let machine, cfg;
      try { machine = parseMachine(spec && spec.tm); } catch (e) { return reject(asErr(e)); }
      try { cfg = startConfig(spec.start || { kind: 'blank' }, machine, spec.s0 || 0); } catch (e) { return reject(asErr(e)); }
      const steps = spec.steps === undefined ? this.limits.defaultSteps : spec.steps;
      if (!Number.isFinite(steps) || steps < 0) return reject(E(ERR.CONFIG, `bad steps ${steps}`));
      const sid = `s${this.sidSeq++}`;
      const sess = new Session(this, sid, spec, machine, cfg, cfg.step + Math.floor(steps));
      const w = this.factory('run');
      sess.run = w;
      sess.openResolve = resolve; sess.openReject = reject;
      w.onmessage = (e) => this._onRunMsg(sess, e.data);
      w.onerror = (e) => this._onRunMsg(sess, { v: V, type: 'error', sid, code: ERR.INTERNAL, message: `run worker crashed: ${(e && e.message) || e}` });
      this.sessions.set(sid, sess);
      w.postMessage({ type: 'open', v: V, sid, tm: machine.text, start: sess.spec.start, s0: cfg.step, steps: sess._info.target, limits: this.limits });
    });
  }
  _post(sess, msg) { msg.v = V; if (sess.run) sess.run.postMessage(msg); }
  _onRunMsg(sess, msg) {
    if (sess.closed || !msg) return;
    if (msg.v !== V) { sess._emit('error', E(ERR.VERSION, 'engine/UI version mismatch: press Ctrl+F5')); return; }
    switch (msg.type) {
      case 'opened': {
        const ck = msg.start;
        sess.store.add(ck);
        sess.store.c = 0;
        const r = sess.openResolve; sess.openResolve = sess.openReject = null;
        if (r) r(sess);
        return;
      }
      case 'ckpts': {
        sess.store.c = msg.c;
        for (const { ckpt, ov } of msg.list) {
          sess.store.add(ckpt);
          sess.ov.add(ckpt.t, ov, ckpt.lo, ckpt.hi, ckpt.pos);
        }
        sess._set({ ckpt: { c: msg.c, count: sess.store.count, bytes: sess.store.bytes } });
        sess._emit('overview', sess.ov.view());
        if (sess.blocked.length) this._unblock(sess);
        return;
      }
      case 'ckptStride': {
        const dropped = sess.store.setStride(msg.c);
        const S = 2 ** msg.c;
        sess.ov.retain((t) => (t - sess.s0) % S === 0);
        this._dropMirror(sess.sid, dropped.map((c) => c.id));
        sess._set({ ckpt: { c: msg.c, count: sess.store.count, bytes: sess.store.bytes } });
        return;
      }
      case 'records': sess.recIdx.append(msg); return;
      case 'recStride': sess.recIdx.setStride(msg.r); return;
      case 'progress': {
        sess.recL = msg.recL;
        const st = sess._info.status;
        sess._set({
          t: msg.t, rate: msg.rate, state: msg.state, pos: msg.pos, lo: msg.lo, hi: msg.hi, extent: msg.extent,
          rec: { count: msg.rec, r: msg.recR }, ckpt: { c: msg.c, count: sess.store.count, bytes: sess.store.bytes }, status: st,
        });
        sess._emit('progress', sess._info);
        this._refresh(sess, false);
        return;
      }
      case 'done': {
        if (msg.reason === 'closed') return;
        const status = msg.reason === 'halt' ? 'halted' : msg.reason === 'span-cap' ? 'span-cap' : 'done';
        const patch = {
          t: msg.t, status, state: msg.end.state, pos: msg.end.pos, lo: msg.end.lo, hi: msg.end.hi,
          extent: { lo: msg.end.lo, hi: msg.end.hi }, rec: { count: msg.rec, r: sess.recIdx.r }, nonzeros: msg.end.nonzeros,
        };
        sess.recL = msg.recL;
        if (msg.halt) patch.halt = msg.halt;
        if (status === 'span-cap') patch.error = E(ERR.SPANCAP, `span cap reached (${this.limits.spanCap} cells) at step ${msg.t}`);
        sess._set(patch);
        sess._emit('progress', sess._info);
        sess._emit('done', sess._info);
        if (status === 'span-cap') sess._emit('error', patch.error);
        this._refresh(sess, true);
        if (sess.blocked.length) this._unblock(sess);
        return;
      }
      case 'error': {
        const err = E(msg.code || ERR.INTERNAL, msg.message || 'run worker error');
        if (sess.openReject) {
          const r = sess.openReject; sess.openResolve = sess.openReject = null;
          this._closeSession(sess);
          r(err);
          return;
        }
        sess._set({ status: 'error', error: err });
        sess._emit('error', err);
        return;
      }
      default: return;
    }
  }
  _closeSession(sess) {
    if (sess.closed) return;
    sess.closed = true;
    try { sess.run.postMessage({ type: 'close', v: V, sid: sess.sid }); sess.run.terminate(); } catch (e) { /* ignore */ }
    this.sessions.delete(sess.sid);
    const err = E(ERR.CLOSED, 'session closed');
    this.queue = this.queue.filter((j) => {
      if (j.sess !== sess) return true;
      if (j.type !== 'strip' && j.reject) j.reject(err);
      return false;
    });
    for (const j of sess.blocked) if (j.reject) j.reject(err);
    sess.blocked = [];
    for (const job of [...this.pending.values()]) {
      if (job.sess === sess) {
        job.obsolete = true;
        if (job.tw && !job.tw.dead) job.tw.w.postMessage({ type: 'cancel', v: V, jid: job.jid });
        if (job.type !== 'strip' && job.reject) { job.reject(err); job.reject = null; job.resolve = () => {}; job.done = () => {}; }
      }
    }
    for (const j of sess.jobs) if (j.reject) j.reject(err);
    sess.jobs.clear();
    for (const w of sess.usageWait.splice(0)) w.resolve();
    for (const [key, e] of this.cache) if (e.sess === sess) { this.cache.delete(key); this.cacheBytes -= e.bytes; }
    this._dropMirror(sess.sid, sess.store.list.map((c) => c.id));
    if (sess.live) sess.live.cancelled = true;
    sess.live = null;
    if (sess.openReject) { const r = sess.openReject; sess.openResolve = sess.openReject = null; r(err); }
  }

  // ---------------------------------------------------------------------------------------------- tile cache
  _cacheGet(key) {
    const e = this.cache.get(key);
    if (e) { this.cache.delete(key); this.cache.set(key, e); }
    return e;
  }
  _cachePut(e) {
    this.cache.set(e.key, e);
    this.cacheBytes += e.bytes;
    for (const [k, x] of this.cache) {
      if (this.cacheBytes <= this.limits.tileCacheBytes) break;
      if (x === e) continue;
      this.cache.delete(k); this.cacheBytes -= x.bytes;
    }
  }
  /** Cache entry; its tile object is allocated when the first strip lands (keeps tiles() well under 4 ms). */
  _newEntry(sess, key, req, ty, tx, ri, pats, blk) {
    const evRows = ri.kind === 'events';
    const e = {
      key, sess, ty, tx, kt: req.kt, kx: req.kx, frame: req.frame, halt: req.halt, rows: req.rows, ri,
      patterns: req.kx < 0 ? (req.patterns || []).slice() : [], blk: req.kx < 0 && req.blk ? { k: req.blk.k, p: req.blk.p, words: req.blk.words.slice() } : null,
      tile: null, bytes: tileBytesFor(req, sess.machine, evRows, pats, blk), final: false, prio: 0,
      st: new Int8Array(STRIPS), pendFirst: new Float64Array(STRIPS).fill(NaN), endAbsent: new Uint8Array(STRIPS),
      make: () => emptyTile(key, req, ty, tx, sess.machine, evRows, pats, blk),
    };
    return e;
  }

  // ---------------------------------------------------------------------------------------------- tiles
  tiles(req, onTile) {
    const sess = this.sessions.get(req && req.sid);
    if (!sess || sess.closed || this.disposed) throw E(ERR.CLOSED, `no open session ${req && req.sid}`);
    const ri = rowsInfo(req.rows, sess.machine);
    const { pats, blk } = checkRequest(req, sess.machine);
    if (sess.live) sess.live.cancelled = true;
    const R = { req, onTile, gen: req.gen, keys: new Map(), finalSent: new Set(), cancelled: false };
    sess.live = R;
    const need = [];
    req.tiles.forEach(([ty, tx], i) => {
      const key = tileKey(req, ty, tx);
      let e = this._cacheGet(key);
      if (!e) { e = this._newEntry(sess, key, req, ty, tx, ri, pats, blk); this._cachePut(e); }
      if (R.keys.has(key)) return;
      R.keys.set(key, e);
      e.prio = i;
      if (e.final) queueMicrotask(() => this._deliver(e, R));
      else {
        if (e.st.some((x) => x >= 2)) queueMicrotask(() => this._deliver(e, R));
        need.push(e);
      }
    });
    this._dropObsolete(sess, R);
    this._schedule(sess, need, R);
    this._schedulePump();
    return { cancel: () => this._cancelReq(sess, R) };
  }
  _cancelReq(sess, R) {
    if (R.cancelled) return;
    R.cancelled = true;
    if (sess.live === R) { sess.live = null; this._dropObsolete(sess, null); }
  }
  _deliver(e, R) {
    if (!R || R.cancelled || !e.tile || !R.keys.has(e.key) || R.keys.get(e.key) !== e) return;
    if (e.final) {
      if (R.finalSent.has(e.key)) return;
      R.finalSent.add(e.key);
    }
    try { R.onTile(e.key, e.tile, e.final); } catch (x) { /* UI errors never break the engine */ }
  }
  /** Queue strip jobs for strips of `entries` that are not computed or queued (st 0), grouped per band and strip
   *  into contiguous tx runs (<= 8 tiles per job). Re-prioritises queued strips from the live request. */
  _schedule(sess, entries, R) {
    const groups = new Map();
    for (const e of entries) {
      for (let si = 0; si < STRIPS; si++) {
        if (e.st[si] !== 0) continue;
        const k = `${e.ty}|${si}`;
        if (!groups.has(k)) groups.set(k, []);
        groups.get(k).push(e);
      }
    }
    for (const [k, list] of groups) {
      const si = +k.split('|')[1];
      list.sort((a, b) => a.tx - b.tx);
      let run = [];
      const flush = () => {
        if (!run.length) return;
        for (const e of run) e.st[si] = 1;
        this.queue.push(this._stripJob(sess, run, si));
        run = [];
      };
      for (const e of list) {
        if (run.length && (e.tx !== run[run.length - 1].tx + 1 || run.length >= 8)) flush();
        run.push(e);
      }
      flush();
    }
    if (R) {
      for (const j of this.queue) {
        if (j.type !== 'strip' || j.sess !== sess) continue;
        let p = Infinity;
        for (const e of j.entries) if (R.keys.get(e.key) === e) p = Math.min(p, e.prio * STRIPS + j.si);
        if (p < Infinity) j.prio = p;
      }
    }
  }
  _dropObsolete(sess, R) {
    const needed = (j) => R && j.entries.some((e) => R.keys.get(e.key) === e);
    this.queue = this.queue.filter((j) => {
      if (j.type !== 'strip' || j.sess !== sess || needed(j)) return true;
      for (const e of j.entries) if (e.st[j.si] === 1) e.st[j.si] = 0;
      return false;
    });
    sess.blocked = sess.blocked.filter((j) => {
      if (needed(j)) return true;
      for (const e of j.entries) if (e.st[j.si] === 1) e.st[j.si] = 0;
      return false;
    });
    for (const job of this.pending.values()) {
      if (job.type !== 'strip' || job.sess !== sess || job.obsolete || needed(job)) continue;
      job.obsolete = true;
      const tw = job.tw;
      const remaining = job.est / this.rate - (nowMs() - job.started);
      if (remaining > 300 && tw.cursors === 0) this._killWorker(tw, E(ERR.CANCELLED, 'obsolete'));
      else tw.w.postMessage({ type: 'cancel', v: V, jid: job.jid });
    }
  }
  _stripJob(sess, entries, si) {
    const job = {
      jid: this.seq++, type: 'strip', sess, si, ty: entries[0].ty, entries, prio: entries[0].prio * STRIPS + si,
      est: 0, pendFirst: NaN, endAbsent: 0, obsolete: false,
      build: (tw, need) => this._buildStrip(job, tw, need),
      done: (msg) => this._stripDone(job, msg),
    };
    return job;
  }
  _unblock(sess) {
    const b = sess.blocked;
    sess.blocked = [];
    for (const j of b) this.queue.push(j);
    this._schedulePump();
  }

  /** Event counts (events with step <= ck.t) at checkpoints L[0..E.length) for an events rows mode. For state and
   *  transition rows this is the covered prefix of the UsageIndex (length >= 1); missing intervals are requested. */
  _ckEvents(sess, ri, L = sess.store.list) {
    if (ri.mode === 'rec') {
      const E = new Float64Array(L.length);
      for (let i = 0; i < L.length; i++) {
        const c = L[i];
        E[i] = ri.sideCode === 0 ? c.recL : ri.sideCode === 1 ? c.rec - c.recL : c.rec;
      }
      return E;
    }
    const ts = L.map((c) => c.t);
    const E = sess.usage.prefixPartial(ts, ri.mask);
    if (E.length < ts.length) this._ensureUsage(sess).catch(() => {});
    return E;
  }
  _lastLE(E, x) {               // last index i with E[i] < x  (E non-decreasing), or -1
    let a = 0, b = E.length - 1, r = -1;
    while (a <= b) { const mid = (a + b) >> 1; if (E[mid] < x) { r = mid; a = mid + 1; } else b = mid - 1; }
    return r;
  }

  _buildStrip(job, tw, need) {
    const sess = job.sess, e0 = job.entries[0], ri = e0.ri, info = sess._info;
    if (!sess.store.count) return 'blocked';
    const r0 = job.si * STRIP, nr = STRIP, kt = e0.kt, S = 2 ** -kt;
    const tMax = info.t, live = info.status === 'running';
    const H = info.halt ? info.halt.step : NaN;
    const halted = H === H;
    const s0 = sess.s0;
    let plan, est = 0, pendFirst = NaN;
    const recSteps = ri.mode === 'rec' && sess.recIdx.r === 0;
    if (ri.kind === 'steps' || recSteps) {
      const steps = new Float64Array(nr), ord = recSteps ? new Float64Array(nr).fill(NaN) : null;
      let Rh = Infinity;                          // level row index of the halting row
      let known = 0, haltIsEvent = false;
      if (recSteps) {
        known = sess.recIdx.countKnown(ri.side);
        if (halted) {
          const hr = info.halt.rec;
          haltIsEvent = !!hr && (ri.side === 'LR' || ri.side === hr);
          // the halting row follows the last regular row: if the halting step is itself the last record (ordinal
          // known - 1) it is an ordinary row when on the grid, else the next level row shows it at its real step
          Rh = Math.ceil((haltIsEvent ? known - 1 : known) / S);
        }
      } else if (halted) {
        const bh = Math.ceil((H - ri.O) / ri.K);
        Rh = Math.ceil(bh / S);
      }
      for (let k = 0; k < nr; k++) {
        const R = job.ty * TILE + r0 + k, b = R * S;
        let st;
        if (R > Rh) st = NaN;
        else if (R === Rh) st = H;
        else if (recSteps) {
          if (b < known) { st = sess.recIdx.step(ri.side, b); ord[k] = b; }
          else st = halted ? NaN : Infinity;
        } else {
          st = b * ri.K + ri.O;
          if (st < s0) st = NaN;
        }
        steps[k] = st;
      }
      const seeks = new Array(nr).fill(null);
      let prev = -1, first = true;
      for (let k = 0; k < nr; k++) {
        const st = steps[k];
        if (!(st === st) || st > tMax) { if (st === st && st > tMax && !(pendFirst <= st)) pendFirst = st === Infinity ? -1 : st; continue; }
        const ck = sess.store.atOrBefore(st);
        if (first || ck.t > prev) { seeks[k] = this._ref(tw, sess, ck, need); est += st - ck.t; first = false; }
        else est += st - prev;
        prev = st;
      }
      if (recSteps && !halted && live) pendFirst = -1;
      plan = { kind: 'steps', steps, seeks, ord };
    } else {
      const L = sess.store.list;
      const Ev = this._ckEvents(sess, ri, L);
      const eMax = (job.ty * TILE + r0 + nr - 1) * S + ri.off;
      if (Ev.length < L.length - 2 && eMax > Ev[Ev.length - 1]) return 'blocked';
      const ev = new Float64Array(nr), ord = new Float64Array(nr), seeks = new Array(nr).fill(null);
      let prevI = -2;
      for (let k = 0; k < nr; k++) {
        const R = job.ty * TILE + r0 + k, b = R * S, e = b + ri.off;
        ev[k] = e; ord[k] = b;
        const i = e === 0 ? 0 : this._lastLE(Ev, e);
        if (i < 0) throw E(ERR.INTERNAL, `no checkpoint before event ${e}`);
        if (i !== prevI) { seeks[k] = { ref: this._ref(tw, sess, L[i], need), event: Ev[i] }; est += 2 ** sess.store.c; }
        prevI = i;
      }
      pendFirst = -1;
      plan = { kind: 'events', ev, ord, stride: S, mode: ri.mode, side: ri.sideCode, mask: ri.mask || null, seeks };
    }
    job.est = est; job.pendFirst = pendFirst; job.endAbsent = !live && !halted ? 1 : 0;
    const msg = {
      type: 'strip', v: V, jid: job.jid, gen: sess.live ? sess.live.gen : 0, sid: sess.sid, tm: sess.machine.text,
      frame: e0.frame, kt, kx: e0.kx, patterns: e0.patterns, blk: e0.blk, halt: e0.halt,
      ty: job.ty, r0, r1: r0 + nr, tx0: job.entries[0].tx, tx1: job.entries[job.entries.length - 1].tx,
      tMax, haltStep: H, live, plan,
    };
    return { msg, transfer: [] };
  }
  _stripDone(job, msg) {
    const el = nowMs() - job.started;
    if (job.est > 1e6 && el > 1) this.rate = 0.8 * this.rate + 0.2 * (job.est / el);
    const nr = msg.r1 - msg.r0;
    for (const part of msg.tiles) {
      const e = job.entries.find((x) => x.tx === part.tx);
      if (!e) continue;
      if (!e.tile) e.tile = e.make();
      assembleStrip(e.tile, part, msg.r0);
      let pend = false;
      for (let r = 0; r < nr; r++) if (part.meta[8 * r + 2] & F_PENDING) { pend = true; break; }
      e.st[job.si] = pend ? 3 : 2;
      e.pendFirst[job.si] = job.pendFirst;
      e.endAbsent[job.si] = job.endAbsent;
      if (!pend && e.st.every((x) => x === 2)) { e.final = true; e.tile.final = true; }
      this._deliver(e, job.sess.live);
    }
    if (job.sess.live && !job.sess.live.cancelled && job.sess._info.status !== 'running') this._refresh(job.sess, false);
  }

  /** LIVE: recompute strips with PENDING rows that the run has passed (or all of them once it stopped). */
  _refresh(sess, force) {
    const R = sess.live;
    if (!R || R.cancelled) return;
    const t = sess._info.t, running = sess._info.status === 'running';
    const need = [];
    for (const e of R.keys.values()) {
      if (e.final) continue;
      let any = false;
      for (let si = 0; si < STRIPS; si++) {
        if (e.st[si] !== 3) continue;
        const pf = e.pendFirst[si];
        if (force || !running || pf < 0 || pf <= t) { e.st[si] = 0; any = true; }
      }
      if (any) need.push(e);
    }
    if (need.length) { this._schedule(sess, need, R); this._schedulePump(); }
  }
  /** After extend/resume: tiles holding end-of-run ABSENT rows become stale. */
  _reopenEnd(sess) {
    for (const [key, e] of this.cache) {
      if (e.sess !== sess || !e.endAbsent.some((x) => x)) continue;
      for (let si = 0; si < STRIPS; si++) if (e.endAbsent[si] && e.st[si] >= 2) { e.st[si] = 0; e.endAbsent[si] = 0; }
      e.final = false; if (e.tile) e.tile.final = false;
      if (sess.live) sess.live.finalSent.delete(key);
    }
    this._refresh(sess, true);
    const R = sess.live;
    if (R && !R.cancelled) this._schedule(sess, [...R.keys.values()].filter((e) => !e.final), R);
    this._schedulePump();
  }

  overview(sid) {
    const sess = this.sessions.get(sid);
    return sess ? sess.ov.view() : null;
  }

  // ---------------------------------------------------------------------------------------------- usage index
  _ensureUsage(sess, L = sess.store.list) {
    if (sess.closed) return Promise.reject(E(ERR.CLOSED, 'session closed'));
    const ts = L.map((c) => c.t), cks = L.slice();
    if (sess.usage.covered(ts)) return Promise.resolve();
    const miss = sess.usage.missing(ts);
    const ckAt = new Map(cks.map((c) => [c.t, c]));
    const chunk = Math.max(1, Math.ceil(miss.length / (this.P * 4)));
    for (let i = 0; i < miss.length; i += chunk) {
      const part = miss.slice(i, i + chunk);
      for (const [a, b] of part) sess.usage.inflight.add(`${a}:${b}`);
      this._general(sess, 'usage', -0.5, (job, tw, need) => {
        const intervals = part.map(([a, b]) => ({ t0: a, t1: b, seek: this._ref(tw, sess, ckAt.get(a) || sess.store.atOrBefore(a), need) }));
        return { msg: { type: 'usage', v: V, jid: job.jid, sid: sess.sid, tm: sess.machine.text, intervals }, transfer: [] };
      }, (msg) => msg.counts).then((counts) => {
        part.forEach(([a, b], k) => sess.usage.put(a, b, counts[k]));
        this._usageProgress(sess);
      }, () => {
        for (const [a, b] of part) sess.usage.inflight.delete(`${a}:${b}`);
        this._usageProgress(sess);
      });
    }
    return new Promise((resolve) => sess.usageWait.push({ ts, resolve }))
      .then(() => (sess.closed ? Promise.reject(E(ERR.CLOSED, 'session closed')) : undefined));
  }
  _usageProgress(sess) {
    const keep = [];
    for (const w of sess.usageWait) {
      if (sess.usage.covered(w.ts)) w.resolve();
      else keep.push(w);
    }
    sess.usageWait = keep;
    if (sess.blocked.length) this._unblock(sess);
    if (keep.length && !sess.usage.inflight.size) this._ensureUsage(sess).catch(() => {});
  }
  /** Count job over (t0, t1] starting from the checkpoint at or before t0. */
  _countInterval(sess, t0, t1) {
    if (t1 <= t0) return Promise.resolve(new Float64Array(sess.machine.n * sess.machine.m));
    return this._general(sess, 'usage', -0.6, (job, tw, need) => {
      const ck = sess.store.atOrBefore(t0);
      return { msg: { type: 'usage', v: V, jid: job.jid, sid: sess.sid, tm: sess.machine.text, intervals: [{ t0, t1, seek: this._ref(tw, sess, ck, need) }] }, transfer: [] };
    }, (msg) => msg.counts[0]);
  }
  _sess(sid) {
    const s = this.sessions.get(sid);
    if (!s || s.closed || this.disposed) throw E(ERR.CLOSED, `no open session ${sid}`);
    return s;
  }

  async usage(sid, t0, t1) {
    const sess = this._sess(sid), info = sess._info;
    const a = Math.max(sess.s0, Math.floor(t0)), b = Math.min(info.t, Math.floor(t1));
    const out = new Float64Array(sess.machine.n * sess.machine.m);
    if (b <= a) return { t0: a, t1: Math.max(a, b), counts: out };
    const L = sess.store.list;
    const inner = L.filter((c) => c.t >= a && c.t <= b).map((c) => c.t);
    const parts = [];
    if (inner.length >= 2) {
      await this._ensureUsage(sess, L.filter((c) => c.t >= a && c.t <= b));
      for (let i = 0; i + 1 < inner.length; i++) {
        const c = sess.usage.get(inner[i], inner[i + 1]);
        if (c) parts.push(Promise.resolve(c)); else parts.push(this._countInterval(sess, inner[i], inner[i + 1]));
      }
    }
    if (!inner.length) parts.push(this._countInterval(sess, a, b));
    else {
      parts.push(this._countInterval(sess, a, inner[0]));
      parts.push(this._countInterval(sess, inner[inner.length - 1], b));
    }
    for (const c of await Promise.all(parts)) for (let k = 0; k < out.length; k++) out[k] += c[k];
    return { t0: a, t1: b, counts: out };
  }

  // ---------------------------------------------------------------------------------------------- events
  _haltRowExtra(sess, ri) {
    const h = sess._info.halt;
    if (!h) return 0;
    if (ri.kind === 'steps') return ri.mode === 'auto' ? 0 : ((h.step - ri.O) % ri.K === 0 ? 0 : 1);
    if (ri.mode === 'rec') return h.rec && (ri.side === 'LR' || ri.side === h.rec) ? 0 : 1;
    if (ri.tr !== undefined) {
      const hk = (h.from.charCodeAt(0) - 65) * sess.machine.m + h.read;
      return hk === ri.tr ? 0 : 1;
    }
    return 1;
  }
  async eventCount(sid, rows) {
    const sess = this._sess(sid), ri = rowsInfo(rows, sess.machine), info = sess._info;
    const complete = info.status !== 'running' && info.status !== 'paused';
    let count;
    if (ri.mode === 'auto') count = info.t + 1;
    else if (ri.mode === 'every') count = info.t >= ri.O ? Math.floor((info.t - ri.O) / ri.K) + 1 : 0;
    else if (ri.mode === 'rec') {
      const all = info.rec.count, L = sess.recL;
      count = (ri.sideCode === 0 ? L : ri.sideCode === 1 ? all - L : all) + 1;
    } else {
      const L = sess.store.list.slice(), tEnd = info.t;
      await this._ensureUsage(sess, L);
      const Ev = sess.usage.prefix(L.map((c) => c.t), ri.mask);
      const last = L[L.length - 1];
      const tail = await this._countInterval(sess, last.t, tEnd);
      count = Ev[L.length - 1] + maskedSum(tail, ri.mask);
    }
    return { count, complete, rows: count + this._haltRowExtra(sess, ri) };
  }
  async stepOfEvent(sid, rows, i) {
    const sess = this._sess(sid), ri = rowsInfo(rows, sess.machine);
    if (!Number.isSafeInteger(i) || i < 0) throw E(ERR.RANGE, `bad event index ${i}`);
    if (ri.kind === 'steps') return i * ri.K + ri.O;
    if (ri.mode === 'rec' && sess.recIdx.r === 0) {
      const st = sess.recIdx.step(ri.side, i);
      if (st === st) return st;
      throw E(ERR.RANGE, `record ${i} not reached (run at step ${sess._info.t})`);
    }
    if (ri.mode === 'rec' && i === 0) return sess.s0;
    const L = sess.store.list.slice();
    if (ri.mode === 'watch') await this._ensureUsage(sess, L);
    const Ev = this._ckEvents(sess, ri, L);
    const e = i + ri.off;
    const k = this._lastLE(Ev, e);
    const r = await this._general(sess, 'findEvent', -0.75, (job, tw, need) => ({
      msg: {
        type: 'findEvent', v: V, jid: job.jid, sid, tm: sess.machine.text, seek: this._ref(tw, sess, L[k], need), event: Ev[k],
        e, mode: ri.mode, side: ri.sideCode, mask: ri.mask || null, tMax: sess._info.t,
      }, transfer: [],
    }), (msg) => msg);
    if (r.step === null) throw E(ERR.RANGE, `event ${i} not reached (run at step ${sess._info.t})`);
    return r.step;
  }
  async eventAtStep(sid, rows, step) {
    const sess = this._sess(sid), ri = rowsInfo(rows, sess.machine);
    if (ri.kind === 'steps') return step >= ri.O ? Math.floor((step - ri.O) / ri.K) : -1;
    if (step < sess.s0) return -1;
    if (ri.mode === 'rec' && sess.recIdx.r === 0 && step <= sess._info.t) return sess.recIdx.ordinalAtStep(ri.side, step);
    const L = sess.store.list.slice();
    if (ri.mode === 'watch') await this._ensureUsage(sess, L);
    const Ev = this._ckEvents(sess, ri, L);
    const t1 = Math.min(step, sess._info.t);
    let k = 0;
    while (k + 1 < L.length && L[k + 1].t <= t1) k++;
    const r = await this._general(sess, 'countEvents', -0.75, (job, tw, need) => ({
      msg: {
        type: 'countEvents', v: V, jid: job.jid, sid, tm: sess.machine.text, seek: this._ref(tw, sess, L[k], need), event: Ev[k],
        t1, mode: ri.mode, side: ri.sideCode, mask: ri.mask || null,
      }, transfer: [],
    }), (msg) => msg.count);
    return r - ri.off;
  }

  // ---------------------------------------------------------------------------------------------- probe & co
  probe(sid, step, x0, x1, opts = {}) {
    let sess;
    try { sess = this._sess(sid); } catch (e) { return Promise.reject(e); }
    const info = sess._info;
    if (!(step >= sess.s0 && step <= info.t)) return Promise.reject(E(ERR.RANGE, `step ${step} outside [${sess.s0}, ${info.t}]`));
    return this._general(sess, 'probe', -1, (job, tw, need) => ({
      msg: { type: 'probe', v: V, jid: job.jid, sid, tm: sess.machine.text, step, x0: Math.floor(x0), x1: Math.floor(x1), compress: opts.compress, seek: this._ref(tw, sess, sess.store.atOrBefore(step), need) },
      transfer: [],
    }), (msg) => msg.result);
  }
  blockStats(sid, step, k) {
    let sess;
    try { sess = this._sess(sid); } catch (e) { return Promise.reject(e); }
    if (!(step >= sess.s0 && step <= sess._info.t)) return Promise.reject(E(ERR.RANGE, `step ${step} outside the run`));
    if (!(k >= 1 && k <= this.limits.maxBlockK)) return Promise.reject(E(ERR.RANGE, `bad k ${k}`));
    return this._general(sess, 'blockStats', -0.9, (job, tw, need) => ({
      msg: { type: 'blockStats', v: V, jid: job.jid, sid, tm: sess.machine.text, step, k, seek: this._ref(tw, sess, sess.store.atOrBefore(step), need) },
      transfer: [],
    }), (msg) => msg.result);
  }
  /** Engine extension (additive to §6): background-period detection at a step (atlas/explorer-research.md §2.5).
   *  -> {k, p, word, words, rates, best, confident, coverage, step, lo, hi}; words = the k-block background set. */
  background(sid, step, maxP = 8) {
    let sess;
    try { sess = this._sess(sid); } catch (e) { return Promise.reject(e); }
    if (!(step >= sess.s0 && step <= sess._info.t)) return Promise.reject(E(ERR.RANGE, `step ${step} outside the run`));
    const P = Math.max(1, Math.min(16, Math.floor(maxP)));
    return this._general(sess, 'background', -0.9, (job, tw, need) => ({
      msg: { type: 'background', v: V, jid: job.jid, sid, tm: sess.machine.text, step, maxP: P, seek: this._ref(tw, sess, sess.store.atOrBefore(step), need) },
      transfer: [],
    }), (msg) => msg.result);
  }
  diverge(sidA, sidB, maxSteps) {
    let A, B;
    try { A = this._sess(sidA); B = this._sess(sidB); } catch (e) { return Promise.reject(e); }
    if (A.s0 !== B.s0 || JSON.stringify(A.spec.start) !== JSON.stringify(B.spec.start)) {
      return Promise.resolve({ step: null, reason: 'different starts' });
    }
    const n = Math.max(0, Math.floor(maxSteps === undefined ? A._info.target - A.s0 : maxSteps));
    return this._general(A, 'diverge', -0.25, (job, tw, need) => ({
      msg: { type: 'diverge', v: V, jid: job.jid, tmA: A.machine.text, tmB: B.machine.text, seek: this._ref(tw, A, A.store.list[0], need), maxSteps: n },
      transfer: [],
    }), (msg) => {
      const r = { step: msg.step };
      if (msg.step !== null) { r.tr = msg.tr; r.a = msg.a; r.b = msg.b; } else r.reason = msg.reason;
      return r;
    });
  }
  async cursor(sid, step) {
    const sess = this._sess(sid);
    if (!(step >= sess.s0 && step <= sess._info.t)) throw E(ERR.RANGE, `step ${step} outside [${sess.s0}, ${sess._info.t}]`);
    if (!this.pool.length) this._spawnTile(0);
    let tw = this.pool[0];
    for (const w of this.pool) if (w && !w.dead && w.inflight < tw.inflight) tw = w;
    const cid = this.seq++;
    let closed = false, chain = Promise.resolve();
    const call = (type, extra, withSeek) => {
      if (closed) return Promise.reject(E(ERR.CLOSED, 'cursor closed'));
      if (sess.closed || this.disposed || tw.dead) return Promise.reject(E(ERR.CLOSED, 'session closed'));
      return new Promise((resolve, reject) => {
        const job = { jid: this.seq++, type, sess, resolve, reject, done: (msg) => { sess.jobs.delete(job); resolve(msg); } };
        sess.jobs.add(job);
        const msg = { type, v: V, jid: job.jid, cid, sid, tm: sess.machine.text, tMax: sess._info.t, ...extra };
        if (withSeek) {
          const ck = sess.store.atOrBefore(extra.step);
          msg.seek = seekRef(sid, ck, true);
        }
        this._send(tw, job, msg);
      });
    };
    tw.cursors++;
    const first = await call('cursorOpen', { step }, true).then((m) => m.frame, (e) => { tw.cursors--; throw e; });
    const cur = {
      frame: first,
      advance: (n) => (chain = chain.then(() => call('cursorAdvance', { n: Math.max(0, Math.floor(n)) }, false)).then((m) => (cur.frame = m.frame))),
      seek: (s) => {
        if (!(s >= sess.s0 && s <= sess._info.t)) return Promise.reject(E(ERR.RANGE, `step ${s} outside the run`));
        return (chain = chain.then(() => call('cursorSeek', { step: s }, true)).then((m) => (cur.frame = m.frame)));
      },
      close: () => {
        if (closed) return;
        const p = call('cursorClose', {}, false).catch(() => {});
        closed = true; tw.cursors = Math.max(0, tw.cursors - 1);
        return p;
      },
    };
    // the cursor's worker keeps its state: cid = the jid of cursorOpen
    return cur;
  }

  stats() {
    let ckptBytes = 0, recBytes = 0, rate = 0;
    for (const s of this.sessions.values()) {
      ckptBytes += s.store.bytes; recBytes += s.recIdx.bytes;
      if (s._info.status === 'running') rate += s._info.rate;
    }
    let running = 0;
    for (const tw of this.pool) if (tw) running += tw.inflight;
    return { workers: this.pool.filter((w) => w && !w.dead).length, queued: this.queue.length, running, tileBytes: this.cacheBytes, ckptBytes, recBytes, rate, respawns: this.respawns };
  }
  dispose() {
    if (this.disposed) return;
    for (const s of [...this.sessions.values()]) this._closeSession(s);
    this.disposed = true;
    const err = E(ERR.CLOSED, 'engine disposed');
    for (const job of this.pending.values()) if (job.reject) job.reject(err);
    for (const job of this.queue) if (job.reject) job.reject(err);
    this.pending.clear(); this.queue = [];
    for (const tw of this.pool) if (tw) { tw.dead = true; try { tw.w.terminate(); } catch (e) { /* ignore */ } }
    this.cache.clear(); this.cacheBytes = 0;
  }
}
