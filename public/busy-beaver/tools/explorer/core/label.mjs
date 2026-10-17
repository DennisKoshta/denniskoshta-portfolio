// The label contract (spec §10): every view states Start · Rows · Window · Colors (+ a status segment).
// makeLabel is pure; it feeds the on-screen label, the legend, PNG export and the snapshot tests.
import { int, ordinal, pow2, rate, pct, secs, log2Exact, plural } from './fmt.mjs';
import { MAG } from './protocol.mjs';
import { ppu, upp, stepOfBase, firstBase, isTimeRows } from './lod.mjs';
import { isEventRows, parsePattern } from './viewstate.mjs';
import {
  STYLE_NAMES, STATE_COLOR_NAMES, HL_NAMES, symbolColorName, symbolColor, unvisitedColor, rampTicks, kblockColors,
  rotations, HEAD_R, HEAD_L, HEAD_OVER, STATE_COLORS, UNV_MARK, HL_COLORS, HATCH_FG, BLK_COLOR, DIM_LO, DIM_HI, DIFF_AB, DIFF_BA, TINT,
} from './palette.mjs';

const SEP = ' · ';
const FRAME_NAME = { abs: 'abs', head: 'head-relative', left: 'left-edge-relative', right: 'right-edge-relative' };

export function ellipsis(s, n) { return s.length <= n ? s : s.slice(0, n - 1) + '…'; }

/** Visible level-row index range [r0, r1] of a time axis (rows partly visible count). */
function visibleLevelRows(at, H) {
  const px = at.k < 0 ? 1 : MAG[at.z];
  return [Math.ceil((-at.origin - px + 1) / px), Math.floor((H - 1 - at.origin) / px)];
}

/** Visible cell range [c0, c1] (frame-relative), whole texels when pooled. */
export function visibleCells(ax, W) {
  if (ax.k < 0) {
    const t0 = Math.ceil(-ax.origin), t1 = Math.floor(W - 1 - ax.origin);
    return [t0 * ax.per, t1 * ax.per + ax.per - 1];
  }
  const px = MAG[ax.z];
  return [Math.ceil((-ax.origin - px + 1) / px), Math.floor((W - 1 - ax.origin) / px)];
}

/** End of the real rows: the halt step if halted, else the simulated step count. */
export function runEnd(run) {
  if (!run) return 0;
  return run.halt ? run.halt.step : run.t;
}

/**
 * Visible real rows for time rows: {count, step0, step1, haltVisible, absentVisible, firstStep (top row)}.
 * The halting configuration is always the row right after the last regular row (spec §5.3).
 */
export function timeRows(vs, vp, run) {
  const at = vp.at, per = at.per, [r0, r1] = visibleLevelRows(at, vp.H);
  const rows = vs.rows, s0 = vs.s0 || 0;
  const fb = firstBase(rows, s0);                       // first real base row
  const rFirst = Math.ceil(fb / per);                   // first real level row
  const end = runEnd(run);
  const lastRegular = Math.floor(Math.floor((Math.max(s0, end) - (rows.o || 0)) / (rows.kind === 'every' ? rows.k : 1)) / per);
  let rLast = lastRegular;
  const halted = !!(run && run.halt);
  let haltStep = null;
  if (halted) {
    const lastStep = stepOfBase(rows, lastRegular * per);
    if (lastStep < run.halt.step) { rLast = lastRegular + 1; haltStep = run.halt.step; }
    else if (lastStep === run.halt.step) haltStep = run.halt.step;
  }
  const a = Math.max(r0, rFirst), b = Math.min(r1, rLast);
  const count = b >= a ? b - a + 1 : 0;
  const stepAt = (r) => (halted && r === rLast && haltStep !== null && r > lastRegular ? haltStep : stepOfBase(rows, r * per));
  // a paused run is not live: the engine draws the rows after its last step hatched (ABSENT), not dark (PENDING)
  const live = !!run && run.status === 'running';
  return {
    count,
    step0: count ? stepAt(a) : null,
    step1: count ? stepAt(b) : null,
    haltVisible: haltStep !== null && rLast >= r0 && rLast <= r1,
    haltStep,
    absentVisible: r0 < rFirst || (!live && r1 > rLast),
    pendingVisible: live && r1 > rLast,
    // the step of the top row actually drawn (the halting row sits off the grid at its real step)
    topStep: count ? stepAt(a) : stepOfBase(rows, Math.max(r0, rFirst) * per),
    topIsStart: r0 <= rFirst,
  };
}

function startText(start, s0, tm, opts = {}) {
  if (!start || start.kind === 'blank') return s0 ? `blank tape (state A on cell 0) · steps numbered from ${int(s0)}` : 'blank tape (state A on cell 0)';
  if (start.kind === 'site') {
    // the site's parser (config.siteTapeConfig = vizref parse_initial_tape) keeps the LAST state letter
    const all = start.tape.match(/[A-Za-z]/g);
    const q = all ? all[all.length - 1].toUpperCase() : 'A';
    return `bbchallenge tape "${start.tape}" (state ${q} on cell 0)`;
  }
  let s = `constructed: ${ellipsis(start.dh || '(loading)', opts.dhLen || 56)}`;
  if (start.vars && Object.keys(start.vars).length) s += ` [${Object.entries(start.vars).map(([k, v]) => `${k}=${v}`).join(', ')}]`;
  // the machine's own folder is implied (the machine is named in the top bar): machines/<tm>/x.txt -> machines/…/x.txt
  if (start.src) s += ` · from ${start.src.replace(/^@/, '').replace(/^machines\/([^/]+)\//, (m0, d) => (d === tm ? 'machines/…/' : m0))}`;
  if (start.from && Number.isFinite(start.from.step)) s += ` · = step ${int(start.from.step)} of the blank-tape run`;
  s += ` · steps numbered from ${int(s0 || 0)}`;
  return s;
}

function rowsHead(rows, kt) {
  const per = 2 ** -Math.min(0, kt);
  if (rows.kind === 'auto') {
    if (per === 1) return 'every step';
    const k = log2Exact(per);
    return `every ${ordinal(per)} step (${k >= 0 ? `2^${k}; ` : ''}sampled: the ${plural(per - 1, 'step')} between rows are not drawn)`;
  }
  if (rows.kind === 'every') {
    const K = rows.k, off = rows.o ? ` · grid offset ${int(rows.o)}` : '';
    if (per === 1) return `every ${ordinal(K)} step (sampled: the ${plural(K - 1, 'step')} between rows are not drawn)${off}`;
    const gap = K * per;
    return `every ${ordinal(K)} step, showing every ${ordinal(per)} row (${int(gap)} steps apart; sampled: the ${plural(gap - 1, 'step')} between rows are not drawn)${off}`;
  }
  let s;
  if (rows.kind === 'records') s = rows.side === 'LR' ? 'records L+R' : `records ${rows.side}`;
  else if (rows.kind === 'state') s = `entries into ${rows.q}${rows.dir ? ` moving ${rows.dir}` : ''}`;
  else s = `firings of ${rows.tr}`;
  s += ' · rows not evenly spaced in time';
  if (per > 1) s += ` · showing every ${ordinal(per)} row${pow2(per)}`;
  return s;
}

/** Text for one count-pattern channel. */
function patternPhrase(pat, mode, pooled) {
  const P = parsePattern(pat);
  if (!P) return pat;
  const where = P.k > 1 ? ` at cells ≡ ${P.p} mod ${P.k}` : '';
  const what = P.w.length === 1 ? `cells holding ${P.w}` : P.w.length === 2 ? `${P.w} pairs` : `${P.w} occurrences`;
  if (!pooled) return `cells inside ${P.w.length === 1 ? 'a ' + P.w : P.w.length === 2 ? 'a ' + P.w + ' pair' : 'an occurrence of ' + P.w}${where}`;
  if (mode === 'any') return `any ${what.replace(/s$/, '')}${where} in the px`;
  if (mode === 'frac') return `share of positions starting ${P.w}${where}`;
  return `number of ${what}${P.w.length > 1 ? ' starting' : ''}${where} in the px`;
}

/**
 * Colour descriptor shared by the Colors line and the legend panel.
 * @returns {{text:string, items:Array}} items: {kind:'swatch', rgb, label} | {kind:'ramp', rgb, ticks, label} | {kind:'grid2', ...} | {kind:'hatch', label}
 */
export function colorsDescriptor(vs, m, vp, extra = {}) {
  const items = [], parts = [];
  const pooled = vp.kx < 0, cx = 2 ** -Math.min(0, vp.kx);
  const st = vs.style, name = STYLE_NAMES[st];
  const hlOn = vs.hl.length > 0 && extra.hlOn !== false;
  const bgOn = !!vs.bg && extra.bgOn !== false;
  const diff = extra.diff;
  if (diff) {
    if (pooled) {
      parts.push('compare diff: zoom in to see the diff (pooled diff is v1.5); showing A');
    } else {
      parts.push(`diff: equal cells in A's ${name} colours at 30% · orange = A > B · cyan = B > A · head A red outline, B blue outline`);
      items.push({ kind: 'swatch', rgb: DIFF_AB, label: 'A > B' }, { kind: 'swatch', rgb: DIFF_BA, label: 'B > A' });
      return { text: parts.join(SEP), items };
    }
  }
  if (hlOn || (bgOn && pooled)) {
    // dimmed base
    const what = m === 2 ? `share of 1s among the ${int(cx)} cells` : `mean symbol among the ${int(cx)} cells`;
    parts.push(pooled ? `base dimmed: ${what}` : 'base dimmed');
    items.push({ kind: 'ramp2', from: DIM_LO, to: DIM_HI, label: pooled ? `base: ${what}` : 'base (dimmed symbols)' });
    if (hlOn) {
      const nm = vs.hl.map((p, i) => {
        let ph = patternPhrase(p, vs.hlm, pooled);
        if (i > 0 && pooled) ph = ph.replace(/ starting in the px$| in the px$/, '');
        return `${HL_NAMES[i]} = ${ph}`;
      });
      const lens = vs.hl.map((p) => (parsePattern(p) || { w: '' }).w.length);
      const nmax = Math.max(1, cx - Math.min(...lens) + 1);
      let s = nm.join(', ');
      if (pooled && vs.hlm === 'count') s += ` (log ramp: ${rampTicks(nmax).map(int).join(', ')})`;
      parts.push(s);
      if (vs.hl.length >= 2) parts.push(vs.hl.length === 2 ? 'purple = both' : 'overlaps mix (blue + red = purple)');
      if (pooled) parts.push('only read cells count');
      else if (vs.unv) { parts.push('never-read cells purple #4b3b6b'); items.push({ kind: 'swatch', rgb: UNV_MARK, label: 'never read' }); }
      vs.hl.forEach((p, i) => items.push(pooled && vs.hlm !== 'any'
        ? { kind: 'ramp', rgb: HL_COLORS[i], ticks: rampTicks(Math.max(1, cx - (parsePattern(p) || { w: 'x' }).w.length + 1)), mode: vs.hlm, label: `${p}: ${patternPhrase(p, vs.hlm, pooled)}` }
        : { kind: 'swatch', rgb: HL_COLORS[i], label: `${p}: ${patternPhrase(p, vs.hlm, pooled)}` }));
      if (vs.hl.length === 2) items.push({ kind: 'grid2', a: HL_COLORS[0], b: HL_COLORS[1], label: `${vs.hl[0]} × ${vs.hl[1]}` });
    }
  } else {
    // site style legend
    const sym = [];
    for (let k = 0; k < m; k++) {
      sym.push(`${k} ${symbolColorName(st, k, m)}`);
      items.push({ kind: 'swatch', rgb: symbolColor(st, k, m), label: `symbol ${k}` });
    }
    let base;
    if (!pooled) base = `${name}: ${sym.join(' · ')}`;
    else if (vs.pool === 'near') base = `${name}, each px = the read cell nearest the ${vs.frame === 'abs' ? 'origin' : 'anchor'} among its ${int(cx)} cells: ${sym.join(' · ')}`;
    else base = `${name}, each px = mean colour of its ${int(cx)} cells (our pooling): ${sym.join(' · ')}`;
    parts.push(base);
    const unvName = st === 'explore' ? 'slate' : st === 'default' ? 'black' : 'white';
    if (vs.unv) { parts.push('unvisited purple #4b3b6b'); items.push({ kind: 'swatch', rgb: UNV_MARK, label: 'never read' }); }
    else parts.push(`unvisited ${unvName} (same as 0)`);
    if (pooled && vs.pool === 'mean' && m >= 3 && (st === 'default' || st === 'explore')) parts.push('grey is ambiguous for 3+ symbols (half 0 + half 2 looks like 1): try Blaze or near');
  }
  if (bgOn) {
    const kb = vs.bg, words = Array.isArray(kb.words) ? kb.words : (extra.bgWords || null);
    const phase = kb.k === 2 ? (kb.p === 0 ? 'even cells' : 'odd cells') : `cells ≡ ${kb.p} mod ${kb.k}`;
    if (!pooled) {
      if (words && words.length) {
        const map = kblockColors(kb.k, m, words);
        const segs = [];
        for (const [w, c] of map) {
          if (c.bg) segs.push(`${w} ${w === words[0] ? 'light' : 'grey'}`);
          items.push({ kind: 'swatch', rgb: c.rgb, label: `${kb.k}-block ${w}${c.bg ? ' (background)' : ''}` });
        }
        for (const [w, c] of map) if (!c.bg && c.idx < 8) segs.push(`${w} ${c.name}`);
        parts.push(`${kb.k}-blocks at ${phase}: ${segs.join(', ')}`);
      } else parts.push(`${kb.k}-blocks at ${phase}: finding the background word…`);
    } else {
      const nmax = Math.max(1, Math.floor(cx / kb.k));
      parts.push(`orange = number of ${kb.k}-blocks at ${phase} that are not background${words ? ' (' + words.join('/') + ')' : ''} (log ramp: ${rampTicks(nmax).map(int).join(', ')})`);
      items.push({ kind: 'ramp', rgb: BLK_COLOR, ticks: rampTicks(nmax), mode: 'count', label: 'non-background blocks' });
    }
  }
  // head (while highlight / k-block channels are on: yellow at exact zoom, not drawn when pooled)
  if (!(hlOn || bgOn)) {
    if (vs.head === 'trans') { parts.push('head = the transition about to fire (colours as in the table)'); }
    else if (st === 'default') {
      parts.push(`head red = last move R, green = last move L${vs.quirks ? ' (site quirks: not drawn on some fresh cells, row 0 hidden)' : ''}${pooled ? ' (the px holding the head)' : ''}`);
      items.push({ kind: 'swatch', rgb: HEAD_R, label: 'head, last move R' }, { kind: 'swatch', rgb: HEAD_L, label: 'head, last move L' });
    } else if (st === 'explore') {
      const n = extra.n || 7;
      parts.push(`head = state about to act: ${STATE_COLOR_NAMES.slice(0, Math.min(n, 7)).map((c, i) => `${String.fromCharCode(65 + i)} ${c}`).join(', ')}${n > 7 ? ' (H+ none)' : ''}`);
      for (let q = 0; q < Math.min(n, 7); q++) items.push({ kind: 'swatch', rgb: STATE_COLORS[q], label: `head in state ${String.fromCharCode(65 + q)}` });
    } else parts.push('no head (as on the site)');
  } else if (vs.head === 'trans') parts.push('head = transition about to fire');
  else if (!pooled && (st === 'default' || st === 'explore')) {
    parts.push('head yellow');
    items.push({ kind: 'swatch', rgb: HEAD_OVER, label: 'head' });
  }
  if (extra.absentVisible) {
    parts.push(extra.paused ? `hatched = no row (before the start, or after step ${int(extra.pausedAt)}: the run is paused)` : 'hatched = no row (outside the run)');
    items.push({ kind: 'hatch', rgb: HATCH_FG, label: extra.paused ? 'no row here (before the start / run paused)' : 'no row here' });
  }
  if (extra.pendingVisible) parts.push('dark = not simulated yet');
  return { text: parts.join(SEP), items };
}

/**
 * makeLabel(view, viewport, runA, runB|null, status) -> {start, rows, window, colors, status, text}
 * viewport: {W, H, ax, at, zx, zt, kx, kt}; status: {refining?:number (0..1 exact), partial?:bool,
 *   ev?:{count, step0, step1, haltVisible}, n?, m?, bgWords?, diff?:bool, siteHidden?}
 */
export function makeLabel(view, vp, runA, runB, status = {}) {
  const vs = view, m = status.m || (runA && runA.m) || 2;
  // Start
  let start = startText(vs.start, vs.s0, vs.tm);
  let tr = null;
  if (isTimeRows(vs.rows)) tr = timeRows(vs, vp, runA);
  const topStep = tr ? tr.topStep : status.ev ? status.ev.step0 : null;
  if (tr && topStep !== null && topStep > (vs.s0 || 0) && tr.count) {
    const end = runA ? Math.max(runA.target || 0, runA.t || 0) : 0;
    const done = runA && runA.status !== 'running';
    const total = done ? runEnd(runA) : end;
    const frac = total > (vs.s0 || 0) ? Math.min(1, Math.max(0, (topStep - (vs.s0 || 0)) / (total - (vs.s0 || 0)))) : 0;
    const gap = isTimeRows(vs.rows) ? (vs.rows.kind === 'every' ? vs.rows.k : 1) * 2 ** -Math.min(0, vp.kt) : 1;
    if (tr.topIsStart && topStep - (vs.s0 || 0) < gap && !(tr.haltVisible && topStep === tr.haltStep)) {
      // the view is at the start, but the row grid (multiples of the row spacing, counted from step 0) has its
      // first row a little after s0: say so instead of claiming the view starts later
      start += ` · view starts at step ${int(topStep)} (${pct(frac)} into the run: the first row of the every-${ordinal(gap)}-step grid after the start; the steps before it are simulated, not shown)`;
    } else start += ` · view starts at step ${int(topStep)} (${pct(frac)} into the run; the steps before it are simulated, not shown)`;
  } else if (!tr && status.ev && status.ev.count && status.ev.step0 > (vs.s0 || 0)) {
    const ev = status.ev;
    if (ev.ev0 === 0) start += ` · the first row is the first ${vs.rows.kind === 'records' ? 'record' : vs.rows.kind === 'state' ? 'entry' : 'firing'} (step ${int(ev.step0)})`;
    else start += ` · view starts at row #${int(ev.ev0 ?? 0)}, step ${int(ev.step0)} (the rows before it are not shown)`;
  }
  if (runB && vs.cmp) {
    const bStart = vs.cmp.start === 'same' || !vs.cmp.start ? vs.start : vs.cmp.start === 'blank' ? { kind: 'blank' } : vs.cmp.start;
    const same = vs.cmp.start === 'same' || !vs.cmp.start;
    const bt = same ? 'the same start' : startText(bStart, vs.s0, vs.cmp.tm, { dhLen: 32 });
    start = `A: ${vs.tm} │ B: ${vs.cmp.tm} from ${bt} │ ${start}`;
  }
  // Rows
  const hpx = vp.zt >= 0 ? MAG[vp.zt] : 1;
  let rows = rowsHead(vs.rows, vp.kt);
  if (tr) {
    if (tr.count) rows += ` · steps ${int(tr.step0)} … ${int(tr.step1)} · ${int(tr.count)} row${tr.count === 1 ? '' : 's'}`;
    else rows += ' · no rows in view';
    rows += ` · 1 row = ${hpx} px`;
    if (tr.haltVisible) rows += ` · halting row at step ${int(tr.haltStep)}`;
  } else {
    const ev = status.ev, evB = status.evB;
    if (ev && ev.count) rows += ` · steps ${int(ev.step0)} … ${int(ev.step1)}${evB && evB.count ? ` (B: ${int(evB.step0)} … ${int(evB.step1)})` : ''} · ${int(ev.count)} row${ev.count === 1 ? '' : 's'}`;
    else if (ev) rows += ' · no rows in view';
    else rows += ' · steps (computing…)';
    rows += ` · 1 row = ${hpx} px`;
    if (ev && ev.haltVisible) rows += ` · halting row at step ${int(ev.haltStep)}`;
  }
  // Window
  const [c0, c1] = visibleCells(vp.ax, vp.W);
  let win = `cells ${int(c0)} … ${int(c1)} (${FRAME_NAME[vs.frame]})`;
  const cpp = upp(vp.zx);
  if (vp.zx >= 0) win += ` · 1 cell = ${MAG[vp.zx]} px`;
  else {
    const rule = vs.hl.length || vs.bg ? 'counts per px' : vs.pool === 'near' ? 'the read cell nearest the ' + (vs.frame === 'abs' ? 'origin' : 'anchor') : 'mean colour';
    win += ` · ${int(cpp)} cells/px (pooled: ${rule})`;
  }
  if (isTimeRows(vs.rows)) {
    const spp = upp(vp.zt) * (vs.rows.kind === 'every' ? vs.rows.k : 1);
    const q = spp / cpp;
    if (Math.abs(q - 1) < 1e-12) win += ' · aspect 1:1';
    else {
      const how = `(time ${q > 1 ? 'squeezed' : 'stretched'} ${int(q > 1 ? q : 1 / q)}× relative to space)`;
      if (cpp >= 1 && spp >= 1) win += ` · 1 px = ${int(cpp)} cell${cpp === 1 ? '' : 's'} × ${int(spp)} step${spp === 1 ? '' : 's'} ${how}`;
      else {
        // the cell width is already stated just before ("1 cell = 5 px" / "64 cells/px"): add the row height, in
        // the direction that reads as a whole number
        const sT = spp >= 1 ? `1 px = ${plural(spp, 'step')} tall` : `1 step = ${int(1 / spp)} px tall`;
        win += ` · ${sT} ${how}`;
      }
    }
  }
  // Colors
  const desc = colorsDescriptor(vs, m, vp, {
    n: status.n || (runA && runA.n), bgWords: status.bgWords, diff: status.diff,
    absentVisible: tr ? tr.absentVisible : status.absentVisible, pendingVisible: tr ? tr.pendingVisible : false,
    paused: !!runA && runA.status === 'paused', pausedAt: runA ? runA.t : null,
  });
  const colors = desc.text;
  // Status
  const st = statusText(runA, runB, status);
  const text = `Start   ${start}\nRows    ${rows}\nWindow  ${win}\nColors  ${colors}`;
  return { start, rows, window: win, colors, status: st, text, legend: desc.items };
}

export function statusText(run, runB, status = {}) {
  if (!run) return 'no machine';
  const segs = [];
  const one = (r, tag) => {
    const p = tag ? `${tag} ` : '';
    if (r.status === 'error') return `${p}error: ${r.error ? r.error.message : '?'}`;
    if (r.status === 'span-cap') return `${p}span cap reached at step ${int(r.t)}`;
    if (r.halt) {
      const how = r.halt.kind === 'undefined' ? `'---' at ${r.halt.from}, shown as on bbchallenge: no write, no head` : `halt state via ${r.halt.from}`;
      return `${p}HALTED at step ${int(r.halt.step)} (${how})`;
    }
    if (r.status === 'running' || r.status === 'paused') return `${p}run ${int(r.t)} / ${int(r.target)} · ${rate(r.rate)}${r.status === 'paused' ? ' · paused' : ''}`;
    return `${p}complete: ${int(r.t)} steps${r.elapsed ? ` in ${secs(r.elapsed)}` : ''} · not halted`;
  };
  segs.push(one(run, runB ? 'A' : ''));
  if (runB) segs.push(one(runB, 'B'));
  if (status.refining !== undefined && status.refining < 1) segs.push(`refining ${Math.floor(status.refining * 100)}% exact`);
  if (status.partial) segs.unshift('PARTIAL');
  return segs.join(' · ');
}
