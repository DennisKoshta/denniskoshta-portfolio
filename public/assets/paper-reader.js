const reader = document.querySelector('[data-live-paper]');
if (reader) {
  const frame = reader.querySelector('[data-paper-frame]');
  const status = reader.querySelector('[data-paper-status]');
  const reload = reader.querySelector('[data-paper-reload]');
  const links = [reader.querySelector('[data-paper-open]'), reader.querySelector('[data-paper-download]')];
  let objectURL;

  async function loadPaper() {
    reload.disabled = true;
    reader.dataset.paperState = 'loading';
    status.textContent = 'Loading the current PDF from GitHub…';
    frame.hidden = true;
    frame.removeAttribute('src');
    for (const link of links) { link.hidden = true; link.removeAttribute('href'); }
    if (objectURL) { URL.revokeObjectURL(objectURL); objectURL = undefined; }
    try {
      const source = new URL(reader.dataset.livePaper);
      // Bypass both browser caching and GitHub's short-lived CDN cache on main.
      source.searchParams.set('refresh', crypto.randomUUID());
      const response = await fetch(source, {cache: 'no-store', credentials: 'omit', signal: AbortSignal.timeout(30000)});
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const bytes = await response.arrayBuffer();
      if (new TextDecoder().decode(bytes.slice(0, 5)) !== '%PDF-') throw new Error('Not a PDF');
      objectURL = URL.createObjectURL(new Blob([bytes], {type: 'application/pdf'}));
      for (const link of links) { link.href = objectURL; link.hidden = false; }
      frame.src = `${objectURL}#view=FitH`;
      frame.hidden = false;
      reader.dataset.paperState = 'ready';
      status.textContent = 'Current PDF loaded. Use Reload PDF to check for updates while reading.';
    } catch {
      reader.dataset.paperState = 'error';
      status.textContent = 'Could not load the current PDF. Try Reload PDF, or view it on GitHub below.';
    } finally {
      reload.disabled = false;
    }
  }

  reload.hidden = false;
  reload.addEventListener('click', loadPaper);
  window.addEventListener('pageshow', event => { if (event.persisted) loadPaper(); });
  loadPaper();
}
