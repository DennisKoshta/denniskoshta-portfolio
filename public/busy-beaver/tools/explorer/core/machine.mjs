// core/machine.mjs (ENGINE): parse and normalise TM text exactly like tools/sim.py `parse` after the site's
// trim + upper-case (tools/diagram.py `machine`). Pure and DOM-free.
//
//   parseMachine(text) -> Machine (core/types.mjs), throws {code:'E_PARSE', message}
//   n <= 25 states, 2 <= m <= 10 symbols; '---' = undefined (acts as 1RZ: write 1, move R, halt);
//   a next-state letter >= n is a halt state if it is 'Z' or 'H' (else an error), as in sim.py.
//   A bbchallenge URL (https://bbchallenge.org/<tm>&s=..&w=..) is accepted: last path component, query dropped.
import { ERR, LIMITS } from './protocol.mjs';

export const STATES = 'ABCDEFGHIJKLMNOPQRSTUVWXY';
export const N_UNDEF = -1;      // Machine.N value for '---'
export const N_HALT = -2;       // Machine.N value for a halt state (Z, or H beyond the states)

function perr(message) { return { code: ERR.PARSE, message }; }
const q = (s) => JSON.stringify(s);

/** Normalised machine text: trim, take the last path component of a URL, drop '&...'/'?...', upper-case. */
export function normaliseText(text) {
  let s = String(text ?? '').trim();
  if (s.includes('/')) { s = s.replace(/\/+$/, ''); s = s.slice(s.lastIndexOf('/') + 1); }
  const cut = s.search(/[&?#]/);
  if (cut >= 0) s = s.slice(0, cut);
  return s.trim().toUpperCase();
}

/** @returns {import('./types.mjs').Machine} */
export function parseMachine(text) {
  const t = normaliseText(text);
  const rows = t.split('_');
  const n = rows.length;
  if (n < 1 || n > LIMITS.maxStates) throw perr(`bad machine ${q(t)}: ${n} states (max ${LIMITS.maxStates})`);
  const width = rows[0].length;
  const m = width / 3;
  if (width % 3 || m < 2 || m > LIMITS.maxSymbols || rows.some((r) => r.length !== width)) {
    throw perr(`bad machine ${q(t)}: every state needs 3*m characters, 2 <= m <= ${LIMITS.maxSymbols}`);
  }
  const W = new Uint8Array(n * m), D = new Int8Array(n * m), N = new Int8Array(n * m);
  const names = new Array(n * m), acts = new Array(n * m);
  for (let qq = 0; qq < n; qq++) {
    for (let s = 0; s < m; s++) {
      const i = qq * m + s;
      const tr = rows[qq].slice(3 * s, 3 * s + 3);
      names[i] = STATES[qq] + s;
      acts[i] = tr;
      if (tr === '---') { W[i] = 1; D[i] = 1; N[i] = N_UNDEF; continue; }
      const mo = /^([0-9])([LR])([A-Z])$/.exec(tr);
      if (!mo) throw perr(`bad transition ${q(tr)} in ${q(t)}`);
      const w = +mo[1];
      if (w >= m) throw perr(`transition ${q(tr)} writes symbol ${w} in a ${m}-symbol machine`);
      let nx = mo[3].charCodeAt(0) - 65;
      if (nx >= n) {
        if (mo[3] !== 'Z' && mo[3] !== 'H') {
          throw perr(`transition ${q(tr)} goes to ${q(mo[3])}, not a state of ${q(t)} (halt: Z or ---)`);
        }
        nx = N_HALT;
      }
      W[i] = w; D[i] = mo[2] === 'R' ? 1 : -1; N[i] = nx;
    }
  }
  const reachable = new Array(n).fill(false);
  reachable[0] = true;
  const stack = [0];
  while (stack.length) {
    const a = stack.pop();
    for (let s = 0; s < m; s++) {
      const b = N[a * m + s];
      if (b >= 0 && !reachable[b]) { reachable[b] = true; stack.push(b); }
    }
  }
  return { text: t, n, m, W, D, N, names, acts, reachable };
}

/** {machine} or {error:{code,message}} without throwing. */
export function tryParseMachine(text) {
  try { return { machine: parseMachine(text) }; } catch (e) { return { error: e && e.code ? e : perr(String(e)) }; }
}

export function stateName(qq) { return qq < 0 ? 'Z' : STATES[qq]; }
export function stateIndex(machine, letter) {
  const i = STATES.indexOf(letter);
  return letter && letter.length === 1 && i >= 0 && i < machine.n ? i : -1;
}
/** 'C1' -> q*m+s, or -1 if not a transition of this machine. */
export function transIndex(machine, name) {
  const mo = /^([A-Y])([0-9])$/.exec(String(name || '').toUpperCase());
  if (!mo) return -1;
  const qq = mo[1].charCodeAt(0) - 65, s = +mo[2];
  return qq < machine.n && s < machine.m ? qq * machine.m + s : -1;
}
/** null | 'undefined' | 'halt-state' */
export function haltKind(machine, i) {
  const nx = machine.N[i];
  return nx === N_UNDEF ? 'undefined' : nx === N_HALT ? 'halt-state' : null;
}
export function transInfo(machine, i) { return i < 0 ? null : { tr: machine.names[i], act: machine.acts[i] }; }

/** Transitions where A and B act differently. Machines must share m; a state present in only one machine counts
 *  as all-'---' in the other. Returns {ok:true, diffs:[{i, tr, a, b}], mask:Uint8Array(nA*m)} or {ok:false, reason}. */
export function machineDiff(a, b) {
  if (a.m !== b.m) return { ok: false, reason: `different symbol counts (${a.m} vs ${b.m})` };
  const m = a.m, n = Math.max(a.n, b.n);
  const diffs = [], mask = new Uint8Array(a.n * m);
  for (let i = 0; i < n * m; i++) {
    const x = i < a.n * m ? a.acts[i] : '---', y = i < b.n * m ? b.acts[i] : '---';
    if (x !== y) {
      diffs.push({ i, tr: STATES[(i / m) | 0] + (i % m), a: x, b: y });
      if (i < a.n * m) mask[i] = 1;
    }
  }
  return { ok: true, diffs, mask };
}

/** Watch masks for event rows (engine-internal). state: transitions whose next state is X (moving dir if given);
 *  trans: the one transition. Halting transitions never enter a state. */
export function stateMask(machine, letter, dir) {
  const x = stateIndex(machine, letter);
  const mask = new Uint8Array(machine.n * machine.m);
  if (x < 0) return null;
  const want = dir === 'L' ? -1 : dir === 'R' ? 1 : 0;
  for (let i = 0; i < mask.length; i++) {
    if (machine.N[i] === x && (want === 0 || machine.D[i] === want)) mask[i] = 1;
  }
  return mask;
}
export function transMask(machine, name) {
  const i = transIndex(machine, name);
  if (i < 0) return null;
  const mask = new Uint8Array(machine.n * machine.m);
  mask[i] = 1;
  return mask;
}
