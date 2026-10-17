// Minimap: the overview (whole run, abs cells) in the current style, the viewport rectangle and marks.
// Click or drag to jump (time rows: both axes in the abs frame; otherwise time only).
import { axis, baseOfStep, stepOfBase, isTimeRows } from '../core/lod.mjs';
import { h } from './dom.mjs';
import { drawBands } from './canvas-view.mjs';

export class Minimap {
  constructor(app) {
    this.app = app;
    this.cv = h('canvas', { class: 'minimap', title: 'Minimap: the whole run. Click or drag to jump.' });
    this.ctx = this.cv.getContext('2d');
    this.key = '';
    let down = false;
    const jump = (e) => {
      const r = this.cv.getBoundingClientRect();
      this.jumpTo((e.clientX - r.left) / r.width, (e.clientY - r.top) / r.height);
    };
    // docked over the diagram: its pointer events must not reach the diagram (drag, pin, hover, wheel)
    const stop = (e) => e.stopPropagation();
    this.cv.addEventListener('pointerdown', (e) => { stop(e); down = true; this.cv.setPointerCapture(e.pointerId); jump(e); });
    this.cv.addEventListener('pointermove', (e) => { stop(e); if (down) jump(e); });
    this.cv.addEventListener('pointerup', (e) => { stop(e); down = false; });
    for (const t of ['dblclick', 'click', 'pointerleave', 'pointerenter']) this.cv.addEventListener(t, stop);
    this.cv.addEventListener('wheel', (e) => { e.stopPropagation(); e.preventDefault(); }, { passive: false });
  }

  geom() {
    const app = this.app, S = app.A, vs = app.store.get();
    if (!S || !S.ov || !S.info || S.ov.t.length < 1) return null;
    const ov = S.ov, info = S.info;
    const t0 = vs.s0 || 0, t1 = Math.max(info.t, ov.t[ov.t.length - 1] + 1, info.halt ? info.halt.step : 0);
    const c0 = ov.u0, c1 = ov.u0 + ov.cols * 2 ** ov.j;
    return { ov, t0, t1, c0, c1 };
  }

  jumpTo(fx, fy) {
    const app = this.app, vs = app.store.get(), g = this.geom(), vp = app.vp;
    if (!g || !vp) return;
    const pane = vp.panes[0];
    const c = app.concrete();
    const step = g.t0 + Math.max(0, Math.min(1, fy)) * (g.t1 - g.t0);
    const patch = { ...c, follow: false };
    if (isTimeRows(vs.rows)) {
      const at = axis(c.t, c.zt, vp.H);
      patch.t = baseOfStep(vs.rows, step) - (vp.H / 2) / at.ppu;
      if (vs.frame === 'abs') {
        const ax = axis(c.x, c.zx, pane.w);
        const cell = g.c0 + Math.max(0, Math.min(1, fx)) * (g.c1 - g.c0);
        patch.x = cell - (pane.w / 2) / ax.ppu;
      }
      app.store.set(patch);
    } else {
      app.goto(String(Math.round(step)));
    }
  }

  draw() {
    const app = this.app, vs = app.store.get(), vp = app.vp, g = this.geom();
    const dpr = window.devicePixelRatio || 1;
    if (this.cv.hidden) return;
    const W = Math.max(1, Math.round((this.cv.clientWidth || 180) * dpr)), H = Math.max(1, Math.round((this.cv.clientHeight || 120) * dpr));
    if (this.cv.width !== W || this.cv.height !== H) { this.cv.width = W; this.cv.height = H; this.key = ''; }
    const key = JSON.stringify([vp && [vp.x, vp.t, vp.zx, vp.zt, vp.W, vp.H], g && [g.ov.t.length, g.t1, g.c0, g.c1], vs.style, vs.pool, vs.rows, vs.frame, vs.marks, app.A && app.A.ovState && app.A.ovState.rows]);
    if (key === this.key) return;
    this.key = key;
    const ctx = this.ctx;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = '#111'; ctx.fillRect(0, 0, W, H);
    if (!g || !vp) return;
    const img = app.view.overviewImage(app.A);
    if (img && img.rows) {
      ctx.imageSmoothingEnabled = true;
      const rows = img.rows, dt = g.ov.t.length > 1 ? g.ov.t[1] - g.ov.t[0] : 1;
      const yEnd = ((g.ov.t[rows - 1] + dt - g.t0) / (g.t1 - g.t0)) * H;
      drawBands(ctx, img, 0, 0, W, Math.min(H, yEnd));
    }
    const sx = (c) => ((c - g.c0) / (g.c1 - g.c0)) * W, sy = (s) => ((s - g.t0) / (g.t1 - g.t0)) * H;
    // marks
    ctx.strokeStyle = 'rgba(80,160,255,.9)'; ctx.lineWidth = 1;
    for (const s of vs.marks) { const y = Math.round(sy(s)) + 0.5; ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke(); }
    // viewport
    const pane = vp.panes[0];
    if (!pane) return;
    const ax = axis(vp.x, vp.zx, pane.w), at = axis(vp.t, vp.zt, vp.H);
    let y0, y1;
    if (isTimeRows(vs.rows)) { y0 = sy(stepOfBase(vs.rows, at.u0)); y1 = sy(stepOfBase(vs.rows, at.u1)); }
    else {
      const ev = app.eventRowsInfo('A');
      if (!ev || ev.step0 === null) return;
      y0 = sy(ev.step0); y1 = sy(ev.step1);
    }
    let x0 = 0, x1 = W;
    if (vs.frame === 'abs') { x0 = sx(ax.u0); x1 = sx(ax.u1); }
    ctx.strokeStyle = '#ffcc00'; ctx.lineWidth = Math.max(1, dpr);
    const rx = Math.max(-2, Math.min(W + 2, x0)), ry = Math.max(-2, Math.min(H + 2, y0));
    const rw = Math.max(2, Math.min(W + 2, x1) - rx), rh = Math.max(2, Math.min(H + 2, y1) - ry);
    ctx.strokeRect(Math.round(rx) + 0.5, Math.round(ry) + 0.5, Math.round(rw), Math.round(rh));
    // deep zoom: the viewport is a dot, so add a crosshair through it
    if (rw < 8 * dpr || rh < 8 * dpr) {
      const cx = Math.round(rx + rw / 2) + 0.5, cy = Math.round(ry + rh / 2) + 0.5;
      ctx.strokeStyle = 'rgba(255,204,0,0.55)'; ctx.lineWidth = 1; ctx.setLineDash([3 * dpr, 3 * dpr]);
      ctx.beginPath(); ctx.moveTo(0, cy); ctx.lineTo(W, cy); ctx.moveTo(cx, 0); ctx.lineTo(cx, H); ctx.stroke(); ctx.setLineDash([]);
    }
  }
}
