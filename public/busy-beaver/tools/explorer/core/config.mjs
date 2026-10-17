// core/config.mjs (ENGINE): start configurations and the directed-head printer, byte-exact to tools/sim.py.
//
//   parseConfigText(text, {step, pos, vars})  = sim.Config.parse(text, step=, pos=, **vars)
//   siteTapeConfig(tape, machine)             = diagram.site_tape_config (vizref parse_initial_tape)
//   startConfig(startSpec, machine, s0)       StartSpec (core/types.mjs) -> Config, validated against the machine
//   dh(cfg, {rle, trim}) / dhCells(...)       = sim.Config.dh(rle=, trim=)
//
// A Config here is {tape:Uint8Array, head:int (index into tape), state:'A'..'Y'|'Z', dir:'L'|'R', step, lo}
// with pos = lo + head and hi = lo + tape.length - 1 (sim.Config). Errors are {code:'E_CONFIG', message}.
import { ERR, LIMITS } from './protocol.mjs';
import { STATES } from './machine.mjs';

function cerr(message) { return { code: ERR.CONFIG, message }; }
const q = (s) => JSON.stringify(s);

export function cfgPos(c) { return c.lo + c.head; }
export function cfgHi(c) { return c.lo + c.tape.length - 1; }
export function blankConfig(step = 0) { return { tape: new Uint8Array(1), head: 0, state: 'A', dir: 'R', step, lo: 0 }; }

// ------------------------------------------------------------------------------------------------
// Exponent expressions (sim.py _eval_expr: ints, names, unary +/-, + - * // % **, implicit 2n), Python semantics
// ------------------------------------------------------------------------------------------------

function pyFloorDiv(a, b) {
  let r = a / b;
  if (a % b !== 0n && ((a < 0n) !== (b < 0n))) r -= 1n;
  return r;
}
function pyMod(a, b) {
  let r = a % b;
  if (r !== 0n && ((r < 0n) !== (b < 0n))) r += b;
  return r;
}

function tokenizeExpr(src, expr) {
  const toks = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (/\s/.test(c)) { i++; continue; }
    let mo;
    if ((mo = /^[0-9](?:_?[0-9])*/.exec(src.slice(i)))) {
      const digits = mo[0].replace(/_/g, '');
      if (digits.length > 1 && digits[0] === '0' && /[1-9]/.test(digits)) throw cerr(`bad exponent expression ${q(expr)}`);
      toks.push({ k: 'int', v: BigInt(digits) });
      i += mo[0].length;
      if (i < src.length && /[A-Za-z_0-9]/.test(src[i])) throw cerr(`bad exponent expression ${q(expr)}`);
      continue;
    }
    if ((mo = /^[A-Za-z_][A-Za-z_0-9]*/.exec(src.slice(i)))) { toks.push({ k: 'name', v: mo[0] }); i += mo[0].length; continue; }
    const two = src.slice(i, i + 2);
    if (two === '**' || two === '//') { toks.push({ k: 'op', v: two }); i += 2; continue; }
    if ('+-*%()'.includes(c)) { toks.push({ k: 'op', v: c }); i++; continue; }
    if ('/^&|<>=!~@.,[]{}:'.includes(c)) { toks.push({ k: 'bad', v: c }); i++; continue; }
    throw cerr(`bad exponent expression ${q(expr)}`);
  }
  return toks;
}

/** Evaluate an integer exponent expression exactly like sim.py _eval_expr (BigInt). */
export function evalExpr(expr, bindings = {}) {
  const src = expr.replace(/(?<![A-Za-z_\d])(\d+)\s*(?=[A-Za-z_(])/g, '$1*');
  const toks = tokenizeExpr(src, expr);
  let p = 0;
  const peek = () => toks[p];
  const isOp = (v) => toks[p] && toks[p].k === 'op' && toks[p].v === v;
  let unsupported = false;
  function atom() {
    const t = toks[p];
    if (!t) throw cerr(`bad exponent expression ${q(expr)}`);
    if (t.k === 'int') { p++; return t.v; }
    if (t.k === 'name') {
      p++;
      if (!Object.prototype.hasOwnProperty.call(bindings, t.v)) throw cerr(`unbound variable ${q(t.v)} in exponent ${q(expr)}`);
      const v = bindings[t.v];
      if (typeof v === 'bigint') return v;
      if (typeof v !== 'number' || !Number.isInteger(v)) throw cerr(`variable ${q(t.v)} must be an int, got ${q(v)}`);
      return BigInt(v);
    }
    if (t.k === 'op' && t.v === '(') {
      p++;
      const v = sum();
      if (!isOp(')')) throw cerr(`bad exponent expression ${q(expr)}`);
      p++;
      return v;
    }
    if (t.k === 'bad') unsupported = true;
    throw cerr(`bad exponent expression ${q(expr)}`);
  }
  function power() {
    const a = atom();
    if (isOp('**')) {
      p++;
      const b = unary();
      if (b < 0n || b.toString(2).length > 20) throw cerr(`exponent power out of range in ${q(expr)}`);
      if ((a > 1n || a < -1n) && b > 64n) throw cerr(`exponent power out of range in ${q(expr)}`);
      return a ** b;
    }
    return a;
  }
  function unary() {
    if (isOp('-')) { p++; return -unary(); }
    if (isOp('+')) { p++; return unary(); }
    return power();
  }
  function term() {
    let a = unary();
    for (;;) {
      if (isOp('*')) { p++; a = a * unary(); }
      else if (isOp('//') || isOp('%')) {
        const op = toks[p].v; p++;
        const b = unary();
        if (b === 0n) throw cerr(`division by zero in exponent ${q(expr)}`);
        a = op === '//' ? pyFloorDiv(a, b) : pyMod(a, b);
      } else return a;
    }
  }
  function sum() {
    let a = term();
    for (;;) {
      if (isOp('+')) { p++; a = a + term(); }
      else if (isOp('-')) { p++; a = a - term(); }
      else return a;
    }
  }
  let v;
  try {
    v = sum();
  } catch (e) {
    if (unsupported && e && e.code === ERR.CONFIG && /bad exponent expression/.test(e.message)) {
      throw cerr(`unsupported syntax in exponent ${q(expr)}`);
    }
    throw e;
  }
  if (p !== toks.length) throw cerr(toks.some((t) => t.k === 'bad') ? `unsupported syntax in exponent ${q(expr)}` : `bad exponent expression ${q(expr)}`);
  return v;
}

function exponent(raw, bindings) {
  if (raw === undefined) return 1n;
  if (raw === 'inf') return null;
  if (/^[0-9]+$/.test(raw)) return BigInt(raw);
  if (/^[A-Za-z_][A-Za-z_0-9]*$/.test(raw)) return evalExpr(raw, bindings);
  if (raw.startsWith('(') && raw.endsWith(')')) return evalExpr(raw.slice(1, -1), bindings);
  throw cerr(`bad exponent ${q(raw)}`);
}

function stripParenSpaces(text) {
  let out = '', depth = 0;
  for (const ch of text) {
    if (ch === '(') depth++;
    else if (ch === ')') depth--;
    if (depth > 0 && /\s/.test(ch)) continue;
    out += ch;
  }
  if (depth) throw cerr(`unbalanced parentheses in ${q(text)}`);
  return out;
}

/** sim.Config.parse(text, step=, pos=, **vars). */
export function parseConfigText(text, { step = 0, pos = 0, vars = {}, maxCells = LIMITS.spanCap } = {}) {
  if (typeof text !== 'string') throw cerr('configuration must be a string');
  const toks = stripParenSpaces(text.replace(/∞/g, 'inf')).split(/\s+/).filter((x) => x.length);
  const left = [], right = [];
  let state = null, dirn = null, total = 0;
  const n = toks.length;
  for (let i = 0; i < n; i++) {
    const tok = toks[i];
    let mo = /^(?:<([A-Z])|([A-Z])>)$/.exec(tok);
    if (mo) {
      if (state !== null) throw cerr(`two state tokens in ${q(text)}`);
      if (mo[1]) { state = mo[1]; dirn = 'L'; } else { state = mo[2]; dirn = 'R'; }
      continue;
    }
    mo = /^(?:\(([0-9]+)\)|([0-9]+))(?:\^(.+))?$/s.exec(tok);
    if (!mo) throw cerr(`cannot parse token ${q(tok)} in ${q(text)}`);
    const block = Array.from(mo[1] ?? mo[2], (c) => c.charCodeAt(0) - 48);
    const count = exponent(mo[3], vars);
    if (count === null) {
      if (!(block.length === 1 && block[0] === 0)) throw cerr(`only 0^inf is supported as an infinite part, got ${q(tok)}`);
      if (!((i === 0 && state === null) || (i === n - 1 && state !== null))) throw cerr(`0^inf must be the first or last token in ${q(text)}`);
      continue;
    }
    if (count < 0n) throw cerr(`negative exponent in ${q(tok)} of ${q(text)}`);
    const cells = BigInt(block.length) * count;
    if (cells + BigInt(total) > BigInt(maxCells)) throw cerr(`configuration too large (more than ${maxCells} cells)`);
    total += Number(cells);
    const dst = state === null ? left : right;
    const c = Number(count);
    for (let r = 0; r < c; r++) for (const s of block) dst.push(s);
  }
  if (state === null) throw cerr(`no state token (<X or X>) in ${q(text)}`);
  let head;
  if (dirn === 'L') { if (!left.length) left.push(0); head = left.length - 1; }
  else { if (!right.length) right.push(0); head = left.length; }
  const tape = new Uint8Array(left.length + right.length);
  tape.set(left, 0); tape.set(right, left.length);
  return { tape, head, state, dir: dirn, step, lo: pos - head };
}

/** diagram.site_tape_config / vizref parse_initial_tape: digits < m are cells; a state letter (either case, < n)
 *  sets the state and puts the head on the next digit; everything else is ignored. */
export function siteTapeConfig(tape, machine, step = 0) {
  const raw = [];
  let state = 0, pos = 0;
  for (let i = 0; i < tape.length; i++) {
    const c = tape.charCodeAt(i);
    if (c >= 48 && c < 48 + machine.m) raw.push(c - 48);
    else if ((c >= 65 && c < 65 + machine.n) || (c >= 97 && c < 97 + machine.n)) { state = (c - 1) % 32; pos = raw.length; }
  }
  if (pos === raw.length) raw.push(0);
  return { tape: Uint8Array.from(raw), head: pos, state: STATES[state], dir: 'R', step, lo: 0 - pos };
}

/** StartSpec -> validated Config with step = s0. Throws {code:'E_CONFIG'}. */
export function startConfig(start, machine, s0 = 0) {
  if (!Number.isSafeInteger(s0) || s0 < 0) throw cerr(`bad start step ${q(s0)}`);
  const kind = start && start.kind;
  let cfg;
  if (!start || kind === 'blank') cfg = blankConfig(s0);
  else if (kind === 'site') {
    if (typeof start.tape !== 'string') throw cerr('site start needs a tape string');
    cfg = siteTapeConfig(start.tape, machine, s0);
  } else if (kind === 'config') {
    const pos = start.pos ?? 0;
    if (!Number.isSafeInteger(pos)) throw cerr(`bad start position ${q(pos)}`);
    cfg = parseConfigText(start.dh, { step: s0, pos, vars: start.vars || {} });
  } else throw cerr(`unknown start kind ${q(kind)}`);
  for (let i = 0; i < cfg.tape.length; i++) {
    if (cfg.tape[i] >= machine.m) throw cerr(`config uses symbols >= ${machine.m}`);
  }
  if (cfg.state === 'Z') throw cerr('cannot start in the halt state');
  const qi = STATES.indexOf(cfg.state);
  if (qi < 0 || qi >= machine.n) throw cerr(`no state ${q(cfg.state)} in a ${machine.n}-state machine`);
  if (cfg.lo < -LIMITS.spanCap || cfgHi(cfg) > LIMITS.spanCap) throw cerr('start position out of range');
  return cfg;
}

// ------------------------------------------------------------------------------------------------
// Directed-head printer (sim.Config.dh)
// ------------------------------------------------------------------------------------------------

function rleInto(out, cells, a, b, rle) {
  if (a >= b) return;
  if (!rle) {
    let s = '';
    for (let i = a; i < b; i++) s += String.fromCharCode(48 + cells[i]);
    out.push(s);
    return;
  }
  let i = a;
  while (i < b) {
    const s = cells[i];
    let j = i + 1;
    while (j < b && cells[j] === s) j++;
    out.push(j - i === 1 ? String(s) : `${s}^${j - i}`);
    i = j;
  }
}

/** dh of cells[a..b) with the head at index h (a <= h < b): sim.Config.dh(rle, trim) byte-exact. */
export function dhCells(cells, a, b, h, state, dir, { rle = true, trim = true } = {}) {
  let la = a, lb, ra, rb = b;
  let headTok;
  if (dir === 'R' || dir === 1) { lb = h; ra = h; headTok = `${state}>`; }
  else { lb = h + 1; ra = h + 1; headTok = `<${state}`; }
  if (trim) {
    while (la < lb && cells[la] === 0) la++;
    while (rb > ra && cells[rb - 1] === 0) rb--;
  }
  const out = ['0^inf'];
  rleInto(out, cells, la, lb, rle);
  out.push(headTok);
  rleInto(out, cells, ra, rb, rle);
  out.push('0^inf');
  return out.join(' ');
}

export function dh(cfg, opts = {}) {
  return dhCells(cfg.tape, 0, cfg.tape.length, cfg.head, cfg.state, cfg.dir, opts);
}
