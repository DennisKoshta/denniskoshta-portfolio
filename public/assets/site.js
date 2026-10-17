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
    catalog.querySelector('[data-result-count]').textContent = `${count} ${count === 1 ? 'project' : 'projects'}`;
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

// Load the actual application only on request. Destroying the frame stops its audio.
for (const panel of document.querySelectorAll('[data-demo]')) {
  const mount = panel.querySelector('[data-demo-mount]');
  panel.addEventListener('toggle',() => {
    if (!panel.open) {mount.replaceChildren(); return;}
    if (mount.firstChild) return;
    const frame = document.createElement('iframe');
    frame.title = 'Signal Garden music composition application';
    frame.src = 'https://denniskoshta.github.io/studio/signal-garden/';
    frame.allow = 'autoplay; fullscreen';
    frame.setAttribute('sandbox','allow-scripts allow-same-origin allow-downloads allow-forms');
    frame.referrerPolicy = 'no-referrer';
    mount.append(frame);
  });
  panel.querySelector('[data-close-demo]').addEventListener('click',() => {
    panel.open = false;
    mount.replaceChildren();
    panel.querySelector('summary').focus();
  });
}
