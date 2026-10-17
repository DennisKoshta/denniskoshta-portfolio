// Legend: drawn from the same descriptor as the label's Colors line (swatches, numbered ramps, 2-D grid, hatch).
import { h } from '../dom.mjs';
import { hlIntensity, HATCH_FG, HATCH_BG, DIM_LO } from '../../core/palette.mjs';
import { int } from '../../core/fmt.mjs';

function screen(base, chans) {
  let r = 1 - base[0] / 255, g = 1 - base[1] / 255, b = 1 - base[2] / 255;
  for (const [a, c] of chans) { r *= 1 - a * c[0] / 255; g *= 1 - a * c[1] / 255; b *= 1 - a * c[2] / 255; }
  return [Math.round((1 - r) * 255), Math.round((1 - g) * 255), Math.round((1 - b) * 255)];
}

function rampCanvas(item) {
  const W = 180, H = 28, dpr = window.devicePixelRatio || 1;
  const cv = h('canvas', { width: Math.round(W * dpr), height: Math.round(H * dpr), style: { width: W + 'px', height: H + 'px' } });
  const ctx = cv.getContext('2d'); ctx.scale(dpr, dpr);
  const ticks = item.ticks || [1], nmax = ticks[ticks.length - 1];
  const pos = (c) => (c <= 0 ? 0 : 8 + (W - 16) * Math.log2(1 + c) / Math.log2(1 + nmax));
  for (let x = 0; x < W; x++) {
    // invert pos(): find c for this x
    const f = Math.max(0, (x - 8) / (W - 16));
    const c = x < 8 ? 0 : 2 ** (f * Math.log2(1 + nmax)) - 1;
    const a = hlIntensity(c, nmax, item.mode || 'count');
    const col = screen(DIM_LO, [[a, item.rgb]]);
    ctx.fillStyle = `rgb(${col})`; ctx.fillRect(x, 0, 1, 14);
  }
  ctx.fillStyle = getComputedStyle(document.documentElement).getPropertyValue('--text') || '#000';
  ctx.font = '10px ui-monospace, Consolas, monospace'; ctx.textAlign = 'center'; ctx.textBaseline = 'top';
  ctx.fillText('0', 4, 16);
  for (const t of ticks) { const x = pos(t); ctx.fillRect(x, 12, 1, 4); ctx.fillText(int(t), Math.min(W - 10, Math.max(10, x)), 16); }
  return cv;
}

function grid2(item) {
  const n = 5, s = 14, cv = h('canvas', { width: n * s, height: n * s, style: { width: n * s + 'px', height: n * s + 'px' } });
  const ctx = cv.getContext('2d');
  for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) {
    const a = i / (n - 1), b = j / (n - 1);
    ctx.fillStyle = `rgb(${screen(DIM_LO, [[a, item.a], [b, item.b]])})`;
    ctx.fillRect(i * s, (n - 1 - j) * s, s, s);
  }
  return cv;
}

function hatchSwatch() {
  const cv = h('canvas', { width: 14, height: 12, class: 'sw' });
  const ctx = cv.getContext('2d');
  for (let y = 0; y < 12; y++) for (let x = 0; x < 14; x++) { ctx.fillStyle = ((x + y) & 7) < 2 ? `rgb(${HATCH_FG})` : `rgb(${HATCH_BG})`; ctx.fillRect(x, y, 1, 1); }
  return cv;
}

export function renderLegend(el, label) {
  el.replaceChildren();
  const box = h('div', { class: 'legend' });
  const seen = new Set();
  for (const it of label.legend || []) {
    const k = JSON.stringify(it); if (seen.has(k)) continue; seen.add(k);
    if (it.kind === 'swatch') box.append(h('div', { class: 'li' }, h('span', { class: 'sw', style: { background: `rgb(${it.rgb})` } }), it.label));
    else if (it.kind === 'ramp') box.append(h('div', {}, h('div', { class: 'note' }, it.label), rampCanvas(it)));
    else if (it.kind === 'ramp2') box.append(h('div', { class: 'li' }, h('span', { class: 'sw', style: { background: `linear-gradient(90deg, rgb(${it.from}), rgb(${it.to}))`, width: '40px' } }), it.label));
    else if (it.kind === 'grid2') box.append(h('div', { class: 'li' }, grid2(it), h('span', {}, `${it.label}: right = more of the first, up = more of the second; both = purple`)));
    else if (it.kind === 'hatch') box.append(h('div', { class: 'li' }, hatchSwatch(), it.label));
  }
  box.append(h('div', { class: 'note' }, label.colors));
  el.append(box);
}
