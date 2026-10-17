// Exact site palettes plus explorer overlay colours (spec §9.3). Pure; node-testable.
// The symbol/head colours are BBD's own (tools/diagram.py CORE_JS), so exact-zoom pixels equal diagram.py.

export const SLATE = [0x1e, 0x29, 0x3b];
export const STATE_COLORS = [[255, 0, 0], [255, 128, 0], [0, 0, 255], [0, 255, 0], [255, 0, 255], [0, 255, 255], [255, 255, 0]];
export const STATE_COLOR_NAMES = ['red', 'orange', 'blue', 'green', 'magenta', 'cyan', 'yellow'];
export const BLAZE = {
  light: [[255, 255, 255], [255, 165, 0], [255, 255, 0], [255, 0, 255], [0, 255, 255]],
  dark: [[255, 255, 255], [0, 0, 0], [128, 128, 128], [64, 64, 64], [192, 192, 192]],
};
const BLAZE_NAMES = {
  light: ['white', 'orange', 'yellow', 'magenta', 'cyan'],
  dark: ['white', 'black', 'grey #808080', 'grey #404040', 'grey #c0c0c0'],
};
export const HEAD_R = [255, 0, 0], HEAD_L = [0, 255, 0];
/** Head colour while highlights / k-block channels are on (red/green/blue would read as a channel). */
export const HEAD_OVER = [255, 225, 0];
export const UNV_MARK = [0x4b, 0x3b, 0x6b];
export const HATCH_FG = [0x3a, 0x3a, 0x3a], HATCH_BG = [0x26, 0x26, 0x26];
export const PLACEHOLDER = [0x26, 0x26, 0x26];
export const HL_COLORS = [[0x3b, 0x82, 0xf6], [0xef, 0x44, 0x44], [0x22, 0xc5, 0x5e]];
export const HL_NAMES = ['blue', 'red', 'green'];
export const DIM_LO = [0x16, 0x16, 0x16], DIM_HI = [0x5a, 0x5a, 0x5a];
export const KB_MAIN = [0xd0, 0xd0, 0xd0], KB_ROT = [0x9a, 0x9a, 0x9a];
export const KB_COLORS = [[0x2f, 0x7b, 0xff], [0xff, 0x3b, 0x30], [0x34, 0xc7, 0x59], [0xff, 0x9f, 0x0a],
  [0xaf, 0x52, 0xde], [0x00, 0xc7, 0xbe], [0xff, 0x2d, 0x55], [0xa2, 0x84, 0x5e]];
export const KB_NAMES = ['blue', 'red', 'green', 'orange', 'purple', 'teal', 'pink', 'brown'];
export const BLK_COLOR = [0xff, 0x9f, 0x0a];
export const DIFF_AB = [0xff, 0x8c, 0x00], DIFF_BA = [0x00, 0xb7, 0xff];
// Transition head tint: categorical, indexed by q*m+s (cycled beyond 12).
export const TINT = [[0xe6, 0x19, 0x4b], [0x3c, 0xb4, 0x4b], [0xff, 0xe1, 0x19], [0x43, 0x63, 0xd8],
  [0xf5, 0x82, 0x31], [0x91, 0x1e, 0xb4], [0x46, 0xf0, 0xf0], [0xf0, 0x32, 0xe6],
  [0xbc, 0xf6, 0x0c], [0xfa, 0xbe, 0xbe], [0x00, 0x80, 0x80], [0x9a, 0x63, 0x24]];

export const STYLES = ['default', 'explore', 'blaze', 'blaze-dark'];
export const STYLE_NAMES = { default: 'Default', explore: 'Explore', blaze: 'Blaze', 'blaze-dark': 'Blaze dark' };

export function grey(k, m) { return Math.floor((255 / (m - 1)) * k); }

/** BBD style name + theme for a view style. */
export function bbdStyle(style) {
  if (style === 'blaze-dark') return { style: 'blaze', theme: 'dark' };
  if (style === 'blaze') return { style: 'blaze', theme: 'light' };
  return { style, theme: 'light' };
}

/** Opaque background the transparent BBD output is flattened over (blaze is already opaque). */
export function styleBg(style) {
  return style === 'explore' ? SLATE : style === 'default' ? [0, 0, 0] : (style === 'blaze-dark' ? BLAZE.dark[0] : BLAZE.light[0]);
}

/** Opaque colour of symbol k in a style (explore 0 = slate). */
export function symbolColor(style, k, m) {
  if (style === 'blaze' || style === 'blaze-dark') {
    const p = BLAZE[style === 'blaze-dark' ? 'dark' : 'light'];
    return k === 0 ? p[0] : p[1 + (k - 1) % (p.length - 1)];
  }
  if (style === 'explore' && k === 0) return SLATE;
  const g = grey(k, m);
  return [g, g, g];
}

/** Opaque colour of never-read cells. */
export function unvisitedColor(style) {
  if (style === 'blaze' || style === 'blaze-dark') return symbolColor(style, 0, 2);
  return style === 'explore' ? SLATE : [0, 0, 0];
}

export function symbolColorName(style, k, m) {
  if (style === 'blaze' || style === 'blaze-dark') {
    const t = style === 'blaze-dark' ? 'dark' : 'light', p = BLAZE_NAMES[t];
    return k === 0 ? p[0] : p[1 + (k - 1) % (p.length - 1)];
  }
  if (style === 'explore' && k === 0) return 'not drawn (slate)';
  const g = grey(k, m);
  if (g === 0) return 'black';
  if (g === 255) return 'white';
  const h = g.toString(16).padStart(2, '0');
  return `grey #${h}${h}${h}`;
}

export function css(rgb, a) {
  return a === undefined ? `rgb(${rgb[0]},${rgb[1]},${rgb[2]})` : `rgba(${rgb[0]},${rgb[1]},${rgb[2]},${a})`;
}

export function hexOf(rgb) { return '#' + rgb.map((v) => v.toString(16).padStart(2, '0')).join(''); }

export function stateLetter(q) { return q < 0 ? 'Z' : String.fromCharCode(65 + q); }

/** Explore head colour of state index q, or null (states beyond G get no head). */
export function stateColor(q) { return q >= 0 && q < STATE_COLORS.length ? STATE_COLORS[q] : null; }

/** Highlight intensity a in [0,1] for count c (spec §9.3). nmax = N - |W| + 1. */
export function hlIntensity(c, nmax, mode) {
  if (!(c > 0)) return 0;
  if (mode === 'any') return 1;
  if (mode === 'frac') return Math.min(1, c / Math.max(1, nmax));
  if (nmax <= 1) return 1;
  // floor 0.5: one occurrence in a px must stand out on the dimmed base (sparse #17 walls were faint at 0.3)
  return Math.min(1, 0.5 + 0.5 * Math.log2(1 + c) / Math.log2(1 + nmax));
}

/** Ticks for a numbered log ramp: 1, 4, 16, ..., nmax. */
export function rampTicks(nmax) {
  const t = [];
  for (let v = 1; v < nmax; v *= 4) t.push(v);
  if (!t.length || t[t.length - 1] !== nmax) t.push(nmax);
  return t;
}

/** Rotations of a word (k-block background): '10' -> ['10','01']. */
export function rotations(w) {
  const out = [];
  for (let i = 0; i < w.length; i++) {
    const r = w.slice(i) + w.slice(0, i);
    if (!out.includes(r)) out.push(r);
  }
  return out;
}

/** Colour assignment for k-block words: background word + rotations pale, others categorical by word value. */
export function kblockColors(k, m, bgWords) {
  const main = bgWords && bgWords.length ? bgWords[0] : null;
  const pale = new Map();
  if (main) {
    pale.set(main, KB_MAIN);
    for (const w of bgWords.slice(1)) pale.set(w, KB_ROT);
  }
  const map = new Map();
  let ci = 0;
  const total = m ** k;
  for (let v = 0; v < total; v++) {
    let s = '', x = v;
    for (let i = 0; i < k; i++) { s = String(x % m) + s; x = Math.floor(x / m); }
    if (pale.has(s)) map.set(s, { rgb: pale.get(s), bg: true });
    else map.set(s, { rgb: KB_COLORS[ci % KB_COLORS.length], name: KB_NAMES[ci % KB_NAMES.length], bg: false, idx: ci++ });
  }
  return map;
}
