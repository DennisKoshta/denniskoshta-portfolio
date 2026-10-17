// core/compress.mjs (ENGINE): compressed-tape text for the inspector, a port of tools/compress.py `compress(cfg)`
// (method 'dp', K = 16, nested) and `CConfig.text()`. Output is byte-identical to compress.py (unit-tested on
// fixtures from tools/explorer/tests/gen_fixtures.py), e.g. #17's alternating background reads `10^32000`.
//
//   compressText(cells, a, b, h, state, dir)  cells[a..b) = the span, head at index h, dir 'L'|'R'|-1|+1
//   compressCfg(cfg)                          Config (core/config.mjs) -> text
//
// compress.py scores tokenisations with one big integer p*B2 + s*B1 + t; JS numbers would lose precision on large
// spans, so costs here are triples [p, s, t] compared lexicographically, which orders them identically.

export const DEFAULT_K = 16;
const MAX_NEST_TOKENS = 8;
const VIRTUAL_PENALTY = 2;

// ------------------------------------------------------------------------------------------------ runs
function runs(s, K) {
  const n = s.length, out = [];
  for (let k = 1; k <= Math.min(K, n >> 1); k++) {
    let a = -1;
    for (let j = 0; j <= n - k; j++) {
      const eq = j < n - k && s[j] === s[j + k];
      if (eq) { if (a < 0) a = j; continue; }
      if (a >= 0) {
        const b = j;
        if (b - a >= k) {
          const e = b + k;
          let covered = false;
          for (let d = 1; d < k && !covered; d++) {
            if (k % d !== 0) continue;
            let ok = true;
            for (let x = a; x < e - d; x++) if (s[x] !== s[x + d]) { ok = false; break; }
            covered = ok;
          }
          if (!covered) out.push([a, e, k]);
        }
        a = -1;
      }
    }
  }
  return dropBuried(out);
}

function bisectRight(arr, x) { let lo = 0, hi = arr.length; while (lo < hi) { const m = (lo + hi) >> 1; if (x < arr[m]) hi = m; else lo = m + 1; } return lo; }
function bisectLeft(arr, x) { let lo = 0, hi = arr.length; while (lo < hi) { const m = (lo + hi) >> 1; if (arr[m] < x) lo = m + 1; else hi = m; } return lo; }
function cmpTuple(a, b) { for (let i = 0; i < a.length; i++) { if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1; } return 0; }

function dropBuried(rs) {
  const big = rs.filter((r) => r[1] - r[0] >= Math.max(8, 6 * r[2])).sort(cmpTuple);
  if (!big.length) return rs;
  const starts = big.map((r) => r[0]);
  const keep = [];
  for (const r of rs) {
    const [a, e, k] = r;
    if (e - a >= Math.max(8, 6 * k)) { keep.push(r); continue; }
    const i = bisectRight(starts, a) - 1;
    let buried = false;
    for (const j of [i, i - 1, i - 2]) {
      if (j >= 0 && j < big.length) {
        const [a2, e2, k2] = big[j];
        if (k2 !== k && a2 + k2 <= a && e + k2 <= e2 && e2 - a2 >= 2 * (e - a)) { buried = true; break; }
      }
    }
    if (!buried) keep.push(r);
  }
  return keep;
}

// ------------------------------------------------------------------------------------------------ dp
const add3 = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const lt3 = (a, b) => a[0] !== b[0] ? a[0] < b[0] : a[1] !== b[1] ? a[1] < b[1] : a[2] < b[2];
const le3 = (a, b) => !lt3(b, a);

/** compress.py _dp_side: minimum-description-length tokenisation of s (head at index 0). -> [[Uint8Array word, count]] */
function dpSide(s, K, pad) {
  const n = s.length, nr = n - pad;
  if (nr <= 0) return [];
  const rs = runs(s, K);
  if (!rs.length) return [[s.subarray(0, nr), 1]];
  const runStarts = [...new Set(rs.map((r) => r[0]))].sort((x, y) => x - y);
  const cand = new Map();         // st -> Map(key -> [en, k])
  function addFrom(st, a, e, k) {
    const cmax = Math.floor((e - st) / k);
    if (cmax < 2) return [];
    let ends = new Set([st + cmax * k]);
    if (cmax >= 3) ends.add(st + (cmax - 1) * k);
    let j = bisectLeft(runStarts, st + 2 * k);
    const last = st + cmax * k;
    let cnt = 0;
    while (j < runStarts.length && runStarts[j] <= last && cnt < 64) {
      const qq = runStarts[j];
      if ((qq - st) % k === 0) ends.add(qq);
      cnt++; j++;
    }
    ends = [...ends].filter((en) => en <= nr + k - 1);
    if (st >= nr) return [];
    for (const en of ends) {
      let m = cand.get(st);
      if (!m) cand.set(st, (m = new Map()));
      m.set(en * 64 + k, [en, k]);
    }
    return ends;
  }
  const newEnds = new Set();
  for (const [a, e, k] of rs) {
    for (let st = a; st < Math.min(a + k, e - 2 * k + 1); st++) for (const en of addFrom(st, a, e, k)) newEnds.add(en);
  }
  newEnds.add(0);
  const starts2 = [...newEnds].sort((x, y) => x - y);
  for (const [a, e, k] of rs) {
    const lo = bisectLeft(starts2, a + k), hi = bisectRight(starts2, e - 2 * k);
    for (const st of starts2.slice(lo, hi)) addFrom(st, a, e, k);
  }
  const nodeSet = new Set([0, nr, n]);
  for (const [st, m] of cand) { nodeSet.add(st); for (const [en] of m.values()) nodeSet.add(en); }
  const nodes = [...nodeSet].sort((x, y) => x - y);
  const idx = new Map(nodes.map((p, i) => [p, i]));
  const N = nodes.length;
  const A = new Array(N), Bc = new Array(N), chA = new Array(N).fill(null), chB = new Array(N).fill(null);
  for (let i = 0; i < N; i++) { A[i] = [0, 0, 0]; Bc[i] = [0, 0, 0]; }
  for (let i = N - 2; i >= 0; i--) {
    const p = nodes[i];
    if (p >= nr) continue;
    const L = nodes[i + 1] - p;
    let best = add3([L + 1, L, 0], A[i + 1]);
    let ch = null;
    const cs = cand.get(p) ? [...cand.get(p).values()].sort((x, y) => x[1] - y[1] || y[0] - x[0]) : [];
    for (const [en, k] of cs) {
      const c = add3([k + 2 + (en > nr ? VIRTUAL_PENALTY : 0), 0, k], Bc[idx.get(en)]);
      if (le3(c, best)) { if (lt3(c, best) || ch === null) { best = c; ch = [en, k]; } }
    }
    Bc[i] = best; chB[i] = ch;
    const cont = add3([L, L, 0], A[i + 1]);
    if (lt3(cont, best)) { A[i] = cont; chA[i] = true; } else { A[i] = best; chA[i] = false; }
  }
  const out = [];
  let i = 0, open = false, litStart = 0;
  while (i < N - 1) {
    const p = nodes[i];
    if (p >= nr) break;
    if (open) {
      if (chA[i]) { i++; continue; }
      out.push([s.subarray(litStart, p), 1]);
      open = false;
    }
    const ch = chB[i];
    if (ch === null) { open = true; litStart = p; i++; continue; }
    const [en, k] = ch;
    out.push([s.subarray(p, p + k), (en - p) / k]);
    i = idx.get(en);
  }
  if (open) out.push([s.subarray(litStart, nr), 1]);
  return out;
}

// ------------------------------------------------------------------------------------------------ tokens
// token = [w, e]: w a digit string or an array of tokens (nested group); e an integer
const tokKey = (t) => (typeof t[0] === 'string' ? `${t[0]}^${t[1]}` : `(${t[0].map(tokKey).join(' ')})^${t[1]}`);
const wordKey = (w) => (typeof w === 'string' ? w : `(${w.map(tokKey).join(' ')})`);

function primitiveRoot(w) {
  const n = w.length;
  for (let d = 1; d < n; d++) if (n % d === 0 && w.slice(0, d).repeat(n / d) === w) return [w.slice(0, d), n / d];
  return [w, 1];
}

function mergeTokens(toks) {
  const out = [];
  for (let [w, e] of toks) {
    if (e === 0) continue;
    if (typeof w === 'string') {
      if (!w) continue;
      const [r, j] = primitiveRoot(w);
      if (j > 1 && e !== 1) { w = r; e = e * j; }
    }
    if (out.length) {
      const [pw, pe] = out[out.length - 1];
      if (wordKey(pw) === wordKey(w) && (pe !== 1 || e !== 1)) { out[out.length - 1] = [w, pe + e]; continue; }
      if (typeof w === 'string' && typeof pw === 'string' && pe === 1 && e === 1) { out[out.length - 1] = [pw + w, 1]; continue; }
    }
    out.push([w, e]);
  }
  return out;
}

function tokCost(t) {
  const [w, e] = t;
  if (typeof w === 'string') return w.length + (e === 1 ? 1 : 2);
  return w.reduce((a, u) => a + tokCost(u), 0) + 4;
}

function nest(toks0) {
  let toks = toks0.slice();
  if (toks.length > 4000) return toks;
  for (;;) {
    let best = null;
    const n = toks.length, keys = toks.map(tokKey);
    for (let m = 2; m <= MAX_NEST_TOKENS; m++) {
      let i = 0;
      while (i + 2 * m <= n) {
        if (keys[i] === keys[i + m] && seqEq(keys, i, i + m, m)) {
          let c = 2;
          while (i + (c + 1) * m <= n && seqEq(keys, i + c * m, i, m)) c++;
          let unit = 0;
          for (let x = i; x < i + m; x++) unit += tokCost(toks[x]);
          const saving = (c - 1) * unit - 4;
          if (saving > 0 && (best === null || saving > best[0])) best = [saving, i, m, c];
        }
        i++;
      }
    }
    if (best === null) return toks;
    const [, i, m, c] = best;
    toks = [...toks.slice(0, i), [toks.slice(i, i + m), c], ...toks.slice(i + c * m)];
  }
}
function seqEq(keys, a, b, m) { for (let x = 0; x < m; x++) if (keys[a + x] !== keys[b + x]) return false; return true; }

const DIG = (u8) => { let s = ''; for (let i = 0; i < u8.length; i++) s += String.fromCharCode(48 + u8[i]); return s; };

/** compress.py compress_side: side 'L' (head at the end) or 'R' (head at the start); cells in tape order. */
export function compressSide(cells, side, K = DEFAULT_K, nested = true) {
  let a = 0, b = cells.length;
  if (side === 'L') while (a < b && cells[a] === 0) a++;
  else while (b > a && cells[b - 1] === 0) b--;
  if (a >= b) return [];
  const padN = Math.max(1, K - 1), len = b - a;
  const s = new Uint8Array(len + padN);
  let raw;
  if (side === 'L') {
    for (let i = 0; i < len; i++) s[i] = cells[b - 1 - i];
    raw = dpSide(s, K, padN).reverse().map(([w, c]) => [DIG(w.slice().reverse()), c]);
  } else {
    s.set(cells.subarray(a, b), 0);
    raw = dpSide(s, K, padN).map(([w, c]) => [DIG(w), c]);
  }
  let toks = mergeTokens(raw);
  if (nested) toks = nest(toks);
  return toks;
}

function tokText(t) {
  const [w, e] = t;
  if (typeof w === 'string') return e === 1 ? w : `${w}^${e}`;
  return '(' + w.map(tokText).join(' ') + ')^' + e;
}

/** compress.py compress(cfg).text() for the span cells[a..b) with the head at index h. */
export function compressText(cells, a, b, h, state, dir) {
  const right = dir === 'R' || dir === 1;
  const span = cells.subarray(a, b), hh = h - a;
  const left = right ? span.subarray(0, hh) : span.subarray(0, hh + 1);
  const rest = right ? span.subarray(hh) : span.subarray(hh + 1);
  const L = compressSide(left, 'L').map(tokText), R = compressSide(rest, 'R').map(tokText);
  const head = right ? `${state}>` : `<${state}`;
  return ['0^inf', ...L, head, ...R, '0^inf'].join(' ');
}

export function compressCfg(cfg) { return compressText(cfg.tape, 0, cfg.tape.length, cfg.head, cfg.state, cfg.dir); }
