import fs from 'node:fs';
import path from 'node:path';
const root=path.resolve('dist');
const errors=[];
const read=file=>JSON.parse(fs.readFileSync(file,'utf8'));
const projects=['core','supporting','studio'].flatMap(n=>read(`content/${n}-projects.json`));
const papers=read('content/papers.json');
for(const paper of papers){
 for(const key of ['title','type','course','summary','url'])if(!paper[key])errors.push(`Paper missing ${key}`);
 if(!paper.url?.startsWith('/papers/')||!paper.url?.endsWith('.pdf'))errors.push(`Invalid paper URL: ${paper.url}`);
 if(!Number.isInteger(paper.pages)||paper.pages<1)errors.push(`Invalid page count: ${paper.title}`);
}
const slugs=new Set();
for(const p of projects){
 if(slugs.has(p.slug))errors.push(`Duplicate project ${p.slug}`);slugs.add(p.slug);
 for(const key of ['slug','title','summary','kind','status','contribution'])if(!p[key])errors.push(`${p.slug}: missing ${key}`);
 if(!p.details?.length)errors.push(`${p.slug}: missing description`);
 for(const o of p.outcomes||[])if(typeof o!=='object'||!o.value||!o.label)errors.push(`${p.slug}: incomplete outcome`);
 for(const l of p.links||[])if(!l.label||!l.url)errors.push(`${p.slug}: incomplete source link`);
}
for(const p of projects)for(const s of p.related||[])if(!slugs.has(s))errors.push(`${p.slug}: unknown related project ${s}`);
const pages=[];
function walk(dir){for(const e of fs.readdirSync(dir,{withFileTypes:true})){const f=path.join(dir,e.name);if(e.isDirectory())walk(f);else if(e.name.endsWith('.html'))pages.push(f);}}
// The imported research site has its own export/link validation.
walk(root);
for(let i=pages.length-1;i>=0;i--)if(path.relative(root,pages[i]).startsWith('busy-beaver/'))pages.splice(i,1);
const decode=s=>s.replaceAll('&amp;','&').replaceAll('&quot;','"').replaceAll('&#39;',"'");
let localLinks=0;
for(const file of pages){
 const html=fs.readFileSync(file,'utf8');const name=path.relative(root,file);
 for(const [key,re] of [['h1',/<h1(?:\s[^>]*)?>/g],['main',/<main(?:\s[^>]*)?>/g],['title',/<title>/g]])if((html.match(re)||[]).length!==1)errors.push(`${name}: expected one ${key}`);
 if(!/<meta name="description" content="[^"]+"/.test(html))errors.push(`${name}: missing description`);
 if(!/<link rel="canonical" href="https:\/\/denniskoshta\.com\//.test(html))errors.push(`${name}: invalid canonical`);
 if(/(?:TODO|PLACEHOLDER|Lorem ipsum|undefined|null<\/)/.test(html))errors.push(`${name}: placeholder or invalid content`);
 if(/(?:\/home\/dennis|\/mnt\/c|file:\/\/|sk-proj-|ghp_[A-Za-z0-9]{20}|invite\?token=)/.test(html))errors.push(`${name}: private path or credential pattern`);
 const ids=[...html.matchAll(/\bid="([^"]+)"/g)].map(m=>m[1]);if(new Set(ids).size!==ids.length)errors.push(`${name}: duplicate id`);
 for(const m of html.matchAll(/\b(?:href|src)="([^"]+)"/g)){
  const href=decode(m[1]);if(!href.startsWith('/')&&!href.startsWith('#'))continue;localLinks++;
  const u=new URL(href,'https://denniskoshta.com/'+name.replace(/index\.html$/,''));
  let target=path.join(root,decodeURIComponent(u.pathname));
  if(fs.existsSync(target)&&fs.statSync(target).isDirectory())target=path.join(target,'index.html');
  if(!fs.existsSync(target)){errors.push(`${name}: missing asset or page ${href}`);continue;}
  if(u.hash&&target.endsWith('.html')){const targetHtml=fs.readFileSync(target,'utf8');if(!targetHtml.includes(`id="${decodeURIComponent(u.hash.slice(1))}"`))errors.push(`${name}: missing anchor ${href}`);}
 }
}
const index=read('dist/project-index.json');if(index.length!==projects.length)errors.push('Incomplete project catalog');
if(errors.length){console.error(errors.join('\n'));process.exitCode=1;}else console.log(`Content and build checks passed: ${projects.length} projects, ${papers.length} papers, ${pages.length} HTML pages, ${localLinks} local references.`);
