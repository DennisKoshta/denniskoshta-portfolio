// Temporary preset/color editor. The mode toggle and shared theme engine are permanent.
const themes=window.portfolioTheme;
if(themes){
  const host=document.createElement('div');
  host.className='theme-lab';
  host.innerHTML=`<button class="theme-toggle" type="button" aria-expanded="false" aria-controls="theme-panel">Theme lab</button>
  <section class="theme-panel" id="theme-panel" aria-labelledby="theme-title" hidden>
    <div class="theme-panel-heading"><h2 id="theme-title">Theme lab</h2><button type="button" data-theme-close aria-label="Close theme panel">×</button></div>
    <p class="theme-help">Temporary preview. Your choice stays in this browser.</p>
    <div class="theme-modes" role="group" aria-label="Color mode"><button type="button" data-theme-mode="light" aria-pressed="false">Light</button><button type="button" data-theme-mode="dark" aria-pressed="false">Dark</button></div>
    <div class="theme-presets" role="group" aria-label="Theme presets">${themes.presets.map(p=>`<button type="button" data-theme-preset="${p.id}" data-preset-mode="${p.mode}" aria-pressed="false"><span class="theme-swatch" style="--swatch-bg:${p.bg};--swatch-accent:${p.accent}" aria-hidden="true"></span>${p.name}</button>`).join('')}</div>
    <div class="theme-colors"><label>Background<input type="color" data-theme-color="bg"></label><label>Accent<input type="color" data-theme-color="accent"></label></div>
    <p class="theme-help">Text contrast adjusts automatically. Photos and demos keep their own colors.</p>
    <p class="theme-values" data-theme-values></p>
    <div class="theme-actions"><button type="button" data-theme-reset>Reset</button><button type="button" data-theme-copy>Copy theme</button></div>
    <p class="theme-status" role="status" data-theme-status></p>
    <textarea class="theme-copy-fallback" aria-label="Theme settings to copy" readonly hidden></textarea>
  </section>`;
  document.querySelector('.appearance-controls').append(host);
  const toggle=host.querySelector('.theme-toggle'),panel=host.querySelector('.theme-panel'),close=host.querySelector('[data-theme-close]');
  const status=host.querySelector('[data-theme-status]'),fallback=host.querySelector('textarea');
  function sync(){
    const theme=themes.current;
    for(const button of host.querySelectorAll('[data-theme-preset]')){button.hidden=button.dataset.presetMode!==theme.mode;button.setAttribute('aria-pressed',String(button.dataset.themePreset===theme.id));}
    for(const button of host.querySelectorAll('[data-theme-mode]'))button.setAttribute('aria-pressed',String(button.dataset.themeMode===theme.mode));
    for(const input of host.querySelectorAll('[data-theme-color]'))input.value=theme[input.dataset.themeColor];
    host.querySelector('[data-theme-values]').textContent=`${theme.mode === 'light' ? 'Light' : 'Dark'}: ${theme.name} · ${theme.bg} / ${theme.accent}`;
    status.textContent='';fallback.hidden=true;
  }
  function setOpen(open,restoreFocus=false){panel.hidden=!open;toggle.setAttribute('aria-expanded',String(open));if(open)close.focus();else if(restoreFocus)toggle.focus();}
  toggle.addEventListener('click',()=>setOpen(panel.hidden));
  close.addEventListener('click',()=>setOpen(false,true));
  document.addEventListener('keydown',e=>{if(e.key==='Escape'&&!panel.hidden){setOpen(false,true);}});
  document.addEventListener('pointerdown',e=>{if(!panel.hidden&&!host.contains(e.target))setOpen(false);});
  window.addEventListener('portfolio-theme-change',sync);
  for(const button of host.querySelectorAll('[data-theme-mode]'))button.addEventListener('click',()=>themes.setMode(button.dataset.themeMode));
  for(const button of host.querySelectorAll('[data-theme-preset]'))button.addEventListener('click',()=>{themes.apply(themes.presets.find(p=>p.id===button.dataset.themePreset));});
  for(const input of host.querySelectorAll('[data-theme-color]'))input.addEventListener('input',()=>{themes.apply({...themes.current,[input.dataset.themeColor]:input.value});});
  host.querySelector('[data-theme-reset]').addEventListener('click',()=>{themes.reset();});
  host.querySelector('[data-theme-copy]').addEventListener('click',async()=>{
    const theme=themes.current,text=`Portfolio theme: ${theme.name}\nMode: ${theme.mode}\nBackground: ${theme.bg}\nAccent: ${theme.accent}`;
    try{await navigator.clipboard.writeText(text);status.textContent='Theme copied.';}
    catch{fallback.value=text;fallback.hidden=false;fallback.focus();fallback.select();status.textContent='Select and copy the settings below.';}
  });
  sync();
}
