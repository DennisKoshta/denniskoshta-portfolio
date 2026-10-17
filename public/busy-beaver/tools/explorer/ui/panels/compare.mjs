// Compare section (left panel): machine B, its start, side-by-side or diff, and the first difference.
import { h, btn, seg, textField, toast } from '../dom.mjs';
import { int } from '../../core/fmt.mjs';
import { fromBbchallengeURL } from '../../core/url.mjs';
import { baseOfStep, isTimeRows, ppu } from '../../core/lod.mjs';

export function compareSection(app, vs, sec) {
  const s = sec('Compare', 'd: side ↔ diff');
  const cmp = vs.cmp;
  const f = textField(cmp ? cmp.tm : '', { cls: 'field wide', placeholder: 'machine B (empty = off)', apply: (v) => {
    let t = v.trim();
    const u = fromBbchallengeURL(t); if (u) t = u.tm;
    t = t.toUpperCase();
    if (!t) { app.store.set({ cmp: null }); return; }
    app.store.set({ cmp: { tm: t, start: cmp ? cmp.start : 'same', view: cmp ? cmp.view : 'side' } });
  } });
  s.append(h('div', { class: 'rowc' }, f));
  if (cmp) {
    const st = cmp.start === 'same' || cmp.start === 'blank' ? cmp.start : 'config';
    s.append(
      h('div', { class: 'rowc' }, h('label', {}, 'B starts'), seg([['same', 'same as A'], ['blank', 'blank']], st, (v) => app.store.set({ cmp: { ...cmp, start: v } }))),
      h('div', { class: 'rowc' }, h('label', {}, 'view'), seg([['side', 'side by side'], ['diff', 'diff']], cmp.view, (v) => app.setCmpView(v)),
        btn('swap', () => app.store.set({ tm: cmp.tm, cmp: { ...cmp, tm: vs.tm } }), { small: true, title: 'swap A and B' }),
        btn('✕', () => app.store.set({ cmp: null }), { small: true, title: 'stop comparing' })));
    const d = app.divergence;
    if (d && d.step !== null) {
      s.append(h('div', { class: 'note' }, `First difference at step ${int(d.step)}: ${d.tr} is ${d.a} in A, ${d.b} in B. Identical before that.`),
        h('div', { class: 'rowc' }, btn('go to first difference', () => {
          const v = app.store.get();
          if (isTimeRows(v.rows)) { const c = app.concrete(); app.store.set({ ...c, t: baseOfStep(v.rows, d.step) - (app.vp.H / 3) / ppu(c.zt), follow: false }); }
          else app.goto(String(d.step));
          app.store.set({ play: { t: Math.max(v.s0, d.step - 1), speed: v.play ? v.play.speed : 4 } });
          app.preparePlayFrame();
        }, { small: true })));
    } else if (d && d.reason) s.append(h('div', { class: 'note' }, `No first difference: ${d.reason}.`));
    else if (app.B && app.B.session) s.append(h('div', { class: 'note' }, 'looking for the first difference…'));
    if (app.B && app.B.error) s.append(h('div', { class: 'note bad' }, String(app.B.error.message || app.B.error)));
    s.append(h('div', { class: 'note' }, cmp.view === 'diff' ? 'Diff: equal cells faded; orange = A has the bigger symbol, cyan = B does. Zoom in to 1 px per cell or more.' : 'Both machines share rows, zoom and pan. Rows are aligned by row index: the same step (or the k-th record of each).'));
  }
  return s;
}
