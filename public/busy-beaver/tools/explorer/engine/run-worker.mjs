// engine/run-worker.mjs (ENGINE): the first pass of one session (explorer-spec §8.3). Module Worker; also runs
// under node worker_threads through tests/lib/node-worker.mjs.
//
// Simulates in slices of <= sliceSteps with a macrotask yield between slices (so pause/extend/close land),
// checkpoints every 2^c steps after s0 (bit-packed, with an abs-frame overview row), owns the stride rule
// (count <= ckptMaxCount and bytes <= ckptBudgetBytes, else c += 1 and `ckptStride`), batches checkpoints and
// records at <= 10 Hz, posts progress at <= 4 Hz and `done` with its reason.
import { PROTOCOL_VERSION, ERR, LIMITS } from '../core/protocol.mjs';
import { parseMachine } from '../core/machine.mjs';
import { startConfig } from '../core/config.mjs';
import { Sim } from './sim.mjs';
import { initialStride, overBudget } from './checkpoints.mjs';
import { overviewRow } from './pool.mjs';
import { RecordBatcher } from './records.mjs';

const V = PROTOCOL_VERSION;
const post = (msg, transfer) => { msg.v = V; self.postMessage(msg, transfer || []); };
const now = () => performance.now();

const ch = new MessageChannel();
const waiters = [];
ch.port1.onmessage = () => { const w = waiters.shift(); if (w) w(); };
function yieldNow() { return new Promise((r) => { waiters.push(r); ch.port2.postMessage(0); }); }

let R = null;      // the run

self.onmessage = (e) => {
  const msg = e.data;
  if (!msg || msg.v !== V) { post({ type: 'error', sid: msg && msg.sid, code: ERR.VERSION, message: 'engine/UI version mismatch: press Ctrl+F5' }); return; }
  try {
    switch (msg.type) {
      case 'open': open(msg); break;
      case 'extend':
        if (!R) return;
        R.target = Math.max(R.target, msg.steps);
        if (R.status === 'done' && !R.sim.halted && !R.sim.capped && R.sim.t < R.target) { R.status = 'running'; loop(); }
        break;
      case 'pause': if (R && R.status === 'running') R.status = 'paused'; break;
      case 'resume': if (R && R.status === 'paused') { R.status = 'running'; loop(); } break;
      case 'close': if (R) { R.status = 'closed'; } break;
      default: break;
    }
  } catch (err) {
    post({ type: 'error', sid: msg.sid, code: (err && err.code) || ERR.INTERNAL, message: (err && err.message) || String(err) });
  }
};

function open(msg) {
  const limits = { ...LIMITS, ...(msg.limits || {}) };
  const M = parseMachine(msg.tm);
  const cfg = startConfig(msg.start, M, msg.s0 || 0);
  const sim = new Sim(M, { spanCap: limits.spanCap }).loadConfig(cfg);
  R = {
    sid: msg.sid, M, sim, limits, target: msg.steps, status: 'running', s0: sim.s0,
    c: initialStride(msg.steps - sim.s0, limits), ck: [], ckBytes: 0, nextId: 0,
    pend: [], lastFlush: 0, lastProgress: 0, rate: 0, rateT: now(), rateS: sim.t, looping: false,
  };
  R.rec = new RecordBatcher(R.sid, post, limits);
  sim.onRecord = (t, side) => R.rec.add(t, side);
  const start = makeCkpt();
  post({ type: 'opened', sid: R.sid, machine: { n: M.n, m: M.m }, start: { ...start.ckpt, bits: start.ckpt.bits.slice(0) } });
  R.pend.push(start);
  flush(true);
  loop();
}

function makeCkpt() {
  const sim = R.sim;
  const ckpt = sim.checkpoint(R.nextId++);
  const ov = overviewRow(sim, R.limits.ovMaxCols);
  R.ck.push({ id: ckpt.id, t: ckpt.t, bytes: ckpt.bits.byteLength });
  R.lastCkT = ckpt.t;
  R.ckBytes += ckpt.bits.byteLength;
  return { ckpt, ov };
}

function strideRule() {
  while (overBudget(R.ck.length, R.ckBytes, R.limits)) {
    flush(true);
    R.c += 1;
    const S = 2 ** R.c;
    const keep = [];
    R.ckBytes = 0;
    for (const k of R.ck) if ((k.t - R.s0) % S === 0) { keep.push(k); R.ckBytes += k.bytes; }
    R.ck = keep;
    post({ type: 'ckptStride', sid: R.sid, c: R.c });
  }
}

function flush(force) {
  const t = now();
  R.rec.flush();
  if (!R.pend.length || (!force && t - R.lastFlush < 100)) return;
  const list = R.pend, transfer = [];
  R.pend = [];
  for (const { ckpt, ov } of list) {
    transfer.push(ckpt.bits, ov.vis, ov.near, ...ov.cnt);
  }
  post({ type: 'ckpts', sid: R.sid, c: R.c, list }, transfer);
  R.lastFlush = t;
}

function info() {
  const s = R.sim;
  return {
    type: 'progress', sid: R.sid, t: s.t, rate: R.rate, state: s.stateName, pos: s.pos, lo: s.lo, hi: s.hi,
    extent: { lo: s.lo, hi: s.hi }, rec: R.rec.count, recL: R.rec.countL, recR: R.rec.r,
    c: R.c, ckCount: R.ck.length, ckBytes: R.ckBytes, status: R.status, target: R.target,
  };
}

function progress(force) {
  const t = now();
  if (!force && t - R.lastProgress < 250) return;
  const dt = (t - R.rateT) / 1000;
  if (dt > 0.05) {
    const r = (R.sim.t - R.rateS) / dt;
    R.rate = R.rate ? 0.6 * R.rate + 0.4 * r : r;
    R.rateT = t; R.rateS = R.sim.t;
  }
  R.lastProgress = t;
  post(info());
}

async function loop() {
  if (R.looping) return;
  R.looping = true;
  const sim = R.sim, slice = R.limits.sliceSteps;
  R.rateT = now(); R.rateS = sim.t;
  try {
    while (R.status === 'running') {
      const S = 2 ** R.c;
      const nextCk = R.s0 + (Math.floor((sim.t - R.s0) / S) + 1) * S;
      const goal = Math.min(nextCk, R.target, sim.t + slice);
      if (goal > sim.t) sim.runTo(goal);
      if (!sim.halted && !sim.capped && sim.t === goal && sim.t !== R.lastCkT && (sim.t - R.s0) % (2 ** R.c) === 0) {
        R.pend.push(makeCkpt());
        strideRule();
      }
      if (sim.halted || sim.capped || sim.t >= R.target) {
        finish();
        break;
      }
      flush(false);
      progress(false);
      await yieldNow();
    }
    if (R.status === 'paused') { flush(true); progress(true); }
    if (R.status === 'closed') { flush(true); post({ type: 'done', sid: R.sid, reason: 'closed', t: sim.t, end: endInfo() }); }
  } catch (err) {
    R.status = 'error';
    post({ type: 'error', sid: R.sid, code: (err && err.code) || ERR.INTERNAL, message: (err && err.message) || String(err) });
  } finally {
    R.looping = false;
  }
}

function endInfo() {
  const s = R.sim;
  return { state: s.stateName, pos: s.pos, lo: s.lo, hi: s.hi, nonzeros: s.nonzeros(), dir: s.sdir };
}

function finish() {
  const sim = R.sim;
  flush(true);
  progress(true);
  let reason = 'steps', halt;
  if (sim.halted) {
    reason = 'halt';
    halt = { step: sim.t, from: String.fromCharCode(65 + sim.haltFrom), read: sim.haltRead, kind: sim.haltKind,
      rec: sim.fresh ? (sim.sdir > 0 ? 'R' : 'L') : null };            // the halting step was a record of that side
  } else if (sim.capped) reason = 'span-cap';
  R.status = 'done';
  post({ type: 'done', sid: R.sid, reason, t: sim.t, halt, end: endInfo(), rec: R.rec.count, recL: R.rec.countL });
}
