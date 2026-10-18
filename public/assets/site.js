const catalog = document.querySelector('[data-catalog]');
if (catalog) {
  const form = catalog.querySelector('form');
  const search = form.elements.q;
  const category = form.elements.type;
  const entries = [...catalog.querySelectorAll('[data-project]')];
  const categories = new Set([...category.options].map(o => o.value));
  function render(updateURL = true) {
    const query = search.value.trim().toLowerCase();
    let count = 0;
    for (const entry of entries) {
      entry.hidden = !((category.value === 'all' || entry.dataset.kind === category.value) && query.split(/\s+/).every(term => entry.dataset.search.includes(term)));
      if (!entry.hidden) count++;
    }
    catalog.querySelectorAll('[data-project-group], .tile-grid').forEach(section => {
      section.hidden = ![...section.querySelectorAll('[data-project]')].some(entry => !entry.hidden);
    });
    catalog.querySelector('[data-result-count]').textContent = `${count} ${count === 1 ? 'result' : 'results'}`;
    catalog.querySelector('.empty-results').hidden = count > 0;
    if (updateURL) {
      const url = new URL(location.href);
      for (const [key,value] of [['q',search.value.trim()],['type',category.value === 'all' ? '' : category.value]]) {
        if (value) url.searchParams.set(key,value); else url.searchParams.delete(key);
      }
      history.replaceState(null,'',url);
    }
  }
  function fromURL() {
    const params = new URLSearchParams(location.search);
    search.value = params.get('q') || '';
    const requested = params.get('type') === 'tools' ? 'research' : params.get('type');
    category.value = categories.has(requested) ? requested : 'all';
    render(false);
  }
  form.addEventListener('submit',e => {e.preventDefault(); render();});
  search.addEventListener('input',() => render());
  category.addEventListener('change',() => render());
  catalog.querySelector('[data-clear-filters]').addEventListener('click',() => {search.value = ''; category.value = 'all'; render(); search.focus();});
  window.addEventListener('popstate',fromURL);
  fromURL();
}

// Keep a visible preview, but load the application only after an explicit start.
// Removing its frame also stops its animation, workers, and audio.
for (const panel of document.querySelectorAll('[data-demo]')) {
  const mount = panel.querySelector('[data-demo-mount]');
  const rest = panel.querySelector('[data-demo-rest]');
  const start = panel.querySelector('[data-start-demo]');
  const stop = panel.querySelector('[data-stop-demo]');
  const status = panel.querySelector('[data-demo-status]');
  const template = panel.querySelector('[data-demo-template]').content.querySelector('iframe');
  stop.addEventListener('click', () => {
    mount.replaceChildren();
    rest.hidden = false;
    stop.hidden = true;
    status.textContent = 'Demo stopped.';
    start.focus();
  });
  start.addEventListener('click', () => {
    if (mount.firstChild) return;
    const frame = template.cloneNode();
    frame.loading = 'eager';
    mount.append(frame);
    rest.hidden = true;
    stop.hidden = false;
    status.textContent = 'Starts paused. Play or create a scene to listen.';
    stop.focus();
  });
}
