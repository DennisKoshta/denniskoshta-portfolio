// Main canvas: tile requests, paint queue, bitmap cache, compositing with progressive refinement (spec §9.4-9.6),
// overlays (playhead, veil, pin, hover, marks, divergence, grid) and pointer input.
import { TILE, F_ABSENT, F_PENDING, F_NOHEAD, UNREAD, MAG, LIMITS, tileKey } from '../core/protocol.mjs';
import { paintExact, paintPooled, paintDiff, paintKey, tileRow, exactCell, anchorOf } from '../core/paint.mjs';
import { axis, ppu, toUnit, stepOfBase, baseOfStep, isTimeRows } from '../core/lod.mjs';
import { PLACEHOLDER, HATCH_FG, HATCH_BG, styleBg, symbolColor, unvisitedColor, UNV_MARK, css } from '../core/palette.mjs';

const PAINT_BUDGET_MS = 4;
const OV_BAND = 64;                 // overview rows per band canvas
const DATA_MAX = 900;
const BMP_MAX = LIMITS.bitmapCacheCount * 2;

/** Draw an overview image (bands of rows) into the rectangle (x, y, w, h); the rows are spread evenly over h. */
export function drawBands(ctx, img, x, y, w, h) {
  const rows = img.rows;
  for (let bi = 0; bi < img.bands.length; bi++) {
    const r0 = bi * img.band, nr = Math.min(img.band, rows - r0);
    if (nr <= 0 || !img.bands[bi]) break;
    const ya = y + h * r0 / rows, yb = y + h * (r0 + nr) / rows;
    ctx.drawImage(img.bands[bi], 0, 0, img.cols, nr, x, ya, w, yb - ya);
  }
}

function mkCanvas(w, h) {
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(w, h);
  const c = document.createElement('canvas'); c.width = w; c.height = h; return c;
}

export class CanvasView {
  constructor(app, els) {
    this.app = app;
    this.el = els.view; this.base = els.base; this.over = els.over;
    this.bctx = this.base.getContext('2d', { alpha: false });
    this.octx = this.over.getContext('2d');
    this.W = 0; this.H = 0; this.dpr = window.devicePixelRatio || 1;
    this.data = new Map();          // tileKey -> {tile, final}
    this.bmps = new Map();          // dataKey -> {pk, cv, sig, ty, tx, kt, kx, final}
    this.queue = new Set();         // dataKeys needing paint
    this.req = { A: null, B: null }; this.lastTileAt = {};
    this.gen = 1; this.ver = 0;
    this.dirty = true; this.raf = 0;
    this.prevSig = null; this.curSig = null;
    this.anim = null;
    this.hover = null;              // {pane, dev:[x,y], u, b}
    this.drag = null;
    this.wheelAcc = { t: 0, x: 0, z: 0 };
    this.stats = { frames: 0, paints: 0, lastPaintMs: 0 };
    this.listeners();
    this.resizeObs();
  }

  // ------------------------------------------------------------------ sizing
  resizeObs() {
    const apply = (w, h) => {
      w = Math.max(1, Math.round(w)); h = Math.max(1, Math.round(h));
      if (w === this.W && h === this.H) return;
      this.W = w; this.H = h;
      for (const c of [this.base, this.over]) { c.width = w; c.height = h; }
      this.app.onResize();
      this.invalidate();
    };
    const ro = new ResizeObserver((entries) => {
      const e = entries[0];
      this.dpr = window.devicePixelRatio || 1;
      const cr = e.contentRect, ew = cr.width * this.dpr, eh = cr.height * this.dpr;
      const s = e.devicePixelContentBoxSize && e.devicePixelContentBoxSize[0];
      // device-pixel-content-box is exact (snapped) device px; it can disagree with css × dpr under emulated
      // device scale factors (headless tests), so only trust it when it is within a pixel or two of that.
      if (s && Math.abs(s.inlineSize - ew) <= 2 && Math.abs(s.blockSize - eh) <= 2) {
        apply(s.inlineSize, s.blockSize);
      } else {
        const r = this.el.getBoundingClientRect(); apply(r.width * this.dpr, r.height * this.dpr);
      }
    });
    try { ro.observe(this.el, { box: 'device-pixel-content-box' }); } catch { ro.observe(this.el); }
    const r = this.el.getBoundingClientRect();
    apply(r.width * this.dpr, r.height * this.dpr);
  }

  invalidate() { this.dirty = true; if (!this.raf) this.raf = requestAnimationFrame((ts) => this.frame(ts)); }

  // ------------------------------------------------------------------ tile requests
  /** Level signature: tiles of the same signature share geometry and paint semantics. */
  sigOf(sess, vp) {
    const vs = this.app.store.get();
    const patterns = vp.kx < 0 ? vs.hl.slice() : [];
    const blk = vp.kx < 0 && vs.bg && this.app.bgWords ? { k: vs.bg.k, p: vs.bg.p, words: this.app.bgWords } : null;
    return { sid: sess.sid, rows: vs.rows, frame: vs.frame, kt: vp.kt, kx: vp.kx, patterns, blk, halt: vs.halt };
  }

  /** Compute the request for each pane's session; call engine.tiles when the needed set changes. */
  request(vp) {
    const app = this.app, E = app.engine;
    if (!E || !vp) return;
    const diff = vp.diff;
    const want = [];
    if (vp.panes.length) for (const pane of vp.panes) want.push([pane.sess, pane]);
    if (diff && app.B && app.B.session) want.push(['B', vp.panes[0]]);
    const seen = new Set();
    for (const [which, pane] of want) {
      if (seen.has(which)) continue; seen.add(which);
      const S = app[which];
      if (!S || !S.session) continue;
      const base = this.sigOf(S.session, vp);
      const tiles = this.visibleTiles(vp, pane, 1);
      const missing = tiles.filter(([ty, tx]) => { const d = this.data.get(tileKey(base, ty, tx)); return !d || !d.final; });
      const baseSig = JSON.stringify(base);
      const out = this.req[which];
      const now = performance.now();
      // Keep the outstanding request while it still covers everything we need (tiles arriving only shrink the
      // missing set); re-request when the level changes, a new tile is needed, or nothing arrived for 3 s.
      if (out && out.baseSig === baseSig && missing.every(([ty, tx]) => out.set.has(`${ty},${tx}`))
          && (!missing.length || now - Math.max(out.t, this.lastTileAt[base.sid] || 0) < 3000)) continue;
      if (out) { try { out.handle.cancel(); } catch { /* closed */ } this.req[which] = null; }
      if (!missing.length) continue;
      const req = { ...base, gen: ++this.gen, tiles: missing };
      try {
        const handle = E.tiles(req, (key, tile, final) => this.onTile(key, tile, final));
        this.req[which] = { handle, baseSig, set: new Set(missing.map(([a, b]) => `${a},${b}`)), t: now };
      } catch (e) { if (e && e.code !== 'E_CLOSED') console.warn('tiles:', e); }
    }
  }

  onTile(key, tile, final) {
    this.lastTileAt[tile.sid] = performance.now();
    const prev = this.data.get(key);
    if (prev && prev.final && !final) return;
    this.data.delete(key);
    this.data.set(key, { tile, final, v: ++this.ver });
    if (this.data.size > DATA_MAX) {
      for (const k of this.data.keys()) { if (this.data.size <= DATA_MAX * 0.8) break; if (!this.isVisibleKey(k)) this.data.delete(k); }
    }
    this.queue.add(key);
    if (this.app.vp && this.app.vp.diff) this.queue.add('diff:' + key);
    this.invalidate();
  }

  isVisibleKey(k) { return this.visibleKeySet && this.visibleKeySet.has(k); }

  /** Tiles covering a pane (plus `margin` tiles around it), centre-out. */
  visibleTiles(vp, pane, margin = 0) {
    const ax = axis(vp.x, vp.zx, pane.w), at = axis(vp.t, vp.zt, vp.H);
    const out = [];
    const cy = (at.i0 + at.i1) / 2, cx = (ax.i0 + ax.i1) / 2;
    const ty0 = Math.max(at.i0 - margin, vp.tyMin ?? -Infinity), ty1 = Math.min(at.i1 + margin, vp.tyMax ?? Infinity);
    for (let ty = ty0; ty <= ty1; ty++) for (let tx = ax.i0 - margin; tx <= ax.i1 + margin; tx++) out.push([ty, tx]);
    const inView = (ty, tx) => ty >= at.i0 && ty <= at.i1 && tx >= ax.i0 && tx <= ax.i1;
    out.sort((a, b) => (inView(b[0], b[1]) - inView(a[0], a[1])) || ((Math.abs(a[0] - cy) + Math.abs(a[1] - cx)) - (Math.abs(b[0] - cy) + Math.abs(b[1] - cx))));
    if (out.length > 160) out.length = 160;
    return out;
  }

  // ------------------------------------------------------------------ painting
  paintView() {
    const vs = this.app.store.get(), m = this.app.A && this.app.A.machine ? this.app.A.machine.m : 2;
    const v = { style: vs.style, frame: vs.frame, quirks: vs.quirks, unv: vs.unv, head: vs.head, pool: vs.pool, hl: vs.hl, hlm: vs.hlm,
      bg: vs.bg, bgWords: vs.bg ? this.app.bgWords : null, m, diff: !!(this.app.vp && this.app.vp.diff) };
    if (vs.bg && this.app.bgWords && this.app.vp && this.app.vp.kx < 0) v.blkKey = `blk:${vs.bg.k}.${vs.bg.p}.${this.app.bgWords.join('+')}`;
    return v;
  }

  drainPaint(deadline) {
    if (!this.queue.size) return;
    const view = this.paintView(), pk = paintKey(view);
    for (const key of this.queue) {
      if (performance.now() > deadline) break;
      this.queue.delete(key);
      if (key.startsWith('diff:')) continue;        // diff bitmaps are painted lazily in draw()
      const d = this.data.get(key);
      if (!d) continue;
      if (this.visibleKeySet && !this.visibleKeySet.has(key)) continue;
      this.paintOne(key, d, view, pk);
    }
  }

  /** Exact tiles with highlights or k-blocks read up to |W| - 1 cells of the neighbouring tiles (spec §9.3): the
   *  bitmap depends on which neighbours were there. Stamp = their data versions ('' when no overlay needs them). */
  nbStamp(key, view) {
    if (!(view.hl.length || view.bg)) return '';
    const L = this.data.get(key.replace(/\|(-?\d+),(-?\d+)$/, (_, a, b) => `|${a},${+b - 1}`));
    const R = this.data.get(key.replace(/\|(-?\d+),(-?\d+)$/, (_, a, b) => `|${a},${+b + 1}`));
    return `${L ? L.v : 0}:${R ? R.v : 0}`;
  }

  paintOne(key, d, view, pk) {
    const t0 = performance.now();
    const T = d.tile;
    const out = new Uint8ClampedArray(TILE * TILE * 4);
    let nbs = '';
    if (T.kind === 'exact') {
      const nb = {};
      if (view.hl.length || view.bg) {
        const L = this.data.get(key.replace(/\|(-?\d+),(-?\d+)$/, (_, a, b) => `|${a},${+b - 1}`));
        const R = this.data.get(key.replace(/\|(-?\d+),(-?\d+)$/, (_, a, b) => `|${a},${+b + 1}`));
        if (L) nb.left = L.tile; if (R) nb.right = R.tile;
        nbs = `${L ? L.v : 0}:${R ? R.v : 0}`;
      }
      paintExact(T, view, out, nb);
    } else paintPooled(T, view, out);
    const bm = this.putBitmap(key, out, pk, T, d.final);
    bm.v = d.v; bm.nb = nbs;
    this.stats.paints++; this.stats.lastPaintMs = performance.now() - t0;
  }

  putBitmap(key, rgba, pk, T, final) {
    let bm = this.bmps.get(key);
    let cv = bm ? bm.cv : mkCanvas(TILE, TILE);
    cv.getContext('2d').putImageData(new ImageData(rgba, TILE, TILE), 0, 0);
    this.bmps.delete(key);
    this.bmps.set(key, { pk, cv, ty: T.ty, tx: T.tx, kt: T.kt, kx: T.kind === 'exact' ? 0 : T.kx, final, sig: key.replace(/\|(-?\d+),(-?\d+)$/, '') });
    if (this.bmps.size > BMP_MAX) {
      for (const k of this.bmps.keys()) { if (this.bmps.size <= BMP_MAX * 0.85) break; if (!this.visibleKeySet || !this.visibleKeySet.has(k)) this.bmps.delete(k); }
    }
    return this.bmps.get(key);
  }

  /** Restyle: every visible tile with data is repainted (old bitmaps stay as placeholders meanwhile). */
  restyle() {
    for (const k of this.data.keys()) this.queue.add(k);
    this.invalidate();
  }

  // ------------------------------------------------------------------ frame
  frame(ts) {
    this.raf = 0;
    const app = this.app, vp = app.vp;
    if (!vp) return;
    this.stats.frames++;
    const deadline = performance.now() + PAINT_BUDGET_MS;
    // animation
    let anim = null;
    if (this.anim) {
      const f = Math.min(1, (performance.now() - this.anim.start) / this.anim.dur);
      if (f >= 1) this.anim = null; else anim = { ...this.anim, f: 1 - (1 - f) * (1 - f) };
    }
    this.drainPaint(deadline);
    this.draw(vp, anim);
    this.drawOverlay(vp, anim);
    app.afterFrame();
    if (this.queue.size || this.anim) this.invalidate();
  }

  /** Current affine for a pane: unit -> device. During a zoom animation, interpolate around the anchor. */
  affine(vp, pane, anim) {
    const ax = axis(vp.x, vp.zx, pane.w), at = axis(vp.t, vp.zt, vp.H);
    let px = ax.ppu, ox = ax.origin, py = at.ppu, oy = at.origin;
    if (anim) {
      const f = anim.f;
      const lerpLog = (a, b) => Math.exp(Math.log(a) + (Math.log(b) - Math.log(a)) * f);
      const [adx, ady] = anim.anchor;
      const ux = (adx - anim.from.ox) / anim.from.px, uy = (ady - anim.from.oy) / anim.from.py;
      const ux2 = (adx - ox) / px, uy2 = (ady - oy) / py;
      const npx = lerpLog(anim.from.px, px), npy = lerpLog(anim.from.py, py);
      const uxa = ux + (ux2 - ux) * f, uya = uy + (uy2 - uy) * f;
      ox = adx - uxa * npx; oy = ady - uya * npy; px = npx; py = npy;
    }
    return { ax, at, px, ox: ox + pane.x0, py, oy };
  }

  startZoomAnim(vpOld, anchorDev) {
    if (!vpOld || !vpOld.panes.length) return;
    const pane = vpOld.panes[0];
    const ax = axis(vpOld.x, vpOld.zx, pane.w), at = axis(vpOld.t, vpOld.zt, vpOld.H);
    this.anim = { from: { px: ax.ppu, ox: ax.origin, py: at.ppu, oy: at.origin }, anchor: anchorDev || [pane.w / 2, vpOld.H / 2], start: performance.now(), dur: 130 };
  }

  draw(vp, anim) {
    const ctx = this.bctx, app = this.app;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.imageSmoothingEnabled = false;
    ctx.fillStyle = css(PLACEHOLDER);
    ctx.fillRect(0, 0, this.W, this.H);
    const view = this.paintView(), pk = paintKey(view);
    const vis = new Set();
    let total = 0, ready = 0;
    for (const pane of vp.panes) {
      const S = app[pane.sess];
      if (!S || !S.session) continue;
      const A = this.affine(vp, pane, anim);
      ctx.save();
      ctx.beginPath(); ctx.rect(pane.x0, 0, pane.w, this.H); ctx.clip();
      this.drawOverview(ctx, vp, S, A);
      const base = this.sigOf(S.session, vp);
      const sigStr = tileKey(base, 0, 0).replace(/\|0,0$/, '');
      // fallback: bitmaps of other signatures of this session (previous level), drawn scaled
      if (this.prevSig && this.prevSig !== sigStr) this.drawSig(ctx, vp, A, this.prevSig, pane);
      const tiles = this.visibleTiles(vp, pane, 0);
      for (const [ty, tx] of tiles) {
        const key = tileKey(base, ty, tx);
        vis.add(key);
        total++;
        const d = this.data.get(key);
        let bkey = key;
        if (vp.diff && pane.sess === 'A' && app.B && app.B.session) {
          const keyB = tileKey({ ...base, sid: app.B.session.sid }, ty, tx);
          vis.add(keyB);
          const dB = this.data.get(keyB);
          bkey = key + '&' + keyB;
          if (d && dB && d.tile.kind === 'exact' && dB.tile.kind === 'exact') {
            const bm = this.bmps.get(bkey), stamp = `${d.v}:${dB.v}`;
            if (!bm || bm.pk !== pk || bm.stamp !== stamp) {
              const out = paintDiff(d.tile, dB.tile, view);
              this.putBitmap(bkey, out, pk, d.tile, d.final && dB.final).stamp = stamp;
            }
          } else bkey = key;
        }
        const bm = this.bmps.get(bkey);
        if (bm) {
          this.blitTile(ctx, A, vp, bm, ty, tx);
          // stale when its data changed, or (exact + overlays) when a neighbour arrived or changed since its paint
          const fresh = bkey !== key || (bm.v === (d && d.v) && (bm.kx !== 0 || (bm.nb || '') === this.nbStamp(key, view)));
          if (bm.pk === pk && d && d.final && fresh) ready++;
          else if (d && (bm.pk !== pk || !fresh)) this.queue.add(key);
        } else if (d) this.queue.add(key);
      }
      // rows before the first row: hatched (no tiles are requested there)
      if (vp.tyMin !== undefined) {
        const yTop = Math.round(vp.tyMin * TILE * 2 ** -vp.kt * A.py + A.oy);
        if (yTop > 0) { ctx.fillStyle = this.hatchPattern(ctx); ctx.fillRect(pane.x0, 0, pane.w, Math.min(this.H, yTop)); }
      }
      ctx.restore();
      this.curSig = sigStr;
    }
    this.visibleKeySet = vis;
    this.refining = total ? ready / total : 1;
    this.allFinal = total > 0 && ready === total;
    if (vp.panes.length === 2) {
      ctx.fillStyle = '#000';
      const p = vp.panes[1];
      ctx.fillRect(p.x0 - vp.gap, 0, vp.gap, this.H);
    }
  }

  hatchPattern(ctx) {
    if (!this._hatch) {
      const c = mkCanvas(8, 8), g = c.getContext('2d');
      for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) { g.fillStyle = ((x + y) & 7) < 2 ? css(HATCH_FG) : css(HATCH_BG); g.fillRect(x, y, 1, 1); }
      this._hatch = ctx.createPattern(c, 'repeat');
    }
    return this._hatch;
  }

  /** Drop data and bitmaps of a closed session (and never use them as placeholders). */
  forgetSession(sid) {
    const pre = sid + '|';
    for (const k of [...this.data.keys()]) if (k.startsWith(pre)) this.data.delete(k);
    for (const k of [...this.bmps.keys()]) if (k.startsWith(pre) || k.includes('&' + pre)) this.bmps.delete(k);
    if (this.prevSig && this.prevSig.startsWith(pre)) this.prevSig = null;
    if (this.curSig && this.curSig.startsWith(pre)) this.curSig = null;
  }

  levelChanged() {
    // remember the signature on screen so its bitmaps serve as placeholders for the new level
    if (this.curSig) this.prevSig = this.curSig;
  }

  blitTile(ctx, A, vp, bm, ty, tx) {
    const cx = 2 ** -bm.kx, per = 2 ** -bm.kt;
    const x0 = TILE * tx * cx * A.px + A.ox, y0 = TILE * ty * per * A.py + A.oy;
    const w = TILE * cx * A.px, h = TILE * per * A.py;
    if (x0 > this.W || y0 > this.H || x0 + w < 0 || y0 + h < 0) return;
    ctx.drawImage(bm.cv, Math.round(x0), Math.round(y0), Math.round(x0 + w) - Math.round(x0), Math.round(y0 + h) - Math.round(y0));
  }

  drawSig(ctx, vp, A, sig, pane) {
    for (const [k, bm] of this.bmps) {
      if (bm.sig !== sig) continue;
      this.blitTile(ctx, A, vp, bm, bm.ty, bm.tx);
    }
  }

  /** Overview placeholder (abs frame, time rows): one pooled image of the whole run. */
  drawOverview(ctx, vp, S, A) {
    const vs = this.app.store.get();
    if (vs.frame !== 'abs' || !isTimeRows(vs.rows) || !S.ov || S.ov.t.length < 2) return;
    const img = this.overviewImage(S);
    if (!img || !img.rows) return;
    const ov = S.ov, rows = img.rows, dt = ov.t[1] - ov.t[0];
    const b0 = baseOfStep(vs.rows, ov.t[0]), b1 = baseOfStep(vs.rows, ov.t[rows - 1] + dt);
    const x0 = ov.u0 * A.px + A.ox, x1 = (ov.u0 + ov.cols * 2 ** ov.j) * A.px + A.ox;
    const y0 = b0 * A.py + A.oy, y1 = b1 * A.py + A.oy;
    drawBands(ctx, img, x0, y0, x1 - x0, y1 - y0);
  }

  /**
   * The overview painted in the current style (mean or near pooling). Built incrementally: new rows are added
   * within a small time budget per frame, so a growing 4096x2048 overview never blocks the main thread. Rows
   * live in bands of OV_BAND rows (one canvas each): adding rows rewrites only the last band, never the whole
   * image (a canvas that was just drawn from is copied on write, which for one 32 MB canvas is a long task).
   * Returns {bands, band, rows, cols} (rows = how many overview rows are painted so far) or null.
   */
  overviewImage(S, styleOverride, budgetMs = 3) {
    const vs = this.app.store.get(), ov = S.ov;
    if (!ov || !ov.t.length) return null;
    const style = styleOverride || vs.style;
    const rows = ov.t.length, cols = ov.cols, N = 2 ** ov.j, m = S.machine.m;
    const dt = rows > 1 ? ov.t[1] - ov.t[0] : 0;
    const key = `${S.session.sid}|${ov.j}|${ov.u0}|${cols}|${dt}|${ov.t[0]}|${style}|${vs.pool}|${vs.unv}`;
    let st = S.ovState;
    if (!st || st.key !== key) st = S.ovState = { key, bands: [], band: OV_BAND, rows: 0, cols: Math.max(1, cols) };
    if (st.rows >= rows) return st;
    const colsC = []; for (let k = 0; k < m; k++) colsC.push(symbolColor(style, k, m));
    const unv = vs.unv ? UNV_MARK : unvisitedColor(style);
    const blaze = style.startsWith('blaze');
    const t0 = performance.now();
    while (st.rows < rows && performance.now() - t0 < budgetMs) {
      // one band per pass: compute its new rows, then a single putImageData
      const bi = Math.floor(st.rows / OV_BAND), bandEnd = (bi + 1) * OV_BAND;
      const r0 = st.rows, r1 = Math.min(rows, bandEnd, r0 + Math.max(1, Math.floor(65536 / Math.max(1, cols))));
      const out = new Uint8ClampedArray((r1 - r0) * cols * 4);
      for (let i = r0 * cols, o = 0; i < r1 * cols; i++, o += 4) {
        const V = ov.vis[i];
        if (vs.pool === 'near') {
          const sy = ov.near[i]; const c = sy === UNREAD || sy >= m ? unv : colsC[sy];
          out[o] = c[0]; out[o + 1] = c[1]; out[o + 2] = c[2]; out[o + 3] = 255; continue;
        }
        if (blaze) {
          let r = 0, g = 0, b = 0, ws = 0;
          for (let k = 1; k < m; k++) { const w = Math.floor(255 * ov.cnt[k - 1][i] / N); ws += w; r += w * colsC[k][0]; g += w * colsC[k][1]; b += w * colsC[k][2]; }
          const w0 = Math.max(0, 255 - ws); r += w0 * colsC[0][0]; g += w0 * colsC[0][1]; b += w0 * colsC[0][2];
          out[o] = r / 255; out[o + 1] = g / 255; out[o + 2] = b / 255; out[o + 3] = 255; continue;
        }
        let n0 = V, r = 0, g = 0, b = 0;
        for (let k = 1; k < m; k++) { const n = ov.cnt[k - 1][i]; n0 -= n; r += n * colsC[k][0]; g += n * colsC[k][1]; b += n * colsC[k][2]; }
        r += n0 * colsC[0][0] + (N - V) * unv[0]; g += n0 * colsC[0][1] + (N - V) * unv[1]; b += n0 * colsC[0][2] + (N - V) * unv[2];
        out[o] = r / N; out[o + 1] = g / N; out[o + 2] = b / N; out[o + 3] = 255;
      }
      if (!st.bands[bi]) st.bands[bi] = mkCanvas(st.cols, OV_BAND);
      st.bands[bi].getContext('2d').putImageData(new ImageData(out, cols, r1 - r0), 0, r0 - bi * OV_BAND);
      st.rows = r1;
    }
    if (st.rows < rows) this.invalidate();
    return st;
  }

  // ------------------------------------------------------------------ overlay
  /** A small text tag with a dark backing box (readable over any diagram colour); y = top of the box. */
  tag(ctx, text, x, y, fg) {
    const d = this.dpr, fs = Math.round(11 * d), padX = Math.round(4 * d), hgt = Math.round(15 * d);
    ctx.font = `${fs}px ui-monospace, Consolas, monospace`; ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
    const w = Math.ceil(ctx.measureText(text).width) + 2 * padX;
    ctx.fillStyle = 'rgba(12,12,16,0.82)'; ctx.fillRect(Math.round(x), Math.round(y), w, hgt);
    ctx.fillStyle = fg; ctx.fillText(text, Math.round(x) + padX, Math.round(y) + hgt / 2 + 0.5);
  }

  drawOverlay(vp, anim) {
    const ctx = this.octx, app = this.app, vs = app.store.get();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.W, this.H);
    for (const pane of vp.panes) {
      const A = this.affine(vp, pane, anim);
      ctx.save();
      ctx.beginPath(); ctx.rect(pane.x0, 0, pane.w, this.H); ctx.clip();
      const cellPx = A.px, rowPx = A.py;
      // grid at >= 8 px per unit
      if (vs.grid && !anim) {
        ctx.strokeStyle = 'rgba(128,128,128,0.28)'; ctx.lineWidth = 1;
        ctx.beginPath();
        if (cellPx >= 8) {
          const u0 = Math.floor((pane.x0 - A.ox) / cellPx), u1 = Math.ceil((pane.x0 + pane.w - A.ox) / cellPx);
          for (let u = u0; u <= u1; u++) { const x = Math.round(u * cellPx + A.ox) + 0.5; ctx.moveTo(x, 0); ctx.lineTo(x, this.H); }
        }
        if (rowPx >= 8) {
          const b0 = Math.floor(-A.oy / rowPx), b1 = Math.ceil((this.H - A.oy) / rowPx);
          for (let b = b0; b <= b1; b++) { const y = Math.round(b * rowPx + A.oy) + 0.5; ctx.moveTo(pane.x0, y); ctx.lineTo(pane.x0 + pane.w, y); }
        }
        ctx.stroke();
      }
      // marks (steps) in time rows
      if (isTimeRows(vs.rows)) {
        let lastLabelY = -Infinity;
        for (const s of [...vs.marks].sort((a, b) => a - b)) {
          const y = Math.round(baseOfStep(vs.rows, s) * rowPx + A.oy) + 0.5;
          if (y < 0 || y > this.H) continue;
          ctx.setLineDash([6, 4]); ctx.strokeStyle = 'rgba(80,160,255,0.9)'; ctx.lineWidth = 1;
          ctx.beginPath(); ctx.moveTo(pane.x0, y); ctx.lineTo(pane.x0 + pane.w, y); ctx.stroke(); ctx.setLineDash([]);
          // label only when it does not collide with the previous one (close marks share one label row)
          const ly = y < 18 * this.dpr ? y + 3 * this.dpr : y - 16 * this.dpr;
          if (ly - lastLabelY >= 16 * this.dpr) { this.tag(ctx, `mark ${s.toLocaleString('en-US')}`, pane.x0 + 4, ly, 'rgb(120,180,255)'); lastLabelY = ly; }
        }
      }
      // first difference (compare)
      if (app.divergence && app.divergence.step !== null && isTimeRows(vs.rows)) {
        const y = Math.round(baseOfStep(vs.rows, app.divergence.step) * rowPx + A.oy) + 0.5;
        if (y >= 0 && y <= this.H) {
          ctx.setLineDash([8, 5]); ctx.strokeStyle = '#ffd400'; ctx.lineWidth = 1.5;
          ctx.beginPath(); ctx.moveTo(pane.x0, y); ctx.lineTo(pane.x0 + pane.w, y); ctx.stroke(); ctx.setLineDash([]);
          const dv = app.divergence;
          this.tag(ctx, `first difference at step ${dv.step.toLocaleString('en-US')} (${dv.tr}: A=${dv.a}, B=${dv.b})`, pane.x0 + 4, y < 18 * this.dpr ? y + 3 * this.dpr : y - 16 * this.dpr, '#ffd400');
        }
      }
      // playhead + veil below it
      const ph = app.playheadBase();
      if (ph !== null) {
        const y = Math.round(ph * rowPx + A.oy + Math.max(1, rowPx));
        if (app.playing || vs.play) {
          ctx.fillStyle = 'rgba(0,0,0,0.6)';
          if (y < this.H) ctx.fillRect(pane.x0, Math.max(0, y), pane.w, this.H - Math.max(0, y));
        }
        ctx.strokeStyle = '#ffcc00'; ctx.lineWidth = 1;
        const yl = Math.round(ph * rowPx + A.oy) + 0.5;
        ctx.beginPath(); ctx.moveTo(pane.x0, yl); ctx.lineTo(pane.x0 + pane.w, yl); ctx.stroke();
        // head marker at the playhead
        const f = pane.sess === 'B' ? app.playFrameB : app.playFrame;
        if (f && !f.halted) {
          const anchor = vs.frame === 'head' ? f.pos : vs.frame === 'left' ? f.lo : vs.frame === 'right' ? f.hi : 0;
          const hx = (f.pos - anchor) * cellPx + A.ox;
          const w = Math.max(3, cellPx), h = Math.max(3, rowPx);
          ctx.strokeStyle = '#ffcc00'; ctx.lineWidth = 2;
          ctx.strokeRect(Math.round(hx) - 1.5, Math.round(ph * rowPx + A.oy) - 1.5, w + 3, h + 3);
        }
      }
      // pin
      if (vs.pin) {
        const x = vs.pin.x * cellPx + A.ox, y = vs.pin.t * rowPx + A.oy;
        ctx.strokeStyle = '#00e5ff'; ctx.lineWidth = 1.5;
        if (cellPx >= 4 && rowPx >= 4) ctx.strokeRect(Math.round(x) - 0.75, Math.round(y) - 0.75, Math.max(2, cellPx) + 1.5, Math.max(2, rowPx) + 1.5);
        ctx.strokeStyle = 'rgba(0,229,255,0.35)'; ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(Math.round(x) + 0.5, 0); ctx.lineTo(Math.round(x) + 0.5, this.H); ctx.moveTo(pane.x0, Math.round(y) + 0.5); ctx.lineTo(pane.x0 + pane.w, Math.round(y) + 0.5); ctx.stroke();
      }
      // hover outline
      const hv = this.hover;
      if (hv && !this.drag) {
        const x = Math.floor(hv.uTex) * cellPx * hv.per_x + A.ox, y = Math.floor(hv.bLev) * rowPx * hv.per_t + A.oy;
        const w = Math.max(1, cellPx * hv.per_x), h = Math.max(1, rowPx * hv.per_t);
        ctx.strokeStyle = 'rgba(255,255,255,0.85)'; ctx.lineWidth = 1;
        if (w >= 3 && h >= 3) ctx.strokeRect(Math.round(x) + 0.5, Math.round(y) + 0.5, Math.round(w) - 1, Math.round(h) - 1);
        else {
          ctx.strokeStyle = 'rgba(255,255,255,0.25)';
          ctx.beginPath(); ctx.moveTo(Math.round(x) + 0.5, 0); ctx.lineTo(Math.round(x) + 0.5, this.H); ctx.moveTo(pane.x0, Math.round(y) + 0.5); ctx.lineTo(pane.x0 + pane.w, Math.round(y) + 0.5); ctx.stroke();
        }
      }
      ctx.restore();
    }
  }

  // ------------------------------------------------------------------ pointer
  /** Device px -> {pane, u (cell, frame-relative, fractional), b (base row, fractional)}. */
  locate(dx, dy) {
    const vp = this.app.vp;
    if (!vp) return null;
    const pane = vp.panes.find((p) => dx >= p.x0 && dx < p.x0 + p.w) || vp.panes[0];
    if (!pane) return null;
    const ax = axis(vp.x, vp.zx, pane.w), at = axis(vp.t, vp.zt, vp.H);
    const u = toUnit(ax, dx - pane.x0), b = toUnit(at, dy);
    return { pane, ax, at, u, b, per_x: ax.per, per_t: at.per, uTex: Math.floor(u / ax.per), bLev: Math.floor(b / at.per) };
  }

  devXY(e) {
    const r = this.el.getBoundingClientRect();
    return [(e.clientX - r.left) * (this.W / r.width), (e.clientY - r.top) * (this.H / r.height)];
  }

  /** The data tile and row/column under a located point (or null). */
  lookup(loc, which) {
    const app = this.app, S = app[which || loc.pane.sess];
    if (!S || !S.session || !app.vp) return null;
    const base = this.sigOf(S.session, app.vp);
    const lv = loc.bLev, tex = loc.uTex;
    const ty = Math.floor(lv / TILE), tx = Math.floor(tex / TILE);
    const d = this.data.get(tileKey(base, ty, tx));
    if (!d) return null;
    const i = lv - ty * TILE, c = tex - tx * TILE;
    return { tile: d.tile, i, c, row: tileRow(d.tile, i), final: d.final };
  }

  listeners() {
    const el = this.el;
    el.addEventListener('pointermove', (e) => {
      const [dx, dy] = this.devXY(e);
      if (this.drag) {
        const ddx = dx - this.drag.x, ddy = dy - this.drag.y;
        if (Math.abs(ddx) + Math.abs(ddy) > 3) this.drag.moved = true;
        if (this.drag.moved) { this.app.panByDevice(ddx - this.drag.px, ddy - this.drag.py); this.drag.px = ddx; this.drag.py = ddy; }
        return;
      }
      const loc = this.locate(dx, dy);
      this.hover = loc; this.hoverDev = [dx, dy];
      this.app.onHover(loc);
      this.invalidate();
    });
    el.addEventListener('pointerleave', () => { this.hover = null; this.app.onHover(null); this.invalidate(); });
    el.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      const [dx, dy] = this.devXY(e);
      this.drag = { x: dx, y: dy, px: 0, py: 0, moved: false };
      el.setPointerCapture(e.pointerId);
      el.classList.add('dragging');
    });
    el.addEventListener('pointerup', (e) => {
      const d = this.drag; this.drag = null; el.classList.remove('dragging');
      if (d && !d.moved) {
        const [dx, dy] = this.devXY(e);
        const loc = this.locate(dx, dy);
        if (loc) this.app.pinAt(loc);
      }
    });
    el.addEventListener('dblclick', (e) => { const [dx, dy] = this.devXY(e); this.app.exactAt([dx, dy]); });
    el.addEventListener('wheel', (e) => {
      e.preventDefault();
      const [dx, dy] = this.devXY(e);
      const unit = e.deltaMode === 1 ? 33 : e.deltaMode === 2 ? 300 : 1;
      let ddx = e.deltaX * unit, ddy = e.deltaY * unit;
      if (e.ctrlKey || e.altKey) {
        const axisSel = e.ctrlKey && e.shiftKey ? 'x' : e.altKey ? 't' : 'both';
        // with Shift (and on some systems Alt) the browser turns a vertical wheel into deltaX
        const dz = ddy || ddx;
        if (e.altKey) window.__stxAltWheel = performance.now();
        this.wheelAcc.z += dz;
        while (Math.abs(this.wheelAcc.z) >= 100) {
          const s = Math.sign(this.wheelAcc.z);
          this.wheelAcc.z -= s * 100;
          this.app.zoom(axisSel, -s, [dx, dy]);
        }
        return;
      }
      if (e.shiftKey && !ddx) { ddx = ddy; ddy = 0; }
      this.app.panByDevice(-ddx, -ddy);
    }, { passive: false });
  }
}
