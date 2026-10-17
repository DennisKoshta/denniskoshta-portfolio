// engine/rows.mjs (ENGINE): row geometry, exact/pooled row extraction and strip execution (explorer-spec §5.3,
// §5.4, §8.5). Runs inside tile workers (and node tests); pure apart from the Sim it drives.
//
// Strip job (engine-internal form of the §7 `strip` message):
//   {sid, frame, kt, kx, patterns, blk, halt, ty, r0, r1, tx0, tx1, tMax, haltStep, live, plan}
//   plan = {kind:'steps', steps:Float64Array(nr), seeks:Array<SeekRef|null>(nr)}
//            row k is the configuration at steps[k] (NaN = ABSENT); a row at haltStep is the halting row.
//        | {kind:'events', ev:Float64Array(nr) (event number e per row: records ordinal / state,trans b+1; NaN = ABSENT),
//            ord:Float64Array(nr) (value of the tile's `ev` field), stride, mode:'rec'|'watch', side:0|1|2, mask,
//            seeks:Array<{ref:SeekRef, event:number}|null>(nr)}   (event = events with step <= ref.t)
//   A row's seek is restored before advancing to it when given (the facade only gives one when it is ahead of
//   the previous row, or the strip's first row).
import { TILE, F_FRESH, F_NOHEAD, F_HALTED, F_ABSENT, F_PENDING, F_START, ERR, LIMITS } from '../core/protocol.mjs';
import { stateMask, transMask, transInfo, STATES } from '../core/machine.mjs';
import { dh } from '../core/config.mjs';
import { poolRow, makePlanes, parsePatterns, parseBlk, pooledDtype } from './pool.mjs';

/** Display geometry of the sim's current configuration as a tile row (§5.3 per-row rules). */
export function rowGeom(sim, haltMode) {
  const g = {
    state: sim.halted ? -1 : sim.q, dir: sim.dir, flags: (sim.fresh ? F_FRESH : 0) | (sim.t === sim.s0 ? F_START : 0),
    pos: sim.pos, lo: sim.lo, hi: sim.hi, next: sim.next, step: sim.t, fixP: NaN, fixV: 0,
  };
  if (sim.halted) {
    g.flags |= F_HALTED;
    if (haltMode !== 'sim' && sim.haltKind === 'undefined') {
      // diagram.py _fix_halt: the site neither writes nor moves on '---': tape before the halting transition,
      // pos - 1, the cell restored to halt_read, no head; a fresh cell the move stepped onto is not defined.
      const p = g.pos - 1;
      if (g.flags & F_FRESH) g.hi -= 1;
      g.fixP = p; g.fixV = sim.haltRead;
      g.pos = p;
      g.flags = (g.flags & ~F_FRESH) | F_NOHEAD;
    }
  }
  return g;
}

export function anchorOf(g, frame) {
  return frame === 'head' ? g.pos : frame === 'left' ? g.lo : frame === 'right' ? g.hi : 0;
}

/** read range [dlo, dhi] of a geometry (span minus a fresh head cell at an edge) */
export function readRange(g) {
  let lo = g.lo, hi = g.hi;
  if (g.flags & F_FRESH) { if (g.pos === lo) lo++; else if (g.pos === hi) hi--; }
  return [lo, hi];
}

function emptyRowMeta(meta, r, flags, clo) {
  const b = 8 * r;
  meta[b] = -1; meta[b + 1] = 0; meta[b + 2] = F_NOHEAD | flags; meta[b + 3] = 0; meta[b + 4] = 0; meta[b + 5] = 0;
  meta[b + 6] = clo; meta[b + 7] = 0;
}

/** Strip output buffers for tx0..tx1 (row slices of nr rows). */
export function makeStripOut(job, m) {
  const nr = job.r1 - job.r0, out = [];
  const pooled = job.kx < 0;
  const cx = pooled ? 2 ** -job.kx : 1;
  const evRows = job.plan.kind === 'events' || !!job.plan.ord;
  const pats = pooled ? parsePatterns(job.patterns, m) : [];
  const blk = pooled && job.blk ? parseBlk(job.blk, m) : null;
  for (let tx = job.tx0; tx <= job.tx1; tx++) {
    const o = {
      tx, meta: new Int32Array(8 * nr), steps: new Float64Array(nr).fill(NaN),
      ev: evRows ? new Float64Array(nr).fill(NaN) : null, next: new Int16Array(nr).fill(-1),
    };
    if (pooled) { o.headCol = new Int16Array(nr).fill(-1); o.planes = makePlanes(m, cx, pats, blk, nr); o.dtype = pooledDtype(cx); }
    else o.cells = new Uint8Array(TILE * nr);
    out.push(o);
  }
  return { out, pooled, cx, pats, blk, nr };
}

/** Mark row r of every tile as ABSENT or PENDING. */
export function putEmpty(S, job, r, flag) {
  for (const o of S.out) {
    emptyRowMeta(o.meta, r, flag, 0);
    o.steps[r] = NaN; o.next[r] = -1;
    if (o.ev) o.ev[r] = NaN;
  }
}

/** Extract the sim's current configuration as row r of every tile tx0..tx1. evOrd = the tile `ev` value. */
export function putRow(S, job, sim, r, evOrd) {
  const g = rowGeom(sim, job.halt);
  const anchor = anchorOf(g, job.frame);
  const T = sim.tape, org = sim.org;
  let saved = -1;
  if (g.fixP === g.fixP) { saved = T[g.fixP + org]; T[g.fixP + org] = g.fixV; }
  const [dlo, dhi] = readRange(g);
  for (const o of S.out) {
    const tx = o.tx, b = 8 * r, M = o.meta;
    M[b] = g.state; M[b + 1] = g.dir; M[b + 2] = g.flags; M[b + 3] = g.pos; M[b + 4] = g.lo; M[b + 5] = g.hi;
    o.steps[r] = g.step; o.next[r] = g.next;
    if (o.ev) o.ev[r] = evOrd;
    if (!S.pooled) {
      const wlo = anchor + TILE * tx, whi = wlo + TILE - 1;
      const a = Math.max(wlo, g.lo), e = Math.min(whi, g.hi);
      if (a <= e) {
        M[b + 6] = a; M[b + 7] = e - a + 1;
        o.cells.set(T.subarray(a + org, e + org + 1), TILE * r);
      } else { M[b + 6] = wlo; M[b + 7] = 0; }
    } else {
      const cx = S.cx, W0 = anchor + TILE * tx * cx;
      M[b + 6] = W0; M[b + 7] = TILE * cx;
      poolRow(T, org, dlo, dhi, W0, TILE * tx, cx, sim.m, o.planes, r, S.pats, S.blk);
      if (!(g.flags & F_NOHEAD)) {
        const c = Math.floor((g.pos - W0) / cx);
        o.headCol[r] = c >= 0 && c < TILE ? c : -1;
      }
    }
  }
  if (saved >= 0) T[g.fixP + org] = saved;
}

/** Cooperative context: {yield: async () => void, cancelled: () => boolean, slice: number, getBits(ref) -> bits} */
async function advanceTo(sim, T, ctx) {
  while (T - sim.t > ctx.slice + 1 && !sim.halted && !sim.capped) {
    sim.run(ctx.slice);
    await ctx.yield();
    if (ctx.cancelled()) return false;
  }
  if (sim.t < T) sim.runTo(T);
  return true;
}

function restoreSeek(sim, ref, ctx) {
  sim.restore(ref, ctx.getBits(ref));
}

/** Execute a strip job. Returns {tiles: [...]} (row slices) or null if cancelled. */
export async function runStrip(sim, job, ctx) {
  const S = makeStripOut(job, sim.m);
  const nr = S.nr, plan = job.plan;
  const pendFlag = job.live ? F_PENDING : F_ABSENT;
  let since = 0, started = false;
  if (plan.kind === 'steps') {
    for (let k = 0; k < nr; k++) {
      const step = plan.steps[k];
      if (step !== step) { putEmpty(S, job, k, F_ABSENT); continue; }
      if (step > job.tMax) { putEmpty(S, job, k, pendFlag); continue; }
      const sk = plan.seeks[k];
      if (sk && (!started || sk.t > sim.t || sim.t > step)) { restoreSeek(sim, sk, ctx); started = true; }
      if (!started) throw Object.assign(new Error(`strip row ${k}: no seek`), { code: 'E_INTERNAL' });
      if (sim.t > step) throw Object.assign(new Error(`strip row ${k}: sim at ${sim.t} past ${step}`), { code: 'E_INTERNAL' });
      const ok = await advanceTo(sim, step, ctx);
      if (!ok) return null;
      if (sim.t !== step) { putEmpty(S, job, k, F_ABSENT); continue; }   // halted / span cap earlier
      putRow(S, job, sim, k, plan.ord && !sim.halted ? plan.ord[k] : NaN);
      if (++since >= 8) { since = 0; await ctx.yield(); if (ctx.cancelled()) return null; }
    }
  } else {
    let E = -1;                       // events with step <= sim.t (valid after a seek)
    let haltDone = false;             // halting row emitted, or the halt step was itself an event row
    for (let k = 0; k < nr; k++) {
      const e = plan.ev[k];
      if (e !== e || haltDone) { putEmpty(S, job, k, F_ABSENT); continue; }
      const sk = plan.seeks[k];
      if (sk && (E < 0 || E >= e || sk.ref.t > sim.t)) { restoreSeek(sim, sk.ref, ctx); E = sk.event; }
      if (E < 0 || E > e) throw Object.assign(new Error(`strip row ${k}: no usable seek for event ${e}`), { code: 'E_INTERNAL' });
      if (e === 0) {                                  // records ordinal 0 = the start configuration
        if (sim.t !== sim.s0) throw Object.assign(new Error('records row 0 needs the start checkpoint'), { code: 'E_INTERNAL' });
        putRow(S, job, sim, k, plan.ord[k]);
        continue;
      }
      // advance to event e
      while (E < e && !sim.halted && !sim.capped && sim.t < job.tMax) {
        const budget = Math.min(ctx.slice, job.tMax - sim.t);
        if (plan.mode === 'rec') {
          sim.runRecords(budget, e - E, plan.side);
          const got = (e - E) - sim.rwLeft;
          E += got;
        } else {
          let left = budget;
          while (left > 0 && E < e && !sim.halted) {
            const d = sim.runWatch(left, plan.mask, ctx.watchFn);
            left -= d;
            if (sim.ev >= 0) E++;
            else break;
          }
        }
        if (E < e && !sim.halted && sim.t < job.tMax) { await ctx.yield(); if (ctx.cancelled()) return null; }
      }
      if (E === e) {
        putRow(S, job, sim, k, plan.ord[k]);
        if (sim.halted) haltDone = true;
      } else if (sim.halted) {
        // halt before event e: the halting row follows the last regular row (previous level row was an event).
        // When the halting step is itself event E and the previous level row was exactly E, that row already was
        // the halting row (possibly in the previous strip): nothing more here.
        const prevE = e - plan.stride;
        const haltIsEv = plan.mode === 'rec'
          ? sim.fresh && (plan.side === 2 || (plan.side === 1) === (sim.sdir > 0))
          : sim.ev >= 0;
        if (prevE < E || (prevE === E && !haltIsEv)) { putRow(S, job, sim, k, NaN); }
        else putEmpty(S, job, k, F_ABSENT);
        haltDone = true;
      } else {
        putEmpty(S, job, k, sim.capped ? F_ABSENT : pendFlag);
      }
      if (++since >= 8) { since = 0; await ctx.yield(); if (ctx.cancelled()) return null; }
    }
  }
  return { tiles: S.out };
}

// ------------------------------------------------------------------------------------------------
// Shared by both facades (ui/engine-client.mjs and engine/stub-client.mjs)
// ------------------------------------------------------------------------------------------------
const bad = (message) => ({ code: ERR.RANGE, message });

/** Validate a RowsSpec and derive what the engine needs:
 *  {kind:'steps'|'events', rk, K, O, side ('LR'|'L'|'R'), sideCode (0 L, 1 R, 2 LR), mask, off} */
export function rowsInfo(rows, M) {
  const kind = rows && rows.kind;
  if (kind === 'auto') return { kind: 'steps', mode: 'auto', K: 1, O: 0 };
  if (kind === 'every') {
    const K = rows.k, O = rows.o || 0;
    if (!Number.isSafeInteger(K) || K < 1 || !Number.isSafeInteger(O) || O < 0 || O >= K) throw bad(`bad every rows k=${K} o=${O}`);
    return { kind: 'steps', mode: 'every', K, O };
  }
  if (kind === 'records') {
    const side = rows.side || 'LR';
    if (!['LR', 'L', 'R'].includes(side)) throw bad(`bad records side ${side}`);
    return { kind: 'events', mode: 'rec', side, sideCode: side === 'L' ? 0 : side === 'R' ? 1 : 2, off: 0 };
  }
  if (kind === 'state') {
    if (rows.dir && rows.dir !== 'L' && rows.dir !== 'R') throw bad(`bad state dir ${rows.dir}`);
    const mask = stateMask(M, rows.q, rows.dir);
    if (!mask) throw bad(`no state ${rows.q} in this machine`);
    return { kind: 'events', mode: 'watch', mask, off: 1 };
  }
  if (kind === 'trans') {
    const mask = transMask(M, rows.tr);
    if (!mask) throw bad(`no transition ${rows.tr} in this machine`);
    return { kind: 'events', mode: 'watch', mask, off: 1, tr: mask.indexOf(1) };
  }
  throw bad(`bad rows ${JSON.stringify(rows)}`);
}

/** Validate a TileRequest; returns {pats, blk, cx} (parsed planes for kx < 0). */
export function checkRequest(req, M) {
  if (!Number.isInteger(req.kt) || req.kt > 0 || req.kt < -52) throw bad(`bad kt ${req.kt}`);
  if (!Number.isInteger(req.kx) || req.kx > 0 || req.kx < -30) throw bad(`bad kx ${req.kx}`);
  if (!['abs', 'head', 'left', 'right'].includes(req.frame)) throw bad(`bad frame ${req.frame}`);
  if (req.halt !== 'site' && req.halt !== 'sim') throw bad(`bad halt ${req.halt}`);
  if (!Array.isArray(req.tiles)) throw bad('tiles must be an array');
  let pats = [], blk = null;
  if (req.kx < 0) {
    const ps = req.patterns || [];
    if (ps.length > LIMITS.maxPatterns) throw bad(`at most ${LIMITS.maxPatterns} patterns`);
    try {
      pats = parsePatterns(ps, M.m);
      blk = req.blk ? parseBlk(req.blk, M.m) : null;
    } catch (e) { throw bad(e.message); }
  }
  return { pats, blk, cx: 2 ** -req.kx };
}

export const OFF256 = (() => { const o = new Float64Array(TILE + 1); for (let i = 0; i <= TILE; i++) o[i] = TILE * i; return o; })();

/** A tile object with every row PENDING (§5.3/§5.4). */
export function emptyTile(key, req, ty, tx, M, evRows, pats, blk) {
  const pooled = req.kx < 0, cx = 2 ** -req.kx;
  const meta = new Int32Array(8 * TILE);
  for (let r = 0; r < TILE; r++) { meta[8 * r] = -1; meta[8 * r + 2] = F_NOHEAD | F_PENDING; }
  const t = {
    key, kind: pooled ? 'pooled' : 'exact', sid: req.sid, ty, tx, kt: req.kt, m: M.m, n: TILE,
    meta, steps: new Float64Array(TILE).fill(NaN), ev: evRows ? new Float64Array(TILE).fill(NaN) : null,
    next: new Int16Array(TILE).fill(-1), final: false,
  };
  if (pooled) {
    t.kx = req.kx; t.cx = cx; t.cols = TILE;
    t.headCol = new Int16Array(TILE).fill(-1);
    t.dtype = pooledDtype(cx);
    t.planes = makePlanes(M.m, cx, pats, blk, TILE);
  } else {
    t.cells = new Uint8Array(TILE * TILE);
    t.off = OFF256;
  }
  return t;
}

/** Bytes a tile of this request will take (without allocating it). */
export function tileBytesFor(req, M, evRows, pats, blk) {
  let b = 8 * TILE * 4 + TILE * 8 + TILE * 2 + (evRows ? TILE * 8 : 0) + 256;
  if (req.kx < 0) {
    const w = pooledDtype(2 ** -req.kx) === 'u16' ? 2 : 4;
    b += TILE * TILE * (w * (M.m + pats.length + (blk ? 1 : 0)) + 1) + TILE * 2;
  } else b += TILE * TILE;
  return b;
}

export function tileBytes(t) {
  let b = t.meta.byteLength + t.steps.byteLength + t.next.byteLength + (t.ev ? t.ev.byteLength : 0) + 256;
  if (t.cells) b += t.cells.byteLength;
  if (t.planes) for (const k in t.planes) b += t.planes[k].byteLength;
  if (t.headCol) b += t.headCol.byteLength;
  return b;
}

/** Copy a strip's row slices (worker result) into a tile at rows r0.. */
export function assembleStrip(tile, part, r0) {
  tile.meta.set(part.meta, 8 * r0);
  tile.steps.set(part.steps, r0);
  tile.next.set(part.next, r0);
  if (tile.ev && part.ev) tile.ev.set(part.ev, r0);
  if (tile.cells) tile.cells.set(part.cells, TILE * r0);
  if (tile.planes) {
    tile.headCol.set(part.headCol, r0);
    for (const k in tile.planes) tile.planes[k].set(part.planes[k], TILE * r0);
  }
}

/** ProbeResult of a start Config (no worker needed). */
export function startProbe(cfg, M) {
  const L = cfg.tape.length, cells = new Uint8Array(L);
  cells.set(cfg.tape);
  const q = STATES.indexOf(cfg.state), pos = cfg.lo + cfg.head;
  return {
    step: cfg.step, state: cfg.state, dir: 0, pos, lo: cfg.lo, hi: cfg.lo + L - 1, fresh: false, halted: false,
    x0: cfg.lo, cells, next: transInfo(M, q * M.m + cfg.tape[cfg.head]), prev: null,
    dh: dh(cfg), dhExact: dh(cfg, { trim: false }),
  };
}

/** Level row R -> base row (R * 2^-kt). */
export function baseRow(R, kt) { return R * 2 ** -kt; }
