// bbchallenge view: the site's own canvases (site worker = vizref code), a thumbnail in the right panel and a
// large overlay (Shift+S) at 1 device px per canvas px, with a label that says what the site hides.
import { h, btn, seg } from '../dom.mjs';
import { int } from '../../core/fmt.mjs';
import BBD from '../../core/bbd.mjs';

export class SitePanel {
  constructor(app) {
    this.app = app; this.mode = 'default'; this.modeUser = false; this.overlayOpen = false; this.key = ''; this.jobId = 0; this.result = null;
    this.thumb = h('canvas', { class: 'site-thumb', title: 'bbchallenge.org view (click or Shift+S for the large overlay)' });
    this.thumb.addEventListener('click', () => this.toggleOverlay());
    this.info = h('div', { class: 'note site-info' });
    this.collapsed = false;
    try { this.collapsed = localStorage.getItem('stx-site-collapsed') === '1'; } catch { /* */ }
  }

  section(sec) {
    this.body = h('div');
    this.segEl = h('span');
    this.collapseBtn = btn(this.collapsed ? 'show' : 'hide', () => this.setCollapsed(!this.collapsed), { small: true });
    const s = sec('bbchallenge view', 'as on the site', h('div', { class: 'rowc' }, this.segEl, btn('⤢', () => this.toggleOverlay(), { small: true, title: 'large (Shift+S)' }), this.collapseBtn), this.body);
    this.renderSeg();
    this.body.append(this.thumb, this.info);
    this.body.hidden = this.collapsed;
    return s;
  }

  setCollapsed(c) {
    this.collapsed = c; this.body.hidden = c; this.collapseBtn.textContent = c ? 'show' : 'hide';
    try { localStorage.setItem('stx-site-collapsed', c ? '1' : '0'); } catch { /* */ }
    if (!c) this.maybeUpdate(true);
  }

  /** The site mode: follows the main view's style (Default / Explore / Blaze) until the user picks one here. */
  curMode() {
    if (this.modeUser) return this.mode;
    const st = this.app.store.get().style;
    return st === 'explore' ? 'explore' : st.startsWith('blaze') ? 'blaze' : 'default';
  }

  modeSeg() {
    return seg([['default', 'Default'], ['explore', 'Explore'], ['blaze', 'Blaze']], this.curMode(), (v) => { this.mode = v; this.modeUser = true; this.renderSeg(); this.maybeUpdate(true); });
  }

  renderSeg() { this.segEl.replaceChildren(this.modeSeg()); }

  job() {
    const vs = this.app.store.get();
    if (!vs.tm) return null;
    if (vs.start.kind === 'config') return { disabled: 'the site has no start-config input' };
    const tape = vs.start.kind === 'site' ? vs.start.tape : '0';
    const mode = this.curMode();
    const steps = mode === 'blaze' ? Math.min(vs.steps, 1e7) : 10000;
    return { mode, tm: vs.tm, tape, steps, theme: vs.style === 'blaze-dark' ? 'dark' : 'light', quality: true, stretch: true, noHead: false, width: 400, ox: 0.5 };
  }

  maybeUpdate(force) {
    if (this.collapsed && !this.overlayOpen) return;
    const j = this.job();
    const key = JSON.stringify(j);
    if (!force && key === this.key) return;
    this.key = key;
    if (this.segEl) this.renderSeg();
    if (!j) { this.info.textContent = ''; return; }
    if (j.disabled) { this.info.textContent = `Not available: ${j.disabled}.`; const c = this.thumb.getContext('2d'); c.clearRect(0, 0, this.thumb.width, this.thumb.height); return; }
    if (!this.worker) {
      try {
        this.worker = new Worker(new URL('../site-worker.mjs', import.meta.url), { type: 'module' });
        this.worker.onmessage = (e) => this.onResult(e.data);
        this.worker.onerror = (e) => { this.info.textContent = 'site worker failed: ' + (e.message || 'error'); };
      } catch (e) { this.info.textContent = 'site worker unavailable'; return; }
    }
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.info.textContent = 'drawing as the site does…';
      this.worker.postMessage({ ...j, id: ++this.jobId });
    }, 150);
  }

  onResult(r) {
    if (r.id !== this.jobId) return;
    if (r.error) { this.info.textContent = 'site view: ' + r.error; return; }
    this.result = r;
    const cv = this.thumb;
    cv.width = r.w; cv.height = r.h;
    cv.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(r.rgba), r.w, r.h), 0, 0);
    this.info.textContent = `${r.status} · ${this.hidden(r)}`;
    if (this.overlayOpen) this.renderOverlay();
  }

  /** What the site hides, in words. */
  hidden(r) {
    const j = this.job();
    if (!j || j.disabled) return '';
    if (j.mode === 'default') {
      const H = j.steps, ratio = H / 500;
      let s = `Default as on the site: ${int(H)} steps squeezed into 500 rows`;
      if (ratio >= 2) {
        const y = 0, t = BBD.siteTaps(H, 500, y);
        s += `; each canvas row is a blend of 2 trace rows (row 0 = rows ${t[0]} and ${t[1]}); ${int(Math.round(ratio) - 2)} of every ${int(Math.round(ratio))} rows are not shown`;
      } else if (ratio < 1) s += `; rows stretched ${(1 / ratio).toFixed(1)}× and blurred`;
      s += '; row 0 (the start) is never drawn; only cells −200…199; the head is not drawn on some new cells (site quirk)';
      return s;
    }
    if (j.mode === 'explore') return 'Explore as on the site: rows 0–49 at 10 px per cell, cells −40…39 (the site lets you scroll the rest)';
    return `Blaze as on the site: ${int(j.steps)} steps (capped at 10,000,000 here); rows are averaged blocks of 2^k steps, pixels average 2^j cells; stretched to 800×500`;
  }

  toggleOverlay() { if (this.overlayOpen) this.closeOverlay(); else this.openOverlay(); }

  openOverlay() {
    this.overlayOpen = true;
    const ov = document.getElementById('site-overlay');
    ov.hidden = false;
    this.maybeUpdate();
    this.renderOverlay();
  }

  closeOverlay() { this.overlayOpen = false; document.getElementById('site-overlay').hidden = true; }

  renderOverlay() {
    const ov = document.getElementById('site-overlay');
    ov.replaceChildren();
    const r = this.result, j = this.job();
    const close = btn('close (Esc)', () => this.closeOverlay(), { small: true });
    const head = h('div', { class: 'sl' }, h('b', {}, 'bbchallenge.org view · '), this.modeSeg(), ' ', j && j.disabled ? `not available: ${j.disabled}` : r ? `${r.status} · ${this.hidden(r)}` : 'drawing…', ' ', close);
    ov.append(head);
    if (!r || (j && j.disabled)) return;
    const dpr = window.devicePixelRatio || 1;
    const cv = h('canvas', { width: r.w, height: r.h, style: { width: `${r.w / dpr}px`, height: `${r.h / dpr}px`, cursor: 'pointer' } });
    cv.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(r.rgba.slice ? r.rgba.slice(0) : r.rgba), r.w, r.h), 0, 0);
    const hov = h('div', { class: 'sl' }, 'hover: which trace rows a canvas row shows · click: open the equivalent exact view');
    cv.addEventListener('mousemove', (e) => {
      const rect = cv.getBoundingClientRect();
      const y = Math.floor((e.clientY - rect.top) * r.h / rect.height);
      if (j.mode === 'default') {
        const t = BBD.siteTaps(j.steps, 500, y);
        hov.textContent = `canvas row ${y} = ${t[2] ? `${Math.round((1 - t[2]) * 100)}% of trace row ${t[0]} + ${Math.round(t[2] * 100)}% of row ${t[1]}` : `trace row ${t[0]}`} (trace row r = the configuration after r steps)`;
      } else if (j.mode === 'explore') hov.textContent = `row ${Math.floor(y / 10)} = the configuration after ${Math.floor(y / 10)} steps`;
      else hov.textContent = 'Blaze rows are averages over blocks of steps';
    });
    cv.addEventListener('click', (e) => {
      const rect = cv.getBoundingClientRect();
      const y = Math.floor((e.clientY - rect.top) * r.h / rect.height);
      this.closeOverlay();
      const app = this.app;
      if (j.mode === 'default') {
        const t = BBD.siteTaps(j.steps, 500, y);
        app.store.set({ rows: { kind: 'auto' }, frame: 'abs', style: 'default', zx: 0, zt: 0, x: -200, t: Math.max(0, t[0] - 100), sq: false, follow: false });
      } else if (j.mode === 'explore') app.store.set({ rows: { kind: 'auto' }, frame: 'abs', style: 'explore', zx: 7, zt: 7, x: -40, t: 0, follow: false });
      else app.store.set({ style: j.theme === 'dark' ? 'blaze-dark' : 'blaze', x: null, t: null, zx: null, zt: null, rows: { kind: 'auto' }, frame: 'abs', follow: true });
    });
    ov.append(cv, hov);
  }
}
