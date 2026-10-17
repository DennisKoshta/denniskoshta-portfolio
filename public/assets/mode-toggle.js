// Kept separate from the temporary preset editor.
const themes=window.portfolioTheme;
const button=document.querySelector('[data-mode-toggle]');
if(themes&&button){
  const moon='<path d="M20 13A8 8 0 0 1 11 4a8 8 0 1 0 9 9Z"/>';
  const sun='<circle cx="12" cy="12" r="4"/><path d="M12 2v2m0 16v2M2 12h2m16 0h2M5 5l1.5 1.5m11 11L19 19M5 19l1.5-1.5m11-11L19 5"/>';
  function sync(){
    const dark=themes.current.mode==='dark',label=dark?'Light mode':'Dark mode';
    button.innerHTML=`<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${dark?sun:moon}</svg><span>${label}</span>`;
    button.setAttribute('aria-label',`Switch to ${label.toLowerCase()}`);
    button.hidden=false;
  }
  button.addEventListener('click',()=>themes.toggleMode());
  window.addEventListener('portfolio-theme-change',sync);
  sync();
}
