// ViewState: the single source of truth for what is on screen (spec §12). Pure; node-testable.
import { LIMITS } from './protocol.mjs';
import { STYLES } from './palette.mjs';
import { clampZ } from './lod.mjs';

/** @returns {object} a fresh default ViewState (tm empty = pilot list opens). */
export function defaults() {
  return {
    v: 1, tm: '', start: { kind: 'blank' }, s0: 0, steps: LIMITS.defaultSteps, halt: 'site',
    rows: { kind: 'auto' }, frame: 'abs',
    t: null, x: null, zt: null, zx: null, sq: false,
    style: 'default', quirks: false, unv: false, grid: true, head: 'style', pool: 'mean',
    hl: [], hlm: 'count', bg: null,
    pin: null, play: null, marks: [],
    cmp: null, follow: true, workers: null, engine: 'real',
    preset: null,
  };
}

export function clone(vs) { return JSON.parse(JSON.stringify(vs)); }

const STATES = 'ABCDEFGHIJKLMNOPQRSTUVWXY';

/** Validate a RowsSpec; returns a normalised copy or null. */
export function normRows(r) {
  if (!r || typeof r !== 'object') return null;
  switch (r.kind) {
    case 'auto': return { kind: 'auto' };
    case 'every': {
      const k = Math.floor(Number(r.k)), o = Math.floor(Number(r.o || 0));
      if (!(k >= 1) || !Number.isFinite(k)) return null;
      const out = { kind: 'every', k };
      if (o > 0) out.o = ((o % k) + k) % k;
      if (k === 1) return { kind: 'auto' };
      return out;
    }
    case 'records': return ['LR', 'L', 'R'].includes(r.side) ? { kind: 'records', side: r.side } : null;
    case 'state': {
      if (typeof r.q !== 'string' || r.q.length !== 1 || !STATES.includes(r.q)) return null;
      const out = { kind: 'state', q: r.q };
      if (r.dir === 'L' || r.dir === 'R') out.dir = r.dir;
      return out;
    }
    case 'trans': return typeof r.tr === 'string' && /^[A-Y][0-9]$/.test(r.tr) ? { kind: 'trans', tr: r.tr } : null;
    default: return null;
  }
}

export function isEventRows(rows) { return rows.kind === 'records' || rows.kind === 'state' || rows.kind === 'trans'; }

/** Normalise a whole ViewState in place-ish (returns a new object) with a list of fixes made. */
export function normalize(vs, warn = () => {}) {
  const d = defaults(), o = { ...d, ...vs };
  if (typeof o.tm !== 'string') o.tm = '';
  if (!(o.steps >= 1)) { warn('steps'); o.steps = d.steps; }
  o.steps = Math.min(Math.floor(o.steps), 1e15);
  o.s0 = Number.isInteger(o.s0) && o.s0 >= 0 ? o.s0 : 0;
  if (!['site', 'sim'].includes(o.halt)) o.halt = 'site';
  const r = normRows(o.rows); if (!r) { warn('rows'); o.rows = { kind: 'auto' }; } else o.rows = r;
  if (!['abs', 'head', 'left', 'right'].includes(o.frame)) { warn('frame'); o.frame = 'abs'; }
  for (const k of ['t', 'x']) if (o[k] !== null && !Number.isFinite(o[k])) { warn(k); o[k] = null; }
  for (const k of ['zt', 'zx']) if (o[k] !== null) { if (!Number.isFinite(o[k])) { warn(k); o[k] = null; } else o[k] = clampZ(o[k]); }
  if (!STYLES.includes(o.style)) { warn('style'); o.style = 'default'; }
  for (const k of ['quirks', 'unv', 'grid', 'sq', 'follow']) o[k] = !!o[k];
  if (!['style', 'trans'].includes(o.head)) o.head = 'style';
  if (!['mean', 'near'].includes(o.pool)) o.pool = 'mean';
  if (!Array.isArray(o.hl)) o.hl = [];
  o.hl = o.hl.filter(validPattern).slice(0, LIMITS.maxPatterns);
  if (!['count', 'any', 'frac'].includes(o.hlm)) o.hlm = 'count';
  if (o.bg && !(o.bg.k >= 1 && o.bg.k <= LIMITS.maxBlockK)) { warn('bg'); o.bg = null; }
  if (o.bg) { o.bg = { k: o.bg.k | 0, p: ((o.bg.p | 0) % o.bg.k + o.bg.k) % o.bg.k, words: o.bg.words === 'auto' || !Array.isArray(o.bg.words) ? 'auto' : o.bg.words.filter((w) => /^[0-9]+$/.test(w) && w.length === o.bg.k) }; if (Array.isArray(o.bg.words) && !o.bg.words.length) o.bg.words = 'auto'; }
  if (!Array.isArray(o.marks)) o.marks = [];
  o.marks = o.marks.filter(Number.isFinite);
  if (o.pin && !(Number.isFinite(o.pin.t) && Number.isFinite(o.pin.x))) o.pin = null;
  if (o.play && !(Number.isFinite(o.play.t) && o.play.speed >= 1)) o.play = null;
  if (o.cmp && typeof o.cmp.tm !== 'string') o.cmp = null;
  if (o.cmp) o.cmp = { tm: o.cmp.tm, start: o.cmp.start || 'same', view: o.cmp.view === 'diff' ? 'diff' : 'side' };
  if (o.workers !== null && !(o.workers >= 1 && o.workers <= 16)) o.workers = null;
  if (!['real', 'stub', 'mock'].includes(o.engine)) o.engine = 'real';
  return o;
}

/** 'W' or 'W@k.p' with |W| <= 8 digits, k >= 1, 0 <= p < k. */
export function validPattern(p) {
  if (typeof p !== 'string') return false;
  const mo = /^([0-9]{1,8})(?:@(\d+)\.(\d+))?$/.exec(p);
  if (!mo) return false;
  if (mo[2] !== undefined) { const k = +mo[2], ph = +mo[3]; if (!(k >= 1 && ph < k)) return false; }
  return true;
}

export function parsePattern(p) {
  const mo = /^([0-9]{1,8})(?:@(\d+)\.(\d+))?$/.exec(p);
  if (!mo) return null;
  return { w: mo[1], k: mo[2] ? +mo[2] : 1, p: mo[3] ? +mo[3] : 0 };
}

/** Keys of a ViewState whose change means "new run" (machine/start/steps) -> pushState and re-open. */
export const RUN_KEYS = ['tm', 'start', 's0', 'steps'];
export const CMP_KEYS = ['cmp'];

export function sameJSON(a, b) { return JSON.stringify(a) === JSON.stringify(b); }
