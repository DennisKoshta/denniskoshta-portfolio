// Tile painters (spec §9.3). Pure and DOM-free: data tile + style -> RGBA 256x256 (Uint8ClampedArray).
// paintExact = BBD.paint (tools/diagram.py CORE_JS, byte-identical to diagram.py render_rows) flattened over the
// style background, then explorer overlays. paintPooled/paintDiff implement the pooled and compare formulas.
import BBD from './bbd.mjs';
import { TILE, F_FRESH, F_NOHEAD, F_ABSENT, F_PENDING, UNREAD } from './protocol.mjs';
import { HEAD_OVER,
  bbdStyle, styleBg, symbolColor, unvisitedColor, HEAD_R, HEAD_L, STATE_COLORS, UNV_MARK, HATCH_FG, HATCH_BG,
  HL_COLORS, DIM_LO, DIM_HI, kblockColors, BLK_COLOR, DIFF_AB, DIFF_BA, TINT, hlIntensity,
} from './palette.mjs';
import { parsePattern } from './viewstate.mjs';

const N = TILE;

/** The fields of a view that change painted pixels (cache key part). */
export function paintKey(view) {
  return [view.style, view.quirks ? 1 : 0, view.unv ? 1 : 0, view.head, view.pool, view.hl.join(','), view.hlm,
    view.bg ? `${view.bg.k}.${view.bg.p}.${(view.bgWords || []).join('+')}` : '', view.diff ? 'diff' : ''].join('|');
}

function anchorOf(meta, b, frame) {
  return frame === 'head' ? meta[b + 3] : frame === 'left' ? meta[b + 4] : frame === 'right' ? meta[b + 5] : 0;
}

function definedRange(meta, b) {
  let lo = meta[b + 4], hi = meta[b + 5];
  const pos = meta[b + 3];
  if (meta[b + 2] & F_FRESH) { if (pos === lo) lo++; else if (pos === hi) hi--; }
  return [lo, hi];
}

/** Cell value at absolute p in row i of an exact tile, or -1 if not read / not stored. */
function exactCell(tile, i, p) {
  if (!tile) return -2;                                    // -2 = unknown (tile missing)
  const b = 8 * i, meta = tile.meta;
  const flags = meta[b + 2];
  if (flags & (F_ABSENT | F_PENDING)) return -2;
  const [d0, d1] = definedRange(meta, b);
  if (p < d0 || p > d1) return -1;
  const clo = meta[b + 6], len = meta[b + 7];
  if (p < clo || p >= clo + len) return -2;
  return tile.cells[tile.off[i] + p - clo];
}

function hatchRow(out, i, ty, tx, x0 = 0, x1 = N) {
  const o = i * N * 4, yy = ty * N + i;
  for (let x = x0; x < x1; x++) {
    const c = ((yy + tx * N + x) & 7) < 2 ? HATCH_FG : HATCH_BG, j = o + 4 * x;
    out[j] = c[0]; out[j + 1] = c[1]; out[j + 2] = c[2]; out[j + 3] = 255;
  }
}

function clearRow(out, i) { out.fill(0, i * N * 4, (i + 1) * N * 4); }

function put(out, j, c) { out[j] = c[0]; out[j + 1] = c[1]; out[j + 2] = c[2]; out[j + 3] = 255; }

function headColor(view, meta, b, next, i, m, over = false) {
  if (meta[b + 2] & F_NOHEAD) return null;
  if (view.head === 'trans') return next && next[i] >= 0 ? TINT[next[i] % TINT.length] : null;
  if (over && (view.style === 'default' || view.style === 'explore')) return HEAD_OVER;
  if (view.style === 'default') { const d = meta[b + 1]; return d > 0 ? HEAD_R : d < 0 ? HEAD_L : null; }
  if (view.style === 'explore') { const q = meta[b]; return q >= 0 && q < STATE_COLORS.length ? STATE_COLORS[q] : null; }
  return null;
}

function lerp(a, b, f) { return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f]; }

/** Screen blend of channels over a base colour: out = 1 - (1-base) * prod(1 - a_p * col_p). */
function screen(base, chans, out, j) {
  let r = 1 - base[0] / 255, g = 1 - base[1] / 255, bl = 1 - base[2] / 255;
  for (const [a, col] of chans) {
    if (a <= 0) continue;
    r *= 1 - a * col[0] / 255; g *= 1 - a * col[1] / 255; bl *= 1 - a * col[2] / 255;
  }
  out[j] = Math.round((1 - r) * 255); out[j + 1] = Math.round((1 - g) * 255); out[j + 2] = Math.round((1 - bl) * 255); out[j + 3] = 255;
}

/**
 * Exact tile -> RGBA. view: {style, frame, quirks, unv, head, hl, hlm, bg, bgWords, m}.
 * nb: {left, right} neighbouring exact tiles of the same band (for patterns/blocks crossing tile edges).
 * Without overlays the result equals diagram.py render_rows(transparent=False) for the tile's rows.
 */
export function paintExact(tile, view, out = new Uint8ClampedArray(N * N * 4), nb = {}) {
  const m = tile.m, meta = tile.meta, frame = view.frame;
  const { style: bs, theme } = bbdStyle(view.style);
  // "site quirks" are the Default trace's quirks (no row 0, no head on some fresh cells); the site's Explore and
  // Blaze views draw row 0 and every head, so the toggle only changes Default
  const quirks = !!view.quirks && view.style === 'default';
  const skipRow0 = quirks && tile.steps[0] === 0;
  BBD.paint(tile, bs, frame, N * tile.tx, N, 0, N, { head: true, siteExact: quirks, skipRow0, theme }, out);
  const bg = styleBg(view.style);
  if (view.style === 'default' || view.style === 'explore') {
    for (let j = 0; j < out.length; j += 4) if (out[j + 3] === 0) { out[j] = bg[0]; out[j + 1] = bg[1]; out[j + 2] = bg[2]; out[j + 3] = 255; }
  }
  const hl = (view.hl || []).map(parsePattern).filter(Boolean);
  const kb = view.bg && view.bgWords && view.bgWords.length ? view.bg : null;
  const kbMap = kb ? kblockColors(kb.k, m, view.bgWords) : null;
  const unvC = unvisitedColor(view.style);
  for (let i = 0; i < N; i++) {
    const b = 8 * i, flags = meta[b + 2], o = i * N * 4;
    if (flags & F_ABSENT) { hatchRow(out, i, tile.ty, tile.tx); continue; }
    if (flags & F_PENDING) { clearRow(out, i); continue; }
    if (skipRow0 && i === 0) continue;
    const anchor = anchorOf(meta, b, frame), p0 = anchor + N * tile.tx;
    const [d0, d1] = definedRange(meta, b);
    const cell = (p) => {
      if (p >= p0 && p < p0 + N) return exactCell(tile, i, p);
      if (p < p0) return nb.left ? exactCellFrame(nb.left, i, p, frame) : -2;
      return nb.right ? exactCellFrame(nb.right, i, p, frame) : -2;
    };
    // k-block colouring (exact): blocks [x, x+k), x ≡ p (mod k), absolute cells
    if (kb) {
      const k = kb.k;
      let x = p0 - (((p0 - kb.p) % k) + k) % k;
      for (; x < p0 + N; x += k) {
        let w = '', ok = true;
        for (let u = 0; u < k; u++) { const v = cell(x + u); if (v < 0) { ok = false; break; } w += v; }
        if (!ok) continue;
        const c = kbMap.get(w);
        if (!c) continue;
        let rgb = c.rgb;
        if (hl.length) rgb = lerp([0, 0, 0], rgb, 0.45);
        for (let u = 0; u < k; u++) { const xx = x + u - p0; if (xx >= 0 && xx < N) put(out, o + 4 * xx, rgb); }
      }
    }
    // highlights (exact): dimmed base + every cell inside an occurrence gets its channel at a = 1
    if (hl.length) {
      const chan = new Array(N).fill(null);
      hl.forEach((P, ci) => {
        const L = P.w.length;
        for (let x = p0 - L + 1; x < p0 + N; x++) {
          if (P.k > 1 && (((x - P.p) % P.k) + P.k) % P.k !== 0) continue;
          let ok = true;
          for (let u = 0; u < L; u++) { const v = cell(x + u); if (v < 0 || v !== P.w.charCodeAt(u) - 48) { ok = false; break; } }
          if (!ok) continue;
          for (let u = 0; u < L; u++) {
            const xx = x + u - p0;
            if (xx >= 0 && xx < N) (chan[xx] || (chan[xx] = [])).push([1, HL_COLORS[ci]]);
          }
        }
      });
      for (let xx = 0; xx < N; xx++) {
        const p = p0 + xx, j = o + 4 * xx;
        let base;
        if (kb) base = [out[j], out[j + 1], out[j + 2]];
        else {
          const v = p >= d0 && p <= d1 ? exactCell(tile, i, p) : -1;
          base = v >= 0 ? lerp(DIM_LO, DIM_HI, m > 1 ? v / (m - 1) : 0) : DIM_LO;
        }
        if (chan[xx]) screen(base, chan[xx], out, j); else put(out, j, base.map(Math.round));
      }
    }
    // mark never-read cells
    if (view.unv) {
      for (let xx = 0; xx < N; xx++) { const p = p0 + xx; if (p < d0 || p > d1) put(out, o + 4 * xx, UNV_MARK); }
    }
    // head (re-drawn after overlays; transition tint replaces the style colour)
    if (view.head === 'trans' || hl.length || view.bg || view.unv) {
      const hx = meta[b + 3] - p0;
      if (hx >= 0 && hx < N && !(flags & F_NOHEAD)) {
        let hc = headColor(view, meta, b, tile.next, i, m, !!(hl.length || view.bg));
        if (hc && quirks && view.head !== 'trans' && (flags & F_FRESH) && !BBD.siteHeadVisible(BBD.row(tile, i))) hc = null;
        if (hc) put(out, o + 4 * hx, hc);
      }
    }
  }
  return out;
}

function exactCellFrame(tile, i, p) { return exactCell(tile, i, p); }

/**
 * Pooled tile -> RGBA (one texel per pixel). view: {style, pool, head, hl, hlm, bg, unv, m}.
 */
export function paintPooled(tile, view, out = new Uint8ClampedArray(N * N * 4)) {
  const m = tile.m, cx = tile.cx, meta = tile.meta, P = tile.planes;
  const vis = P.vis, near = P.near, cnt = [];
  for (let k = 1; k < m; k++) cnt[k] = P['cnt:' + k];
  const st = view.style, blaze = st === 'blaze' || st === 'blaze-dark';
  const cols = []; for (let k = 0; k < m; k++) cols.push(symbolColor(st, k, m));
  const unv = view.unv ? UNV_MARK : unvisitedColor(st);
  const hls = (view.hl || []).map((p) => ({ P: parsePattern(p), plane: P['pat:' + p] })).filter((h) => h.P && h.plane);
  const blk = view.bg && view.blkKey ? P[view.blkKey] : null;
  const dimmed = hls.length > 0 || !!blk;
  const hlNmax = hls.map((x) => Math.max(1, cx - x.P.w.length + 1));
  const blkNmax = blk ? Math.max(1, Math.floor(cx / view.bg.k)) : 1;
  for (let i = 0; i < N; i++) {
    const b = 8 * i, flags = meta[b + 2], o = i * N * 4;
    if (flags & F_ABSENT) { hatchRow(out, i, tile.ty, tile.tx); continue; }
    if (flags & F_PENDING) { clearRow(out, i); continue; }
    for (let c = 0; c < N; c++) {
      const idx = i * N + c, j = o + 4 * c, V = vis[idx];
      if (dimmed) {
        // allocation-free form of screen(lerp(DIM_LO, DIM_HI, f), channels): same arithmetic, same bytes
        let s = 0;
        for (let k = 1; k < m; k++) s += k * cnt[k][idx];
        const f = m > 1 ? s / (cx * (m - 1)) : 0;
        let r = 1 - (DIM_LO[0] + (DIM_HI[0] - DIM_LO[0]) * f) / 255;
        let g = 1 - (DIM_LO[1] + (DIM_HI[1] - DIM_LO[1]) * f) / 255;
        let bl = 1 - (DIM_LO[2] + (DIM_HI[2] - DIM_LO[2]) * f) / 255;
        for (let h = 0; h < hls.length; h++) {
          const a = hlIntensity(hls[h].plane[idx], hlNmax[h], view.hlm);
          if (a <= 0) continue;
          const col = HL_COLORS[h];
          r *= 1 - a * col[0] / 255; g *= 1 - a * col[1] / 255; bl *= 1 - a * col[2] / 255;
        }
        if (blk) {
          const a = hlIntensity(blk[idx], blkNmax, 'count');
          if (a > 0) { r *= 1 - a * BLK_COLOR[0] / 255; g *= 1 - a * BLK_COLOR[1] / 255; bl *= 1 - a * BLK_COLOR[2] / 255; }
        }
        out[j] = Math.round((1 - r) * 255); out[j + 1] = Math.round((1 - g) * 255); out[j + 2] = Math.round((1 - bl) * 255); out[j + 3] = 255;
        continue;
      }
      if (view.pool === 'near') {
        const s = near[idx];
        put(out, j, s === UNREAD || s >= m ? unv : cols[s]);
        continue;
      }
      if (blaze) {
        // Blaze's encoder on exact counts: w_k = floor(255 n_k / N); RGB = floor((Σ w_k c_k + max(0, 255 - Σ w_k) c_0) / 255)
        let r = 0, g = 0, bl = 0, wsum = 0;
        for (let k = 1; k < m; k++) {
          const w = Math.floor(255 * cnt[k][idx] / cx);
          wsum += w; r += w * cols[k][0]; g += w * cols[k][1]; bl += w * cols[k][2];
        }
        const w0 = Math.max(0, 255 - wsum);
        if (view.unv && V < cx) {
          // unread share drawn in the mark colour instead of symbol 0
          const wu = Math.floor(255 * (cx - V) / cx), wz = Math.max(0, w0 - wu);
          r += wz * cols[0][0] + wu * unv[0]; g += wz * cols[0][1] + wu * unv[1]; bl += wz * cols[0][2] + wu * unv[2];
        } else { r += w0 * cols[0][0]; g += w0 * cols[0][1]; bl += w0 * cols[0][2]; }
        out[j] = Math.min(255, Math.floor(r / 255)); out[j + 1] = Math.min(255, Math.floor(g / 255)); out[j + 2] = Math.min(255, Math.floor(bl / 255)); out[j + 3] = 255;
        continue;
      }
      // mean (default / explore): floor((Σ_k n_k C_k + (N - vis) C_unv) / N)
      let n0 = V, r = 0, g = 0, bl = 0;
      for (let k = 1; k < m; k++) { const n = cnt[k][idx]; n0 -= n; r += n * cols[k][0]; g += n * cols[k][1]; bl += n * cols[k][2]; }
      r += n0 * cols[0][0] + (cx - V) * unv[0]; g += n0 * cols[0][1] + (cx - V) * unv[1]; bl += n0 * cols[0][2] + (cx - V) * unv[2];
      out[j] = Math.floor(r / cx); out[j + 1] = Math.floor(g / cx); out[j + 2] = Math.floor(bl / cx); out[j + 3] = 255;
    }
    // head texel
    const hc = tile.headCol ? tile.headCol[i] : -1;
    if (hc >= 0 && !(flags & F_NOHEAD)) {
      const col = dimmed && view.head !== 'trans' ? null : headColor(view, meta, b, tile.next, i, m);
      if (col && (!blaze || view.head === 'trans')) put(out, o + 4 * hc, col);
    }
  }
  return out;
}

/**
 * Compare diff at exact zoom: tiles A and B with the same key coordinates.
 * Equal cells in A's style at 30% contrast; A > B orange; B > A cyan; heads A red, B blue.
 */
export function paintDiff(tA, tB, view, out = new Uint8ClampedArray(N * N * 4)) {
  const m = Math.max(tA.m, tB.m), frame = view.frame, st = view.style;
  const bg = styleBg(st), unv = unvisitedColor(st);
  const cols = []; for (let k = 0; k < m; k++) cols.push(symbolColor(st, k, m));
  const fade = (c) => [Math.round(bg[0] + 0.3 * (c[0] - bg[0])), Math.round(bg[1] + 0.3 * (c[1] - bg[1])), Math.round(bg[2] + 0.3 * (c[2] - bg[2]))];
  const fcols = cols.map(fade), funv = fade(unv);
  for (let i = 0; i < N; i++) {
    const b = 8 * i, fa = tA.meta[b + 2], fb = tB.meta[b + 2], o = i * N * 4;
    if ((fa & F_ABSENT) && (fb & F_ABSENT)) { hatchRow(out, i, tA.ty, tA.tx); continue; }
    if ((fa & F_PENDING) || (fb & F_PENDING)) { clearRow(out, i); continue; }
    const pa0 = anchorOf(tA.meta, b, frame) + N * tA.tx, pb0 = anchorOf(tB.meta, b, frame) + N * tB.tx;
    for (let x = 0; x < N; x++) {
      const a = fa & F_ABSENT ? -1 : exactCell(tA, i, pa0 + x), bb = fb & F_ABSENT ? -1 : exactCell(tB, i, pb0 + x);
      const j = o + 4 * x;
      if (a < 0 && bb < 0) { put(out, j, funv); continue; }
      const va = a < 0 ? 0 : a, vb = bb < 0 ? 0 : bb;
      put(out, j, va === vb ? fcols[va] || funv : va > vb ? DIFF_AB : DIFF_BA);
    }
    if (!(fa & (F_NOHEAD | F_ABSENT))) { const hx = tA.meta[b + 3] - pa0; if (hx >= 0 && hx < N) put(out, o + 4 * hx, [255, 40, 40]); }
    if (!(fb & (F_NOHEAD | F_ABSENT))) { const hx = tB.meta[b + 3] - pb0; if (hx >= 0 && hx < N) put(out, o + 4 * hx, [60, 110, 255]); }
  }
  return out;
}

/** Row-level helpers used by hover/inspector on tile data. */
export function tileRow(tile, i) {
  const b = 8 * i, M = tile.meta;
  return { state: M[b], dir: M[b + 1], flags: M[b + 2], pos: M[b + 3], lo: M[b + 4], hi: M[b + 5], clo: M[b + 6], len: M[b + 7],
    step: tile.steps[i], ev: tile.ev ? tile.ev[i] : null, next: tile.next ? tile.next[i] : -1 };
}

export { exactCell, anchorOf, definedRange };
