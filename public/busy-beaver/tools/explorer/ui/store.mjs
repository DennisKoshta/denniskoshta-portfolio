// ViewState store: one source of truth, change notifications with the changed keys, URL sync.
import { clone, normalize, sameJSON, RUN_KEYS } from '../core/viewstate.mjs';
import { encode, parsePairs } from '../core/url.mjs';

/**
 * A link written with `preset=<id>` re-applies the preset's keys before the explicit ones, so it only restores the
 * view while every key the preset sets is still written explicitly. A setting turned back to its default is omitted
 * from the hash (defaults are never written) and the preset would bring it back on reload: then the preset id must
 * go, and the hash restores the state from its explicit keys alone.
 */
export function presetStillHolds(vs, presets) {
  const pre = vs.preset && presets && presets[vs.preset];
  if (!pre) return false;
  const have = new Set(parsePairs(encode(vs)).map(([k]) => k));
  return parsePairs(pre.hash).every(([k]) => k === 'v' || k === 'preset' || have.has(k));
}

export class Store {
  constructor(vs, presets = null) {
    this.presets = presets;
    this.vs = normalize(vs);
    if (this.vs.preset && presets && !presetStillHolds(this.vs, presets)) this.vs.preset = null;
    this.subs = new Set();
    this.urlTimer = 0;
    this.lastHash = null;
  }
  get() { return this.vs; }
  snapshot() { return clone(this.vs); }
  subscribe(fn) { this.subs.add(fn); return () => this.subs.delete(fn); }
  /**
   * Merge a partial ViewState. opts.push: pushState (machine/start/compare changes so Back works);
   * opts.silentUrl: do not touch the URL; opts.source: who changed it (for listeners).
   */
  set(partial, opts = {}) {
    const next = normalize({ ...this.vs, ...partial });
    if (next.preset && this.presets && !presetStillHolds(next, this.presets)) next.preset = null;
    const changed = [];
    for (const k of Object.keys(next)) if (!sameJSON(next[k], this.vs[k])) changed.push(k);
    if (!changed.length) return changed;
    const prev = this.vs;
    this.vs = next;
    const push = opts.push ?? changed.some((k) => RUN_KEYS.includes(k) || k === 'cmp');
    if (!opts.silentUrl) this.syncUrl(push);
    for (const fn of this.subs) fn(next, changed, prev, opts);
    return changed;
  }
  hash() { return encode(this.vs); }
  syncUrl(push) {
    if (typeof history === 'undefined') return;
    const h = '#' + encode(this.vs);
    if (push) {
      clearTimeout(this.urlTimer);
      if (h !== location.hash) history.pushState(null, '', h);
      this.lastHash = h;
      return;
    }
    clearTimeout(this.urlTimer);
    this.urlTimer = setTimeout(() => {
      const hh = '#' + encode(this.vs);
      if (hh !== location.hash) history.replaceState(null, '', hh);
      this.lastHash = hh;
    }, 250);
  }
}
