// Rulers: top = cells (frame-relative names in non-abs frames), left = the real step of the rows
// (event modes: event ordinal and its step). Redrawn only when the transform changes.
import { axis, stepOfBase, baseOfStep, isTimeRows } from '../core/lod.mjs';
import { int } from '../core/fmt.mjs';
import { TILE } from '../core/protocol.mjs';

function nice(minUnits) {
  const p = 10 ** Math.floor(Math.log10(Math.max(1e-9, minUnits)));
  for (const m of [1, 2, 5, 10]) if (m * p >= minUnits) return m * p;
  return 10 * p;
}

function size(cv) {
  const dpr = window.devicePixelRatio || 1;
  const w = Math.max(1, Math.round(cv.clientWidth * dpr)), h = Math.max(1, Math.round(cv.clientHeight * dpr));
  if (cv.width !== w || cv.height !== h) { cv.width = w; cv.height = h; }
  return [w, h, dpr];
}

let lastKey = '';

/** Wheel over a ruler zooms that axis only (about the pointer): the top ruler = space, the left ruler = time. */
export function installRulerWheel(app) {
  const acc = { x: 0, t: 0 };
  const on = (id, which) => {
    const el = document.getElementById(id);
    el.addEventListener('wheel', (e) => {
      e.preventDefault();
      const V = app.view, r = el.getBoundingClientRect(), vr = V.el.getBoundingClientRect();
      const dev = which === 'x' ? [(e.clientX - vr.left) * (V.W / vr.width), V.H / 2] : [V.W / 2, (e.clientY - vr.top) * (V.H / vr.height)];
      void r;
      const unit = e.deltaMode === 1 ? 33 : e.deltaMode === 2 ? 300 : 1;
      acc[which] += (e.deltaY || e.deltaX) * unit;
      while (Math.abs(acc[which]) >= 100) { const sg = Math.sign(acc[which]); acc[which] -= sg * 100; app.zoom(which, -sg, dev); }
    }, { passive: false });
    el.title = which === 'x' ? 'cells · wheel here: zoom space only' : 'steps of the rows · wheel here: zoom time only';
  };
  on('ruler-top', 'x');
  on('ruler-left', 't');
}

export function drawRulers(app) {
  const vp = app.vp, vs = app.store.get();
  const top = document.getElementById('ruler-top'), left = document.getElementById('ruler-left');
  if (!vp) return;
  const anim = app.view.anim ? performance.now() : 0;
  const key = JSON.stringify([vp.x, vp.t, vp.zx, vp.zt, vp.W, vp.H, vs.frame, vs.rows, anim, app.view.stats.paints, top.clientWidth, left.clientHeight]);
  if (key === lastKey) return;
  lastKey = key;
  const style = getComputedStyle(document.documentElement);
  const fg = style.getPropertyValue('--ruler-text').trim() || '#555';
  // ---------------- top ruler
  {
    const [w, hh, dpr] = size(top);
    const ctx = top.getContext('2d');
    ctx.clearRect(0, 0, w, hh);
    ctx.fillStyle = fg; ctx.strokeStyle = fg; ctx.font = `${Math.round(10 * dpr)}px ui-monospace, Consolas, monospace`; ctx.textBaseline = 'top';
    const scale = w / Math.max(1, vp.W);
    for (const pane of vp.panes) {
      const A = app.view.affine(vp, pane, app.view.anim ? { ...app.view.anim, f: Math.min(1, (performance.now() - app.view.anim.start) / app.view.anim.dur) } : null);
      const px = A.px * scale, ox = A.ox * scale;
      const step = nice((80 * dpr) / px);
      const u0 = Math.floor((pane.x0 * scale - ox) / px / step) * step, u1 = ((pane.x0 + pane.w) * scale - ox) / px;
      ctx.beginPath();
      for (let u = u0; u <= u1; u += step) {
        const x = Math.round(u * px + ox) + 0.5;
        if (x < pane.x0 * scale || x > (pane.x0 + pane.w) * scale) continue;
        ctx.moveTo(x, hh - 6 * dpr); ctx.lineTo(x, hh);
        const pre = vs.frame === 'head' ? 'h' : vs.frame === 'left' ? 'L' : vs.frame === 'right' ? 'R' : '';
        const txt = pre ? `${pre}${u >= 0 ? '+' : ''}${int(u)}` : int(u);
        ctx.fillText(txt, x + 2 * dpr, 3 * dpr);
      }
      // minor ticks
      const minor = step / 5;
      if (minor * px >= 4 * dpr) for (let u = u0; u <= u1; u += minor) { const x = Math.round(u * px + ox) + 0.5; ctx.moveTo(x, hh - 3 * dpr); ctx.lineTo(x, hh); }
      ctx.stroke();
      if (vp.panes.length > 1) { ctx.fillStyle = '#e44'; ctx.fillText(pane.sess, (pane.x0 + pane.w) * scale - 12 * dpr, 3 * dpr); ctx.fillStyle = fg; }
    }
  }
  // ---------------- left ruler
  {
    const [w, hh, dpr] = size(left);
    const ctx = left.getContext('2d');
    ctx.clearRect(0, 0, w, hh);
    ctx.fillStyle = fg; ctx.strokeStyle = fg; ctx.font = `${Math.round(10 * dpr)}px ui-monospace, Consolas, monospace`; ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
    const scale = hh / Math.max(1, vp.H);
    const pane = vp.panes[0] || { x0: 0, w: vp.W, sess: 'A' };
    const A = app.view.affine(vp, pane, null);
    const py = A.py * scale, oy = A.oy * scale;
    if (isTimeRows(vs.rows)) {
      const K = vs.rows.kind === 'every' ? vs.rows.k : 1;
      // label spacing in steps: nice, and a multiple of the row spacing
      const per = 2 ** -Math.min(0, vp.zt);
      const stepsPerDev = K / py;
      let st = nice(stepsPerDev * 34 * dpr);
      const rowSteps = K * per;
      // ticks name real rows while rows are a few ticks apart; when many rows share a tick gap, round numbers
      // read better (the tick then sits at that step's exact height, between two sampled rows)
      const onRows = st < 10 * rowSteps;
      if (onRows) { if (st < rowSteps) st = rowSteps; st = Math.ceil(st / rowSteps) * rowSteps; }
      const o = onRows ? vs.rows.o || 0 : 0;
      const b0 = -oy / py, b1 = (hh - oy) / py;
      // no ticks past the end of the run (the hatched area below it has no rows)
      const info = app.A && app.A.info, sEnd = info ? (info.halt ? info.halt.step : Math.max(info.t, info.status === 'running' ? info.target : info.t)) : Infinity;
      const s0 = Math.floor((stepOfBase(vs.rows, b0) - o) / st) * st + o, s1 = Math.min(sEnd, stepOfBase(vs.rows, b1));
      ctx.beginPath();
      for (let s = s0; s <= s1; s += st) {
        if (s < (vs.s0 || 0)) continue;
        const b = baseOfStep(vs.rows, s);
        const y = Math.round(b * py + oy) + 0.5;
        if (y < 0 || y > hh) continue;
        ctx.moveTo(w - 6 * dpr, y); ctx.lineTo(w, y);
        ctx.fillText(int(s), w - 8 * dpr, Math.min(hh - 6 * dpr, Math.max(6 * dpr, y)));
      }
      ctx.stroke();
    } else {
      // event rows: label every ~40 px with ordinal and step (from tile data)
      const S = app.A && app.A.session;
      const gap = 40 * dpr;
      const per = 2 ** -Math.min(0, vp.zt);
      const base = S ? app.view.sigOf(S, vp) : null;
      const ax = axis(vp.x, vp.zx, pane.w);
      const tx = Math.floor(Math.floor(ax.u0 / ax.per) / TILE);
      for (let y = 6 * dpr; y < hh - 6 * dpr; y += gap) {
        const lv = Math.floor((y - oy) / py / per);
        if (lv < 0) continue;
        const ty = Math.floor(lv / TILE), i = lv - ty * TILE;
        let stepTxt = '';
        if (base) {
          const d = app.view.data.get(app.tileKeyOf(base, ty, tx));
          if (d && Number.isFinite(d.tile.steps[i])) stepTxt = int(d.tile.steps[i]);
        }
        const yy = Math.round(lv * per * py + oy);
        ctx.beginPath(); ctx.moveTo(w - 6 * dpr, yy + 0.5); ctx.lineTo(w, yy + 0.5); ctx.stroke();
        ctx.fillText('#' + int(lv * per), w - 8 * dpr, yy - 6 * dpr);
        if (stepTxt) { ctx.globalAlpha = 0.7; ctx.fillText(stepTxt, w - 8 * dpr, yy + 6 * dpr); ctx.globalAlpha = 1; }
      }
    }
  }
}
