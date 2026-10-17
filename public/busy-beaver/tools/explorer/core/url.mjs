// URL hash <-> ViewState (spec §12). Pure; node-testable.
// Keys are written in the fixed order below and defaults are omitted. Unknown keys and invalid values fall
// back to the defaults and are reported as warnings (the UI shows them as a toast).
import { defaults, normRows, validPattern, isEventRows } from './viewstate.mjs';
import { compact, parseCount } from './fmt.mjs';
import { STYLES } from './palette.mjs';
import { stepOfBase, baseOfStep, ppu } from './lod.mjs';

export const KEY_ORDER = ['v', 'tm', 'steps', 'start', 'vars', 'pos', 's0', 'from', 'halt', 'rows', 't', 'x', 'zt', 'zx', 'sq',
  'frame', 'style', 'quirks', 'unv', 'grid', 'head', 'pool', 'hl', 'hlm', 'bg', 'pin', 'play', 'marks',
  'cmp', 'cmpstart', 'cmpview', 'follow', 'workers', 'engine', 'preset'];

const enc = (s) => encodeURIComponent(s).replace(/%2C/g, ',').replace(/%3A/g, ':').replace(/%40/g, '@').replace(/%2B/g, '+').replace(/%2F/g, '/');

function num(v) { return Number.isInteger(v) ? String(v) : String(Math.round(v * 100) / 100); }

/**
 * Text for a view position: the shortest decimal that decodes (via back) to exactly v, so a reloaded link restores
 * the identical view state. If no decimal of up to 17 significant digits does (only possible when back is not the
 * identity, e.g. a step of every-K rows decoded to a base row), the shortest one that keeps the device origin
 * Math.round(-v * ppu(z)) (the only use of a view position), so the same pixels are drawn.
 */
function exactPos(v, z, back = Number, shown = v) {
  if (Number.isInteger(shown) && back(String(shown)) === v) return String(shown);
  for (let p = 1; p <= 17; p++) {
    const s = String(Number(shown.toPrecision(p)));
    if (back(s) === v) return s;
  }
  if (z !== null && z !== undefined) {
    const q = ppu(z), want = Math.round(-v * q);
    for (let d = 0; d <= 15; d++) {
      const s = String(Number(shown.toFixed(d)));
      if (Math.round(-back(s) * q) === want) return s;
    }
  }
  return String(shown);
}

/** steps: compact ('1e9') only when it is exact, else the plain integer. */
function stepsText(n) {
  const c = compact(n).replace(/,/g, '_');
  return parseCount(c) === n ? c : String(n);
}

export function rowsToText(rows) {
  switch (rows.kind) {
    case 'auto': return 'auto';
    case 'every': return `every:${rows.k}${rows.o ? '+' + rows.o : ''}`;
    case 'records': return rows.side === 'LR' ? 'rec' : `rec:${rows.side}`;
    case 'state': return `st:${rows.q}${rows.dir ? ':' + rows.dir : ''}`;
    case 'trans': return `tr:${rows.tr}`;
  }
  return 'auto';
}

export function rowsFromText(s) {
  if (s === 'auto') return { kind: 'auto' };
  let mo;
  if ((mo = /^every:([0-9_e.,]+)(?:\+(\d+))?$/i.exec(s))) {
    const k = parseCount(mo[1]);
    return k ? normRows({ kind: 'every', k, o: mo[2] ? +mo[2] : 0 }) : null;
  }
  if (s === 'rec') return { kind: 'records', side: 'LR' };
  if ((mo = /^rec:(LR|L|R)$/.exec(s))) return { kind: 'records', side: mo[1] };
  if ((mo = /^st:([A-Y])(?::(L|R))?$/.exec(s))) return normRows({ kind: 'state', q: mo[1], dir: mo[2] });
  if ((mo = /^tr:([A-Y][0-9])$/.exec(s))) return { kind: 'trans', tr: mo[1] };
  return null;
}

/** Row position (base row) -> URL text: a step for time rows, '#i' for event rows. */
export function rowPosToText(rows, b, z) {
  if (isEventRows(rows)) return '#' + exactPos(b, z);
  // the URL holds the step; it must decode back to this base row
  return exactPos(b, z, (s) => baseOfStep(rows, Number(s)), stepOfBase(rows, b));
}

export function rowPosFromText(rows, s) {
  if (s.startsWith('#')) { const v = Number(s.slice(1)); return Number.isFinite(v) ? v : null; }
  const v = parseCount(s) ?? (Number.isFinite(Number(s)) ? Number(s) : null);
  if (v === null) return null;
  if (isEventRows(rows)) return v;
  return baseOfStep(rows, v);
}

function startToParts(start) {
  const p = {};
  if (!start || start.kind === 'blank') return p;
  if (start.kind === 'site') p.start = 'site:' + start.tape;
  else if (start.kind === 'config') {
    p.start = start.src && !start.inline ? start.src : 'dh:' + start.dh;
    if (start.vars && Object.keys(start.vars).length) p.vars = Object.entries(start.vars).map(([k, v]) => `${k}=${v}`).join(',');
    if (start.pos) p.pos = String(start.pos);
    if (start.from) p.from = String(start.from.step);
  }
  return p;
}

/** ViewState -> hash string (without '#'). opts.inline: inline '@path' starts as dh (Copy link). */
export function encode(vs, opts = {}) {
  const d = defaults(), parts = {};
  parts.v = '1';
  if (vs.tm) parts.tm = vs.tm;
  if (vs.steps !== d.steps) parts.steps = stepsText(vs.steps);
  let start = vs.start;
  if (opts.inline && start && start.kind === 'config' && start.src) start = { ...start, src: undefined };
  Object.assign(parts, startToParts(start));
  if (vs.s0) parts.s0 = String(vs.s0);
  if (vs.halt !== d.halt) parts.halt = vs.halt;
  if (vs.rows.kind !== 'auto') parts.rows = rowsToText(vs.rows);
  if (vs.t !== null) parts.t = rowPosToText(vs.rows, vs.t, vs.zt);
  if (vs.x !== null) parts.x = exactPos(vs.x, vs.zx);
  if (vs.zt !== null) parts.zt = String(vs.zt);
  if (vs.zx !== null) parts.zx = String(vs.zx);
  if (vs.sq) parts.sq = '1';
  if (vs.frame !== d.frame) parts.frame = vs.frame;
  if (vs.style !== d.style) parts.style = vs.style;
  if (vs.quirks) parts.quirks = '1';
  if (vs.unv) parts.unv = '1';
  if (!vs.grid) parts.grid = '0';
  if (vs.head !== d.head) parts.head = vs.head;
  if (vs.pool !== d.pool) parts.pool = vs.pool;
  if (vs.hl.length) parts.hl = vs.hl.join(',');
  if (vs.hlm !== d.hlm) parts.hlm = vs.hlm;
  if (vs.bg) parts.bg = `kb:${vs.bg.k}:${vs.bg.p}${Array.isArray(vs.bg.words) ? ':' + vs.bg.words.join('+') : ''}`;
  if (vs.pin) parts.pin = `${rowPosToText(vs.rows, vs.pin.t)},${num(vs.pin.x)}`;
  if (vs.play) parts.play = `${num(vs.play.t)}:${vs.play.speed}`;
  if (vs.marks.length) parts.marks = vs.marks.join(',');
  if (vs.cmp) {
    parts.cmp = vs.cmp.tm;
    const cs = vs.cmp.start;
    if (cs && cs !== 'same') parts.cmpstart = cs === 'blank' || cs.kind === 'blank' ? 'blank' : 'dh:' + cs.dh;
    if (vs.cmp.view !== 'side') parts.cmpview = vs.cmp.view;
  }
  if (!vs.follow) parts.follow = '0';
  if (vs.workers) parts.workers = String(vs.workers);
  if (vs.engine !== 'real') parts.engine = vs.engine;
  if (vs.preset) parts.preset = vs.preset;
  return KEY_ORDER.filter((k) => parts[k] !== undefined).map((k) => `${k}=${enc(parts[k])}`).join('&');
}

/** Split a hash into ordered [key, value] pairs (values decoded). */
export function parsePairs(hash) {
  const s = (hash || '').replace(/^#/, '');
  if (!s) return [];
  return s.split('&').filter(Boolean).map((kv) => {
    const i = kv.indexOf('=');
    const k = i < 0 ? kv : kv.slice(0, i), v = i < 0 ? '' : kv.slice(i + 1);
    let dv = v;
    try { dv = decodeURIComponent(v); } catch { /* keep raw */ }
    return [k, dv];
  });
}

/**
 * Hash -> {vs, warnings}. presets: {id: {hash}}; a preset's keys are applied first and explicit keys win.
 */
export function decode(hash, presets = {}) {
  const warnings = [];
  let pairs = parsePairs(hash);
  const pre = pairs.find(([k]) => k === 'preset');
  if (pre && presets[pre[1]]) {
    const explicit = new Set(pairs.map(([k]) => k));
    const pp = parsePairs(presets[pre[1]].hash).filter(([k]) => !explicit.has(k));
    pairs = [...pp, ...pairs];
  } else if (pre) warnings.push(`unknown preset ${pre[1]}`);
  const vs = defaults();
  const map = new Map(pairs);
  const bad = (k, v) => warnings.push(`ignored ${k}=${v}`);
  // rows first: t and pin depend on it
  if (map.has('rows')) { const r = rowsFromText(map.get('rows')); if (r) vs.rows = r; else bad('rows', map.get('rows')); }
  for (const [k, v] of pairs) {
    switch (k) {
      case 'v': if (v !== '1') bad(k, v); break;
      case 'tm': vs.tm = v.trim(); break;
      case 'steps': { const n = parseCount(v); if (n && n > 0) vs.steps = n; else bad(k, v); break; }
      case 'start': {
        if (v === 'blank') vs.start = { kind: 'blank' };
        else if (v.startsWith('site:')) vs.start = { kind: 'site', tape: v.slice(5) };
        else if (v.startsWith('dh:')) vs.start = { kind: 'config', dh: v.slice(3), ...(vs.start.kind === 'config' ? pickCfg(vs.start) : {}) };
        else if (v.startsWith('@')) vs.start = { kind: 'config', dh: '', src: v, ...(vs.start.kind === 'config' ? pickCfg(vs.start) : {}) };
        else bad(k, v);
        break;
      }
      case 'vars': case 'pos': case 'from': break;            // applied below
      case 's0': { const n = parseCount(v); if (n !== null && n >= 0) vs.s0 = n; else bad(k, v); break; }
      case 'halt': if (v === 'site' || v === 'sim') vs.halt = v; else bad(k, v); break;
      case 'rows': break;
      case 't': { const b = rowPosFromText(vs.rows, v); if (b !== null) vs.t = b; else bad(k, v); break; }
      case 'x': { const n = Number(v.replace(/−/, '-')); if (Number.isFinite(n)) vs.x = n; else bad(k, v); break; }
      case 'zt': case 'zx': { const n = Number(v); if (Number.isInteger(n)) vs[k] = n; else bad(k, v); break; }
      case 'sq': case 'quirks': case 'unv': case 'grid': case 'follow':
        if (v === '0' || v === '1') vs[k] = v === '1'; else bad(k, v); break;
      case 'frame': if (['abs', 'head', 'left', 'right'].includes(v)) vs.frame = v; else bad(k, v); break;
      case 'style': if (STYLES.includes(v)) vs.style = v; else bad(k, v); break;
      case 'head': if (v === 'style' || v === 'trans') vs.head = v; else bad(k, v); break;
      case 'pool': if (v === 'mean' || v === 'near') vs.pool = v; else bad(k, v); break;
      case 'hl': { const ps = v.split(',').filter(Boolean); const ok = ps.filter(validPattern); if (ok.length !== ps.length) bad(k, v); vs.hl = ok.slice(0, 3); break; }
      case 'hlm': if (['count', 'any', 'frac'].includes(v)) vs.hlm = v; else bad(k, v); break;
      case 'bg': {
        const mo = /^kb:(\d+):(\d+)(?::([0-9+]+))?$/.exec(v);
        if (mo && +mo[1] >= 1 && +mo[1] <= 4) vs.bg = { k: +mo[1], p: +mo[2] % +mo[1], words: mo[3] ? mo[3].split('+').filter((w) => w.length === +mo[1]) : 'auto' };
        else bad(k, v);
        break;
      }
      case 'pin': {
        const [a, b] = v.split(',');
        const t = a !== undefined ? rowPosFromText(vs.rows, a) : null, x = Number(b);
        if (t !== null && Number.isFinite(x)) vs.pin = { t, x }; else bad(k, v);
        break;
      }
      case 'play': {
        const [a, b] = v.split(':');
        const t = parseCount(a), sp = Number(b);
        if (t !== null && sp >= 1) vs.play = { t, speed: sp }; else bad(k, v);
        break;
      }
      case 'marks': { const ms = v.split(',').map(parseCount); if (ms.every((x) => x !== null)) vs.marks = ms; else bad(k, v); break; }
      case 'cmp': vs.cmp = { tm: v.trim(), start: 'same', view: 'side', ...(vs.cmp || {}), tm: v.trim() }; break;
      case 'cmpstart': case 'cmpview': break;
      case 'workers': { const n = Number(v); if (Number.isInteger(n) && n >= 1 && n <= 16) vs.workers = n; else bad(k, v); break; }
      case 'engine': if (['real', 'stub', 'mock'].includes(v)) vs.engine = v; else bad(k, v); break;
      case 'preset': vs.preset = v; break;
      default: warnings.push(`ignored unknown key ${k}`);
    }
  }
  if (vs.start.kind === 'config') {
    if (map.has('vars')) {
      const vars = {};
      let ok = true;
      for (const kv of map.get('vars').split(',').filter(Boolean)) {
        const mo = /^([a-z_][a-z0-9_]*)=(-?\d+)$/i.exec(kv);
        if (mo) vars[mo[1]] = +mo[2]; else ok = false;
      }
      if (!ok) bad('vars', map.get('vars'));
      if (Object.keys(vars).length) vs.start.vars = vars;
    }
    if (map.has('pos')) { const n = Number(map.get('pos')); if (Number.isInteger(n)) vs.start.pos = n; else bad('pos', map.get('pos')); }
    if (map.has('from')) { const n = parseCount(map.get('from')); if (n !== null) vs.start.from = { tm: vs.tm, step: n }; else bad('from', map.get('from')); }
  }
  if (vs.cmp) {
    if (map.has('cmpstart')) {
      const v = map.get('cmpstart');
      if (v === 'same' || v === 'blank') vs.cmp.start = v;
      else if (v.startsWith('dh:')) vs.cmp.start = { kind: 'config', dh: v.slice(3) };
      else bad('cmpstart', v);
    }
    if (map.has('cmpview')) { const v = map.get('cmpview'); if (v === 'side' || v === 'diff') vs.cmp.view = v; else bad('cmpview', v); }
  }
  return { vs, warnings };
}

function pickCfg(s) { const o = {}; for (const k of ['vars', 'pos', 'from']) if (s[k] !== undefined) o[k] = s[k]; return o; }

/**
 * A pasted bbchallenge URL (or plain text) in the TM field -> {tm, steps?, width?, ox?} or null if it is not a URL.
 * e.g. https://bbchallenge.org/1RB1LC_1RC1RB_1RD0LE_1LA1LD_1RZ0LA&s=10000&w=250&ox=0.8&status=halt
 */
export function fromBbchallengeURL(text) {
  const s = (text || '').trim();
  const mo = /^(?:https?:\/\/)?(?:www\.)?bbchallenge\.org\/(?:story\/)?([^?#\s]*)/i.exec(s);
  if (!mo) return null;
  const segs = mo[1].split('&');
  const out = { tm: decodeURIComponent(segs[0] || '').trim() };
  for (const kv of segs.slice(1)) {
    const [k, v] = kv.split('=');
    if (k === 's' && parseCount(v)) out.steps = parseCount(v);
    else if (k === 'w' && Number(v) > 0) out.width = Number(v);
    else if (k === 'ox' && Number.isFinite(Number(v))) out.ox = Number(v);
  }
  if (/^\d+$/.test(out.tm)) out.error = 'bbchallenge machine ids need the network; paste the machine code (e.g. 1RB1LC_...) instead';
  return out;
}

/** "Open on bbchallenge": https://bbchallenge.org/<tm>&s=<min(99999, rows)>&w=<cells>&ox=<-x0/w>. */
export function bbchallengeURL(tm, rowsShown, cellsVisible, x0) {
  const s = Math.max(1, Math.min(99999, Math.round(rowsShown)));
  const w = Math.max(1, Math.min(99999, Math.round(cellsVisible)));
  const ox = Math.round((-x0 / w) * 1e4) / 1e4;
  return `https://bbchallenge.org/${tm}&s=${s}&w=${w}&ox=${ox}`;
}
