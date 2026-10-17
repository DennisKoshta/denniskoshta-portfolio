// Right panel: Machine · Transition table · Inspector · Legend · bbchallenge view (spec §11.2).
import { h, btn, toast, copyText } from '../dom.mjs';
import { TransitionTable } from './table.mjs';
import { Inspector } from './inspector.mjs';
import { renderLegend } from './legend.mjs';

export function mountRight(app, root) {
  const machineEl = h('div', { class: 'fixh fix-machine' });
  const table = new TransitionTable(app);
  const insp = new Inspector(app);
  const legendEl = h('div', { class: 'fixh fix-legend' });
  const noteEl = h('div', { class: 'note' });
  const sec = (title, hint, ...kids) => h('div', { class: 'sec' }, h('h3', {}, title, hint ? h('span', { class: 'hint' }, hint) : null), ...kids);
  // the inspector comes first: on a laptop-height window it is the only section fully in view without scrolling
  root.append(
    sec('Inspector', 'hover · click pins · z opens', h('div', { class: 'fixh fix-insp' }, insp.el)),
    sec('Machine', '', machineEl),
    sec('Legend', 'every colour on screen', legendEl),
    sec('Transitions', 'click: rows = firings', table.el),
    app.site.section(sec),
  );
  let mkey = '';
  function machine() {
    const vs = app.store.get(), M = app.A && app.A.machine;
    const info = app.machines.find((m) => m.tm === vs.tm);
    const key = JSON.stringify([vs.tm, !!M, info && info.tm, app.divergence && app.divergence.step, vs.preset]);
    if (key === mkey) return;
    mkey = key;
    machineEl.replaceChildren();
    if (!vs.tm) { machineEl.append(h('div', { class: 'note' }, 'no machine')); return; }
    const pre = vs.preset && app.presets[vs.preset];
    if (pre) machineEl.append(...[h('div', { class: 'mclass' }, h('b', {}, `Preset: ${pre.title}`)), h('div', { class: 'note' }, pre.caption), pre.reproduces ? h('div', { class: 'note' }, `reproduces ${pre.reproduces.split('/').slice(-2).join('/')}`) : null].filter(Boolean));
    machineEl.append(h('div', { class: 'rowc' }, h('span', { class: 'mrow' }, vs.tm), btn('copy', async () => { await copyText(vs.tm); toast('machine copied'); }, { small: true })));
    if (M) {
      const unreach = M.reachable.map((r, q) => (r ? null : String.fromCharCode(65 + q))).filter(Boolean);
      machineEl.append(h('div', { class: 'note' }, `${M.n} states × ${M.m} symbols${unreach.length ? ` · unreachable: ${unreach.join(', ')}` : ''}`));
    }
    if (info) {
      machineEl.append(h('div', { class: 'mclass' }, h('b', {}, `${info.rank ? '#' + info.rank + ' ' : ''}${info.name || ''} `), info.class || ''));
      if (info.summary) machineEl.append(h('div', { class: 'note' }, info.summary));
      if (info.mechanism && info.mechanism.length) {
        const d = h('details', {}, h('summary', { class: 'note' }, 'mechanism (from observe.json)'));
        for (const l of info.mechanism) d.append(h('div', { class: 'note' }, '• ' + l));
        machineEl.append(d);
      }
    }
    machineEl.append(noteEl);
  }
  return {
    update() { machine(); table.update(); insp.update(); },
    updateTable() { table.highlight(); },
    legend(label) { renderLegend(legendEl, label); },
    note(t) { noteEl.textContent = t; },
  };
}
