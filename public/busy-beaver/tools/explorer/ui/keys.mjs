// Keyboard map (spec §13). One capture-phase keydown handler on window: the behaviour is identical whatever has
// focus. Text fields handle only Enter (apply + blur) and Esc (revert + blur). Ctrl/Meta/Alt combos pass through.
// Key repeat is coalesced to one action per animation frame.

/** Bindings: key = event.key; shift: true means only with Shift (letters ignore case unless Shift is listed). */
export const BINDINGS = [
  { key: 'ArrowLeft', action: 'pan-left', desc: 'pan space by 1/8 view (Shift: ×4)' },
  { key: 'ArrowRight', action: 'pan-right', desc: 'pan space by 1/8 view (Shift: ×4)' },
  { key: 'ArrowUp', action: 'pan-up', desc: 'pan time by 1/8 view (Shift: ×4)' },
  { key: 'ArrowDown', action: 'pan-down', desc: 'pan time by 1/8 view (Shift: ×4)' },
  { key: 'PageUp', action: 'page-up', desc: 'one view earlier' },
  { key: 'PageDown', action: 'page-down', desc: 'one view later' },
  { key: 'Home', action: 'home', desc: 'first row (step 0 / the start)' },
  { key: 'End', action: 'end', desc: 'last simulated row' },
  { key: 'j', action: 'center-left', desc: 'centre on the left edge of the tape' },
  { key: 'k', action: 'center-head', desc: 'centre on the head' },
  { key: 'l', action: 'center-right', desc: 'centre on the right edge' },
  { key: '[', action: 'zoom-out', desc: 'zoom out, both axes' },
  { key: ']', action: 'zoom-in', desc: 'zoom in, both axes' },
  { key: '{', action: 'zoom-out-t', desc: 'zoom out, time only' },
  { key: '}', action: 'zoom-in-t', desc: 'zoom in, time only' },
  { key: '<', action: 'zoom-out-x', desc: 'zoom out, space only' },
  { key: '>', action: 'zoom-in-x', desc: 'zoom in, space only' },
  { key: 'f', action: 'fit', desc: 'fit the whole run' },
  { key: '1', action: 'square', desc: 'square pixels: 1 cell = 1 step (toggle lock)' },
  { key: 'z', action: 'exact', desc: 'open the moment under the pointer (or pin): every step, 8 px per cell, pinned' },
  { key: '0', action: 'reset', desc: "reset to this machine's default view" },
  { key: ',', action: 'row-prev', desc: 'playhead one row back' },
  { key: '.', action: 'row-next', desc: 'playhead one row on' },
  { key: ' ', action: 'play', desc: 'play / pause from the playhead (or the top row)' },
  { key: ' ', shift: true, action: 'play-nofollow', desc: 'play without following' },
  { key: '+', action: 'speed-up', desc: 'speed ×2' },
  { key: '=', action: 'speed-up', desc: 'speed ×2' },
  { key: '-', action: 'speed-down', desc: 'speed ÷2' },
  { key: 'g', action: 'goto', desc: 'go to a step (1e9, 9_786_531) or #event' },
  { key: 'w', action: 'seek-head', desc: 'jump on to the next time the head enters the visible cells' },
  { key: 'm', action: 'toggle-minimap', desc: 'minimap (bottom-right of the diagram) on / off' },
  { key: 'o', action: 'view-from-here', desc: 'view from here: the pointer row becomes the top row' },
  { key: 'r', action: 'cycle-rows', desc: 'rows: every step → records → state entries → every step' },
  { key: 's', action: 'cycle-style', desc: 'style: Default → Explore → Blaze → Blaze dark' },
  { key: 'h', action: 'toggle-hl', desc: 'highlights on / off' },
  { key: 'b', action: 'toggle-bg', desc: 'k-block background removal on / off' },
  { key: 'B', shift: true, action: 'flip-phase', desc: 'k-block: flip the phase' },
  { key: 'd', action: 'toggle-diff', desc: 'compare: side by side ↔ diff' },
  { key: 'c', action: 'copy-dh', desc: 'copy the tape (dh) of the pinned / playhead row' },
  { key: 'C', shift: true, action: 'copy-link', desc: 'copy a link to this view' },
  { key: 'e', action: 'export', desc: 'export PNG with label and legend' },
  { key: 'p', action: 'pin', desc: 'pin the cell under the pointer' },
  { key: 'Enter', action: 'pin', desc: 'pin the cell under the pointer' },
  { key: 'Escape', action: 'escape', desc: 'unpin, close overlays' },
  { key: 'n', action: 'next-machine', desc: 'next machine in the list' },
  { key: 'N', shift: true, action: 'prev-machine', desc: 'previous machine' },
  { key: 'S', shift: true, action: 'site-overlay', desc: 'bbchallenge view, large' },
  { key: '\\', action: 'toggle-panels', desc: 'collapse / expand the side panels' },
  { key: '?', action: 'help', desc: 'this help' },
];

const isLetter = (k) => k.length === 1 && /[a-z]/i.test(k);

/** Resolve a keydown-like {key, shiftKey, ctrlKey, metaKey, altKey} to a binding, or null. */
export function resolve(e) {
  if (e.ctrlKey || e.metaKey || e.altKey) return null;
  const key = e.key;
  if (isLetter(key)) {
    if (e.shiftKey) {
      const b = BINDINGS.find((x) => x.shift && x.key === key.toUpperCase());
      if (b) return b;
    }
    return BINDINGS.find((x) => !x.shift && x.key === key.toLowerCase()) || null;
  }
  if (key === ' ') return BINDINGS.find((x) => x.key === ' ' && !!x.shift === !!e.shiftKey) || null;
  return BINDINGS.find((x) => !x.shift && x.key === key) || null;
}

export function isTextField(el) {
  if (!el || !el.tagName) return false;
  if (el.tagName === 'TEXTAREA') return !el.readOnly;
  if (el.tagName === 'INPUT') return !el.readOnly && (el.type === 'text' || el.type === 'search' || el.type === '');
  return !!el.isContentEditable;
}

/**
 * Install the global handlers. run(action, {shift, repeat, key}) performs an action.
 * Text fields: el.__apply() / el.__revert() are called on Enter / Esc, then the field is blurred.
 */
export function installKeys(run, win = window) {
  let pending = null, raf = 0;
  const flush = () => { raf = 0; const p = pending; pending = null; if (p) run(p.action, p.opts); };
  function onDown(e) {
    const t = e.target;
    if (e.key === 'Tab' && !e.ctrlKey && !e.metaKey && !e.altKey) {
      // Tab would walk focus into the text fields, after which letter keys type into them: never move focus
      e.preventDefault(); e.stopPropagation();
      if (isTextField(t)) { if (t.__revert) t.__revert(); t.blur(); }
      return;
    }
    if (isTextField(t)) {
      if (e.key === 'Enter' && !(t.tagName === 'TEXTAREA' && e.shiftKey)) {
        e.preventDefault(); e.stopPropagation();
        if (t.__apply) t.__apply(); t.blur();
      } else if (e.key === 'Escape') {
        e.preventDefault(); e.stopPropagation();
        if (t.__revert) t.__revert(); t.blur();
      }
      return;
    }
    const b = resolve(e);
    if (!b) return;
    e.preventDefault(); e.stopPropagation();
    const opts = { shift: e.shiftKey, repeat: e.repeat, key: e.key };
    if (e.repeat) {
      pending = { action: b.action, opts };
      if (!raf) raf = win.requestAnimationFrame(flush);
      return;
    }
    run(b.action, opts);
  }
  function onUp(e) {
    // Windows: releasing Alt after Alt+wheel (time zoom) would focus the browser menu
    if (e.key === 'Alt' && win.__stxAltWheel && performance.now() - win.__stxAltWheel < 5000) { e.preventDefault(); win.__stxAltWheel = 0; return; }
    if (isTextField(e.target)) return;
    if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); }
  }
  // Ctrl+wheel / pinch anywhere on the page would zoom the page itself (and the layout would jump): only the
  // diagram and the rulers zoom, everything else ignores it
  function onWheel(e) { if (e.ctrlKey) e.preventDefault(); }
  // Chrome activates a focused button on keyup of Space/Enter; also never let buttons take focus.
  function onMouseDown(e) {
    const b = e.target && e.target.closest && e.target.closest('button, .btn, .chip, .toggle, a.btn');
    if (b && !isTextField(e.target)) e.preventDefault();
  }
  function onPointerUp() {
    const a = document.activeElement;
    if (a && a !== document.body && !isTextField(a)) a.blur();
  }
  win.addEventListener('keydown', onDown, true);
  win.addEventListener('keyup', onUp, true);
  win.addEventListener('mousedown', onMouseDown, true);
  win.addEventListener('pointerup', onPointerUp, true);
  win.addEventListener('wheel', onWheel, { capture: true, passive: false });
  return () => {
    win.removeEventListener('wheel', onWheel, { capture: true });
    win.removeEventListener('keydown', onDown, true);
    win.removeEventListener('keyup', onUp, true);
    win.removeEventListener('mousedown', onMouseDown, true);
    win.removeEventListener('pointerup', onPointerUp, true);
  };
}
