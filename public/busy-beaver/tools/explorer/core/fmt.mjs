// Number formatting for labels, rulers and readouts (spec §10.3). Pure; node-testable.
// Integers: en-US grouping, U+2212 minus, always exact (never rounded). Powers of two >= 1024 may add (2^k).

export const MINUS = '−';

/** Exact grouped integer: 1234567 -> '1,234,567', -349 -> '−349'. Non-integers keep up to 1 decimal. */
export function int(n) {
  if (n === null || n === undefined || Number.isNaN(n)) return '?';
  if (!Number.isFinite(n)) return n > 0 ? '∞' : MINUS + '∞';
  const neg = n < 0;
  let a = Math.abs(n);
  let s;
  if (Number.isInteger(a)) {
    s = a <= Number.MAX_SAFE_INTEGER ? String(a) : BigInt(a).toString();
  } else {
    s = a.toFixed(1);
  }
  const [ip, fp] = s.split('.');
  const g = ip.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return (neg ? MINUS : '') + g + (fp !== undefined ? '.' + fp : '');
}

/** k if n is 2^k with k >= 10, else -1. */
export function log2Exact(n) {
  if (!(n >= 1024) || !Number.isInteger(n)) return -1;
  const k = Math.round(Math.log2(n));
  return 2 ** k === n ? k : -1;
}

/** ' (2^20)' for powers of two >= 1024, else ''. */
export function pow2(n) {
  const k = log2Exact(n);
  return k >= 0 ? ` (2^${k})` : '';
}

/** English ordinal suffix of an integer: 1st, 2nd, 3rd, 4th, 11th, 12th, 13th, 21st, 400,000th. */
export function ordinal(n) {
  const a = Math.abs(n) % 100, b = Math.abs(n) % 10;
  const suf = a >= 11 && a <= 13 ? 'th' : b === 1 ? 'st' : b === 2 ? 'nd' : b === 3 ? 'rd' : 'th';
  return int(n) + suf;
}

/** Plural helper: plural(1,'row') = '1 row', plural(3,'row') = '3 rows'. */
export function plural(n, word, pl) {
  return `${int(n)} ${n === 1 ? word : (pl || word + 's')}`;
}

/** Rate: 210 M steps/s, 3.4 k steps/s, 12 steps/s. */
export function rate(r) {
  if (!(r > 0)) return '0 steps/s';
  if (r >= 1e6) return `${r >= 1e8 ? Math.round(r / 1e6) : (r / 1e6).toFixed(1)} M steps/s`;
  if (r >= 1e3) return `${(r / 1e3).toFixed(1)} k steps/s`;
  return `${Math.round(r)} steps/s`;
}

/** One-decimal percentage without the % sign handled by caller: pct(0.946) = '94.6%'. */
export function pct(frac) {
  if (!Number.isFinite(frac)) return '?%';
  return `${(Math.round(frac * 1000) / 10).toFixed(1)}%`;
}

/** Compact count for buttons: 1e8 -> '1e8', 2.5e6 -> '2.5e6', 12992 -> '12,992'. */
export function compact(n) {
  if (!Number.isFinite(n)) return String(n);
  if (n >= 1e5) {
    const e = Math.floor(Math.log10(n)), m = n / 10 ** e;
    if (Math.abs(m - Math.round(m * 100) / 100) < 1e-9) return `${+(Math.round(m * 100) / 100)}e${e}`;
  }
  return int(n);
}

/** Seconds: 4.6 s, 120 ms. */
export function secs(s) {
  if (!Number.isFinite(s)) return '?';
  if (s < 1) return `${Math.round(s * 1000)} ms`;
  if (s < 120) return `${s.toFixed(1)} s`;
  return `${Math.floor(s / 60)} min ${Math.round(s % 60)} s`;
}

/** Parse a count: '1e9', '2.5e6', '1_000_000', '9,786,531', '12287' -> number; null if invalid. */
export function parseCount(text) {
  if (typeof text === 'number') return Number.isFinite(text) ? text : null;
  if (typeof text !== 'string') return null;
  const s = text.trim().replace(/[_,\s]/g, '').replace(/^−/, '-');
  if (!/^-?(\d+(\.\d*)?|\.\d+)(e\d+)?$/i.test(s)) return null;
  const v = Number(s);
  if (!Number.isFinite(v) || !Number.isInteger(v)) return null;
  return v;
}

/** Hex colour of an [r,g,b] triple. */
export function hex(rgb) {
  return '#' + rgb.slice(0, 3).map((v) => v.toString(16).padStart(2, '0')).join('');
}
