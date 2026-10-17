// Transition table: n × m entries with action, state chip, usage over the visible steps, head-tint swatch;
// the rule about to fire (playhead / pin / hover) is outlined. Click = rows "firings of Xs"; Shift+click = tint.
import { h } from '../dom.mjs';
import { STATE_COLORS, TINT } from '../../core/palette.mjs';
import { int } from '../../core/fmt.mjs';
import { timeRows } from '../../core/label.mjs';
import { axis, isTimeRows } from '../../core/lod.mjs';

export class TransitionTable {
  constructor(app) {
    this.app = app;
    this.el = h('div', { class: 'fixh fix-table' });
    this.cells = [];
    this.key = '';
    this.usage = null; this.usageKey = ''; this.usageT = 0; this.flash = new Map();
  }

  build() {
    const app = this.app, M = app.A && app.A.machine;
    this.el.replaceChildren();
    this.cells = [];
    if (!M) return;
    const vs = app.store.get();
    const t = h('table', { class: 'ttable' });
    const hr = h('tr', {}, h('th', { class: 'q' }, ''));
    for (let s = 0; s < M.m; s++) hr.append(h('th', {}, `read ${s}`));
    t.append(hr);
    for (let q = 0; q < M.n; q++) {
      const X = String.fromCharCode(65 + q), col = STATE_COLORS[q];
      const tr = h('tr', { class: M.reachable[q] ? '' : 'unreach', title: M.reachable[q] ? '' : `${X} is unreachable from A` },
        h('th', { class: 'q' }, h('span', { class: 'stchip', style: { background: col ? `rgb(${col})` : '#bbb' } }, X)));
      for (let s = 0; s < M.m; s++) {
        const i = q * M.m + s, act = M.acts[i];
        const nx = act[2];
        const nq = nx ? nx.charCodeAt(0) - 65 : -1;
        const ncol = nq >= 0 && nq < M.n ? STATE_COLORS[nq] : null;
        const td = h('td', { class: (act === '---' ? 'undef ' : '') + (vs.rows.kind === 'trans' && vs.rows.tr === M.names[i] ? 'sel' : ''), title: describe(M, i) },
          h('div', { class: 'act' }, h('span', { class: 'stc', style: { background: ncol ? `rgb(${ncol})` : 'transparent', border: ncol ? 'none' : '1px solid #999' } }), h('span', {}, act),
            h('span', { class: 'tint', style: { background: `rgb(${TINT[i % TINT.length]})` }, title: 'head colour with head = transition' })),
          h('div', { class: 'use' }, h('span', { class: 'pct' }, ''), h('span', { class: 'ubar' }, h('i', { style: { width: '0%' } }))));
        td.addEventListener('click', (e) => {
          if (e.shiftKey) { app.store.set({ head: vs.head === 'trans' ? 'style' : 'trans' }); return; }
          const cur = app.store.get().rows;
          if (cur.kind === 'trans' && cur.tr === M.names[i]) app.setRows({ kind: 'auto' }); else app.setRows({ kind: 'trans', tr: M.names[i] });
        });
        tr.append(td);
        this.cells[i] = td;
      }
      t.append(tr);
    }
    this.el.append(t, h('div', { class: 'note' }, 'Outlined: the rule about to fire at the playhead / pin / hovered row. % = share of the steps in view. Click a rule to make its firings the rows; Shift+click colours the head by rule.'));
  }

  activeIndex() {
    const app = this.app, M = app.A && app.A.machine;
    if (!M) return -1;
    const f = app.playFrame || (app.inspect && app.inspect.probe);
    const nx = f && f.next;
    if (nx) return M.names.indexOf(nx.tr);
    return -1;
  }

  /** Visible step range [t0, t1] for usage. */
  visibleSteps() {
    const app = this.app, vs = app.store.get(), vp = app.vp, info = app.A && app.A.info;
    if (!vp || !info || !vp.panes.length) return null;
    if (isTimeRows(vs.rows)) {
      const lv = { W: vp.panes[0].w, H: vp.H, ax: axis(vp.x, vp.zx, vp.panes[0].w), at: axis(vp.t, vp.zt, vp.H), zx: vp.zx, zt: vp.zt, kx: vp.kx, kt: vp.kt };
      const tr = timeRows(vs, lv, info);
      if (!tr.count) return null;
      return [Math.max(info.s0, tr.step0 - 1), Math.min(info.t, tr.step1)];
    }
    const ev = app.eventRowsInfo('A');
    return ev && ev.count ? [Math.max(info.s0, ev.step0 - 1), Math.min(info.t, ev.step1)] : null;
  }

  async refreshUsage() {
    const app = this.app, S = app.A && app.A.session;
    const r = this.visibleSteps();
    if (!S || !r) return;
    const key = `${S.sid}|${r[0]}|${r[1]}`;
    if (key === this.usageKey) return;
    this.usageKey = key;
    for (const td of this.cells) if (td) td.querySelector('.pct').textContent = '…';
    try {
      const u = await app.engine.usage(S.sid, r[0], r[1]);
      if (this.usageKey !== key) return;
      this.usage = u;
      this.paintUsage();
    } catch { /* closed */ }
  }

  paintUsage() {
    const u = this.usage; if (!u) return;
    let tot = 0; for (const c of u.counts) tot += c;
    this.cells.forEach((td, i) => {
      if (!td) return;
      const c = u.counts[i] || 0, f = tot ? c / tot : 0;
      td.querySelector('.pct').textContent = c ? (f >= 0.001 ? `${(f * 100).toFixed(1)}%` : '<0.1%') : '0';
      td.querySelector('.pct').title = `${int(c)} firings in steps ${int(u.t0)}…${int(u.t1)}`;
      td.querySelector('.ubar i').style.width = `${Math.min(100, f * 100 * 2)}%`;
    });
  }

  update() {
    const app = this.app, M = app.A && app.A.machine, vs = app.store.get();
    const key = JSON.stringify([M && M.text, vs.rows, vs.head]);
    if (key !== this.key) { this.key = key; this.build(); this.usageKey = ''; }
    this.highlight();
    // recompute usage only when the visible step range changed (not on every playback tick)
    const S = app.A && app.A.session, r = this.visibleSteps();
    const want = S && r ? `${S.sid}|${r[0]}|${r[1]}` : '';
    if (want && want !== this.usageKey && want !== this.pendingKey) {
      this.pendingKey = want;
      clearTimeout(this.usageTimer);
      this.usageTimer = setTimeout(() => { this.pendingKey = ''; this.refreshUsage(); }, 300);
    } else if (this.usage && want === this.usageKey) this.paintUsage();
  }

  highlight() {
    const a = this.activeIndex();
    this.cells.forEach((td, i) => { if (td) td.classList.toggle('active', i === a); });
  }
}

function describe(M, i) {
  const act = M.acts[i], X = M.names[i];
  if (act === '---') return `${X}: undefined — the machine halts here`;
  const nq = act[2];
  return `${X}: in state ${X[0]} reading ${X[1]}: write ${act[0]}, move ${act[1] === 'R' ? 'right' : 'left'}, go to ${nq}${nq.charCodeAt(0) - 65 >= M.n ? ' (halt)' : ''}`;
}
