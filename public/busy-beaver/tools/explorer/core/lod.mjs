// Zoom ladders, data levels, visible tiles, fit and 1:1 (spec §9.1-9.2). Pure; node-testable.
//
// Each axis has a ladder index z:  z >= 0: one unit = MAG[z] device px;  z < 0: one device px = 2^-z units.
// Space units are cells (frame-relative); time units are base rows of the current rows mode.
// Data level k = min(0, z). A tile covers 256 texels x 256 level rows; a texel is 2^-kx cells, a level row is
// base row R * 2^-kt.
import { MAG, TILE } from './protocol.mjs';

export const Z_MAX = MAG.length - 1;
export const Z_MIN = -44;
export const Z_EXACT = 6;                                       // MAG[6] = 8 px per cell (key `z`)

/** Device px per unit at ladder index z. */
export function ppu(z) { return z >= 0 ? MAG[Math.min(z, Z_MAX)] : 2 ** z; }

/** Units per device px (>= 1 only when z < 0). */
export function upp(z) { return z >= 0 ? 1 / MAG[Math.min(z, Z_MAX)] : 2 ** -z; }

export function clampZ(z) { return Math.max(Z_MIN, Math.min(Z_MAX, z | 0)); }

export function level(z) { return Math.min(0, z); }

/** Largest index z whose content (`units` units) fits into `px` device px. */
export function fitIndex(units, px) {
  units = Math.max(1, units);
  for (let z = Z_MAX; z >= 0; z--) if (units * MAG[z] <= px) return z;
  // z < 0: 2^z * units <= px  <=>  units / 2^-z <= px
  let z = -1;
  while (z > Z_MIN && units / 2 ** -z > px) z--;
  return z;
}

/** Index whose ppu is closest to (but not above) a target ppu; used to match axes for 1:1. */
export function indexForPpu(target) {
  if (target >= 1) {
    let best = 0;
    for (let z = 0; z <= Z_MAX; z++) if (MAG[z] <= target + 1e-9) best = z;
    return best;
  }
  return clampZ(Math.floor(Math.log2(target) + 1e-9));
}

/**
 * Viewport geometry for one axis: origin (device px of unit 0) is an integer, so tiles land on whole pixels.
 * @param {number} pos  first visible unit (left cell / top base row), may be fractional
 * @param {number} z    ladder index
 */
export function axis(pos, z, sizePx) {
  const p = ppu(z), k = level(z), per = 2 ** -k;      // units per texel/level row
  const origin = Math.round(-pos * p);
  // visible units [u0, u1)
  const u0 = -origin / p, u1 = (sizePx - origin) / p;
  // tile index range (each tile = TILE texels = TILE * per units)
  const span = TILE * per;
  const i0 = Math.floor(u0 / span), i1 = Math.floor((u1 - 1e-9) / span);
  return { z, k, ppu: p, per, origin, u0, u1, i0, i1, tilePx: TILE * per * p };
}

/** Device px -> unit (fractional) and back, for one axis. */
export function toUnit(ax, dev) { return (dev - ax.origin) / ax.ppu; }
export function toDev(ax, u) { return u * ax.ppu + ax.origin; }

/** The texel/level-row start unit containing unit u (floor-aligned at 0, so u=-1 is in [-per, -1]). */
export function texelStart(ax, u) { return Math.floor(u / ax.per) * ax.per; }

/** Visible tiles [ty, tx], centre-out, then one-screen margin when `margin` is set. */
export function visibleTiles(ax, at, opts = {}) {
  const out = [];
  const cy = (at.i0 + at.i1) / 2, cx = (ax.i0 + ax.i1) / 2;
  const tyMin = opts.tyMin ?? -Infinity, tyMax = opts.tyMax ?? Infinity;
  for (let ty = Math.max(at.i0, tyMin); ty <= Math.min(at.i1, tyMax); ty++)
    for (let tx = ax.i0; tx <= ax.i1; tx++) out.push([ty, tx]);
  out.sort((a, b) => (Math.abs(a[0] - cy) + Math.abs(a[1] - cx)) - (Math.abs(b[0] - cy) + Math.abs(b[1] - cx)));
  return out;
}

/** Zoom about a device anchor: returns the new first-visible unit so that the unit under `dev` stays put. */
export function zoomAbout(pos, zOld, zNew, dev) {
  const pOld = ppu(zOld), pNew = ppu(zNew);
  const originOld = Math.round(-pos * pOld);
  const u = (dev - originOld) / pOld;
  return u - dev / pNew;
}

/** Steps between rows for a time rows mode at level kt (base row spacing * 2^-kt). */
export function rowSpacing(rows, kt) {
  const per = 2 ** -Math.min(0, kt);
  if (rows.kind === 'auto') return per;
  if (rows.kind === 'every') return rows.k * per;
  return null;                                   // event rows: not evenly spaced
}

export function isTimeRows(rows) { return rows.kind === 'auto' || rows.kind === 'every'; }

/** Base row b -> absolute step for time rows (null for event rows). */
export function stepOfBase(rows, b) {
  if (rows.kind === 'auto') return b;
  if (rows.kind === 'every') return b * rows.k + (rows.o || 0);
  return null;
}

/** Absolute step -> base row (fractional) for time rows. */
export function baseOfStep(rows, step) {
  if (rows.kind === 'auto') return step;
  if (rows.kind === 'every') return (step - (rows.o || 0)) / rows.k;
  return null;
}

/** First base row that is a real row (>= s0) for time rows. */
export function firstBase(rows, s0) {
  if (rows.kind === 'auto') return s0;
  if (rows.kind === 'every') return Math.ceil((s0 - (rows.o || 0)) / rows.k);
  return 0;
}
