// Tape strip: ±32 cells around the head at the playhead (else the pinned / hovered row), digits, head with its
// state, the rule about to fire, step, speed and transport buttons.
import { h, btn } from '../dom.mjs';
import { int } from '../../core/fmt.mjs';
import { UNREAD } from '../../core/protocol.mjs';
import { STATE_COLORS, symbolColor } from '../../core/palette.mjs';

export class TapeStrip {
  constructor(app, root) {
    this.app = app; this.root = root;
    this.cv = h('canvas', { class: 'ts-tape' });
    this.caption = h('div', { class: 'ts-caption' });
    this.stepEl = h('span', { class: 'ts-step' });
    this.speedEl = h('span', { class: 'ts-speed' });
    this.playBtn = btn('▶', () => app.action('play'), { small: true, title: 'play / pause (Space)' }); this.playBtn.classList.add('play');
    const ctl = h('div', { class: 'ts-ctl' },
      h('div', { class: 'rowc' },
        btn('‹ row', () => app.action('row-prev'), { small: true, title: 'one row back (,)' }),
        this.playBtn,
        btn('row ›', () => app.action('row-next'), { small: true, title: 'one row on (.)' }),
        btn('−', () => app.action('speed-down'), { small: true, title: 'slower (-)' }),
        this.speedEl,
        btn('+', () => app.action('speed-up'), { small: true, title: 'faster (+)' }),
        btn('head ▸', () => app.action('seek-head'), { small: true, title: 'w: jump on to the next time the head enters the visible cells' })),
      this.stepEl, this.caption);
    root.append(this.cv, ctl);
    this.key = '';
  }

  source() {
    const app = this.app;
    if (app.playFrame && (app.playing || app.store.get().play)) return { f: app.playFrame, kind: 'playhead', focus: null };
    // hover / pin: the strip shows the inspected cell's neighbourhood; the head when it is close to it
    if (app.inspect) return { f: app.inspect.probe, fh: app.inspect.headProbe || app.inspect.probe, kind: app.inspect.pinned ? 'pinned row' : 'hovered row', focus: app.inspect.cell };
    return null;
  }

  update() {
    const app = this.app, vs = app.store.get(), src = this.source();
    const sp = app.playSpeed ? app.playSpeed() : vs.play ? vs.play.speed : 8;
    const gap = app.rowSpacing ? app.rowSpacing() : 1;
    const rps = sp / gap;
    this.speedEl.textContent = rps >= 1 ? `${int(Math.round(rps * 10) / 10)} rows/s` : `1 row/${int(Math.round(1 / rps))} s`;
    this.speedEl.title = `${int(sp)} steps/s (${int(gap)} step${gap === 1 ? '' : 's'} between rows on screen)`;
    this.playBtn.textContent = app.playing ? '❚❚' : '▶';
    const fps = 60;
    const key = JSON.stringify([src && src.f.step, src && src.kind, src && src.focus, vs.style, sp, gap, app.playing, this.cv.clientWidth, document.documentElement.dataset.theme, app.playFrameB && app.playFrameB.step, !!vs.cmp]);
    if (key === this.key) return;
    this.key = key;
    const per = Math.round(sp / fps);
    this.caption.textContent = `${int(sp)} steps/s · ` + (sp > fps && per >= 2 ? `skipping ~${int(per)} steps per frame` : app.playing ? 'every step shown' : 'Space plays (8 rows/s; + − change it)');
    const dpr = window.devicePixelRatio || 1;
    const W = Math.max(1, Math.round(this.cv.clientWidth * dpr)), H = Math.max(1, Math.round(this.cv.clientHeight * dpr));
    if (this.cv.width !== W || this.cv.height !== H) { this.cv.width = W; this.cv.height = H; }
    const ctx = this.cv.getContext('2d');
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, W, H);
    const text = getComputedStyle(document.documentElement).getPropertyValue('--text').trim() || '#222';
    const dim = getComputedStyle(document.documentElement).getPropertyValue('--dim').trim() || '#666';
    if (!src) { ctx.fillStyle = dim; ctx.font = `${12 * dpr}px system-ui, sans-serif`; ctx.textAlign = 'left'; ctx.textBaseline = 'middle'; ctx.fillText('No row selected: hover or pin a row, or press Space to play.', 8 * dpr, H / 2); this.stepEl.textContent = ''; return; }
    let f = src.f;
    const M = app.A && app.A.machine, m = M ? M.m : 2;
    const fB = vs.cmp && app.B && src.kind === 'playhead' ? app.playFrameB : null;
    const style = vs.style === 'explore' ? 'default' : vs.style;
    const cw = Math.max(10, Math.min(22 * dpr, Math.floor(W / 66)));
    const n = Math.floor(W / cw), half = Math.floor(n / 2);
    // centre: the head, unless the inspected cell is too far from it to share the strip
    let centre = f.pos;
    if (src.focus !== null && src.focus !== undefined && Math.abs(src.focus - src.fh.pos) > half - 2) centre = src.focus;
    else if (src.fh) f = src.fh;
    const strip = (fr, y0, ch, tag, ticks, labelAbove) => {
      const c0 = (fr === f ? centre : fr.pos) - half;
      ctx.font = `${Math.round(Math.min(12, ch / dpr - 4) * dpr)}px ui-monospace, Consolas, monospace`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      for (let k = 0; k < n; k++) {
        const p = c0 + k, x = k * cw;
        const v = fr.cells[p - fr.x0];
        const unread = v === undefined || v === UNREAD || (fr.fresh && p === fr.pos);
        const col = unread ? [40, 40, 40] : symbolColor(style, v, m);
        ctx.fillStyle = `rgb(${col})`; ctx.fillRect(x + 1, y0, cw - 2, ch);
        ctx.strokeStyle = 'rgba(128,128,128,0.6)'; ctx.lineWidth = 1; ctx.strokeRect(x + 1.5, y0 + 0.5, cw - 3, ch - 1);
        if (!unread) { const lum = col[0] * 0.3 + col[1] * 0.59 + col[2] * 0.11; ctx.fillStyle = lum > 128 ? '#000' : '#fff'; ctx.fillText(String(v), x + cw / 2, y0 + ch / 2 + dpr); }
        if (ticks && p % 10 === 0) { ctx.fillStyle = dim; ctx.font = `${Math.round(9 * dpr)}px ui-monospace, Consolas, monospace`; ctx.fillText(int(p), x + cw / 2, y0 + ch + 8 * dpr); ctx.font = `${Math.round(12 * dpr)}px ui-monospace, Consolas, monospace`; }
      }
      const q = fr.halted ? -1 : fr.state.charCodeAt(0) - 65;
      const hc = q >= 0 && STATE_COLORS[q] ? `rgb(${STATE_COLORS[q]})` : '#ffcc00';
      const arrow = fr.dir > 0 ? '▸' : fr.dir < 0 ? '◂' : '';
      const ly = labelAbove ? y0 - 8 * dpr : y0 + ch + 8 * dpr;
      const hk = fr.pos - c0;
      if (hk >= 0 && hk < n) {
        const hx = hk * cw;
        ctx.strokeStyle = hc; ctx.lineWidth = 2 * dpr;
        ctx.strokeRect(hx + 1, y0 - 1, cw - 2, ch + 2);
        ctx.fillStyle = hc; ctx.font = `bold ${Math.round(11 * dpr)}px ui-monospace, Consolas, monospace`;
        ctx.fillText(`${tag}${fr.halted ? 'HALT' : `${fr.state}${arrow}`}`, hx + cw / 2, ly);
      } else {
        // the head is off the strip: say where it is, at the edge it is beyond
        ctx.fillStyle = hc; ctx.font = `bold ${Math.round(11 * dpr)}px ui-monospace, Consolas, monospace`;
        const right = hk >= n;
        ctx.textAlign = right ? 'right' : 'left';
        ctx.fillText(right ? `head ${fr.halted ? 'HALT' : fr.state} at cell ${int(fr.pos)} ▸▸` : `◂◂ head ${fr.halted ? 'HALT' : fr.state} at cell ${int(fr.pos)}`, right ? W - 4 * dpr : 4 * dpr, ly);
        ctx.textAlign = 'center';
      }
      if (fr === f && src.focus !== null && src.focus !== undefined) {
        const fk = src.focus - c0;
        if (fk >= 0 && fk < n && fk !== hk) { ctx.strokeStyle = '#00e5ff'; ctx.lineWidth = 1.5 * dpr; ctx.strokeRect(fk * cw + 2, y0, cw - 4, ch); }
      }
    };
    if (fB) {
      strip(f, Math.round(14 * dpr), Math.round(18 * dpr), 'A ', false, true);
      strip(fB, Math.round(36 * dpr), Math.round(18 * dpr), 'B ', false, false);
    } else strip(f, Math.round(18 * dpr), Math.round(22 * dpr), '', true, true);
    const rule = f.next ? `${f.next.tr} → ${f.next.act}` : f.halted ? 'halted' : '';
    const ruleB = fB && fB.next ? ` · B next ${fB.next.tr} → ${fB.next.act}` : '';
    this.stepEl.textContent = `${src.kind} · step ${int(f.step)} · ${fB ? 'A ' : ''}state ${f.halted ? 'Z' : f.state} at cell ${int(f.pos)}${centre !== f.pos ? ` · showing cells around ${int(centre)}` : ''} · next ${rule}${ruleB}`;
    // fired flash
    if (app.lastFired && app.playing && M) {
      let best = -1, bc = 0; app.lastFired.forEach((c, i) => { if (c > bc) { bc = c; best = i; } });
      if (best >= 0) { ctx.textAlign = 'left'; ctx.fillStyle = dim; ctx.font = `${Math.round(10 * dpr)}px ui-monospace, Consolas, monospace`; ctx.fillText(`fired this frame: ${M.names[best]}${bc > 1 ? ` ×${int(bc)}` : ''}`, 4 * dpr, 8 * dpr); }
    }
  }
}
