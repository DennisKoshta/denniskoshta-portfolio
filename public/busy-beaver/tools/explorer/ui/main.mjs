// Space-time Explorer: app wiring (store <-> engine <-> canvas, panels, keys, URL, playback, test hook).
import { PROTOCOL_VERSION, TILE, MAG, LIMITS, ERR, tileKey, F_NOHEAD } from '../core/protocol.mjs';
import { defaults, normalize, isEventRows, sameJSON } from '../core/viewstate.mjs';
import { decode, encode, fromBbchallengeURL, bbchallengeURL, parsePairs } from '../core/url.mjs';
import { makeLabel, runEnd, visibleCells } from '../core/label.mjs';
import { axis, ppu, fitIndex, clampZ, zoomAbout, stepOfBase, baseOfStep, firstBase, isTimeRows, Z_EXACT, Z_MAX } from '../core/lod.mjs';
import { STYLES, rotations } from '../core/palette.mjs';
import { int, compact, parseCount, rate, ordinal } from '../core/fmt.mjs';
import { exactCell, anchorOf } from '../core/paint.mjs';
import { Store } from './store.mjs';
import { CanvasView } from './canvas-view.mjs';
import { installKeys } from './keys.mjs';
import { drawRulers, installRulerWheel } from './rulers.mjs';
import { h, btn, clear, toast, copyText } from './dom.mjs';
import { mountLeft } from './panels/controls.mjs';
import { mountRight } from './panels/machine.mjs';
import { TapeStrip } from './panels/tapestrip.mjs';
import { showHelp, hideHelp } from './panels/help.mjs';
import { SitePanel } from './panels/site.mjs';
import { exportPNG, downloadPNG } from './export.mjs';

const $ = (id) => document.getElementById(id);

async function fetchJSON(path, fallback) {
  try { const r = await fetch(path, { cache: 'no-cache' }); if (!r.ok) return fallback; return await r.json(); } catch { return fallback; }
}

async function loadEngine(kind) {
  try { const q = new URLSearchParams(location.search).get('engine'); if (q === 'stub' || q === 'mock' || q === 'real') kind = q; } catch { /* */ }
  const tries = kind === 'stub' ? ['../engine/stub-client.mjs', './mock-engine.mjs'] : kind === 'mock' ? ['./mock-engine.mjs'] : ['./engine-client.mjs', './mock-engine.mjs'];
  let lastErr = null;
  for (const p of tries) {
    try { const mod = await import(p); if (mod.createEngine) return { mod, path: p }; } catch (e) { lastErr = e; console.warn(`engine ${p} unavailable:`, e && e.message); }
  }
  throw lastErr || new Error('no engine');
}

class App {
  constructor() {
    this.A = null; this.B = null; this.vp = null; this.engine = null;
    this.playing = false; this.playFrame = null; this.playFrameB = null; this.playEv = null;
    this.divergence = null; this.bgWords = null; this.evInfo = { A: null, B: null };
    this.fitSticky = null; this.lastLabel = ''; this.longTasks = 0; this.fps = 0;
    this.hoverLoc = null; this.probeSeq = 0; this.inspect = null;
    this.readyWaiters = [];
    this.lastStateQ = 'A'; this.lastHl = ['00', '11']; this.lastBg = { k: 2, p: 0, words: 'auto' };
  }

  async init() {
    try { new PerformanceObserver((l) => { for (const e of l.getEntries()) if (e.duration > 50) this.longTasks++; }).observe({ type: 'longtask', buffered: true }); } catch { /* unsupported */ }
    this.applyTheme(this.readTheme());
    const [machines, presets] = await Promise.all([fetchJSON('machines.json', { machines: [] }), fetchJSON('presets.json', { presets: [] })]);
    this.machines = machines.machines || [];
    this.presetList = presets.presets || [];
    this.presets = Object.fromEntries(this.presetList.map((p) => [p.id, p]));
    const { vs, warnings } = decode(location.hash, this.presets);
    this.pendingFrame = this.presetFrame(location.hash, vs);
    this.store = new Store(vs, this.presets);
    for (const w of warnings) toast(w);
    this.view = new CanvasView(this, { view: $('view'), base: $('cv-base'), over: $('cv-over') });
    this.tape = new TapeStrip(this, $('tapestrip'));
    this.site = new SitePanel(this);
    this.left = mountLeft(this, $('left'));
    this.right = mountRight(this, $('right'));
    this.wireTopbar();
    installKeys((a, o) => this.action(a, o));
    installRulerWheel(this);
    window.addEventListener('popstate', () => this.fromHash());
    window.addEventListener('hashchange', () => { if (location.hash !== this.store.lastHash) this.fromHash(); });
    this.store.subscribe((v, changed, prev, opts) => this.onChange(v, changed, prev, opts));
    const narrow = () => document.getElementById('app').classList.toggle('narrow', window.innerWidth < 1280);
    window.addEventListener('resize', narrow); narrow();
    try {
      const { mod, path } = await loadEngine(this.store.get().engine);
      this.engine = mod.createEngine({ workers: this.store.get().workers || undefined });
      this.engineName = path.includes('mock') ? 'mock (UI stand-in)' : path.includes('stub') ? 'stub' : 'real';
      if (this.engineName.startsWith('mock') && this.store.get().engine !== 'mock') toast('engine: using the UI stand-in (ui/engine-client.mjs not available yet)');
    } catch (e) {
      toast('no engine could be loaded: ' + (e.message || e), { bad: true, ms: 8000 });
      return;
    }
    await this.openRuns(true);
    this.refresh();
    this.installTestHook();
    // tile watchdog: re-request visible tiles that stopped arriving (cheap no-op while everything is final)
    setInterval(() => { if (this.vp && this.engine && !this.view.allFinal) { this.view.request(this.vp); this.view.invalidate(); } }, 1000);
  }

  // ------------------------------------------------------------------ theme
  readTheme() { try { return localStorage.getItem('stx-theme') || 'auto'; } catch { return 'auto'; } }
  applyTheme(t) {
    this.theme = t;
    if (t === 'auto') document.documentElement.removeAttribute('data-theme'); else document.documentElement.setAttribute('data-theme', t);
    try { localStorage.setItem('stx-theme', t); } catch { /* private mode */ }
    const b = $('theme-btn'); if (b) b.textContent = t === 'auto' ? '◐' : t === 'light' ? '☀' : '☾';
    if (this.view) this.refresh();
  }

  // ------------------------------------------------------------------ top bar
  wireTopbar() {
    const tm = $('tm');
    tm.value = this.store.get().tm;
    tm.__apply = () => this.applyTmField(tm.value);
    tm.__revert = () => { tm.value = this.store.get().tm; tm.classList.remove('bad'); };
    document.querySelector('.topbar').addEventListener('click', (e) => {
      const b = e.target.closest('[data-act]');
      if (!b) return;
      const act = b.dataset.act;
      if (act === 'apply-tm') this.applyTmField(tm.value);
      else if (act === 'machines') this.machinePopover(b);
      else if (act === 'presets') this.presetPopover(b);
      else if (act === 'theme') this.applyTheme(this.theme === 'auto' ? 'light' : this.theme === 'light' ? 'dark' : 'auto');
      else this.action(act, {});
    });
    for (const b of $('steps-seg').children) b.addEventListener('click', () => this.store.set({ steps: +b.dataset.steps }));
  }

  applyTmField(text) {
    const tmEl = $('tm');
    let t = (text || '').trim();
    const u = fromBbchallengeURL(t);
    const patch = {};
    if (u) {
      if (u.error) { toast(u.error, { bad: true }); return; }
      t = u.tm;
      toast(`bbchallenge link converted${u.steps ? ` (site steps ${int(u.steps)})` : ''}`);
    }
    t = t.toUpperCase();
    if (!t) return;
    tmEl.value = t; tmEl.__orig = t;
    if (t === this.store.get().tm) return;
    this.openMachine(t, patch);
  }

  openMachine(tm, extra = {}) {
    const vs = this.store.get();
    // view settings carry over, except what was tuned for the previous machine: a preset's rows / highlights /
    // background / style, and every-K rows (K is chosen per machine and run length)
    const reset = {};
    if (vs.preset) { const d = defaults(); Object.assign(reset, { rows: d.rows, hl: [], hlm: d.hlm, bg: null, style: d.style, frame: d.frame, pool: d.pool }); }
    if (vs.rows.kind === 'every') reset.rows = { kind: 'auto' };
    this.pendingFrame = null;
    this.store.set({ tm, start: { kind: 'blank' }, s0: 0, t: null, x: null, zt: null, zx: null, pin: null, play: null, marks: [], follow: true, preset: null, cmp: null, ...reset, ...extra }, { push: true });
  }

  /** A preset's declared window ({steps:[a,b], cells:[c,d]}): fitted to this window once the run is open, unless
   *  the link fixes the view itself (t / x / zt / zx). */
  presetFrame(hash, vs) {
    const pre = vs.preset && this.presets[vs.preset];
    if (!pre || !pre.view) return null;
    const keys = new Set(parsePairs(hash).map(([k]) => k));
    return ['t', 'x', 'zt', 'zx'].some((k) => keys.has(k)) ? null : pre.view;
  }

  /** Frame a cell range and/or a step range: the largest zoom per axis that shows all of it (centred in space). */
  frameRanges(fr) {
    const vs = this.store.get(), vp = this.derive(), pane = vp.panes[0] || { w: vp.W };
    const patch = { follow: false, sq: false };
    if (fr.cells) {
      const [a, b] = fr.cells, zx = fitIndex(b - a + 1, pane.w);
      patch.zx = zx; patch.x = (a + b + 1) / 2 - pane.w / 2 / ppu(zx);
    }
    if (fr.steps && isTimeRows(vs.rows)) {
      const b0 = Math.ceil(baseOfStep(vs.rows, Math.max(vs.s0 || 0, fr.steps[0]))), b1 = Math.floor(baseOfStep(vs.rows, fr.steps[1]));
      patch.zt = fitIndex(Math.max(1, b1 - b0 + 1), vp.H); patch.t = b0;
    }
    if (!this.store.set(patch).length) this.refresh();
  }

  machinePopover(anchor) {
    const items = this.machines.map((m, i) => ({
      t: `${m.rank ? '#' + m.rank + ' ' : ''}${m.name || m.class || ''}`, s: m.summary || '', tm: m.tm, cur: m.tm === this.store.get().tm,
      run: () => this.openMachine(m.tm, m.steps ? { steps: m.steps } : {}),
    }));
    this.popover(anchor, items, 'Machines (n / Shift+N step through)');
  }

  presetPopover(anchor) {
    const items = this.presetList.map((p) => ({ t: p.title, s: p.caption, tm: p.id + (p.reproduces ? ` → ${p.reproduces.split('/').pop()}` : ''), cur: p.id === this.store.get().preset, run: () => this.applyPreset(p.id) }));
    this.popover(anchor, items, 'Presets: the pilot cards, with labels');
  }

  applyPreset(id) {
    const { vs, warnings } = decode('#preset=' + id, this.presets);
    for (const w of warnings) toast(w);
    vs.preset = id;
    this.pendingFrame = this.presetFrame('#preset=' + id, vs);
    this.store.set({ ...defaults(), ...vs }, { push: true });
    this.refresh();
  }

  popover(anchor, items, title) {
    const pop = $('popover');
    clear(pop);
    if (title) pop.append(h('div', { class: 'note', style: { padding: '4px 8px' } }, title + ' · ↑ ↓ Enter'));
    this.popEls = [];
    this.popSel = Math.max(0, items.findIndex((it) => it.cur));
    for (const it of items) {
      const el = h('div', { class: 'item' + (it.cur ? ' cur' : '') }, h('span', { class: 't' }, it.t), it.s ? h('span', { class: 's' }, it.s) : null, it.tm ? h('span', { class: 'tm' }, it.tm) : null);
      el.addEventListener('click', () => { this.closePopover(); it.run(); });
      pop.append(el);
      this.popEls.push({ el, run: it.run });
    }
    this.popMove(0);
    const r = anchor.getBoundingClientRect();
    pop.style.left = Math.min(r.left, window.innerWidth - 420) + 'px';
    pop.style.top = (r.bottom + 4) + 'px';
    pop.style.maxWidth = '520px';
    pop.hidden = false;
    const close = (e) => { if (!pop.contains(e.target) && e.target !== anchor) { this.closePopover(); } };
    setTimeout(() => window.addEventListener('pointerdown', close, { once: true, capture: true }), 0);
  }
  closePopover() { $('popover').hidden = true; this.popEls = null; }

  /** Keyboard selection inside an open list popover (arrows move, Enter opens). */
  popMove(d) {
    if (!this.popEls || !this.popEls.length) return;
    this.popSel = (this.popSel + d + this.popEls.length) % this.popEls.length;
    this.popEls.forEach((p, i) => p.el.classList.toggle('sel', i === this.popSel));
    this.popEls[this.popSel].el.scrollIntoView({ block: 'nearest' });
  }

  // ------------------------------------------------------------------ runs
  async resolveStart(start) {
    if (!start || start.kind !== 'config' || !start.src) return start;
    if (start.dh) return start;
    const path = start.src.replace(/^@/, '');
    try {
      const r = await fetch('../../' + path, { cache: 'no-cache' });
      if (!r.ok) throw new Error(`${r.status}`);
      const txt = (await r.text()).trim();
      return { ...start, dh: txt };
    } catch (e) { throw { code: ERR.CONFIG, message: `cannot load ${path}: ${e.message || e}` }; }
  }

  async openRuns(first) {
    await this.openSession('A');
    await this.openSession('B');
  }

  async openSession(which) {
    const vs = this.store.get();
    const old = this[which];
    if (old && old.session) {
      try { old.session.close(); } catch { /* closed */ }
      this.view.forgetSession(old.session.sid);
    }
    if (old && old.unsub) old.unsub.forEach((u) => u());
    this[which] = null;
    this.evInfo[which] = null;
    if (which === 'A') { this.divergence = null; this.stopPlay(); this.playFrame = null; this.inspect = null; this.fitSticky = null; }
    if (this.view.req[which]) { try { this.view.req[which].handle.cancel(); } catch { /* */ } this.view.req[which] = null; }
    let tm = vs.tm, start = vs.start;
    if (which === 'B') {
      if (!vs.cmp || !vs.cmp.tm) { this.refresh(); return; }
      tm = vs.cmp.tm;
      start = vs.cmp.start === 'same' || !vs.cmp.start ? vs.start : vs.cmp.start === 'blank' ? { kind: 'blank' } : vs.cmp.start;
    }
    if (!tm) { this.refresh(); return; }
    const slot = { session: null, info: null, machine: null, ov: null, unsub: [], opening: true };
    this[which] = slot;
    this.refresh();
    try {
      const st = await this.resolveStart(start);
      if (which === 'A' && st !== start && st.dh) this.resolvedStart = st;
      const S = await this.engine.open({ tm, start: st, s0: vs.s0, steps: vs.steps });
      if (this[which] !== slot) { S.close(); return; }
      slot.session = S; slot.machine = S.machine; slot.info = S.info(); slot.opening = false; slot.start = st;
      slot.unsub.push(S.on('progress', (info) => { slot.info = info; this.onProgress(which); }));
      slot.unsub.push(S.on('overview', () => { slot.ov = this.engine.overview(S.sid); this.view.invalidate(); }));
      slot.unsub.push(S.on('done', (info) => { slot.info = info; slot.ov = this.engine.overview(S.sid); this.onProgress(which, true); }));
      slot.unsub.push(S.on('error', (e) => toast(e && e.code === 'E_VERSION' ? 'engine/UI version mismatch: press Ctrl+F5' : `${which}: ${e.message}`, { bad: true, ms: 6000 })));
      slot.ov = this.engine.overview(S.sid);
      if (which === 'A') {
        $('tm').classList.remove('bad');
        if (S.machine.text !== vs.tm) this.store.set({ tm: S.machine.text }, { push: false });
        const r = this.store.get().rows;
        if ((r.kind === 'state' && r.q.charCodeAt(0) - 65 >= S.machine.n) || (r.kind === 'trans' && !S.machine.names.includes(r.tr))) this.store.set({ rows: { kind: 'auto' } });
        if (this.store.get().bg) this.computeBgWords();
      }
      if (this.A && this.A.session && this.B && this.B.session) this.findDivergence();
      if (this.store.get().play) this.preparePlayFrame();
    } catch (e) {
      slot.opening = false; slot.error = e;
      if (which === 'A') $('tm').classList.add('bad');
      toast(`${which === 'B' ? 'compare machine: ' : ''}${e.message || e}`, { bad: true, ms: 6000 });
    }
    this.refresh();
  }

  onProgress(which, done) {
    const slot = this[which];
    if (!slot || !slot.session) return;
    if (done || !this._ovT || performance.now() - this._ovT > 240) { slot.ov = this.engine.overview(slot.session.sid); this._ovT = performance.now(); }
    const vs = this.store.get();
    if (isEventRows(vs.rows)) this.updateEventCount(which);
    if (done) {
      this.resolveReady();
      if (which === 'A' && this.B && this.B.session && !this.divergence) this.findDivergence();
    }
    this.refresh();
  }

  async updateEventCount(which) {
    const slot = this[which];
    if (!slot || !slot.session) return;
    try {
      const r = await this.engine.eventCount(slot.session.sid, this.store.get().rows);
      this.evInfo[which] = { ...r, rowsKey: JSON.stringify(this.store.get().rows) };
      this.refresh();
    } catch { /* closed */ }
  }

  async findDivergence() {
    const vs = this.store.get();
    if (!this.A || !this.B || !this.A.session || !this.B.session) return;
    try {
      const d = await this.engine.diverge(this.A.session.sid, this.B.session.sid, vs.steps);
      this.divergence = d;
      if (d.step === null && d.reason) this.right.note && this.right.note(`compare: ${d.reason}`);
      this.view.invalidate(); this.refresh();
    } catch (e) { console.warn(e); }
  }

  async computeBgWords() {
    const vs = this.store.get();
    const prev = this.bgWords;
    if (!vs.bg) { this.bgWords = null; this.view.restyle(); return; }
    if (prev && prev[0] && prev[0].length !== vs.bg.k) this.bgWords = null;
    if (Array.isArray(vs.bg.words)) { this.bgWords = vs.bg.words.slice(); this.view.restyle(); return; }
    if (!this.A || !this.A.session) return;
    const vp = this.vp, info = this.A.info;
    let step = info ? info.t : 0;
    if (vp && isTimeRows(vs.rows)) {
      const mid = vp.t + (vp.H / 2) / axis(vp.t, vp.zt, vp.H).ppu;
      step = Math.max(vs.s0, Math.min(info.t, Math.round(stepOfBase(vs.rows, mid))));
    }
    try {
      const st = await this.engine.blockStats(this.A.session.sid, step, vs.bg.k);
      const ph = st.find((x) => x.p === vs.bg.p) || st[0];
      const top = ph && ph.words.length ? ph.words[0][0] : '0'.repeat(vs.bg.k);
      const words = rotations(top);
      this.bgStats = st;
      if (JSON.stringify(words) === JSON.stringify(prev)) { this.bgWords = prev; return; }
      this.bgWords = words;
    } catch (e) { this.bgWords = null; }
    this.view.restyle();
    this.refresh();
  }

  // ------------------------------------------------------------------ state changes
  fromHash() {
    const { vs, warnings } = decode(location.hash, this.presets);
    for (const w of warnings) toast(w);
    this.pendingFrame = this.presetFrame(location.hash, vs);
    this.store.set(vs, { silentUrl: true });
    this.refresh();
  }

  onChange(vs, changed, prev, opts) {
    const has = (...ks) => ks.some((k) => changed.includes(k));
    if (has('tm')) { $('tm').value = vs.tm; $('tm').__orig = vs.tm; }
    if (has('tm', 'start', 's0', 'steps')) {
      const onlySteps = changed.every((k) => !['tm', 'start', 's0'].includes(k));
      if (onlySteps && this.A && this.A.session && vs.steps > prev.steps) {
        this.A.session.extend(vs.steps);
        if (this.B && this.B.session) this.B.session.extend(vs.steps);
        this.fitSticky = null;
      } else {
        this.openRuns();
        return;
      }
    }
    if (has('cmp')) {
      const a = prev.cmp, b = vs.cmp;
      if (!a || !b || a.tm !== b.tm || JSON.stringify(a.start) !== JSON.stringify(b.start)) this.openSession('B');
    }
    if (has('rows', 'frame', 'halt') || has('zt', 'zx')) this.view.levelChanged();
    if (has('rows', 'frame')) { this.fitSticky = null; this.playEv = null; }
    if (has('rows') || (has('zt') && prev.zt !== null && vs.zt !== null && Math.min(0, prev.zt) !== Math.min(0, vs.zt))) this.userSpeed = false;
    if (has('rows') && isEventRows(vs.rows)) { this.updateEventCount('A'); if (this.B) this.updateEventCount('B'); }
    if (has('style', 'quirks', 'unv', 'head', 'pool', 'hl', 'hlm')) this.view.restyle();
    if (has('bg') && (!prev.bg || !vs.bg || prev.bg.k !== vs.bg.k || prev.bg.p !== vs.bg.p || JSON.stringify(prev.bg.words) !== JSON.stringify(vs.bg.words))) this.computeBgWords();
    if (has('cmp')) this.view.restyle();
    if (has('play') && !vs.play) this.stopPlay();
    if (has('pin') && !vs.pin && this.inspect && this.inspect.pinned) { this.inspect = null; this.tape.update(); }
    this.refresh();
  }

  onResize() { this.refresh(); }

  // ------------------------------------------------------------------ viewport
  fitSpace(vs, slot) {
    const info = slot && slot.info;
    if (!info) return [0, 0];
    if (vs.frame === 'abs') return [info.extent.lo, info.extent.hi];
    const ov = slot.ov;
    let a = 0, b = 0;
    const rows = ov && ov.t.length ? ov.t.length : 0;
    const each = (lo, hi, pos) => {
      if (vs.frame === 'head') { a = Math.min(a, lo - pos); b = Math.max(b, hi - pos); }
      else if (vs.frame === 'left') { b = Math.max(b, hi - lo); }
      else { a = Math.min(a, lo - hi); }
    };
    for (let i = 0; i < rows; i++) each(ov.lo[i], ov.hi[i], ov.pos[i]);
    each(info.lo, info.hi, info.pos);
    return [a, b];
  }

  fitTime(vs, slot) {
    const info = slot && slot.info;
    const s0 = vs.s0 || 0;
    if (isTimeRows(vs.rows)) {
      const end = info ? (info.halt ? info.halt.step : Math.max(info.target, info.t)) : s0 + vs.steps;
      return [firstBase(vs.rows, s0), Math.floor(baseOfStep(vs.rows, end)) + (info && info.halt ? 1 : 0)];
    }
    const ev = this.evInfo.A;
    const n = ev && ev.rowsKey === JSON.stringify(vs.rows) ? ev.count : 1000;
    return [0, Math.max(1, n - 1) + (info && info.halt ? 1 : 0)];
  }

  derive() {
    const vs = this.store.get(), view = this.view;
    const W = view.W, H = view.H;
    const hasB = !!(vs.cmp && this.B && this.B.session);
    const side = hasB && vs.cmp.view === 'side', diff = hasB && vs.cmp.view === 'diff';
    const gap = side ? 4 : 0;
    const pw = side ? Math.floor((W - gap) / 2) : W;
    const panes = this.A && this.A.session ? (side ? [{ sess: 'A', x0: 0, w: pw }, { sess: 'B', x0: pw + gap, w: pw }] : [{ sess: 'A', x0: 0, w: W }]) : [];
    const fx = this.fitSpace(vs, this.A), ft = this.fitTime(vs, this.A);
    if (side && this.B) { const fb = this.fitSpace(vs, this.B); fx[0] = Math.min(fx[0], fb[0]); fx[1] = Math.max(fx[1], fb[1]); }
    // sticky fit: recompute only when the content no longer fits (or on 'f')
    let evKey = '';
    if (isEventRows(vs.rows)) { const ev = this.evInfo.A; evKey = ev && ev.rowsKey === JSON.stringify(vs.rows) ? `|ev${Math.ceil(Math.log2(ev.count + 1))}` : '|ev?'; }
    // the run's end is part of the key: a halt (or a stop short of the target) shrinks the run and must refit
    const infoA = this.A && this.A.info;
    const endKey = infoA ? (infoA.halt ? `H${infoA.halt.step}` : infoA.status === 'running' ? 'run' : `end${infoA.t}`) : '';
    const key = `${vs.tm}|${JSON.stringify(vs.rows)}|${vs.frame}|${pw}x${H}|${vs.sq}|${hasB}${evKey}|${endKey}|${vs.s0}`;
    let F = this.fitSticky;
    const fitsX = (z) => (fx[1] - fx[0] + 1) * ppu(z) <= pw;
    const fitsT = (z) => (ft[1] - ft[0] + 1) * ppu(z) <= H;
    if (!F || F.key !== key || !fitsX(F.zx) || !fitsT(F.zt)) {
      const zx = fitIndex(fx[1] - fx[0] + 1, pw);
      let zt = fitIndex(ft[1] - ft[0] + 1, H);
      if (vs.sq) zt = Math.min(zt, zx);
      F = this.fitSticky = { key, zx: vs.sq ? Math.min(zx, zt) : zx, zt };
    }
    let zx = vs.zx ?? F.zx, zt = vs.zt ?? F.zt;
    if (vs.sq && vs.rows.kind === 'auto') zt = zx;
    const x = vs.x ?? ((fx[0] + fx[1] + 1) / 2 - pw / 2 / ppu(zx));
    const t = vs.t ?? ft[0];
    // never request tiles that can only hold ABSENT rows before the first row (event ordinal < 0, step < s0)
    const perT = 2 ** -Math.min(0, zt);
    const firstB = isTimeRows(vs.rows) ? firstBase(vs.rows, vs.s0 || 0) : 0;
    const tyMin = Math.floor(Math.floor(firstB / perT) / TILE);
    return { W, H, pw, gap, panes, zx, zt, kx: Math.min(0, zx), kt: Math.min(0, zt), x, t, diff, side, fx, ft, tyMin, firstB };
  }

  /** k-block 'auto' words depend on the view's centre row: recompute (debounced) when it moves a lot. */
  maybeBgWords() {
    const vs = this.store.get();
    if (!vs.bg || Array.isArray(vs.bg.words) || !this.vp || !this.A || !this.A.info) return;
    const info = this.A.info;
    let step = info.t;
    if (isTimeRows(vs.rows)) {
      const at = axis(this.vp.t, this.vp.zt, this.vp.H), mid = this.vp.t + (this.vp.H / 2) / at.ppu;
      step = Math.max(vs.s0, Math.min(info.t, Math.round(stepOfBase(vs.rows, mid))));
    }
    const bucket = `${this.A.session && this.A.session.sid}|${vs.bg.k}|${vs.bg.p}|${Math.round(Math.log2(step + 2) * 4)}|${info.status}`;
    if (bucket === this._bgBucket) return;
    this._bgBucket = bucket;
    clearTimeout(this._bgT);
    this._bgT = setTimeout(() => this.computeBgWords(), 400);
  }

  refresh() {
    if (!this.view) return;
    // a preset's declared window is fitted once the run(s) are open and the canvas has its size
    if (this.pendingFrame && this.A && this.A.session && this.view.W > 1 && this.view.H > 1) {
      const vs = this.store.get();
      if (!vs.cmp || (this.B && !this.B.opening)) {
        const fr = this.pendingFrame; this.pendingFrame = null;
        this.frameRanges(fr);
        return;
      }
    }
    this.vp = this.derive();
    this.maybeBgWords();
    if (this.engine) this.view.request(this.vp);
    this.view.invalidate();
    this.left && this.left.update();
    this.right && this.right.update();
    this.tape && this.tape.update();
    this.updateTopbar();
    this.updatePaneTags();
    this.updateEmpty();
    this.site && this.site.maybeUpdate();
  }

  /** Materialise fit values into the ViewState (before a user pan/zoom). */
  concrete() {
    const vp = this.vp || this.derive();
    return { x: vp.x, t: vp.t, zx: vp.zx, zt: vp.zt };
  }

  afterFrame() {
    drawRulers(this);
    this.updateLabel();
    this.left && this.left.frame && this.left.frame();
    if (this.view.allFinal && this.A && this.A.info && this.A.info.status !== 'running') this.resolveReady();
    this.relocateHover();
  }

  // ------------------------------------------------------------------ label + status
  eventRowsInfo(which = 'A') {
    const vp = this.vp, vs = this.store.get(), slot = this[which];
    if (!vp || !slot || !slot.session || !vp.panes.length) return null;
    const pane = vp.panes[0];
    const at = axis(vp.t, vp.zt, vp.H), per = at.per;
    const px = vp.zt >= 0 ? MAG[vp.zt] : 1;
    const r0 = Math.ceil((-at.origin - px + 1) / px), r1 = Math.floor((vp.H - 1 - at.origin) / px);
    const base = this.view.sigOf(slot.session, vp);
    const ax = axis(vp.x, vp.zx, pane.w);
    const tx = Math.floor(Math.floor(ax.u0 / ax.per) / TILE);
    let count = 0, step0 = null, step1 = null, ev0 = null, haltVisible = false, haltStep = null, absent = false, unknown = false;
    let lastTy = null, d = null;
    for (let r = r0; r <= r1; r++) {
      const ty = Math.floor(r / TILE);
      if (ty !== lastTy) { lastTy = ty; d = this.view.data.get(this.tileKeyOf(base, ty, tx)); }
      if (!d) { unknown = true; continue; }
      const i = r - ty * TILE, fl = d.tile.meta[8 * i + 2];
      if (fl & 8) { absent = true; continue; }
      if (fl & 16) continue;
      const s = d.tile.steps[i];
      if (!Number.isFinite(s)) continue;
      count++; if (step0 === null) { step0 = s; ev0 = d.tile.ev ? d.tile.ev[i] : r * per; } step1 = s;
      if (fl & 4) { haltVisible = true; haltStep = s; }
    }
    if (unknown && !count) return null;
    return { count, step0, step1, ev0, haltVisible, haltStep, absentVisible: absent };
  }

  tileKeyOf(base, ty, tx) { return tileKey(base, ty, tx); }
  rowsKeyCache(r) {
    switch (r.kind) { case 'auto': return 'auto'; case 'every': return r.o ? `every:${r.k}+${r.o}` : `every:${r.k}`; case 'records': return `rec:${r.side}`; case 'state': return r.dir ? `st:${r.q}:${r.dir}` : `st:${r.q}`; default: return `tr:${r.tr}`; }
  }

  label() {
    const vs = this.store.get(), vp = this.vp;
    if (!vp || !this.A) return { start: 'no machine: paste one above, or pick from the list (n)', rows: '–', window: '–', colors: '–', status: 'idle', text: '', legend: [] };
    const pane = vp.panes[0] || { w: vp.W };
    const lv = { W: pane.w, H: vp.H, ax: axis(vp.x, vp.zx, pane.w), at: axis(vp.t, vp.zt, vp.H), zx: vp.zx, zt: vp.zt, kx: vp.kx, kt: vp.kt };
    const st = { m: this.A.machine ? this.A.machine.m : 2, n: this.A.machine ? this.A.machine.n : 7, bgWords: this.bgWords, diff: vp.diff, refining: this.view.refining };
    if (isEventRows(vs.rows)) {
      const ev = this.eventRowsInfo('A'); if (ev) { st.ev = ev; st.absentVisible = ev.absentVisible; }
      if (vs.cmp && this.B && this.B.session) st.evB = this.eventRowsInfo('B');
    }
    let view = vs;
    if (vs.start.kind === 'config' && !vs.start.dh && this.A.start && this.A.start.dh) view = { ...vs, start: { ...vs.start, dh: this.A.start.dh } };
    const lab = makeLabel(view, lv, this.A.info, vs.cmp && this.B ? this.B.info : null, st);
    if (this.A.info && this.A.info.capped) lab.status += ` · capped at ${int(this.A.info.capped)} steps by the UI stand-in engine`;
    return lab;
  }

  updateLabel() {
    const L = this.label();
    const key = [L.start, L.rows, L.window, L.colors].join('\n');
    if (key !== this.lastLabel) {
      this.lastLabel = key;
      for (const [id, txt] of [['l-start', L.start], ['l-rows', L.rows], ['l-window', L.window], ['l-colors', L.colors]]) {
        const el = $(id); el.textContent = txt; el.title = txt;
        // a line that does not fit is set smaller (down to 9 px) before it is ellipsised; the height never changes
        el.style.fontSize = '';
        if (el.scrollWidth > el.clientWidth + 1) {
          const base = parseFloat(getComputedStyle(el).fontSize) || 11.5;
          el.style.fontSize = Math.max(9, Math.floor(base * (el.clientWidth / el.scrollWidth) * 10) / 10) + 'px';
        }
      }
      this.right && this.right.legend && this.right.legend(L);
    }
    const s = $('status').querySelector('.status-text');
    if (s.textContent !== L.status) { s.textContent = L.status; s.title = L.status; }
    s.classList.toggle('halted', !!(this.A && this.A.info && this.A.info.halt));
    const info = this.A && this.A.info;
    const frac = info ? Math.min(1, (info.t - info.s0) / Math.max(1, info.target - info.s0)) : 0;
    $('status-bar').style.width = `${(info && info.status !== 'running' && info.status !== 'paused' ? 1 : frac) * 100}%`;
  }

  /** Compare: a header on each pane naming its machine and its side of the first difference. */
  updatePaneTags() {
    const el = $('pane-tags'), vs = this.store.get(), vp = this.vp;
    const hasB = !!(vs.cmp && this.B && this.B.session && vp);
    const d = this.divergence && this.divergence.step !== null ? this.divergence : null;
    const key = hasB ? JSON.stringify([vp.panes.map((p) => [p.x0, p.w]), vp.diff, vp.W, vs.tm, vs.cmp.tm, d && d.step]) : '';
    if (key === this._tagKey) return;
    this._tagKey = key;
    el.replaceChildren();
    if (!hasB) return;
    const name = (tm) => { const m = this.machines.find((x) => x.tm === tm); return m ? `${m.rank ? '#' + m.rank + ' ' : ''}${m.name || ''}`.trim() : ''; };
    const short = (tm) => (tm.length > 22 ? tm.slice(0, 21) + '…' : tm);
    const sx = 100 / Math.max(1, vp.W);
    if (vp.diff) {
      el.append(h('div', { class: 'pane-tag', style: { left: '4px', bottom: '4px', maxWidth: 'calc(100% - 200px)' } }, `diff · A ${name(vs.tm) || short(vs.tm)} vs B ${name(vs.cmp.tm) || short(vs.cmp.tm)} · orange = A bigger, cyan = B bigger${d ? ` · first difference: ${d.tr} = ${d.a} in A, ${d.b} in B` : ''}`));
      return;
    }
    for (const p of vp.panes) {
      const tm = p.sess === 'A' ? vs.tm : vs.cmp.tm;
      const rule = d ? ` · ${d.tr} → ${p.sess === 'A' ? d.a : d.b}` : '';
      // bottom-left of each pane (the top holds the first-difference marker's label; the Start line has the TMs)
      el.append(h('div', { class: 'pane-tag', style: { left: `calc(${p.x0 * sx}% + 4px)`, bottom: '4px', maxWidth: `calc(${p.w * sx}% - ${p.sess === 'B' ? 200 : 8}px)` } }, `${p.sess} · ${name(tm) || short(tm)}${rule}`));
    }
  }

  updateTopbar() {
    const vs = this.store.get();
    const idx = this.machines.findIndex((m) => m.tm === vs.tm);
    $('mpos').textContent = idx >= 0 ? `${idx + 1}/${this.machines.length}` : `–/${this.machines.length}`;
    for (const b of $('steps-seg').children) b.classList.toggle('on', +b.dataset.steps === vs.steps);
    const info = this.A && this.A.info;
    $('run-toggle').textContent = info && info.status === 'paused' ? '▶' : '❚❚';
    $('run-toggle').title = info && info.status === 'paused' ? 'Resume the simulation' : 'Pause the simulation';
    const link = $('site-link');
    if (vs.tm && this.vp) {
      const pane = this.vp.panes[0] || { w: this.vp.W };
      const [c0, c1] = visibleCells(axis(this.vp.x, this.vp.zx, pane.w), pane.w);
      link.href = bbchallengeURL(vs.tm, Math.min(99999, Math.max(1, Math.round(this.vp.H / ppu(this.vp.zt)))), c1 - c0 + 1, c0);
    }
  }

  updateEmpty() {
    const el = $('empty'), vs = this.store.get();
    const has = !!(vs.tm && this.A && (this.A.session || this.A.opening));
    $('app').classList.toggle('nomachine', !has);
    if (has) { el.hidden = true; return; }
    if (!el.hidden && el.__key === `${vs.tm}|${this.A && this.A.error ? 1 : 0}`) return;
    el.__key = `${vs.tm}|${this.A && this.A.error ? 1 : 0}`;
    el.hidden = false;
    clear(el);
    const card = h('div', { class: 'card' },
      h('h2', {}, vs.tm ? 'Could not open this machine' : 'Space-time explorer'),
      h('div', {}, vs.tm && this.A && this.A.error ? String(this.A.error.message || this.A.error) : 'Paste a machine into the field above (standard text like 1RB1LC_1RC1RB_… or a bbchallenge.org link), or pick one:'),
    );
    const list = h('div', { style: { marginTop: '8px', display: 'grid', gap: '4px', maxHeight: '52vh', overflowY: 'auto', paddingRight: '6px' } });
    for (const m of this.machines) {
      const it = h('div', { style: { cursor: 'pointer' } }, h('b', {}, `${m.rank ? '#' + m.rank + ' ' : ''}${m.name || ''} `), h('span', { style: { color: '#aaa' } }, m.class || ''), h('br'), h('code', {}, m.tm));
      it.addEventListener('click', () => this.openMachine(m.tm, m.steps ? { steps: m.steps } : {}));
      list.append(it);
    }
    card.append(list);
    if (this.presetList.length) {
      const pl = h('div', { style: { marginTop: '10px' } }, h('b', {}, 'Presets (the pilot cards, labelled): '));
      for (const p of this.presetList) { const a = h('a', { href: '#preset=' + p.id, style: { color: '#9cf', marginRight: '10px' } }, p.id); pl.append(a); }
      card.append(pl);
    }
    el.append(card);
  }

  // ------------------------------------------------------------------ hover / pin / inspector
  /** After any view change (keys, wheel, zoom, playback, tiles arriving) the pointer points at something else:
   *  re-locate it, refresh the readout, and re-inspect when it is over a different row or cell. */
  relocateHover() {
    const V = this.view;
    if (!V.hover || !V.hoverDev || V.drag) return;
    const loc = V.locate(V.hoverDev[0], V.hoverDev[1]);
    if (!loc) return;
    V.hover = loc;
    const L = V.lookup(loc);
    const vs = this.store.get();
    const key = `${loc.pane.sess}|${loc.bLev}|${loc.uTex}|${loc.per_t}|${loc.per_x}|${JSON.stringify(vs.rows)}|${vs.frame}|${L ? L.row.step : '-'}|${L ? L.final : ''}`;
    if (key === this._hoverKey) return;
    this._hoverKey = key;
    this.onHover(loc, false);
  }

  onHover(loc, quiet) {
    this.hoverLoc = loc;
    const el = $('hover-text');
    if (!loc) { el.textContent = 'hover the diagram: step, cell and what one pixel holds'; return; }
    el.textContent = this.describe(loc);
    if (!quiet && !this.store.get().pin) this.scheduleInspect(loc);
  }

  /** Hover readout text for a located point. */
  describe(loc) {
    const vs = this.store.get(), vp = this.vp, which = loc.pane.sess;
    const slot = this[which];
    if (!slot || !slot.session) return '';
    const L = this.view.lookup(loc, which);
    const per_x = loc.per_x, per_t = loc.per_t;
    const parts = [];
    const tag = vp.panes.length > 1 || vp.diff ? `${which}: ` : '';
    const fr = vs.frame;
    const relName = fr === 'head' ? 'head' : fr === 'left' ? 'left edge' : fr === 'right' ? 'right edge' : '';
    const u0 = loc.uTex * per_x, u1 = u0 + per_x - 1;
    if (!L) {
      if (isTimeRows(vs.rows)) parts.push(`step ${int(stepOfBase(vs.rows, loc.bLev * per_t))}`);
      else parts.push(`${vs.rows.kind === 'records' ? 'record' : 'event'} #${int(loc.bLev * per_t)}`);
      parts.push(per_x > 1 ? `px = cells ${int(u0)}…${int(u1)}${relName ? ' from the ' + relName : ''}` : `cell ${int(u0)}${relName ? ' from the ' + relName : ''}`);
      parts.push('computing…');
      return tag + parts.join(' · ');
    }
    const r = L.row;
    if (r.flags & 8) return tag + 'no row here (before the start or after the end of the run)';
    if (r.flags & 16) return tag + 'not simulated yet';
    const ev = L.tile.ev ? L.tile.ev[L.i] : null;
    if (ev !== null && Number.isFinite(ev)) parts.push(`${vs.rows.kind === 'records' ? 'record' : vs.rows.kind === 'state' ? 'entry' : 'firing'} #${int(ev)}`);
    parts.push(`step ${int(r.step)}`);
    const anchor = fr === 'head' ? r.pos : fr === 'left' ? r.lo : fr === 'right' ? r.hi : 0;
    const a0 = anchor + u0, a1 = anchor + u1;
    const m = slot.machine.m;
    if (L.tile.kind === 'exact') {
      const v = exactCell(L.tile, L.i, a0);
      parts.push(`cell ${int(a0)}${relName ? ` (${relName}${u0 >= 0 ? '+' : '−'}${int(Math.abs(u0))})` : ''} = ${v >= 0 ? v : v === -1 ? 'never read' : '?'}`);
    } else {
      const P = L.tile.planes, idx = L.i * TILE + L.c, N = per_x, vis = P.vis[idx];
      parts.push(`px = cells ${int(a0)}…${int(a1)}`);
      const cnts = [];
      for (let k = 1; k < m; k++) cnts.push(`${k}s ${int(P['cnt:' + k][idx])}/${int(N)}`);
      parts.push(cnts.join(' · '));
      if (vis < N) parts.push(`${int(N - vis)} never read`);
      for (const p of vs.hl) { const pl = P['pat:' + p]; if (pl) parts.push(`${p} ×${int(pl[idx])}`); }
      if (vs.bg && this.bgWords) { const k = `blk:${vs.bg.k}.${vs.bg.p}.${this.bgWords.join('+')}`; if (P[k]) parts.push(`non-background ${vs.bg.k}-blocks ×${int(P[k][idx])}`); }
    }
    if (r.state >= 0) parts.push(`state ${String.fromCharCode(65 + r.state)}, head at ${int(r.pos)}`);
    else if (r.flags & 4) parts.push('HALTED');
    if (r.next >= 0) parts.push(`next ${slot.machine.names[r.next]} → ${slot.machine.acts[r.next]}`);
    return tag + parts.join(' · ');
  }

  scheduleInspect(loc) {
    clearTimeout(this._inspT);
    this._inspT = setTimeout(() => this.inspectAt(loc), 90);
  }

  /** Probe the configuration under a located point (or the pin) for the inspector. */
  async inspectAt(loc, pinned) {
    const which = loc.pane.sess, slot = this[which];
    if (!slot || !slot.session) return;
    if (!pinned && this.store.get().pin) return;             // a pin wins over a late hover
    const L = this.view.lookup(loc, which);
    if (!L || !Number.isFinite(L.row.step) || (L.row.flags & 24)) return;
    const vs = this.store.get();
    const anchor = vs.frame === 'head' ? L.row.pos : vs.frame === 'left' ? L.row.lo : vs.frame === 'right' ? L.row.hi : 0;
    const cell = anchor + loc.uTex * loc.per_x;
    const seq = ++this.probeSeq;
    try {
      const x0 = cell - 40, x1 = cell + 40 + Math.min(loc.per_x, 4096), hp = L.row.pos;
      const near = hp - 70 >= x0 - 20000 && hp + 70 <= x1 + 20000;
      const pr = await this.engine.probe(slot.session.sid, L.row.step, near ? Math.min(x0, hp - 70) : x0, near ? Math.max(x1, hp + 70) : x1);
      // the tape strip is centred on the head: probe there too when the hovered cell is far from it
      const headProbe = near ? pr : await this.engine.probe(slot.session.sid, L.row.step, hp - 70, hp + 70);
      if (seq !== this.probeSeq || (!pinned && this.store.get().pin)) return;
      this.inspect = { probe: pr, headProbe, cell, per: loc.per_x, which, pinned: !!pinned, loc, row: L.row, ev: L.tile.ev ? L.tile.ev[L.i] : null,
        counts: L.tile.kind === 'pooled' ? this.texelCounts(L, slot.machine.m) : null };
      this.right.update();
      this.tape.update();
    } catch (e) { /* range */ }
  }

  texelCounts(L, m) {
    const P = L.tile.planes, idx = L.i * TILE + L.c, out = { vis: P.vis[idx], cnt: [] };
    for (let k = 1; k < m; k++) out.cnt.push(P['cnt:' + k][idx]);
    out.pats = {};
    for (const k of Object.keys(P)) if (k.startsWith('pat:')) out.pats[k.slice(4)] = P[k][idx];
    return out;
  }

  pinAt(loc) {
    const vs = this.store.get();
    const t = loc.bLev * loc.per_t, x = loc.uTex * loc.per_x;
    if (vs.pin && vs.pin.t === t && vs.pin.x === x) { this.store.set({ pin: null }); return; }
    this.store.set({ pin: { t, x } });
    this.inspectAt(loc, true);
  }

  exactAt(dev) { return this.openMoment(dev); }

  /** Device position of the pinned cell's centre in a pane, or null when it is off screen. */
  pinDev(pane) {
    const vs = this.store.get(), vp = this.vp;
    if (!vs.pin || !vp) return null;
    const ax = axis(vp.x, vp.zx, pane.w), at = axis(vp.t, vp.zt, vp.H);
    const x = vs.pin.x * ax.ppu + ax.origin, y = vs.pin.t * at.ppu + at.origin;
    return x >= 0 && x < pane.w && y >= 0 && y < vp.H ? [pane.x0 + x + ax.ppu / 2, y + at.ppu / 2] : null;
  }

  rowsWord(rows) {
    if (rows.kind === 'auto') return 'every step';
    if (rows.kind === 'every') return `every ${ordinal(rows.k)} step`;
    if (rows.kind === 'records') return 'records rows';
    if (rows.kind === 'state') return `entries into ${rows.q}`;
    return `firings of ${rows.tr}`;
  }

  /**
   * z / double-click / "Exact zoom here": open the moment under the pointer (else the pin, else the centre) at
   * 8 px per cell and per step. It snaps to the row actually drawn in that pixel (in sampled, every-K and event
   * rows that is the real step of that row, not a time between two samples), switches rows to every step at that
   * step, centres it and pins it: the zoom lands exactly on what was pointed at.
   */
  openMoment(dev) {
    const vp = this.vp, vs = this.store.get();
    if (!vp || !vp.panes.length) return;
    const pane0 = vp.panes[0];
    let loc = dev ? this.view.locate(dev[0], dev[1]) : null;
    if (!loc) { const pd = this.pinDev(pane0); if (pd) loc = this.view.locate(pd[0], pd[1]); }
    if (!loc) loc = this.view.locate(pane0.x0 + pane0.w / 2, vp.H / 2);
    if (!loc) return;
    const which = loc.pane.sess, L = this.view.lookup(loc, which);
    let step, rel;
    if (L && Number.isFinite(L.row.step) && !(L.row.flags & 24)) {
      step = L.row.step;
      const r = L.row, anchor = vs.frame === 'head' ? r.pos : vs.frame === 'left' ? r.lo : vs.frame === 'right' ? r.hi : 0;
      if (loc.per_x > 1) {
        // a pooled px: its head cell when the head is in it, else its middle cell
        const u0 = loc.uTex * loc.per_x, hr = r.pos - anchor;
        rel = !(r.flags & F_NOHEAD) && hr >= u0 && hr < u0 + loc.per_x ? hr : u0 + Math.floor(loc.per_x / 2);
      } else rel = loc.uTex;
    } else if (isTimeRows(vs.rows) && this.A && this.A.info) {
      step = Math.max(vs.s0, Math.min(runEnd(this.A.info), Math.round(stepOfBase(vs.rows, loc.bLev * loc.per_t))));
      rel = Math.floor(loc.u);
    } else return this.zoomTo(Z_EXACT, Z_EXACT, dev);      // event rows whose tiles have not arrived yet
    const was = vs.rows.kind !== 'auto' ? this.rowsWord(vs.rows) : vp.zt < 0 ? `every ${ordinal(2 ** -vp.zt)} step` : null;
    this.openAt(which, step, rel, dev ? [dev[0] - loc.pane.x0, dev[1]] : null);
    toast(`step ${int(step)}, cell ${int(rel)}${vs.frame === 'abs' ? '' : ' (' + vs.frame + '-relative)'}: every step around it${was ? ` (was ${was})` : ''}; pinned (Esc unpins)`);
  }

  /** Exact view (8 px per cell and step, every step) centred on frame-relative cell `rel` at `step`, pinned there. */
  openAt(which, step, rel, anim) {
    const vp = this.vp, vs = this.store.get(), pane = vp.panes.find((p) => p.sess === which) || vp.panes[0];
    const p = ppu(Z_EXACT);
    if (vs.rows.kind === 'auto') this.view.startZoomAnim(vp, anim || [pane.w / 2, vp.H / 2]);
    else this.view.levelChanged();
    this.userSpeed = false;
    this.store.set({ rows: { kind: 'auto' }, zx: Z_EXACT, zt: Z_EXACT, sq: false, follow: false,
      x: rel + 0.5 - pane.w / 2 / p, t: step + 0.5 - vp.H / 2 / p, pin: { t: step, x: rel } });
    this.inspectStep(which, step, rel);
  }

  /** Pinned inspector at (step, frame-relative cell) without a pointer location (after openAt). */
  async inspectStep(which, step, rel) {
    const slot = this[which], vs = this.store.get();
    if (!slot || !slot.session) return;
    const seq = ++this.probeSeq;
    try {
      const hp = await this.engine.probe(slot.session.sid, step, 0, 0);
      const anchor = vs.frame === 'head' ? hp.pos : vs.frame === 'left' ? hp.lo : vs.frame === 'right' ? hp.hi : 0;
      const cell = anchor + rel;
      // one probe covering the cell and the head when they are close; else two small ones (the tape strip uses
      // the head's neighbourhood, the inspector the cell's)
      const near = Math.abs(cell - hp.pos) <= 20000;
      const pr = await this.engine.probe(slot.session.sid, step, near ? Math.min(cell - 40, hp.pos - 70) : cell - 40, near ? Math.max(cell + 40, hp.pos + 70) : cell + 40);
      const headProbe = near ? pr : await this.engine.probe(slot.session.sid, step, hp.pos - 70, hp.pos + 70);
      if (seq !== this.probeSeq) return;
      this.inspect = { probe: pr, headProbe, cell, per: 1, which, pinned: true, loc: null, row: null, ev: null, counts: null };
      this.right.update(); this.tape.update();
    } catch { /* out of range */ }
  }

  // ------------------------------------------------------------------ pan / zoom
  panByDevice(ddx, ddy) {
    const vp = this.vp; if (!vp) return;
    const c = this.concrete();
    const px = ppu(c.zx), py = ppu(c.zt);
    this.store.set(this.clampView({ ...c, x: c.x - ddx / px, t: c.t - ddy / py, follow: false }));
  }

  /** Keep part of the run on screen: a pan or zoom never leaves the view entirely before the first row, after
   *  the last row, or outside the visited cells (otherwise it is easy to get lost in an empty, hatched region). */
  clampView(p) {
    const vp = this.vp, vs = this.store.get();
    if (!vp) return p;
    const out = { ...p }, pane = vp.panes[0] || { w: vp.W };
    const evKnown = !isEventRows(vs.rows) || (this.evInfo.A && this.evInfo.A.rowsKey === JSON.stringify(vs.rows));
    if (evKnown && Number.isFinite(out.t) && Number.isFinite(out.zt)) {
      const V = vp.H / ppu(out.zt), lo = vp.ft[0] - V * 0.75, hi = vp.ft[1] + 1 - V * 0.25;
      if (hi >= lo) out.t = Math.min(hi, Math.max(lo, out.t));
    }
    if (this.A && this.A.info && Number.isFinite(out.x) && Number.isFinite(out.zx)) {
      const V = pane.w / ppu(out.zx), lo = vp.fx[0] - V * 0.75, hi = vp.fx[1] + 1 - V * 0.25;
      if (hi >= lo) out.x = Math.min(hi, Math.max(lo, out.x));
    }
    return out;
  }

  panFrac(fx, ft) {
    const vp = this.vp; if (!vp) return;
    const pane = vp.panes[0] || { w: vp.W };
    this.panByDevice(-fx * pane.w, -ft * vp.H);
  }

  zoomTo(zx, zt, dev) {
    const vp = this.vp; if (!vp) return;
    const c = this.concrete(), pane = vp.panes.find((p) => dev && dev[0] >= p.x0 && dev[0] < p.x0 + p.w) || vp.panes[0] || { x0: 0, w: vp.W };
    const anchor = dev ? [dev[0] - pane.x0, dev[1]] : this.zoomAnchor(pane);
    zx = clampZ(zx); zt = clampZ(zt);
    const nx = zoomAbout(c.x, c.zx, zx, anchor[0]), nt = zoomAbout(c.t, c.zt, zt, anchor[1]);
    this.view.startZoomAnim(vp, anchor);
    this.store.set(this.clampView({ x: nx, t: nt, zx, zt, follow: false }));
  }

  zoomAnchor(pane) {
    const vs = this.store.get(), vp = this.vp;
    if (vs.pin) {
      const ax = axis(vp.x, vp.zx, pane.w), at = axis(vp.t, vp.zt, vp.H);
      const x = vs.pin.x * ax.ppu + ax.origin, y = vs.pin.t * at.ppu + at.origin;
      if (x >= 0 && x < pane.w && y >= 0 && y < vp.H) return [x + ax.ppu / 2, y + at.ppu / 2];
    }
    return [pane.w / 2, vp.H / 2];
  }

  zoom(which, dir, dev) {
    const vs = this.store.get(), c = this.concrete();
    let zx = c.zx, zt = c.zt, sq = vs.sq;
    if (which === 'both' || which === 'x') zx += dir;
    if (which === 'both' || which === 't') zt += dir;
    if (which !== 'both') sq = false;
    if (sq && vs.rows.kind === 'auto') zt = zx;
    if (zx > Z_MAX || zt > Z_MAX) { zx = Math.min(zx, Z_MAX); zt = Math.min(zt, Z_MAX); }
    if (sq !== vs.sq) this.store.set({ sq });
    this.zoomTo(zx, zt, dev);
  }

  // ------------------------------------------------------------------ actions (keys + buttons)
  action(a, o = {}) {
    const vs = this.store.get(), vp = this.vp;
    const k = o.shift ? 4 : 1;
    if (this.popEls && !$('popover').hidden) {
      // an open list (machines, presets) takes the arrows and Enter
      if (a === 'pan-down' || a === 'pan-up') return this.popMove(a === 'pan-down' ? 1 : -1);
      if (a === 'page-down' || a === 'page-up') return this.popMove(a === 'page-down' ? 5 : -5);
      if (a === 'pin' && o.key === 'Enter') { const p = this.popEls[this.popSel]; this.closePopover(); return p && p.run(); }
    }
    switch (a) {
      case 'pan-left': return this.panFrac(-k / 8, 0);
      case 'pan-right': return this.panFrac(k / 8, 0);
      case 'pan-up': return this.panFrac(0, -k / 8);
      case 'pan-down': return this.panFrac(0, k / 8);
      case 'page-up': return this.panFrac(0, -1);
      case 'page-down': return this.panFrac(0, 1);
      case 'home': { const c = this.concrete(); return this.store.set({ ...c, t: vp ? vp.ft[0] : 0, follow: false }); }
      case 'end': {
        const c = this.concrete(); const info = this.A && this.A.info; if (!info || !vp) return;
        const per = 2 ** -Math.min(0, c.zt);
        let last = isTimeRows(vs.rows) ? Math.floor(baseOfStep(vs.rows, runEnd(info))) : vp.ft[1];
        if (isTimeRows(vs.rows) && info.halt) last = (Math.floor(last / per) + 1) * per;   // the halting row
        return this.store.set({ ...c, t: last - (vp.H - ppu(c.zt)) / ppu(c.zt), follow: false });
      }
      case 'center-left': case 'center-head': case 'center-right': return this.centerOn(a.slice(7));
      case 'zoom-out': return this.zoom('both', -1);
      case 'zoom-in': return this.zoom('both', 1);
      case 'zoom-out-t': return this.zoom('t', -1);
      case 'zoom-in-t': return this.zoom('t', 1);
      case 'zoom-out-x': return this.zoom('x', -1);
      case 'zoom-in-x': return this.zoom('x', 1);
      case 'fit': {
        // always refit (the fit may be stale even when the view state is already "fit"), and always redraw
        this.fitSticky = null;
        const ch = this.store.set({ x: null, t: null, zx: null, zt: null, follow: true });
        if (!ch.length) this.refresh();
        return;
      }
      case 'square': return this.square();
      case 'exact': {
        const dev = this.hoverLoc && this.view.hoverDev ? this.view.hoverDev : null;
        return this.openMoment(dev);
      }
      case 'reset': {
        this.fitSticky = null;
        const d = defaults();
        return this.store.set({ rows: d.rows, frame: d.frame, style: d.style, x: null, t: null, zx: null, zt: null, sq: false, hl: [], bg: null, pin: null, play: null, quirks: false, unv: false, head: 'style', pool: 'mean', follow: true });
      }
      case 'row-prev': return this.stepRow(-1);
      case 'row-next': return this.stepRow(1);
      case 'play': return this.togglePlay(true);
      case 'play-nofollow': return this.togglePlay(false);
      case 'speed-up': case 'speed-down': {
        const p = vs.play || { t: this.topStep(), speed: this.playSpeed() };
        const cur = this.playSpeed();
        const sp = Math.max(1, Math.min(2 ** 30, a === 'speed-up' ? cur * 2 : cur / 2));
        this.userSpeed = true;
        return this.store.set({ play: { ...p, speed: sp } });
      }
      case 'goto': return this.gotoPrompt();
      case 'seek-head': return this.seekHead();
      case 'toggle-minimap': return this.left && this.left.toggleMinimap && this.left.toggleMinimap();
      case 'view-from-here': return this.viewFromHere();
      case 'cycle-rows': {
        let r;
        if (vs.rows.kind === 'auto' || vs.rows.kind === 'every') r = { kind: 'records', side: 'LR' };
        else if (vs.rows.kind === 'records') r = { kind: 'state', q: this.lastStateQ || 'A' };
        else r = { kind: 'auto' };
        return this.setRows(r);
      }
      case 'cycle-style': return this.store.set({ style: STYLES[(STYLES.indexOf(vs.style) + 1) % STYLES.length] });
      case 'toggle-hl': if (vs.hl.length) { this.lastHl = vs.hl; return this.store.set({ hl: [] }); } return this.store.set({ hl: this.lastHl && this.lastHl.length ? this.lastHl : ['00', '11'] });
      case 'toggle-bg': if (vs.bg) { this.lastBg = vs.bg; return this.store.set({ bg: null }); } return this.store.set({ bg: this.lastBg || { k: 2, p: 0, words: 'auto' } });
      case 'flip-phase': if (vs.bg) return this.store.set({ bg: { ...vs.bg, p: (vs.bg.p + 1) % vs.bg.k } }); return;
      case 'toggle-diff': if (vs.cmp) return this.setCmpView(vs.cmp.view === 'side' ? 'diff' : 'side'); return toast('compare: set a machine B first (left panel)');
      case 'copy-dh': return this.copyDh();
      case 'copy-link': return this.copyLink();
      case 'export': return this.doExport();
      case 'pin': if (this.hoverLoc) this.pinAt(this.hoverLoc); return;
      case 'escape':
        if (!$('help').hidden) return hideHelp();
        if (!$('popover').hidden) return this.closePopover();
        if (this.site.overlayOpen) return this.site.closeOverlay();
        if (this.playing) return this.stopPlay();
        if (vs.pin) return this.store.set({ pin: null });
        return;
      case 'next-machine': case 'prev-machine': {
        if (!this.machines.length) return;
        const i = this.machines.findIndex((m) => m.tm === vs.tm);
        const j = ((i < 0 ? -1 : i) + (a === 'next-machine' ? 1 : -1) + this.machines.length) % this.machines.length;
        const m = this.machines[j];
        return this.openMachine(m.tm, m.steps ? { steps: m.steps } : {});
      }
      case 'site-overlay': return this.site.toggleOverlay();
      case 'toggle-panels': {
        const app = $('app');
        if (app.classList.contains('narrow')) { const open = app.classList.contains('drawer-left'); app.classList.toggle('drawer-left', !open); app.classList.toggle('drawer-right', !open); }
        else app.classList.toggle('collapsed');
        return;
      }
      case 'help': return $('help').hidden ? showHelp(this) : hideHelp();
      case 'steps-x10': return this.store.set({ steps: Math.min(1e13, vs.steps * 10) });
      case 'steps-d10': return this.store.set({ steps: Math.max(1000, Math.floor(vs.steps / 10)) });
      case 'run-toggle': {
        const S = this.A && this.A.session; if (!S) return;
        if (S.info().status === 'paused') S.resume(); else S.pause();
        this.A.info = S.info(); return this.refresh();
      }
      case 'machines': return this.machinePopover(document.querySelector('[data-act=machines]'));
      case 'presets': return this.presetPopover(document.querySelector('[data-act=presets]'));
      default: console.warn('unknown action', a);
    }
  }

  /** Change the rows mode and keep your place: the pinned step (else the top row's step) stays on screen. */
  async setRows(rows) {
    const vs = this.store.get();
    if (rows.kind === 'state') this.lastStateQ = rows.q;
    const patch = { rows, zt: null, t: null, pin: null, follow: true };
    if (!this.vp || !this.A || !this.A.session) { this.store.set(patch); return; }
    const pinStep = vs.pin && this.inspect && this.inspect.pinned ? this.inspect.probe.step : null;
    const keep = pinStep ?? (isTimeRows(vs.rows) ? Math.max(vs.s0, stepOfBase(vs.rows, this.vp.t)) : this.topStep());
    const c = this.concrete();
    this.userSpeed = false;
    if (isTimeRows(rows)) {
      const b = baseOfStep(rows, keep);
      patch.zt = isTimeRows(vs.rows) ? vs.zt : c.zt;
      patch.follow = vs.follow && patch.zt === null;
      // the kept step goes where it was: at the top (top row kept), or a third down (pinned row kept)
      const off = pinStep !== null && patch.zt !== null ? (this.vp.H / 3) / ppu(patch.zt) : 0;
      patch.t = Math.max(firstBase(rows, vs.s0) - (pinStep !== null ? off : 0), b - off);
      if (pinStep !== null && rows.kind === 'auto') patch.pin = { t: pinStep, x: vs.pin.x };
      if (patch.zt === null && patch.t <= firstBase(rows, vs.s0)) patch.t = null;
      this.store.set(patch);
      return;
    }
    // into event rows: the kept step becomes the last event row at or before it
    this.store.set(patch);
    if (keep <= vs.s0) return;
    try {
      const e = await this.engine.eventAtStep(this.A.session.sid, rows, keep);
      if (JSON.stringify(this.store.get().rows) !== JSON.stringify(rows)) return;
      if (e > 0) this.store.set({ t: e, follow: false });
    } catch { /* closed / out of range */ }
  }

  /** Compare: side by side <-> diff. The diff is one pane twice as wide, so space is refitted. */
  setCmpView(view) {
    const vs = this.store.get();
    if (!vs.cmp || vs.cmp.view === view) return;
    this.store.set({ cmp: { ...vs.cmp, view }, x: null, zx: null });
  }

  /**
   * `w`: jump forward to the next time the head enters the visible cells (from the playhead, else the top row).
   * The head moves one cell per step, so when it is d cells outside the window it cannot enter within d − 1 steps:
   * the search advances d steps at a time (exactly, in the engine's cursor) and never skips a visit.
   */
  async seekHead() {
    const vs = this.store.get(), vp = this.vp, S = this.A && this.A.session;
    if (!S || !vp || !this.A.info) return;
    if (!isTimeRows(vs.rows)) return toast('w needs time rows (every step / every K): press r to cycle back');
    if (vs.frame === 'head') return toast('in the head frame the head never leaves the view');
    if (this._seeking) return;
    const pane = vp.panes[0], [c0, c1] = visibleCells(axis(vp.x, vp.zx, pane.w), pane.w);
    const end = runEnd(this.A.info);
    const from = Math.max(vs.s0, (vs.play && this.playFrame ? this.playFrame.step : this.topStep()) + 1);
    if (from > end) return toast('end of the simulated run: ×10 to extend');
    const anchor = (f) => (vs.frame === 'left' ? f.lo : vs.frame === 'right' ? f.hi : 0);
    let cur;
    try { cur = await this.engine.cursor(S.sid, from); } catch (e) { return toast(e.message || String(e)); }
    this._seeking = true;
    const t0 = performance.now();
    let f = cur.frame, it = 0, left = false, found = null;
    try {
      for (;;) {
        const rel = f.pos - anchor(f);
        const inside = !f.halted && rel >= c0 && rel <= c1;
        if (inside && left) { found = f.step; break; }
        if (f.halted || f.step >= end) break;
        // inside: it cannot leave within (distance to the nearer edge) steps; outside: it cannot enter sooner
        const d = inside ? Math.min(rel - c0, c1 - rel) + 1 : rel < c0 ? c0 - rel : rel - c1;
        if (!inside) left = true;
        if (++it % 256 === 0) {
          if (performance.now() - t0 > 10000) { toast(`stopped after 10 s at step ${int(f.step)}: the head stays away (press w again to go on)`); this.store.set({ play: { t: f.step, speed: this.playSpeed() } }); await this.preparePlayFrame(); return; }
          toast(`looking for the head… step ${int(f.step)}`);
        }
        f = await cur.advance(Math.min(d, end - f.step));
      }
    } catch (e) { toast(e.message || String(e)); return; }
    finally { cur.close(); this._seeking = false; }
    if (found === null) return toast(f.halted ? `the machine halts at step ${int(f.step)} before the head comes back` : `the head does not enter cells ${int(c0)} … ${int(c1)} before the end of the run (step ${int(end)})`);
    this.store.set({ play: { t: found, speed: this.playSpeed() } });
    await this.preparePlayFrame();
    const c = this.concrete(), b = baseOfStep(vs.rows, found);
    this.store.set({ ...c, t: b - (vp.H / 3) / ppu(c.zt), follow: false });
    toast(`the head enters the view at step ${int(found)} (${int(found - from + 1)} steps on); playhead there`);
  }

  square() {
    const vs = this.store.get();
    if (vs.sq) return this.store.set({ sq: false });
    const c = this.concrete();
    const patch = { sq: true, follow: false };
    if (vs.rows.kind !== 'auto') {
      if (vs.rows.kind === 'every') {
        toast('square pixels need every step: switched rows to "every step"');
        patch.rows = { kind: 'auto' };
        patch.t = stepOfBase(vs.rows, c.t);
      } else { toast('square pixels need time rows: switched rows to "every step"'); patch.rows = { kind: 'auto' }; patch.t = this.topStep(); }
    }
    const vp = this.vp, pane = vp.panes[0] || { w: vp.W };
    const anchor = this.zoomAnchor(pane);
    const t0 = patch.t ?? c.t;
    patch.t = zoomAbout(t0, c.zt, c.zx, anchor[1]);
    patch.zt = c.zx; patch.zx = c.zx; patch.x = c.x;
    this.view.startZoomAnim(vp, anchor);
    this.store.set(patch);
  }

  topStep() {
    const vs = this.store.get(), vp = this.vp;
    if (!vp) return vs.s0;
    if (isTimeRows(vs.rows)) return Math.max(vs.s0, Math.round(stepOfBase(vs.rows, Math.ceil(vp.t))));
    const ev = this.eventRowsInfo('A');
    return ev && ev.step0 !== null ? ev.step0 : vs.s0;
  }

  async centerOn(which) {
    const vs = this.store.get(), vp = this.vp, S = this.A && this.A.session;
    if (!vp || !S) return;
    const pane = vp.panes[0];
    const at = axis(vp.t, vp.zt, vp.H);
    const midB = (vp.H / 2 - at.origin) / at.ppu;
    let step;
    if (isTimeRows(vs.rows)) step = Math.max(vs.s0, Math.min(this.A.info.t, Math.round(stepOfBase(vs.rows, midB))));
    else { const loc = this.view.locate(pane.x0 + pane.w / 2, vp.H / 2); const L = loc && this.view.lookup(loc); step = L && Number.isFinite(L.row.step) ? L.row.step : this.A.info.t; }
    try {
      const pr = await this.engine.probe(S.sid, step, 0, 0);
      const abs = which === 'left' ? pr.lo : which === 'right' ? pr.hi : pr.pos;
      const anchor = vs.frame === 'head' ? pr.pos : vs.frame === 'left' ? pr.lo : vs.frame === 'right' ? pr.hi : 0;
      const c = this.concrete();
      this.store.set({ ...c, x: abs - anchor - pane.w / 2 / ppu(c.zx), follow: false });
    } catch (e) { toast(e.message || String(e)); }
  }

  viewFromHere() {
    const vs = this.store.get();
    const loc = this.hoverLoc || null;
    let b = null;
    if (loc) b = loc.bLev * loc.per_t; else if (vs.pin) b = vs.pin.t;
    if (b === null) return toast('point at a row first (or pin one), then press o');
    const c = this.concrete();
    this.store.set({ ...c, t: b, follow: false });
    toast('the top row is now that row; the steps before it are still simulated, just not shown');
  }

  gotoPrompt() {
    const pop = $('popover'); clear(pop); this.popEls = null;
    const vs = this.store.get();
    const inp = h('input', { class: 'field wide', type: 'text', inputmode: 'numeric', spellcheck: 'false', placeholder: isTimeRows(vs.rows) ? 'step, e.g. 1e9 or 9_786_531' : '#event or step' });
    inp.__apply = () => { this.closePopover(); this.goto(inp.value); };
    inp.__revert = () => this.closePopover();
    pop.append(h('div', { class: 'note', style: { padding: '4px 6px' } }, 'Go to a step (top row) — Enter to go, Esc to cancel'), inp);
    const r = $('view').getBoundingClientRect();
    pop.style.left = (r.left + 20) + 'px'; pop.style.top = (r.top + 20) + 'px';
    pop.hidden = false;
    inp.focus();
  }

  async goto(text) {
    const vs = this.store.get(), c = this.concrete();
    const s = text.trim();
    if (s.startsWith('#')) {
      const i = parseCount(s.slice(1));
      if (i === null) return toast(`not a number: ${s}`);
      if (isEventRows(vs.rows)) return this.store.set({ ...c, t: i, follow: false });
      return toast('#event needs event rows (records / state / transition)');
    }
    const step = parseCount(s);
    if (step === null) return toast(`not a step: ${s}`);
    if (isTimeRows(vs.rows)) return this.store.set({ ...c, t: baseOfStep(vs.rows, step), follow: false });
    try { const b = await this.engine.eventAtStep(this.A.session.sid, vs.rows, step); this.store.set({ ...c, t: Math.max(0, b), follow: false }); } catch (e) { toast(e.message || String(e)); }
  }

  /** Step of the pinned row, else playhead, else top row. */
  focusStep() {
    const vs = this.store.get();
    if (this.inspect && this.inspect.pinned) return this.inspect.probe.step;
    if (this.playFrame) return this.playFrame.step;
    return this.topStep();
  }

  async copyDh() {
    const S = this.A && this.A.session; if (!S) return;
    try {
      const pr = await this.engine.probe(S.sid, this.focusStep(), 0, 0);
      await copyText(pr.dh);
      toast(`copied the tape at step ${int(pr.step)} (${pr.dh.length} chars)`);
    } catch (e) { toast(e.message || String(e)); }
  }

  shareHash() {
    const vs = { ...this.store.get() };
    if (vs.start.kind === 'config' && vs.start.src && this.A && this.A.start && this.A.start.dh && this.A.start.dh.length <= 16384) {
      vs.start = { ...vs.start, dh: this.A.start.dh, src: undefined };
    }
    return '#' + encode(vs);
  }

  async copyLink() {
    const url = location.origin + location.pathname + this.shareHash();
    await copyText(url);
    toast('link copied: it restores exactly this view');
  }

  async doExport() {
    try {
      const png = await exportPNG(this);
      const name = `${this.store.get().tm}__${this.store.get().preset || this.rowsKeyCache(this.store.get().rows).replace(/[:+]/g, '-')}.png`;
      downloadPNG(png, name);
      toast(`exported ${name}`);
    } catch (e) { toast('export failed: ' + (e.message || e), { bad: true }); }
  }

  // ------------------------------------------------------------------ playback
  /** Steps between two rows on screen right now (time rows: K x 2^-zt; event rows: the average gap in view). */
  rowSpacing() {
    const vs = this.store.get(), vp = this.vp;
    if (!vp) return 1;
    if (isTimeRows(vs.rows)) return (vs.rows.kind === 'every' ? vs.rows.k : 1) * 2 ** -Math.min(0, vp.zt);
    const ev = this.eventRowsInfo('A');
    return ev && ev.count > 1 ? Math.max(1, (ev.step1 - ev.step0) / (ev.count - 1)) : 1;
  }

  /** Playback speed in steps/s. Unless set with + / −, it follows the zoom: 8 rows per second on screen. */
  playSpeed() {
    const vs = this.store.get();
    if (this.userSpeed && vs.play) return vs.play.speed;
    return Math.max(1, Math.min(2 ** 30, 2 ** Math.round(Math.log2(8 * this.rowSpacing()))));
  }

  playheadBase() {
    const vs = this.store.get();
    const step = this.playFrame ? this.playFrame.step : vs.play ? vs.play.t : null;
    if (step === null) return null;
    if (isTimeRows(vs.rows)) return baseOfStep(vs.rows, step);
    return this.playEv;
  }

  async preparePlayFrame() {
    const vs = this.store.get();
    if (!vs.play || !this.A || !this.A.session) return;
    try {
      if (!this.cursor) this.cursor = await this.engine.cursor(this.A.session.sid, Math.min(vs.play.t, this.A.info.t));
      this.playFrame = await this.cursor.seek(Math.min(vs.play.t, this.A.info.t));
      if (this.B && this.B.session) {
        if (!this.cursorB) this.cursorB = await this.engine.cursor(this.B.session.sid, this.playFrame.step);
        this.playFrameB = await this.cursorB.seek(Math.min(this.playFrame.step, this.B.info.t));
      }
      this.syncPlayEv();
      this.tape.update(); this.right.update(); this.view.invalidate();
    } catch (e) { console.warn(e); }
  }

  async syncPlayEv() {
    const vs = this.store.get();
    if (!isEventRows(vs.rows) || !this.playFrame || !this.A || !this.A.session) { this.playEv = null; return; }
    try { this.playEv = await this.engine.eventAtStep(this.A.session.sid, vs.rows, this.playFrame.step); this.view.invalidate(); } catch { /* */ }
  }

  async togglePlay(follow) {
    if (this.playing) { this.stopPlay(); return; }
    const vs = this.store.get(), S = this.A && this.A.session;
    if (!S) return;
    const startStep = vs.play ? vs.play.t : vs.pin && this.inspect && this.inspect.pinned ? this.inspect.probe.step : this.topStep();
    const speed = this.playSpeed();
    this.store.set({ play: { t: startStep, speed } });
    this.followPlay = follow;
    try {
      if (this.cursor) { this.cursor.close(); this.cursor = null; }
      if (this.cursorB) { this.cursorB.close(); this.cursorB = null; }
      this.cursor = await this.engine.cursor(S.sid, Math.min(startStep, this.A.info.t));
      this.playFrame = this.cursor.frame;
      if (this.B && this.B.session) { this.cursorB = await this.engine.cursor(this.B.session.sid, this.playFrame.step); this.playFrameB = this.cursorB.frame; }
    } catch (e) { toast(e.message || String(e)); return; }
    this.playing = true; this.playAcc = 0; this.playLast = performance.now(); this.playBusy = false;
    const tick = async () => {
      if (!this.playing) return;
      const now = performance.now(), dt = Math.min(0.25, (now - this.playLast) / 1000); this.playLast = now;
      const sp = this.playSpeed();
      this.playAcc += sp * dt;
      const n = Math.floor(this.playAcc);
      if (n >= 1 && !this.playBusy) {
        this.playAcc -= n;
        this.playBusy = true;
        try {
          const before = this.playFrame.step;
          this.playFrame = await this.cursor.advance(n);
          if (this.cursorB) this.playFrameB = await this.cursorB.advance(this.playFrame.step - (this.playFrameB ? this.playFrameB.step : before));
          this.lastFired = this.playFrame.fired;
          if (this.playFrame.step === before) {
            this.stopPlay();
            const info = this.A.info;
            toast(this.playFrame.halted ? 'the machine halted here' : info.status === 'running' ? 'caught up with the simulation; it is still running' : 'end of the simulated run: ×10 to extend');
          }
          this.store.set({ play: { t: this.playFrame.step, speed: sp } }, { silentUrl: false });
          if (isEventRows(this.store.get().rows) && (!this._evT || now - this._evT > 100)) { this._evT = now; this.syncPlayEv(); }
          if (this.followPlay) this.followPlayhead();
          this.tape.update(); this.right.updateTable && this.right.updateTable();
        } finally { this.playBusy = false; }
      }
      this.playRaf = requestAnimationFrame(tick);
    };
    this.playRaf = requestAnimationFrame(tick);
    this.refresh();
  }

  followPlayhead() {
    const vp = this.vp; if (!vp) return;
    const b = this.playheadBase(); if (b === null) return;
    const py = ppu(vp.zt), y = (b - vp.t) * py;
    if (y > vp.H * 0.75 || y < 0) {
      const c = this.concrete();
      this.store.set({ ...c, t: b - (vp.H * 2 / 3) / py, follow: false }, { silentUrl: true });
    }
  }

  stopPlay() {
    if (!this.playing) return;
    this.playing = false;
    cancelAnimationFrame(this.playRaf);
    this.refresh();
  }

  async stepRow(dir) {
    const vs = this.store.get(), S = this.A && this.A.session;
    if (!S) return;
    const cur = this.playFrame ? this.playFrame.step : vs.play ? vs.play.t : this.focusStep();
    let next;
    if (isTimeRows(vs.rows)) {
      const per = 2 ** -Math.min(0, this.vp.zt), spacing = (vs.rows.kind === 'every' ? vs.rows.k : 1) * per;
      next = cur + dir * spacing;
    } else {
      try {
        const e = await this.engine.eventAtStep(S.sid, vs.rows, cur);
        next = await this.engine.stepOfEvent(S.sid, vs.rows, Math.max(0, e + dir));
      } catch { return; }
    }
    next = Math.max(vs.s0, Math.min(this.A.info.t, next));
    this.store.set({ play: { t: next, speed: this.playSpeed() } });
    await this.preparePlayFrame();
    if (this.store.get().follow !== false || true) this.followPlayhead();
  }

  // ------------------------------------------------------------------ ready / test hook
  resolveReady() {
    const left = [];
    if (!this.store.get().tm) { for (const w of this.readyWaiters) w.resolve(true); this.readyWaiters = []; return; }
    for (const w of this.readyWaiters) {
      const doneRun = this.A && this.A.info && this.A.info.status !== 'running' && this.A.info.status !== 'paused';
      const bOk = !this.store.get().cmp || (this.B && this.B.info && this.B.info.status !== 'running');
      if (doneRun && bOk && (!w.final || this.view.allFinal)) w.resolve(true); else left.push(w);
    }
    this.readyWaiters = left;
  }

  installTestHook() {
    const app = this;
    window.__bb6x = {
      version: PROTOCOL_VERSION,
      state: () => JSON.parse(JSON.stringify(app.store.get())),
      set: (partial) => app.store.set(partial),
      ready: ({ final = false } = {}) => new Promise((resolve) => { app.readyWaiters.push({ final, resolve }); app.view.invalidate(); app.resolveReady(); }),
      presets: () => app.presetList.map((p) => p.id),
      label: () => app.label(),
      exportPNG: () => exportPNG(app),
      stats: () => ({ ...(app.engine && app.engine.stats ? app.engine.stats() : {}), frames: app.view.stats.frames, paints: app.view.stats.paints, longTasks: app.longTasks, engine: app.engineName, refining: app.view.refining }),
      app,
    };
  }
}

const app = new App();
window.__stx = app;
app.init().catch((e) => { console.error(e); toast('startup failed: ' + (e.message || e), { bad: true, ms: 10000 }); });
