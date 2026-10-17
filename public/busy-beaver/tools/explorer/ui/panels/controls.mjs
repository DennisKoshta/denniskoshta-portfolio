// Left panel: Start · Rows · Frame · Style · Pool · Highlight · Background · Compare · Zoom · Minimap (spec §11.2).
import { h, btn, seg, toggle, textField, clear, toast } from '../dom.mjs';
import { int, parseCount, pow2 } from '../../core/fmt.mjs';
import { validPattern, isEventRows } from '../../core/viewstate.mjs';
import { ppu, upp, stepOfBase, baseOfStep, isTimeRows, Z_EXACT, fitIndex } from '../../core/lod.mjs';
import { HL_COLORS, STATE_COLORS, STYLE_NAMES } from '../../core/palette.mjs';
import { Minimap } from '../minimap.mjs';
import { compareSection } from './compare.mjs';

const fieldFocused = (el) => el.contains(document.activeElement) && /^(INPUT|TEXTAREA)$/.test(document.activeElement.tagName);

export function mountLeft(app, root) {
  const mm = new Minimap(app);
  const zoomEl = h('div', { class: 'zoom-readout' });
  let lastSig = '';
  let stateCounts = null, stateCountsKey = '';
  let vfEl = null;                      // the "view from step" field: its placeholder always shows the top row's step

  function sec(title, hint, ...kids) {
    return h('div', { class: 'sec' }, h('h3', {}, title, hint ? h('span', { class: 'hint' }, hint) : null), ...kids);
  }

  function startSection(vs) {
    const k = vs.start.kind;
    const s = sec('Start', 'where the run begins',
      h('div', { class: 'rowc' }, seg([['blank', 'blank'], ['site', 'bbchallenge tape'], ['config', 'config…']], k, (v) => {
        if (v === k) return;
        if (v === 'blank') app.store.set({ start: { kind: 'blank' }, s0: 0, t: null, zt: null, x: null, zx: null });
        else if (v === 'site') app.store.set({ start: { kind: 'site', tape: '0' }, s0: 0 });
        else openConfig(vs);
      })));
    if (k === 'site') {
      const f = textField(vs.start.tape, { cls: 'field wide', placeholder: 'e.g. 1 1 B 0 1', apply: (v) => app.store.set({ start: { kind: 'site', tape: v || '0' } }) });
      s.append(h('div', { class: 'rowc' }, f), h('div', { class: 'note' }, 'As on the site: digits are cells, a state letter puts the head on the next digit.'));
    }
    if (k === 'config') {
      const st = vs.start;
      const dh = st.dh || (app.A && app.A.start && app.A.start.dh) || '';
      const ta = h('textarea', { class: 'dh', spellcheck: 'false' }); ta.value = dh;
      const err = h('div', { class: 'note bad' });
      const varsF = textField(st.vars ? Object.entries(st.vars).map(([a, b]) => `${a}=${b}`).join(',') : '', { placeholder: 'vars a=2,b=7', width: '100%' });
      const s0F = textField(String(vs.s0 || 0), { numeric: true, width: '96px', title: 'step number of this configuration' });
      const apply = () => {
        const vars = {};
        for (const kv of varsF.value.split(',').map((x) => x.trim()).filter(Boolean)) { const mo = /^([a-z_]\w*)=(-?\d+)$/i.exec(kv); if (!mo) { err.textContent = `bad var ${kv}`; return; } vars[mo[1]] = +mo[2]; }
        const s0 = parseCount(s0F.value) ?? 0;
        const start = { kind: 'config', dh: ta.value.trim() };
        if (Object.keys(vars).length) start.vars = vars;
        if (st.from) start.from = st.from;
        app.store.set({ start, s0, t: null, zt: null, x: null, zx: null });
      };
      ta.__apply = apply; ta.__revert = () => { ta.value = dh; };
      varsF.__apply = apply; s0F.__apply = apply;
      if (app.A && app.A.error && app.A.error.code === 'E_CONFIG') err.textContent = app.A.error.message;
      s.append(...[ta, h('div', { class: 'rowc' }, varsF), h('div', { class: 'rowc' }, h('label', {}, 'steps numbered from'), s0F),
        h('div', { class: 'rowc' }, btn('Apply', apply, { small: true }), btn('Revert', () => { ta.value = dh; err.textContent = ''; }, { small: true })), err,
        st.src ? h('div', { class: 'note' }, 'from ', st.src.replace(/^@/, '')) : null,
        st.from ? h('div', { class: 'note' }, `= step ${int(st.from.step)} of the blank-tape run`) : null,
        h('div', { class: 'note' }, 'Directed-head notation as in sim.py: 0^inf 1^3 <B 10^2 0^inf. Enter applies; Shift+Enter is a new line.')].filter(Boolean));
    }
    // view-from-step (mid-run views are explicit)
    const top = app.vp ? app.topStep() : 0;
    const vf = textField('', { numeric: true, width: '110px', placeholder: int(top), apply: (v) => { if (v) app.goto(v); vf.value = ''; vf.__orig = ''; } });
    vfEl = vf;
    s.append(h('div', { class: 'rowc', title: 'Top row of the view. The run is still simulated from the start; the rows before are just not shown.' }, h('label', {}, 'view from step'), vf, btn('⇤ start', () => app.action('home'), { small: true, title: 'back to the first row (Home)' })));
    return s;
  }

  function openConfig(vs) {
    const S = app.A && app.A.session;
    const step = app.focusStep();
    if (!S) { app.store.set({ start: { kind: 'config', dh: '0^inf A> 0^inf' }, s0: 0 }); return; }
    app.engine.probe(S.sid, step, 0, 0).then((pr) => {
      app.store.set({ start: { kind: 'config', dh: pr.dhExact, from: { tm: vs.tm, step: pr.step } }, s0: pr.step, t: null, zt: null, x: null, zx: null });
      toast(`start = the configuration at step ${int(pr.step)} (edit it, then Apply)`);
    }).catch(() => app.store.set({ start: { kind: 'config', dh: '0^inf A> 0^inf' }, s0: 0 }));
  }

  function rowsSection(vs) {
    const r = vs.rows, kind = r.kind;
    const s = sec('Rows', 'which configurations become rows',
      h('div', { class: 'rowc' }, seg([['auto', 'each step'], ['every', 'every K'], ['records', 'records'], ['state', 'state'], ['trans', 'rule']], kind, (v) => {
        if (v === kind) return;
        if (v === 'auto') app.setRows({ kind: 'auto' });
        else if (v === 'every') app.setRows({ kind: 'every', k: 1000 });
        else if (v === 'records') app.setRows({ kind: 'records', side: 'LR' });
        else if (v === 'state') app.setRows({ kind: 'state', q: app.lastStateQ || 'A' });
        else app.setRows({ kind: 'trans', tr: (app.A && app.A.machine && app.A.machine.names[0]) || 'A0' });
      })));
    if (kind === 'every') {
      const kf = textField(String(r.k), { numeric: true, width: '96px', apply: (v) => { const k = parseCount(v); if (k && k >= 1) app.setRows({ kind: 'every', k, o: r.o || 0 }); else toast(`not a count: ${v}`); } });
      const of = textField(String(r.o || 0), { numeric: true, width: '60px', apply: (v) => { const o = parseCount(v) ?? 0; app.setRows({ kind: 'every', k: r.k, o }); } });
      s.append(h('div', { class: 'rowc' }, h('label', {}, 'K'), kf, h('label', {}, '+ offset'), of),
        h('div', { class: 'note warn' }, `Sampled: one row per ${int(r.k)} steps; the ${int(r.k - 1)} steps between rows are not drawn.`));
    }
    if (kind === 'records') {
      s.append(h('div', { class: 'rowc' }, seg([['LR', 'L+R'], ['L', 'L'], ['R', 'R']], r.side, (v) => app.setRows({ kind: 'records', side: v }))),
        h('div', { class: 'note' }, 'A row each time the head reaches a new cell (a record). Rows are not evenly spaced in time.'));
    }
    if (kind === 'state') {
      const M = app.A && app.A.machine;
      const n = M ? M.n : 6;
      const chips = h('div', { class: 'rowc' });
      for (let q = 0; q < n; q++) {
        const X = String.fromCharCode(65 + q);
        const col = STATE_COLORS[q] || [200, 200, 200];
        const cnt = stateCounts && stateCounts[X];
        const c = h('span', { class: 'chip' + (r.q === X && !r.dir ? ' on' : ''), title: cnt ? `entries into ${X}: ${int(cnt.all)} (L ${int(cnt.L)}, R ${int(cnt.R)})` : `entries into ${X}` },
          h('span', { class: 'sw', style: { background: `rgb(${col})` } }), X, cnt ? h('span', { class: 'x' }, ' ' + short(cnt.all)) : null);
        c.addEventListener('click', () => app.setRows({ kind: 'state', q: X }));
        chips.append(c);
      }
      s.append(chips, h('div', { class: 'rowc' }, h('label', {}, 'moving'), seg([[null, 'either'], ['L', 'L'], ['R', 'R']], r.dir || null, (v) => app.setRows(v ? { kind: 'state', q: r.q, dir: v } : { kind: 'state', q: r.q }))),
        h('div', { class: 'note' }, 'A row each time the machine enters this state (after s0). Rows are not evenly spaced in time.'));
      loadStateCounts();
    }
    if (kind === 'trans') s.append(h('div', { class: 'note' }, `A row each time ${r.tr} fires. Pick the transition in the table (right panel).`));
    return s;
  }

  function short(n) { return n >= 1e9 ? (n / 1e9).toFixed(1) + 'G' : n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1e3 ? (n / 1e3).toFixed(1) + 'k' : String(n); }

  async function loadStateCounts() {
    const S = app.A && app.A.session, info = app.A && app.A.info;
    if (!S || !info) return;
    const key = `${S.sid}|${info.t}`;
    if (stateCountsKey === key || info.status === 'running') return;
    stateCountsKey = key;
    try {
      const u = await app.engine.usage(S.sid, info.s0, info.t);
      const M = app.A.machine, out = {};
      for (let i = 0; i < u.counts.length; i++) {
        const nx = M.N[i]; if (nx < 0) continue;
        const X = String.fromCharCode(65 + nx);
        out[X] = out[X] || { all: 0, L: 0, R: 0 };
        out[X].all += u.counts[i]; if (M.D[i] < 0) out[X].L += u.counts[i]; else out[X].R += u.counts[i];
      }
      stateCounts = out; lastSig = ''; update();
    } catch { /* closed */ }
  }

  function frameSection(vs) {
    return sec('Frame', 'which cell stays put',
      h('div', { class: 'rowc' }, seg([['abs', 'abs'], ['head', 'head'], ['left', 'left'], ['right', 'right']], vs.frame, (v) => app.store.set({ frame: v, x: null, zx: vs.zx }))),
      vs.frame !== 'abs' ? h('div', { class: 'note' }, `Each row is shifted so its ${vs.frame === 'head' ? 'head' : vs.frame + ' edge'} is in the same column.`) : null);
  }

  function styleSection(vs) {
    return sec('Style', 's cycles',
      h('div', { class: 'rowc' }, seg(Object.entries(STYLE_NAMES).map(([k, v]) => [k, v]), vs.style, (v) => app.store.set({ style: v }))),
      h('div', { class: 'rowc' },
        toggle('site quirks', vs.quirks, (v) => app.store.set({ quirks: v }), 'Default only: draw exactly as bbchallenge.org (no row 0, no head on some fresh cells)'),
        toggle('mark unvisited', vs.unv, (v) => app.store.set({ unv: v }), 'Never-read cells in purple, so they are not confused with 0'),
        toggle('grid', vs.grid, (v) => app.store.set({ grid: v }), 'Cell grid at 8+ px per cell'),
        toggle('head = transition', vs.head === 'trans', (v) => app.store.set({ head: v ? 'trans' : 'style' }), 'Colour the head by the transition about to fire (table colours)')));
  }

  function poolSection(vs) {
    const pooled = app.vp && app.vp.zx < 0;
    const cx = app.vp ? 2 ** -Math.min(0, app.vp.zx) : 1;
    return sec('Pool', pooled ? `${int(cx)} cells per px` : 'zoom out to pool',
      h('div', { class: 'rowc' }, seg([['mean', 'mean'], ['near', 'nearest']], vs.pool, (v) => app.store.set({ pool: v }))),
      h('div', { class: 'note' + (pooled ? '' : ' ') }, pooled
        ? (vs.pool === 'mean' ? `Each pixel mixes the colours of its ${int(cx)} cells (exact counts; hover shows them).` : `Each pixel shows one of its ${int(cx)} cells: the read cell nearest the ${vs.frame === 'abs' ? 'origin' : 'anchor'} (Blaze "speed").`)
        : 'At 1+ px per cell every pixel is one cell; nothing is pooled.'));
  }

  function hlSection(vs) {
    const s = sec('Highlight', 'h toggles');
    const chips = h('div', { class: 'rowc' });
    vs.hl.forEach((p, i) => {
      const c = h('span', { class: 'chip on' }, h('span', { class: 'sw', style: { background: `rgb(${HL_COLORS[i]})` } }), p, h('span', { class: 'x', title: 'remove' }, '✕'));
      c.querySelector('.x').addEventListener('click', () => app.store.set({ hl: vs.hl.filter((_, j) => j !== i) }));
      chips.append(c);
    });
    if (vs.hl.length < 3) {
      const add = textField('', { width: '86px', placeholder: '+ 00, 1011@2.0', apply: (v) => {
        const p = v.replace(/\s/g, '');
        if (!p) return;
        if (!validPattern(p)) { toast(`pattern: digits (≤8), optionally @k.p (positions ≡ p mod k): ${v}`); return; }
        app.store.set({ hl: [...vs.hl, p] });
      } });
      chips.append(add);
    }
    if (!vs.hl.length) chips.append(btn('00 + 11', () => app.store.set({ hl: ['00', '11'] }), { small: true, title: 'the #17 walls: 00 blue, 11 red' }));
    s.append(chips, h('div', { class: 'rowc' }, h('label', {}, 'shade'), seg([['count', 'count'], ['any', 'any'], ['frac', 'share']], vs.hlm, (v) => app.store.set({ hlm: v }))));
    if (vs.hl.length) s.append(h('div', { class: 'note' }, vs.hlm === 'count' ? 'Zoomed out, each pixel shows HOW MANY occurrences start in it (numbered log ramp in the legend; hover for exact counts). Two colours mix: blue + red = purple.' : vs.hlm === 'any' ? 'Full colour if at least one occurrence starts in the pixel.' : 'Intensity = share of positions in the pixel where the pattern starts.'));
    return s;
  }

  function bgSection(vs) {
    const s = sec('Background', 'b toggles, Shift+B phase');
    s.append(h('div', { class: 'rowc' }, seg([[false, 'off'], [true, 'k-block']], !!vs.bg, (v) => app.store.set({ bg: v ? (app.lastBg || { k: 2, p: 0, words: 'auto' }) : null }))));
    if (vs.bg) {
      const kf = textField(String(vs.bg.k), { numeric: true, width: '40px', apply: (v) => { const k = Math.max(1, Math.min(4, parseCount(v) || 2)); app.store.set({ bg: { k, p: 0, words: 'auto' } }); } });
      const ph = [];
      for (let p = 0; p < vs.bg.k; p++) ph.push([p, String(p)]);
      s.append(h('div', { class: 'rowc' }, h('label', {}, 'k'), kf, h('label', {}, 'phase'), seg(ph, vs.bg.p, (v) => app.store.set({ bg: { ...vs.bg, p: v } }))));
      const words = Array.isArray(vs.bg.words) ? vs.bg.words : app.bgWords;
      const wf = textField(Array.isArray(vs.bg.words) ? vs.bg.words.join('+') : '', { width: '120px', placeholder: words ? 'auto: ' + words.join('+') : 'auto', apply: (v) => {
        const ws = v.split(/[+, ]+/).filter(Boolean);
        if (!ws.length) { app.store.set({ bg: { ...vs.bg, words: 'auto' } }); return; }
        if (ws.some((w) => w.length !== vs.bg.k || !/^\d+$/.test(w))) { toast(`background words must be ${vs.bg.k} digits each`); return; }
        app.store.set({ bg: { ...vs.bg, words: ws } });
      } });
      s.append(h('div', { class: 'rowc' }, h('label', {}, 'background'), wf),
        h('div', { class: 'note' }, words ? `Blocks of ${vs.bg.k} cells starting at ${vs.bg.k === 2 ? (vs.bg.p ? 'odd' : 'even') : '≡ ' + vs.bg.p + ' mod ' + vs.bg.k} cells. Background ${words.join('/')} drawn pale; every other block in colour.` : 'finding the most common block…'));
    }
    return s;
  }

  function zoomSection(vs) {
    const s = sec('Zoom', '[ ] both · { } time · < > space');
    s.append(zoomEl, h('div', { class: 'rowc' },
      btn('fit', () => app.action('fit'), { small: true, title: 'f' }),
      btn('1:1', () => app.action('square'), { small: true, on: vs.sq, title: '1: square pixels (1 cell = 1 step)' }),
      btn('exact', () => app.action('exact'), { small: true, title: 'z: 8 px per cell' }),
      h('span', { class: 'sep' }),
      btn('t−', () => app.zoom('t', -1), { small: true, title: '{' }), btn('t+', () => app.zoom('t', 1), { small: true, title: '}' }),
      btn('x−', () => app.zoom('x', -1), { small: true, title: '<' }), btn('x+', () => app.zoom('x', 1), { small: true, title: '>' })));
    // explicit window: type a cell range / step range to frame exactly that (e.g. to reproduce a card)
    const rng = (txt) => {
      const mo = /^\s*([−-]?[\d_,.e]+)\s*(?:\.\.|…|to|\s)\s*([−-]?[\d_,.e]+)\s*$/.exec(txt.replace(/\u2212/g, '-'));
      if (!mo) return null;
      const a = parseCount(mo[1]), b = parseCount(mo[2]);
      return a === null || b === null || b < a ? null : [a, b];
    };
    const vp = app.vp;
    const cellsF = textField('', { width: '120px', placeholder: 'e.g. −349..2250', apply: (v) => {
      const r = rng(v); if (!r) { toast('cells: type a range like −349..2250'); return; }
      const pw = app.vp.panes[0] ? app.vp.panes[0].w : app.vp.W, zx = fitIndex(r[1] - r[0] + 1, pw);
      app.store.set({ ...app.concrete(), x: r[0], zx, sq: false, follow: false });
    } });
    const stepsF = textField('', { width: '120px', placeholder: isTimeRows(vs.rows) ? 'e.g. 12287..12992' : 'rows #0..#500', apply: async (v) => {
      const r = rng(v.replace(/#/g, '')); if (!r) { toast('steps: type a range like 12287..12992'); return; }
      const cur = app.store.get();
      if (!isTimeRows(cur.rows)) {
        const zt = fitIndex(Math.ceil(r[1] - r[0]) + 1, app.vp.H);
        app.store.set({ ...app.concrete(), t: Math.ceil(r[0]), zt, sq: false, follow: false });
        return;
      }
      // time and space: the tape at the end of the range holds every cell visited during it (abs frame)
      let cells = null;
      const S = app.A && app.A.session, info = app.A && app.A.info;
      if (cur.frame === 'abs' && S && info) {
        try { const pr = await app.engine.probe(S.sid, Math.max(cur.s0, Math.min(info.t, r[1])), 0, 0); cells = [pr.lo, pr.hi]; } catch { /* keep space */ }
      }
      app.frameRanges({ steps: r, cells });
    } });
    s.append(h('div', { class: 'rowc', title: 'frame exactly these cells (frame-relative)' }, h('label', {}, 'cells'), cellsF),
      h('div', { class: 'rowc', title: isTimeRows(vs.rows) ? 'frame exactly these steps' : 'frame these event rows' }, h('label', {}, isTimeRows(vs.rows) ? 'steps' : 'rows'), stepsF));
    void vp;
    s.append(h('div', { class: 'note' }, 'Minimap: bottom-right of the diagram (m hides it).'));
    return s;
  }

  function zoomText() {
    const vp = app.vp, vs = app.store.get();
    if (!vp) return '';
    const cpp = upp(vp.zx), K = vs.rows.kind === 'every' ? vs.rows.k : 1;
    const rpp = upp(vp.zt);
    // each axis in the direction that reads as a whole number: "1 px = 64 cells" or "1 cell = 8 px"
    const cell = cpp >= 1 ? `1 px = ${int(cpp)} cell${cpp > 1 ? 's' : ''}${pow2(cpp)}` : `1 cell = ${int(1 / cpp)} px`;
    let t;
    if (isTimeRows(vs.rows)) t = rpp * K >= 1 ? `1 px = ${int(rpp * K)} step${rpp * K > 1 ? 's' : ''}${pow2(rpp * K)}` : `1 step = ${int(1 / rpp)} px`;
    else t = rpp >= 1 ? `1 px = ${int(rpp)} event row${rpp > 1 ? 's' : ''}` : `1 row = ${int(1 / rpp)} px`;
    return `${cell} · ${t}${vs.sq ? ' · locked 1:1' : ''}`;
  }

  function update() {
    const vs = app.store.get();
    const sig = JSON.stringify([vs.start, vs.s0, vs.rows, vs.frame, vs.style, vs.quirks, vs.unv, vs.grid, vs.head, vs.pool, vs.hl, vs.hlm, vs.bg, vs.cmp, vs.sq,
      app.vp && Math.min(0, app.vp.zx), app.bgWords, app.divergence, app.A && app.A.machine && app.A.machine.n, !!(app.A && app.A.error), app.B && !!app.B.session, stateCounts && 1]);
    zoomEl.textContent = zoomText();
    if (sig === lastSig) return;
    if (fieldFocused(root)) return;
    lastSig = sig;
    const scroll = root.scrollTop;
    clear(root);
    root.append(startSection(vs), rowsSection(vs), frameSection(vs), styleSection(vs), poolSection(vs), hlSection(vs), bgSection(vs), compareSection(app, vs, sec), zoomSection(vs));
    root.scrollTop = scroll;
  }

  function topField() {
    if (!vfEl || !app.vp || !app.A || !app.A.session) return;
    const p = int(app.topStep());
    if (vfEl.placeholder !== p) vfEl.placeholder = p;
  }

  // the minimap floats over the bottom-right corner of the diagram (it stays visible at any panel scroll)
  const dock = document.getElementById('view');
  let mmOn = true;
  try { mmOn = localStorage.getItem('stx-minimap') !== '0'; } catch { /* private mode */ }
  mm.cv.classList.add('docked');
  mm.cv.hidden = !mmOn;
  if (dock) dock.append(mm.cv);
  function toggleMinimap() {
    mmOn = !mmOn; mm.cv.hidden = !mmOn; mm.key = '';
    try { localStorage.setItem('stx-minimap', mmOn ? '1' : '0'); } catch { /* private mode */ }
    toast(mmOn ? 'minimap on (m hides it)' : 'minimap hidden (m shows it)');
  }

  return { update, toggleMinimap, frame: () => { if (mmOn) mm.draw(); zoomEl.textContent = zoomText(); topField(); } };
}
