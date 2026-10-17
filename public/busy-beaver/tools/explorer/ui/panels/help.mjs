// Help overlay: the key map (generated from the bindings), pointer actions, how to read a view, version info.
import { h } from '../dom.mjs';
import { BINDINGS } from '../keys.mjs';
import { PROTOCOL_VERSION } from '../../core/protocol.mjs';

const KEYNAME = { ' ': 'Space', ArrowLeft: '←', ArrowRight: '→', ArrowUp: '↑', ArrowDown: '↓', Escape: 'Esc', '\\': '\\' };

export function showHelp(app) {
  const el = document.getElementById('help');
  el.replaceChildren();
  const keys = h('table');
  const seen = new Set();
  for (const b of BINDINGS) {
    const name = (b.shift && b.key.length === 1 && b.key !== ' ' ? 'Shift+' : b.shift ? 'Shift+' : '') + (KEYNAME[b.key] || b.key);
    const id = b.action + name;
    if (seen.has(id)) continue; seen.add(id);
    keys.append(h('tr', {}, h('td', {}, name), h('td', {}, b.desc)));
  }
  const pointer = h('table', {},
    ...[['move', 'readout: step, cell, what one pixel holds'], ['click', 'pin a cell (inspector + tape strip follow it)'], ['drag', 'pan'], ['double-click', 'exact zoom there'],
      ['wheel', 'pan time'], ['Shift+wheel', 'pan space'], ['Ctrl+wheel', 'zoom both axes at the pointer'], ['Alt+wheel', 'zoom time only'], ['Ctrl+Shift+wheel', 'zoom space only']]
      .map(([a, b]) => h('tr', {}, h('td', {}, a), h('td', {}, b))));
  const read = h('div', {},
    h('p', {}, 'Time runs down, cells run right. Every view says on its label: where the run starts (Start), which configurations are rows (Rows), which cells are shown and how many per pixel (Window), and what each colour means (Colors).'),
    h('p', {}, 'Zoomed out, a pixel holds many cells (pooled) or rows are sampled: the label says how many, and the hover readout gives exact counts. Press 1 for square pixels (one cell = one step) and z for an exact close-up.'),
    h('p', {}, 'Rows can also be events: records (the head reaches a new cell), entries into a state, or firings of one transition. Those rows are not evenly spaced in time.'),
    h('p', {}, 'Space plays from the playhead: the tape strip shows the head moving, the table lights the rule about to fire, and rows below the playhead are veiled.'));
  el.append(
    h('h2', {}, 'Space-time explorer: keys and reading guide'),
    h('div', { class: 'cols' }, h('div', {}, h('h3', {}, 'Keys (work the same whatever has focus)'), keys), h('div', {}, h('h3', {}, 'Pointer'), pointer, h('h3', {}, 'How to read a view'), read)),
    h('div', { class: 'ver' }, `protocol v${PROTOCOL_VERSION} · engine: ${app.engineName || '?'} · Esc or ? closes this`),
  );
  const mt = h('div', { class: 'ver' }, 'module dates: …');
  el.append(mt);
  el.hidden = false;
  // stale-module diagnosis (spec §8.9): Last-Modified of the main modules as served
  const files = ['ui/main.mjs', 'ui/canvas-view.mjs', 'core/paint.mjs', 'core/protocol.mjs', 'ui/engine-client.mjs', 'engine/tile-worker.mjs'];
  Promise.all(files.map((f) => fetch(f, { method: 'HEAD', cache: 'no-cache' }).then((r) => (r.ok ? `${f} ${r.headers.get('last-modified') || '?'}` : null)).catch(() => null)))
    .then((xs) => { mt.textContent = 'module dates: ' + xs.filter(Boolean).join(' · '); });
}

export function hideHelp() { document.getElementById('help').hidden = true; }
