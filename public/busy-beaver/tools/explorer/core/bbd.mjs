// GENERATED from tools/diagram.py CORE_JS (sha256 5cc556cadf65957f4dcb2e0d420eeb0d456524d7f104c6d7ea20b78fbf8a77b3) by tools/explorer/tests/sync_bbd.py. Do not edit.

var BBD = (function () {
  'use strict';
  var SLATE = [0x1e, 0x29, 0x3b];
  var STATE_COLORS = [[255,0,0],[255,128,0],[0,0,255],[0,255,0],[255,0,255],[0,255,255],[255,255,0]];
  var BLAZE = { light: [[255,255,255],[255,165,0],[255,255,0],[255,0,255],[0,255,255]],
                dark: [[255,255,255],[0,0,0],[128,128,128],[64,64,64],[192,192,192]] };
  var FRESH = 1, NOHEAD = 2, HALTED = 4;
  function b64(s) {
    if (typeof atob === 'function') { var bin = atob(s), u = new Uint8Array(bin.length); for (var i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i); return u; }
    return new Uint8Array(Buffer.from(s, 'base64'));
  }
  async function inflate(u8) {
    var stream = new Blob([u8]).stream().pipeThrough(new DecompressionStream('deflate'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }
  async function decodeRows(v) {
    var meta = new Int32Array((await inflate(b64(v.meta))).buffer);
    var steps = new Float64Array((await inflate(b64(v.steps))).buffer);
    var cells = await inflate(b64(v.cells));
    var n = v.n, off = new Float64Array(n + 1);
    for (var i = 0; i < n; i++) off[i + 1] = off[i] + meta[8 * i + 7];
    return { n: n, m: v.m, meta: meta, steps: steps, cells: cells, off: off, info: v.info, label: v.label };
  }
  async function decodeRGB(b) { return await inflate(b64(b.rgb)); }
  function grey(k, m) { return Math.floor((255 / (m - 1)) * k); }
  function blazeColor(k, theme) { var p = BLAZE[theme || 'light']; return k === 0 ? p[0] : p[1 + (k - 1) % (p.length - 1)]; }
  // Same layout as diagram.py palette(..., transparent=True)
  function palette(style, m, theme) {
    var P = [], k;
    for (k = 0; k < m; k++) {
      if (style === 'blaze') P.push(blazeColor(k, theme).concat([255]));
      else if (style === 'explore' && k === 0) P.push([0, 0, 0, 0]);
      else { var g = grey(k, m); P.push([g, g, g, 255]); }
    }
    P.push(style === 'blaze' ? blazeColor(0, theme).concat([255]) : [0, 0, 0, 0]);
    P.push([255, 0, 0, 255], [0, 255, 0, 255]);
    for (k = 0; k < STATE_COLORS.length; k++) P.push(STATE_COLORS[k].concat([255]));
    return P;
  }
  function nat(x) { return x < 0 ? -2 * x - 1 : 2 * x; }
  function row(R, i) {
    var b = 8 * i, M = R.meta;
    return { i: i, step: R.steps[i], state: M[b], dir: M[b + 1], flags: M[b + 2], pos: M[b + 3], lo: M[b + 4],
             hi: M[b + 5], clo: M[b + 6], len: M[b + 7], off: R.off[i] };
  }
  function defined(r) {
    var lo = r.lo, hi = r.hi;
    if (r.flags & FRESH) { if (r.pos === lo) lo++; else if (r.pos === hi) hi--; }
    return [lo, hi];
  }
  function anchor(r, frame) { return frame === 'head' ? r.pos : frame === 'left' ? r.lo : frame === 'right' ? r.hi : 0; }
  // Columns covering every row's stored cells (span ∩ stored window; = the span unless the view is clipped).
  function fitCols(R, frame, n) {
    var a = Infinity, b = -Infinity; n = n === undefined ? R.n : Math.min(n, R.n);
    for (var i = 0; i < n; i++) {
      var r = row(R, i), q = anchor(r, frame), lo = Math.max(r.lo, r.clo), hi = Math.min(r.hi, r.clo + r.len - 1);
      if (lo > hi) continue;
      a = Math.min(a, lo - q); b = Math.max(b, hi - q);
    }
    if (a === Infinity) { a = 0; b = 0; }
    return [a, b];
  }
  function cellAt(R, r, p) {
    var d = defined(r);
    if (p < d[0] || p > d[1] || p - r.clo < 0 || p - r.clo >= r.len) return null;
    return R.cells[r.off + p - r.clo];
  }
  function stored(r, p) { return p >= r.clo && p < r.clo + r.len; }
  function headIndex(r, style, m, siteExact) {
    if (r.flags & NOHEAD) return -1;
    var idx = -1;
    if (style === 'default') idx = r.dir > 0 ? m + 1 : r.dir < 0 ? m + 2 : -1;
    else if (style === 'explore') idx = (r.state >= 0 && r.state < STATE_COLORS.length) ? m + 3 + r.state : -1;
    if (idx >= 0 && siteExact && (r.flags & FRESH)) {
      var d = defined(r);
      if (!(nat(r.pos) <= Math.max(nat(d[0]), nat(d[1])) + 1)) idx = -1;
    }
    return idx;
  }
  // Paint rows r0..r1-1, columns c0..c0+W-1 (relative to the frame anchor) into RGBA `out` (W*(r1-r0)*4).
  // opts: {head, siteExact, skipRow0, theme}. Mirrors diagram.py render_rows(..., transparent=True).
  function paint(R, style, frame, c0, W, r0, r1, opts, out) {
    var m = R.m, P = palette(style, m, opts.theme), unv = P[m], i, x;
    for (var y = r0; y < r1; y++) {
      var o = (y - r0) * W * 4;
      for (x = 0; x < W; x++) { out[o + 4 * x] = unv[0]; out[o + 4 * x + 1] = unv[1]; out[o + 4 * x + 2] = unv[2]; out[o + 4 * x + 3] = unv[3]; }
      if (y >= R.n || (opts.skipRow0 && y === 0)) continue;
      var r = row(R, y), q = anchor(r, frame), d = defined(r);
      var a = Math.max(d[0], r.clo, c0 + q), b = Math.min(d[1], r.clo + r.len - 1, c0 + W - 1 + q);
      for (var p = a; p <= b; p++) {
        var c = P[R.cells[r.off + p - r.clo]], j = o + 4 * (p - q - c0);
        out[j] = c[0]; out[j + 1] = c[1]; out[j + 2] = c[2]; out[j + 3] = c[3];
      }
      if (opts.head) {
        var hx = r.pos - q - c0;
        if (hx >= 0 && hx < W) {
          var h = headIndex(r, style, m, opts.siteExact);
          if (h >= 0) { var hc = P[h], k = o + 4 * hx; out[k] = hc[0]; out[k + 1] = hc[1]; out[k + 2] = hc[2]; out[k + 3] = hc[3]; }
        }
      }
    }
    return out;
  }
  // Nearest-neighbour samples of paint(): output pixel (i, j) = paint pixel (xs[i], ys[j]); xs are columns
  // relative to c0, ys are row indices; -1 = outside (left untouched, i.e. transparent in a fresh buffer).
  // Used for zoomed-out views, so the cost is O(canvas pixels) however large the trace is.
  function paintSampled(R, style, frame, c0, xs, ys, opts, out) {
    var m = R.m, P = palette(style, m, opts.theme), unv = P[m], nx = xs.length;
    for (var j = 0; j < ys.length; j++) {
      var y = ys[j], o = j * nx * 4, i, c, k;
      if (y < 0) continue;
      if (y >= R.n || (opts.skipRow0 && y === 0)) {
        for (i = 0; i < nx; i++) if (xs[i] >= 0) { k = o + 4 * i; out[k] = unv[0]; out[k + 1] = unv[1]; out[k + 2] = unv[2]; out[k + 3] = unv[3]; }
        continue;
      }
      var r = row(R, y), q = anchor(r, frame), d = defined(r);
      var a = Math.max(d[0], r.clo), b = Math.min(d[1], r.clo + r.len - 1);
      var h = opts.head ? headIndex(r, style, m, opts.siteExact) : -1;
      for (i = 0; i < nx; i++) {
        if (xs[i] < 0) continue;
        var p = xs[i] + c0 + q;
        c = (h >= 0 && p === r.pos) ? P[h] : (p >= a && p <= b) ? P[R.cells[r.off + p - r.clo]] : unv;
        k = o + 4 * i; out[k] = c[0]; out[k + 1] = c[1]; out[k + 2] = c[2]; out[k + 3] = c[3];
      }
    }
    return out;
  }
  // The site's Default canvas, computed exactly like diagram.py site_default_canvas(): the W x H trace (site
  // quirks on, transparent where unvisited) drawn into a black cw x ch canvas with the 2x2 bilinear filter
  // (draw_image_bilinear). Only the <= 2*ch trace rows the filter reads are painted, so 99,999 steps cost
  // the same as 1,000. P = {width, steps, ox} (already clamped like the site).
  function jsRound(x) { var f = Math.floor(x); return x - f >= 0.5 ? f + 1 : f; }
  function siteTaps(n, size, i) {             // source taps of destination pixel i: [i0, i1, weight of i1]
    var f = (i + 0.5) * (n / size) - 0.5, f0 = Math.floor(f);
    return [Math.min(n - 1, Math.max(0, f0)), Math.min(n - 1, Math.max(0, f0 + 1)), f - f0];
  }
  function siteCanvas(R, P, head, cw, ch) {
    var W = P.width, H = P.steps, c0 = -Math.floor(W * P.ox), sx = W / cw, sy = H / ch;
    var out = new Uint8ClampedArray(cw * ch * 4), cache = new Map(), x, y;
    for (var i = 3; i < out.length; i += 4) out[i] = 255;
    function src(r) {
      var s = cache.get(r);
      if (!s) { s = new Uint8ClampedArray(W * 4); paint(R, 'default', 'abs', c0, W, r, r + 1, { head: head, siteExact: true, skipRow0: true }, s); cache.set(r, s); }
      return s;
    }
    var xt = [];
    for (x = 0; x < cw; x++) {
      var fx = (x + 0.5) * sx - 0.5, x0 = Math.floor(fx);
      xt.push([4 * Math.min(W - 1, Math.max(0, x0)), 4 * Math.min(W - 1, Math.max(0, x0 + 1)), fx - x0]);
    }
    for (y = 0; y < ch; y++) {
      var fy = (y + 0.5) * sy - 0.5, y0 = Math.floor(fy), wy = fy - y0;
      var A = src(Math.min(H - 1, Math.max(0, y0))), B = src(Math.min(H - 1, Math.max(0, y0 + 1))), base = 4 * y * cw;
      for (x = 0; x < cw; x++) {
        var t = xt[x], wx = t[2], r = 0, g = 0, bl = 0, al = 0;
        var taps = [[A, t[0], (1 - wx) * (1 - wy)], [A, t[1], wx * (1 - wy)], [B, t[0], (1 - wx) * wy], [B, t[1], wx * wy]];
        for (var k = 0; k < 4; k++) {
          var S = taps[k][0], j = taps[k][1], w = taps[k][2];
          if (w === 0) continue;
          var av = S[j + 3] / 255;
          r += S[j] * av * w; g += S[j + 1] * av * w; bl += S[j + 2] * av * w; al += av * w;
        }
        if (al <= 0) continue;
        // diagram.py _blend(d, i, r/a, g/a, b/a, a*255) over the opaque black canvas
        var sa = ((al * 255) / 255) * 1, o = base + 4 * x, da = out[o + 3] / 255, oa = sa + da * (1 - sa);
        out[o] = jsRound(((r / al) * sa + out[o] * da * (1 - sa)) / oa);
        out[o + 1] = jsRound(((g / al) * sa + out[o + 1] * da * (1 - sa)) / oa);
        out[o + 2] = jsRound(((bl / al) * sa + out[o + 2] * da * (1 - sa)) / oa);
        out[o + 3] = jsRound(oa * 255);
      }
    }
    return out;
  }
  function siteHeadVisible(r) {
    if (!(r.flags & FRESH)) return true;
    var d = defined(r);
    return nat(r.pos) <= Math.max(nat(d[0]), nat(d[1])) + 1;
  }
  function stateName(s) { return s < 0 ? 'Z (halted)' : String.fromCharCode(65 + s); }
  return { SLATE: SLATE, STATE_COLORS: STATE_COLORS, FRESH: FRESH, NOHEAD: NOHEAD, HALTED: HALTED, b64: b64,
           inflate: inflate, decodeRows: decodeRows, decodeRGB: decodeRGB, palette: palette, grey: grey, row: row,
           defined: defined, anchor: anchor, fitCols: fitCols, cellAt: cellAt, headIndex: headIndex, paint: paint,
           paintSampled: paintSampled, siteTaps: siteTaps, siteCanvas: siteCanvas, siteHeadVisible: siteHeadVisible,
           stored: stored, stateName: stateName, nat: nat };
})();
if (typeof module !== 'undefined') module.exports = BBD;

export default BBD; export { BBD };
