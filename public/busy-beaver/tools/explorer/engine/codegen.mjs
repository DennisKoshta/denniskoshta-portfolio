// engine/codegen.mjs (ENGINE): generated step functions (explorer-spec §8.2).
//
//   compile(machine, variant, mask?) -> fn(st, budget) -> steps executed
//     st: {tape:Uint8Array, h:int, q:int, cnt:Float64Array (count), ev:int (watch)}
//   variants:
//     'plain'  executes defined non-halting transitions until the budget runs out or it reads a cell >= m
//              (SENT = m: never read; GUARD = m+1: buffer end) or meets a halting transition (not executed).
//     'count'  as plain, plus per-transition firing counts added into st.cnt on exit.
//     'watch'  as plain, but a transition with mask[q*m+s] set executes, sets st.ev = q*m+s and exits.
// The caller (engine/sim.mjs) handles every exit: records, growth, halts (via its table stepOne).
// If `new Function` is unavailable (CSP), a table-driven fallback with identical semantics is used.
import { N_UNDEF } from '../core/machine.mjs';

const cache = new Map();
let useFallback = false;

export function genSource(M, variant, mask) {
  const { n, m, W, D, N } = M;
  const lines = [];
  const count = variant === 'count';
  lines.push('const tape = st.tape; let h = st.h, q = st.q, i = budget;');
  if (count) for (let k = 0; k < n * m; k++) if (N[k] >= 0) lines.push(`let c${k} = 0;`);
  lines.push('outer: for (; i > 0; i--) {', ' switch (q) {');
  for (let q = 0; q < n; q++) {
    lines.push(`  case ${q}: switch (tape[h]) {`);
    for (let s = 0; s < m; s++) {
      const k = q * m + s;
      if (N[k] < 0) { lines.push(`   case ${s}: break outer;`); continue; }
      const store = W[k] === s ? '' : `tape[h] = ${W[k]}; `;
      const mv = D[k] > 0 ? 'h++;' : 'h--;';
      const qs = N[k] === q ? '' : ` q = ${N[k]};`;
      if (variant === 'watch' && mask && mask[k]) {
        lines.push(`   case ${s}: ${store}${mv}${qs || ` q = ${N[k]};`} st.ev = ${k}; i--; break outer;`);
      } else {
        lines.push(`   case ${s}: ${store}${mv}${qs}${count ? ` c${k}++;` : ''} continue outer;`);
      }
    }
    lines.push('   default: break outer;', '  }');
  }
  lines.push('  default: break outer;', ' }', '}');
  if (count) {
    lines.push('const C = st.cnt;');
    for (let k = 0; k < n * m; k++) if (N[k] >= 0) lines.push(`C[${k}] += c${k};`);
  }
  lines.push('st.h = h; st.q = q; return budget - i;');
  return lines.join('\n');
}

/** Table-driven fallback (no code generation): same contract as the generated functions. */
export function tableFn(M, variant, mask) {
  const { n, m, W, D, N } = M;
  const S = m + 2;                      // row stride: symbols, SENT, GUARD
  const T = new Int32Array(n * S).fill(-1);
  for (let q = 0; q < n; q++) for (let s = 0; s < m; s++) {
    const k = q * m + s;
    if (N[k] < 0) continue;
    T[q * S + s] = (N[k] << 8) | ((D[k] > 0 ? 1 : 0) << 4) | W[k];
  }
  const watch = variant === 'watch' && mask ? mask : null;
  const count = variant === 'count';
  return function (st, budget) {
    const tape = st.tape;
    let h = st.h, q = st.q, i = budget;
    const C = st.cnt;
    for (; i > 0; i--) {
      const s = tape[h];
      const e = T[q * S + s];
      if (e < 0) break;
      const k = q * m + s;
      tape[h] = e & 15;
      h += (e & 16) ? 1 : -1;
      q = e >> 8;
      if (count) C[k] += 1;
      if (watch && watch[k]) { st.ev = k; i--; break; }
    }
    st.h = h; st.q = q;
    return budget - i;
  };
}

export function maskKey(mask) {
  if (!mask) return '';
  let s = '';
  for (let i = 0; i < mask.length; i++) if (mask[i]) s += i + ',';
  return s;
}

/** Compiled step function for (machine, variant, mask); cached per machine text + variant + mask. */
export function compile(M, variant = 'plain', mask = null) {
  const key = `${M.text}|${variant}|${variant === 'watch' ? maskKey(mask) : ''}`;
  let fn = cache.get(key);
  if (fn) return fn;
  if (!useFallback) {
    try {
      fn = new Function('st', 'budget', genSource(M, variant, mask));
    } catch (e) {
      useFallback = true;
    }
  }
  if (!fn) fn = tableFn(M, variant, mask);
  if (cache.size > 256) cache.clear();
  cache.set(key, fn);
  return fn;
}

/** For tests: force the table fallback on or off. */
export function setFallback(on) { useFallback = !!on; cache.clear(); }
export function usingFallback() { return useFallback; }
export { N_UNDEF };
