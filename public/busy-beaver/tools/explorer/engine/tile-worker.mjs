// engine/tile-worker.mjs (ENGINE): the shared tile worker (explorer-spec §7, §8.5-§8.7). Module Worker; also runs
// under node worker_threads through tests/lib/node-worker.mjs.
//
// Jobs run one at a time from an internal FIFO; `cancel`, `cancelGen` and `dropCkpt` act immediately. Checkpoint
// bits arriving with any job are cached by `${sid}|${ckptId}` on receipt (even if the job is later cancelled):
// the facade mirrors this cache exactly and evicts with `dropCkpt`, so it knows when to omit bits.
import { PROTOCOL_VERSION, ERR, LIMITS } from '../core/protocol.mjs';
import { parseMachine, transInfo, machineDiff } from '../core/machine.mjs';
import { dhCells } from '../core/config.mjs';
import { compressText } from '../core/compress.mjs';
import { backgroundOf } from './pool.mjs';
import { Sim } from './sim.mjs';
import { runStrip } from './rows.mjs';

const V = PROTOCOL_VERSION;
const DHC_MAX = 1 << 18;          // compressed text only for spans up to this many cells (else null)
const DHC_AUTO = 4096;            // ... and by default (no `compress` option) only up to this many
const machines = new Map();
const bitsCache = new Map();
const cancelledJobs = new Set();
let cancelGenBelow = new Map();          // sid -> gen: strips of that sid with a lower gen are dropped
const cursors = new Map();
const queue = [];
let busy = false;
let current = null;
let limits = LIMITS;

const post = (msg, transfer) => self.postMessage(msg, transfer || []);

// cooperative yield: a macrotask, so cancel messages land between slices
const ch = new MessageChannel();
const waiters = [];
ch.port1.onmessage = () => { const w = waiters.shift(); if (w) w(); };
function yieldNow() { return new Promise((r) => { waiters.push(r); ch.port2.postMessage(0); }); }

function machine(tm) {
  let M = machines.get(tm);
  if (!M) { M = parseMachine(tm); machines.set(tm, M); if (machines.size > 64) machines.delete(machines.keys().next().value); }
  return M;
}
const sims = new Map();
function simFor(tm) {
  let s = sims.get(tm);
  if (!s) { s = new Sim(machine(tm), { spanCap: limits.spanCap }); sims.set(tm, s); if (sims.size > 8) sims.delete(sims.keys().next().value); }
  return s;
}

function cacheRef(ref) {
  if (ref && ref.bits) bitsCache.set(`${ref.sid}|${ref.ckptId}`, ref.bits);
}
function cacheAll(msg) {
  if (msg.seek) cacheRef(msg.seek);
  if (msg.plan && msg.plan.seeks) for (const s of msg.plan.seeks) if (s) cacheRef(s.ref || s);
  if (msg.intervals) for (const it of msg.intervals) cacheRef(it.seek);
}
// attach cached bits to every SeekRef of a job before it starts, so a later dropCkpt cannot affect it
function pinRef(ref) { if (ref && !ref.bits) ref.bits = getBits(ref); }
function pinBits(msg) {
  if (msg.seek) pinRef(msg.seek);
  if (msg.plan && msg.plan.seeks) for (const s of msg.plan.seeks) if (s) pinRef(s.ref || s);
  if (msg.intervals) for (const it of msg.intervals) pinRef(it.seek);
}
function getBits(ref) {
  const b = ref.bits || bitsCache.get(`${ref.sid}|${ref.ckptId}`);
  if (!b) throw { code: ERR.INTERNAL, message: `checkpoint ${ref.sid}|${ref.ckptId} bits missing in worker` };
  return b;
}

function isCancelled(msg) {
  if (cancelledJobs.has(msg.jid)) return true;
  if (msg.type === 'strip') { const g = cancelGenBelow.get(msg.sid); if (g !== undefined && msg.gen < g) return true; }
  return false;
}
function ctxFor(msg) {
  return { yield: yieldNow, cancelled: () => isCancelled(msg), slice: limits.sliceSteps, getBits };
}

self.onmessage = (e) => {
  const msg = e.data;
  if (!msg || msg.v !== V) {
    post({ type: 'error', v: V, jid: msg && msg.jid, code: ERR.VERSION, message: 'engine/UI version mismatch: press Ctrl+F5' });
    return;
  }
  switch (msg.type) {
    case 'init': if (msg.limits) limits = { ...LIMITS, ...msg.limits }; return;
    case 'cancel': cancelledJobs.add(msg.jid); return;
    case 'cancelGen': cancelGenBelow.set(msg.sid, msg.gen); return;
    case 'dropCkpt': for (const id of msg.ids) bitsCache.delete(`${msg.sid}|${id}`); return;
    default:
      cacheAll(msg);
      queue.push(msg);
      pump();
  }
};

async function pump() {
  if (busy) return;
  busy = true;
  while (queue.length) {
    const msg = queue.shift();
    current = msg;
    try {
      if (isCancelled(msg)) { post({ type: 'error', v: V, jid: msg.jid, code: ERR.CANCELLED, message: 'cancelled' }); continue; }
      pinBits(msg);
      await handle(msg);
    } catch (err) {
      post({ type: 'error', v: V, jid: msg.jid, code: (err && err.code) || ERR.INTERNAL, message: (err && err.message) || String(err), stack: err && err.stack });
    } finally {
      cancelledJobs.delete(msg.jid);
      current = null;
    }
  }
  busy = false;
}

async function advance(sim, T, msg) {
  const slice = limits.sliceSteps;
  while (T - sim.t > slice + 1 && !sim.halted && !sim.capped) {
    sim.run(slice);
    await yieldNow();
    if (isCancelled(msg)) throw { code: ERR.CANCELLED, message: 'cancelled' };
  }
  if (sim.t < T) sim.runTo(T);
}

function frameOf(sim, M, fired) {
  const pos = sim.pos;
  return {
    step: sim.t, state: sim.stateName, dir: sim.dir, pos, lo: sim.lo, hi: sim.hi, fresh: sim.fresh, halted: sim.halted,
    x0: pos - 64, cells: sim.cellsAbs(pos - 64, pos + 64),
    next: sim.halted ? null : transInfo(M, sim.next), prev: sim.tr >= 0 ? transInfo(M, sim.tr) : null, fired,
  };
}

async function handle(msg) {
  switch (msg.type) {
    case 'strip': {
      const sim = simFor(msg.tm);
      const res = await runStrip(sim, msg, ctxFor(msg));
      if (!res) { post({ type: 'error', v: V, jid: msg.jid, code: ERR.CANCELLED, message: 'cancelled' }); return; }
      const transfer = [];
      for (const t of res.tiles) {
        transfer.push(t.meta.buffer, t.steps.buffer, t.next.buffer);
        if (t.ev) transfer.push(t.ev.buffer);
        if (t.cells) transfer.push(t.cells.buffer);
        if (t.headCol) transfer.push(t.headCol.buffer);
        if (t.planes) for (const k in t.planes) transfer.push(t.planes[k].buffer);
      }
      post({ type: 'strip', v: V, jid: msg.jid, gen: msg.gen, sid: msg.sid, ty: msg.ty, r0: msg.r0, r1: msg.r1, tiles: res.tiles }, transfer);
      return;
    }
    case 'probe': {
      const M = machine(msg.tm), sim = simFor(msg.tm);
      sim.restore(msg.seek, getBits(msg.seek));
      await advance(sim, msg.step, msg);
      if (sim.t !== msg.step) throw { code: ERR.RANGE, message: `step ${msg.step} is beyond the run's end (${sim.t})` };
      const span = sim.spanView(), h = sim.h - sim.loI, st = sim.stateName, d = sim.sdir;
      const result = {
        step: sim.t, state: st, dir: sim.dir, pos: sim.pos, lo: sim.lo, hi: sim.hi, fresh: sim.fresh, halted: sim.halted,
        x0: msg.x0, cells: sim.cellsAbs(msg.x0, msg.x1),
        next: sim.halted ? null : transInfo(M, sim.next), prev: sim.tr >= 0 ? transInfo(M, sim.tr) : null,
        dh: dhCells(span, 0, span.length, h, st, d), dhExact: dhCells(span, 0, span.length, h, st, d, { trim: false }),
        dhc: span.length <= (msg.compress === true ? DHC_MAX : msg.compress === false ? -1 : DHC_AUTO) ? compressText(span, 0, span.length, h, st, d) : null,
      };
      post({ type: 'probe', v: V, jid: msg.jid, result }, [result.cells.buffer]);
      return;
    }
    case 'usage': {
      const M = machine(msg.tm), sim = simFor(msg.tm), out = [];
      for (const it of msg.intervals) {
        const cnt = new Float64Array(M.n * M.m);
        sim.restore(it.seek, getBits(it.seek));
        if (it.t0 > sim.t) await advance(sim, it.t0, msg);
        while (sim.t < it.t1 && !sim.halted && !sim.capped) {
          sim.runCount(Math.min(limits.sliceSteps, it.t1 - sim.t), cnt);
          if (sim.t < it.t1 && !sim.halted) { await yieldNow(); if (isCancelled(msg)) throw { code: ERR.CANCELLED, message: 'cancelled' }; }
        }
        out.push(cnt);
      }
      post({ type: 'usage', v: V, jid: msg.jid, counts: out }, out.map((c) => c.buffer));
      return;
    }
    case 'cursorOpen': {
      const M = machine(msg.tm), sim = new Sim(M, { spanCap: limits.spanCap });
      sim.restore(msg.seek, getBits(msg.seek));
      await advance(sim, msg.step, msg);
      cursors.set(msg.cid ?? msg.jid, { sim, M });
      post({ type: 'frame', v: V, jid: msg.jid, frame: frameOf(sim, M, new Float64Array(M.n * M.m)) });
      return;
    }
    case 'cursorAdvance': {
      const c = cursors.get(msg.cid);
      if (!c) throw { code: ERR.CLOSED, message: 'cursor closed' };
      const { sim, M } = c;
      const fired = new Float64Array(M.n * M.m);
      let n = Math.max(0, Math.min(msg.n, msg.tMax - sim.t));
      if (n <= 64) {
        for (; n > 0 && !sim.halted && !sim.capped; n--) { sim.stepOne(); fired[sim.tr]++; }
      } else {
        const T = sim.t + n;
        while (T - sim.t > 1 && !sim.halted && !sim.capped) {
          sim.runCount(Math.min(limits.sliceSteps, T - sim.t - 1), fired);
          if (T - sim.t > 1 && !sim.halted) await yieldNow();
        }
        if (!sim.halted && !sim.capped && sim.t < T) { sim.stepOne(); fired[sim.tr]++; }
      }
      post({ type: 'frame', v: V, jid: msg.jid, frame: frameOf(sim, M, fired) });
      return;
    }
    case 'cursorSeek': {
      const c = cursors.get(msg.cid);
      if (!c) throw { code: ERR.CLOSED, message: 'cursor closed' };
      const { sim, M } = c;
      if (!(msg.step >= sim.t && msg.step - sim.t <= (msg.step - msg.seek.t))) sim.restore(msg.seek, getBits(msg.seek));
      await advance(sim, msg.step, msg);
      post({ type: 'frame', v: V, jid: msg.jid, frame: frameOf(sim, M, new Float64Array(M.n * M.m)) });
      return;
    }
    case 'cursorClose': {
      cursors.delete(msg.cid);
      post({ type: 'closed', v: V, jid: msg.jid });
      return;
    }
    case 'diverge': {
      const A = machine(msg.tmA), B = machine(msg.tmB);
      const diff = machineDiff(A, B);
      if (!diff.ok) { post({ type: 'diverge', v: V, jid: msg.jid, step: null, reason: diff.reason }); return; }
      if (!diff.diffs.length) { post({ type: 'diverge', v: V, jid: msg.jid, step: null, reason: 'identical machines' }); return; }
      const sim = new Sim(A, { spanCap: limits.spanCap });
      sim.restore(msg.seek, getBits(msg.seek));
      const end = msg.seek.t + msg.maxSteps;
      for (;;) {
        sim.runWatch(Math.min(limits.sliceSteps, end - sim.t), diff.mask);
        if (sim.ev >= 0) {
          const d = diff.diffs.find((x) => x.i === sim.ev);
          post({ type: 'diverge', v: V, jid: msg.jid, step: sim.t, tr: d.tr, a: d.a, b: d.b });
          return;
        }
        if (sim.halted) { post({ type: 'diverge', v: V, jid: msg.jid, step: null, reason: `A halts at step ${sim.t} before any difference` }); return; }
        if (sim.capped) { post({ type: 'diverge', v: V, jid: msg.jid, step: null, reason: 'span cap reached' }); return; }
        if (sim.t >= end) { post({ type: 'diverge', v: V, jid: msg.jid, step: null, reason: `no difference within ${msg.maxSteps} steps` }); return; }
        await yieldNow();
        if (isCancelled(msg)) throw { code: ERR.CANCELLED, message: 'cancelled' };
      }
    }
    case 'blockStats': {
      const sim = simFor(msg.tm), k = msg.k;
      sim.restore(msg.seek, getBits(msg.seek));
      await advance(sim, msg.step, msg);
      const [dlo, dhi] = sim.defined(), T = sim.tape, org = sim.org;
      const result = [];
      for (let p = 0; p < k; p++) {
        const counts = new Map();
        let x = dlo + ((((p - dlo) % k) + k) % k);
        for (; x + k - 1 <= dhi; x += k) {
          let w = '';
          for (let j = 0; j < k; j++) w += String.fromCharCode(48 + T[x + j + org]);
          counts.set(w, (counts.get(w) || 0) + 1);
        }
        const words = [...counts.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
        result.push({ p, words });
      }
      post({ type: 'blockStats', v: V, jid: msg.jid, result });
      return;
    }
    case 'background': {
      const sim = simFor(msg.tm);
      sim.restore(msg.seek, getBits(msg.seek));
      await advance(sim, msg.step, msg);
      const [dlo, dhi] = sim.defined();
      const cells = sim.tape.subarray(dlo + sim.org, dhi + sim.org + 1);
      const result = backgroundOf(cells, dlo, msg.maxP);
      post({ type: 'background', v: V, jid: msg.jid, result: { ...result, step: sim.t, lo: dlo, hi: dhi } });
      return;
    }
    case 'findEvent': {
      // step of event number msg.e (1-based count of events after s0), counting from msg.seek (msg.event events
      // with step <= seek.t); null if not reached by msg.tMax (or a halt / the span cap first)
      const sim = simFor(msg.tm);
      sim.restore(msg.seek, getBits(msg.seek));
      let E = msg.event;
      while (E < msg.e && !sim.halted && !sim.capped && sim.t < msg.tMax) {
        const budget = Math.min(limits.sliceSteps, msg.tMax - sim.t);
        if (msg.mode === 'rec') { sim.runRecords(budget, msg.e - E, msg.side); E += (msg.e - E) - sim.rwLeft; }
        else {
          let left = budget;
          while (left > 0 && E < msg.e && !sim.halted) { left -= sim.runWatch(left, msg.mask); if (sim.ev >= 0) E++; else break; }
        }
        if (E < msg.e) { await yieldNow(); if (isCancelled(msg)) throw { code: ERR.CANCELLED, message: 'cancelled' }; }
      }
      post({ type: 'findEvent', v: V, jid: msg.jid, step: E === msg.e ? sim.t : null, halted: sim.halted, t: sim.t });
      return;
    }
    case 'countEvents': {
      // events with step <= msg.t1, from msg.seek (msg.event events with step <= seek.t)
      const M = machine(msg.tm), sim = simFor(msg.tm);
      sim.restore(msg.seek, getBits(msg.seek));
      let count;
      if (msg.mode === 'rec') {
        await advance(sim, msg.t1, msg);
        count = msg.side === 0 ? sim.recL : msg.side === 1 ? sim.rec - sim.recL : sim.rec;
      } else {
        const cnt = new Float64Array(M.n * M.m);
        while (sim.t < msg.t1 && !sim.halted && !sim.capped) {
          sim.runCount(Math.min(limits.sliceSteps, msg.t1 - sim.t), cnt);
          if (sim.t < msg.t1 && !sim.halted) { await yieldNow(); if (isCancelled(msg)) throw { code: ERR.CANCELLED, message: 'cancelled' }; }
        }
        count = msg.event;
        for (let k = 0; k < cnt.length; k++) if (msg.mask[k]) count += cnt[k];
      }
      post({ type: 'countEvents', v: V, jid: msg.jid, count, t: sim.t });
      return;
    }
    default:
      throw { code: ERR.INTERNAL, message: `unknown job type ${msg.type}` };
  }
}
