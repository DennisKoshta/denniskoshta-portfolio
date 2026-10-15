import {checkExpression} from './verifier.js';

const menu=document.querySelector('.menu-toggle');
const nav=document.querySelector('#primary-nav');
function closeMenu(){menu?.setAttribute('aria-expanded','false');nav?.classList.remove('is-open');}
menu?.addEventListener('click',()=>{const open=menu.getAttribute('aria-expanded')!=='true';menu.setAttribute('aria-expanded',String(open));nav.classList.toggle('is-open',open);});
document.addEventListener('keydown',e=>{if(e.key==='Escape'&&menu?.getAttribute('aria-expanded')==='true'){closeMenu();menu.focus();}});
document.addEventListener('click',e=>{if(menu?.getAttribute('aria-expanded')==='true'&&!e.target.closest('.site-header'))closeMenu();});
nav?.addEventListener('click',e=>{if(e.target.closest('a'))closeMenu();});
window.matchMedia('(min-width: 651px)').addEventListener('change',e=>{if(e.matches)closeMenu();});

const catalog=document.querySelector('[data-catalog]');
if(catalog){
  const cards=[...catalog.querySelectorAll('[data-project]')];
  const buttons=[...catalog.querySelectorAll('[data-filter]')];
  const search=catalog.querySelector('input[type=search]');
  const count=catalog.querySelector('[data-result-count]');
  const empty=catalog.querySelector('.empty-results');
  const clear=catalog.querySelector('.reset-filters');
  const allowed=new Set(buttons.map(b=>b.dataset.filter));
  let selected='all';
  function render(updateUrl=true){
    const query=search.value.trim().toLowerCase();
    let visible=0;
    for(const card of cards){const matched=(selected==='all'||card.dataset.kind===selected)&&query.split(/\s+/).every(term=>card.dataset.search.includes(term));card.hidden=!matched;if(matched)visible++;}
    buttons.forEach(b=>b.setAttribute('aria-pressed',String(b.dataset.filter===selected)));
    count.textContent=`${visible} ${visible===1?'project':'projects'}${query?' matching your search':''}`;
    empty.hidden=visible>0;
    clear.hidden=selected==='all'&&!query;
    if(updateUrl){const u=new URL(location.href);if(selected==='all')u.searchParams.delete('type');else u.searchParams.set('type',selected);if(query)u.searchParams.set('q',search.value.trim());else u.searchParams.delete('q');history.replaceState(null,'',u);}
  }
  function fromUrl(){const params=new URLSearchParams(location.search);selected=allowed.has(params.get('type'))?params.get('type'):'all';search.value=params.get('q')||'';render(false);}
  buttons.forEach(b=>b.addEventListener('click',()=>{selected=b.dataset.filter;render();}));
  search.addEventListener('input',()=>render());
  catalog.querySelectorAll('.reset-filters,[data-clear-filters]').forEach(b=>b.addEventListener('click',()=>{selected='all';search.value='';render();search.focus();}));
  window.addEventListener('popstate',fromUrl);
  fromUrl();
}

let toastTimer;
function toast(message){const el=document.querySelector('.copy-toast');if(!el)return;el.textContent=message;el.classList.add('is-visible');clearTimeout(toastTimer);toastTimer=setTimeout(()=>el.classList.remove('is-visible'),3500);}
async function copy(text){try{if(!navigator.clipboard?.writeText)throw new Error('unavailable');await navigator.clipboard.writeText(text);toast('Copied to clipboard.');}catch{toast('Copy is unavailable in this browser. Select the address to copy it.');}}
document.querySelectorAll('[data-copy-link]').forEach(b=>b.addEventListener('click',()=>copy(location.href)));
document.querySelectorAll('[data-copy-email]').forEach(b=>b.addEventListener('click',()=>copy(b.dataset.copyEmail)));

const form=document.querySelector('[data-verifier]');
if(form){
  const input=form.querySelector('input[name=expression]');
  function check(){const result=checkExpression(input.value);for(const [key,passed] of [['numeric',result.numeric],['contract',result.inputs]]){const row=form.querySelector(`[data-check=${key}]`);row.dataset.passed=String(result.valid&&passed);row.querySelector('b').textContent=!result.valid?'Invalid':passed?'Pass':'Fail';}form.querySelector('[data-verifier-message]').textContent=result.message;input.setAttribute('aria-invalid',String(!result.valid));}
  form.addEventListener('submit',e=>{e.preventDefault();check();});
  form.querySelectorAll('[data-expression]').forEach(b=>b.addEventListener('click',()=>{input.value=b.dataset.expression;check();}));
  check();
}
