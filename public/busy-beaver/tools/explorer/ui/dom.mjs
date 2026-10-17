// Tiny DOM helpers. Controls follow the input rules of spec §13: buttons have tabindex=-1 and never take focus,
// there are no <select>, radio or range inputs, and text inputs are type=text (never type=number).

export function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else if (k === 'text') el.textContent = v;
    else if (k === 'html') el.innerHTML = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of kids.flat()) if (c !== null && c !== undefined && c !== false) el.append(c.nodeType ? c : document.createTextNode(String(c)));
  return el;
}

export function btn(label, onClick, opts = {}) {
  const b = h('button', { class: 'btn' + (opts.small ? ' small' : '') + (opts.on ? ' on' : ''), tabindex: '-1', title: opts.title, type: 'button' }, label);
  b.addEventListener('click', (e) => { e.preventDefault(); onClick(e); });
  if (opts.disabled) b.disabled = true;
  return b;
}

/** Segmented control: options [[value, label, title?]], current value, onPick(value). */
export function seg(options, value, onPick, opts = {}) {
  const el = h('span', { class: 'seg', role: 'group' });
  for (const [v, label, title] of options) {
    const b = btn(label, () => onPick(v), { small: opts.small !== false, on: sameVal(v, value), title });
    b.dataset.v = JSON.stringify(v);
    el.append(b);
  }
  return el;
}

function sameVal(a, b) { return JSON.stringify(a) === JSON.stringify(b); }

export function toggle(label, value, onChange, title) {
  const el = h('span', { class: 'toggle' + (value ? ' on' : ''), title, role: 'switch', 'aria-checked': value ? 'true' : 'false' }, h('span', { class: 'box' }), label);
  el.addEventListener('click', (e) => { e.preventDefault(); onChange(!value); });
  return el;
}

/**
 * Text field: apply(value) on Enter (then blur), revert on Esc. Plain type=text, inputmode as given.
 */
export function textField(value, { apply, placeholder, cls = 'field', numeric = false, title, width } = {}) {
  const el = h('input', { class: cls, type: 'text', spellcheck: 'false', autocomplete: 'off', placeholder, title, inputmode: numeric ? 'numeric' : undefined });
  el.value = value ?? '';
  if (width) el.style.width = width;
  el.__orig = el.value;
  el.__apply = () => { if (apply) apply(el.value.trim()); el.__orig = el.value; };
  el.__revert = () => { el.value = el.__orig; };
  return el;
}

export function swatch(rgb, title) {
  return h('span', { class: 'sw', title, style: { background: `rgb(${rgb[0]},${rgb[1]},${rgb[2]})` } });
}

export function clear(el) { while (el.firstChild) el.removeChild(el.firstChild); return el; }

let toastBox = null;
export function toast(msg, opts = {}) {
  toastBox = toastBox || document.getElementById('toasts');
  if (!toastBox) return;
  // one toast at a time (a new one replaces the old), so toasts never push each other around
  clearTimeout(toastBox.__t);
  toastBox.replaceChildren(h('div', { class: 'toast' + (opts.bad ? ' bad' : '') }, msg));
  toastBox.__t = setTimeout(() => toastBox.replaceChildren(), opts.ms || 3200);
}

export async function copyText(text) {
  try { await navigator.clipboard.writeText(text); return true; }
  catch {
    const ta = h('textarea', { style: { position: 'fixed', left: '-9999px', top: '0' } });
    ta.value = text; document.body.append(ta); ta.select();
    let ok = false; try { ok = document.execCommand('copy'); } catch { ok = false; }
    ta.remove(); return ok;
  }
}
