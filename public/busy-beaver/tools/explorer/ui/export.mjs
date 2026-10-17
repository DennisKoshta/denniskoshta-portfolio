// PNG export (spec §14.1): the viewport at device resolution with rulers, the label band on top (wrapped, not
// ellipsised) and the legend band at the bottom; tEXt bb6x-url and bb6x-label. Final tiles only (waits <= 10 s).
import { insertText } from './png-text.mjs';
import { hlIntensity, DIM_LO } from '../core/palette.mjs';
import { int } from '../core/fmt.mjs';

const FONT = 'ui-monospace, Consolas, "DejaVu Sans Mono", monospace';

function wrap(ctx, text, maxW) {
  const words = text.split(' '), lines = [];
  let cur = '';
  for (const w of words) {
    const t = cur ? cur + ' ' + w : w;
    if (ctx.measureText(t).width > maxW && cur) { lines.push(cur); cur = w; } else cur = t;
  }
  if (cur) lines.push(cur);
  return lines;
}

function wrapURL(ctx, url, maxW) {
  const parts = url.split(/(?=&)/), lines = [];
  let cur = '';
  for (const p of parts) {
    if (ctx.measureText(cur + p).width > maxW && cur) { lines.push(cur); cur = ''; }
    let q = p;
    while (ctx.measureText(q).width > maxW) {        // a single very long part (inlined dh): hard-wrap
      let n = q.length; while (n > 1 && ctx.measureText(q.slice(0, n)).width > maxW) n = Math.floor(n * 0.9);
      lines.push(q.slice(0, n)); q = q.slice(n);
    }
    cur += q;
  }
  if (cur) lines.push(cur);
  return lines.slice(0, 12);
}

async function waitFinal(app, ms) {
  if (app.view.allFinal && app.A && app.A.info && app.A.info.status !== 'running') return true;
  return await Promise.race([
    new Promise((r) => { app.readyWaiters.push({ final: true, resolve: r }); app.view.invalidate(); }),
    new Promise((r) => setTimeout(() => r(false), ms)),
  ]);
}

export async function exportPNG(app) {
  const final = await waitFinal(app, 10000);
  await new Promise((r) => requestAnimationFrame(r));
  const v = app.view, dpr = window.devicePixelRatio || 1;
  const L = app.label();
  const hover = v.hover; v.hover = null; v.drawOverlay(app.vp, null); v.hover = hover;
  const rl = document.getElementById('ruler-left'), rt = document.getElementById('ruler-top');
  const W = v.W, H = v.H, lw = rl.width, th = rt.height;
  const pad = Math.round(8 * dpr), fs = Math.round(12 * dpr), lh = Math.round(16 * dpr);
  const totalW = lw + W;
  const meas = document.createElement('canvas').getContext('2d');
  meas.font = `${fs}px ${FONT}`;
  const labelLines = [];
  const status = (final ? '' : 'PARTIAL (some tiles were still computing) · ') + L.status;
  for (const [k, t] of [['Start  ', L.start], ['Rows   ', L.rows], ['Window ', L.window], ['Colors ', L.colors], ['Status ', status]]) {
    const ls = wrap(meas, t, totalW - 2 * pad - meas.measureText(k).width);
    ls.forEach((s, i) => labelLines.push([i ? ' '.repeat(k.length) : k, s]));
  }
  const labelH = pad * 2 + labelLines.length * lh;
  // legend layout
  const items = (L.legend || []).filter((x, i, a) => a.findIndex((y) => JSON.stringify(y) === JSON.stringify(x)) === i);
  const sw = Math.round(14 * dpr);
  let lx = pad, ly = 0; const legendRows = [];
  for (const it of items) {
    const w = it.kind === 'ramp' ? Math.round(200 * dpr) + meas.measureText(it.label).width + pad : sw + 6 * dpr + meas.measureText(it.label).width + 2 * pad;
    if (lx + w > totalW - pad && lx > pad) { lx = pad; ly += (it.kind === 'ramp' ? 2 : 1) * lh + 6 * dpr; }
    legendRows.push({ it, x: lx, y: ly }); lx += w;
  }
  const url = location.origin + location.pathname + app.shareHash();
  const urlLines = wrapURL(meas, url, totalW - 2 * pad);
  const legendH = pad * 2 + (items.length ? ly + 2 * lh + 6 * dpr : 0) + urlLines.length * lh;
  const cv = document.createElement('canvas');
  cv.width = totalW; cv.height = labelH + th + H + legendH;
  const ctx = cv.getContext('2d');
  ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, cv.width, cv.height);
  ctx.fillStyle = '#111'; ctx.font = `${fs}px ${FONT}`; ctx.textBaseline = 'top';
  labelLines.forEach(([k, s], i) => {
    ctx.fillStyle = '#666'; ctx.fillText(k, pad, pad + i * lh);
    ctx.fillStyle = s.startsWith('PARTIAL') ? '#b91c1c' : '#111'; ctx.fillText(s, pad + meas.measureText(k).width, pad + i * lh);
  });
  // rulers + canvas
  ctx.fillStyle = '#ececea'; ctx.fillRect(0, labelH, lw, th);
  ctx.drawImage(rt, lw, labelH, W, th);
  ctx.drawImage(rl, 0, labelH + th, lw, H);
  ctx.drawImage(v.base, lw, labelH + th);
  ctx.drawImage(v.over, lw, labelH + th);
  // legend
  const y0 = labelH + th + H + pad;
  for (const { it, x, y } of legendRows) {
    const yy = y0 + y;
    if (it.kind === 'ramp') {
      const rw = Math.round(180 * dpr), ticks = it.ticks || [1], nmax = ticks[ticks.length - 1];
      for (let i = 0; i < rw; i++) {
        const f = i / (rw - 1), c = i === 0 ? 0 : 2 ** (f * Math.log2(1 + nmax)) - 1, a = hlIntensity(c, nmax, it.mode || 'count');
        const col = [0, 1, 2].map((ch) => Math.round(255 * (1 - (1 - DIM_LO[ch] / 255) * (1 - a * it.rgb[ch] / 255))));
        ctx.fillStyle = `rgb(${col})`; ctx.fillRect(x + i, yy, 1, sw);
      }
      ctx.fillStyle = '#111';
      for (const t of ticks) { const px = x + (rw - 1) * Math.log2(1 + t) / Math.log2(1 + nmax); ctx.fillRect(px, yy + sw, 1, 4 * dpr); ctx.fillText(int(t), px - 4 * dpr, yy + sw + 4 * dpr); }
      ctx.fillText(it.label, x + rw + pad, yy);
    } else {
      if (it.kind === 'hatch') { for (let a = 0; a < sw; a++) for (let b = 0; b < sw; b++) { ctx.fillStyle = ((a + b) & 7) < 2 ? '#3a3a3a' : '#262626'; ctx.fillRect(x + a, yy + b, 1, 1); } }
      else if (it.kind === 'grid2') { ctx.fillStyle = `rgb(${it.a})`; ctx.fillRect(x, yy, sw / 2, sw); ctx.fillStyle = `rgb(${it.b})`; ctx.fillRect(x + sw / 2, yy, sw / 2, sw); }
      else if (it.kind === 'ramp2') { const g = ctx.createLinearGradient(x, 0, x + sw, 0); g.addColorStop(0, `rgb(${it.from})`); g.addColorStop(1, `rgb(${it.to})`); ctx.fillStyle = g; ctx.fillRect(x, yy, sw, sw); }
      else { ctx.fillStyle = `rgb(${it.rgb})`; ctx.fillRect(x, yy, sw, sw); }
      ctx.strokeStyle = '#999'; ctx.strokeRect(x + 0.5, yy + 0.5, sw - 1, sw - 1);
      ctx.fillStyle = '#111'; ctx.fillText(it.label, x + sw + 6 * dpr, yy);
    }
  }
  ctx.fillStyle = '#555';
  const uy = y0 + (items.length ? ly + 2 * lh + 6 * dpr : 0);
  urlLines.forEach((s, i) => ctx.fillText(s, pad, uy + i * lh));
  v.invalidate();
  const blob = await new Promise((r) => cv.toBlob(r, 'image/png'));
  const png = new Uint8Array(await blob.arrayBuffer());
  return insertText(png, [['bb6x-url', url], ['bb6x-label', L.text]]);
}

export function downloadPNG(bytes, name) {
  const url = URL.createObjectURL(new Blob([bytes], { type: 'image/png' }));
  const a = document.createElement('a');
  a.href = url; a.download = name; document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}
