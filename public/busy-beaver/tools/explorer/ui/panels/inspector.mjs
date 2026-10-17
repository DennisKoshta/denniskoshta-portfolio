// Inspector: the pinned cell (else the hovered one): step, state, head, rules, the cell or texel counts,
// and the tape of that row as directed-head notation, run-length (sim.py dh) or repeated blocks.
import { h, btn, seg, toast, copyText } from '../dom.mjs';
import { int } from '../../core/fmt.mjs';
import { UNREAD } from '../../core/protocol.mjs';
import { isTimeRows, baseOfStep } from '../../core/lod.mjs';

/** Expand a dh string side into digits: '1 0 1^2 0^3' -> '101100' (null if too long). */
function expand(tokens, cap = 200000) {
  let s = '';
  for (const t of tokens) {
    const mo = /^(\d+)(?:\^(\d+))?$/.exec(t) || /^\((\d+)\)\^(\d+)$/.exec(t);
    if (!mo) return null;
    const n = mo[2] ? +mo[2] : 1;
    if (s.length + mo[1].length * n > cap) return null;
    s += mo[1].repeat(n);
  }
  return s;
}

/** Greedy repeated-block compression: '10101010 1110' -> '(10)^4 1^3 0'. */
export function compressDigits(d) {
  const out = [];
  let lit = '';
  const flush = () => { if (lit) { out.push(lit); lit = ''; } };
  let i = 0;
  while (i < d.length) {
    let best = null;
    for (let p = 1; p <= 16 && i + 2 * p <= d.length; p++) {
      const w = d.substr(i, p);
      if (p > 1 && /^(.)\1*$/.test(w)) continue;          // a run of one digit is period 1
      let r = 1;
      while (d.substr(i + r * p, p) === w) r++;
      const cover = r * p;
      if (r >= 2 && cover >= (p === 1 ? 3 : Math.max(4, 2 * p))) {
        const gain = cover - (p + 4);
        if (!best || gain > best.gain) best = { p, r, w, gain };
      }
    }
    if (best && best.gain > 0) {
      flush();
      out.push(best.p === 1 ? `${best.w}^${best.r}` : `(${best.w})^${best.r}`);
      i += best.p * best.r;
    } else { lit += d[i]; i++; }
  }
  flush();
  return out;
}

export function blocksOf(dh) {
  const toks = dh.split(/\s+/);
  const hi = toks.findIndex((t) => /^<[A-Z]$|^[A-Z]>$/.test(t));
  if (hi < 0) return dh;
  const L = expand(toks.slice(1, hi)), R = expand(toks.slice(hi + 1, toks.length - 1));
  if (L === null || R === null) return 'too long to compress here';
  return ['0^inf', ...compressDigits(L), toks[hi], ...compressDigits(R), '0^inf'].join(' ');
}

/**
 * Repeated-block text of the cells around `cell` (the probe's window), with the head token where the head is
 * (dh convention: 'B>' = state B reading the cell to its right). For long tapes, where the whole-tape blocks text
 * would be a wall of text. Returns {text, a, b}.
 */
export function blocksWindow(P, cell, radius = 40) {
  const a = Math.max(P.x0, P.lo, cell - radius), b = Math.min(P.x0 + P.cells.length - 1, P.hi, cell + radius);
  const dig = (x0, x1) => { let d = ''; for (let x = x0; x <= x1; x++) { const v = P.cells[x - P.x0]; d += v === UNREAD || v === undefined ? '0' : String(v); } return d; };
  const parts = [];
  if (a > P.lo) parts.push('…');
  if (!P.halted && P.pos >= a && P.pos <= b) {
    parts.push(...compressDigits(dig(a, P.pos - 1)), `${P.state}>`, ...compressDigits(dig(P.pos, b)));
  } else parts.push(...compressDigits(dig(a, b)));
  if (b < P.hi) parts.push('…');
  return { text: parts.join(' '), a, b };
}

export class Inspector {
  constructor(app) {
    this.app = app; this.el = h('div', { class: 'insp' }); this.mode = 'blocks'; this.key = '';
  }

  update() {
    const app = this.app, I = app.inspect, vs = app.store.get();
    const key = JSON.stringify([I && I.probe.step, I && I.cell, I && I.pinned, I && I.per, this.mode, !!vs.pin, I && I.counts && I.counts.vis]);
    if (key === this.key) return;
    this.key = key;
    this.el.replaceChildren();
    if (!I) { this.el.append(h('div', { class: 'note' }, 'Hover the diagram to inspect a row; click to pin a cell (Esc unpins).')); return; }
    const P = I.probe, M = app[I.which] && app[I.which].machine;
    const kv = h('div', { class: 'kv' });
    const add = (k, v) => kv.append(h('span', {}, k), h('span', {}, v));
    add(I.pinned ? 'pinned' : 'hover', I.which === 'B' ? 'machine B' : 'machine A');
    if (I.ev !== null && I.ev !== undefined && Number.isFinite(I.ev)) add('row', `#${int(I.ev)} (${vs.rows.kind === 'records' ? 'record' : vs.rows.kind === 'state' ? 'entry into ' + vs.rows.q : 'firing of ' + vs.rows.tr})`);
    add('step', int(P.step));
    add('state', P.halted ? 'halted' : `${P.state}${P.fresh ? ' (head on a new cell)' : ''}`);
    add('head', `cell ${int(P.pos)}${P.dir ? `, last move ${P.dir > 0 ? 'R' : 'L'}` : ''}`);
    add('span', `${int(P.lo)} … ${int(P.hi)} (${int(P.hi - P.lo + 1)} cells)`);
    if (P.prev) add('prev', `${P.prev.tr} → ${P.prev.act}`);
    if (P.next) add('next', `${P.next.tr} → ${P.next.act}`);
    if (I.per <= 1) {
      const v = P.cells[I.cell - P.x0];
      add('cell', `${int(I.cell)} = ${v === UNREAD || v === undefined ? 'never read' : v}`);
    } else if (I.counts) {
      const c = I.counts, m = M ? M.m : 2;
      const zeros = c.vis - c.cnt.reduce((a, b) => a + b, 0);
      add('pixel', `cells ${int(I.cell)} … ${int(I.cell + I.per - 1)}`);
      add('counts', `0: ${int(zeros)} · ` + c.cnt.map((n, k) => `${k + 1}: ${int(n)}`).join(' · ') + (c.vis < I.per ? ` · never read ${int(I.per - c.vis)}` : ''));
      for (const [p, n] of Object.entries(c.pats || {})) {
        const firsts = firstPositions(P, p, I.cell, I.cell + I.per - 1);
        add(p, `×${int(n)}${firsts.length ? ' at ' + firsts.map(int).join(', ') + (n > firsts.length ? ', …' : '') : ''}`);
      }
    }
    this.el.append(kv);
    // blocks of a long tape: a window around the inspected cell (the whole tape would be a wall of text)
    const long = P.hi - P.lo + 1 > 200;
    const win = this.mode === 'blocks' && long ? blocksWindow(P, I.cell) : null;
    const dhText = this.mode === 'exact' ? P.dhExact : this.mode === 'rle' ? P.dh : win ? win.text : blocksOf(P.dh);
    this.el.append(h('div', { class: 'rowc', style: { marginTop: '4px' } }, h('span', { class: 'note' }, win ? `cells ${int(win.a)} … ${int(win.b)}` : 'tape'),
      seg([['blocks', long ? 'blocks near' : 'blocks'], ['rle', 'run-length'], ['exact', 'exact span']], this.mode, (v) => { this.mode = v; this.key = ''; this.update(); })));
    this.el.append(h('div', { class: 'dh', title: 'directed-head notation: <X = state X reading the cell to its left, X> = reading the cell to its right' }, dhText));
    const S = app[I.which] && app[I.which].session;
    this.el.append(h('div', { class: 'rowc' },
      btn('Copy dh', async () => { await copyText(this.mode === 'exact' ? P.dhExact : P.dh); toast('tape copied'); }, { small: true }),
      btn('View from here', () => {
        const c = app.concrete();
        const b = isTimeRows(vs.rows) ? baseOfStep(vs.rows, P.step) : (I.ev ?? c.t);
        app.store.set({ ...c, t: b, follow: false });
      }, { small: true, title: 'make this row the top row (Start unchanged)' }),
      btn('Edit as start…', () => {
        // pos = the head's cell, so cell numbers stay those of the run it was taken from
        app.store.set({ start: { kind: 'config', dh: P.dhExact, pos: P.pos, from: { tm: vs.tm, step: P.step } }, s0: P.step, t: null, x: null, zt: null, zx: null, pin: null });
        toast(`constructed start = step ${int(P.step)}; steps keep their numbers`);
      }, { small: true, title: 'restart the run from this configuration (provenance kept in the label)' }),
      btn('Play from here', () => { app.stopPlay(); app.store.set({ play: { t: P.step, speed: vs.play ? vs.play.speed : 8 } }); app.preparePlayFrame().then(() => app.togglePlay(true)); }, { small: true }),
      btn('Exact zoom here', () => {
        // same as z: every step around this row's step, 8 px per cell, centred and pinned
        const anchor = vs.frame === 'head' ? P.pos : vs.frame === 'left' ? P.lo : vs.frame === 'right' ? P.hi : 0;
        app.openAt(I.which, P.step, I.cell - anchor, null);
      }, { small: true, title: 'z: this step at every step, 8 px per cell' })));
  }
}

function firstPositions(P, pat, a, b) {
  const mo = /^(\d+)(?:@(\d+)\.(\d+))?$/.exec(pat); if (!mo) return [];
  const W = mo[1], k = mo[2] ? +mo[2] : 1, ph = mo[3] ? +mo[3] : 0, out = [];
  for (let x = a; x <= b && out.length < 8; x++) {
    if (k > 1 && (((x - ph) % k) + k) % k) continue;
    let ok = true;
    for (let j = 0; j < W.length; j++) { const v = P.cells[x + j - P.x0]; if (v === undefined || v === UNREAD || v !== W.charCodeAt(j) - 48) { ok = false; break; } }
    if (ok) out.push(x);
  }
  return out;
}
