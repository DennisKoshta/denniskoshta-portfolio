import fs from 'node:fs';
import path from 'node:path';
import {minifyCSS} from './minify-css.mjs';

const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const config = read('content/site.json');
const profile = read('content/profile.json');
const projects = ['core-projects', 'supporting-projects', 'studio-projects'].flatMap(name => read(`content/${name}.json`));
const notes = read('content/notes.json');
const bySlug = new Map(projects.map(p => [p.slug, p]));
const out = path.resolve('dist');
fs.rmSync(out, {recursive:true, force:true});
fs.mkdirSync(out, {recursive:true});
fs.cpSync('public', out, {recursive:true});
fs.writeFileSync(path.join(out, 'assets/site.css'), minifyCSS(fs.readFileSync('styles/site.css', 'utf8')));
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;'}[c]));
const rich = s => esc(s).replace(/`([^`]+)`/g, '<code>$1</code>').replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
const url = slug => `/work/${slug}/`;
const link = (href, label) => `<a href="${esc(href)}">${esc(label)}</a>`;
const group = p => p.kind === 'Creative' ? 'studio' : p.kind === 'Foundations' ? 'foundations' : p.kind === 'Product' ? 'products' : 'research';
const groups = [['research','Research & systems'], ['products','Software'], ['studio','Interactive projects'], ['foundations','Earlier work']];
const routes = [];
const brandMark = fs.readFileSync('public/favicon.svg','utf8').replace(/<style>[\s\S]*?<\/style>/,'').replace('<svg ', '<svg aria-hidden="true" focusable="false" ');
function write(route, html) {
  const file = path.join(out, route.endsWith('.html') ? route : route + 'index.html');
  fs.mkdirSync(path.dirname(file), {recursive:true});
  fs.writeFileSync(file, html);
  if (route !== '/404.html') routes.push(route);
}
function page({title, description = config.description, body, route = '/', active = '', article = false, publishedAt}) {
  const fullTitle = route === '/' ? config.title : `${title} — Dennis Koshta`;
  const schema = article ? {
    '@context':'https://schema.org', '@type':'Article', headline:title, description,
    datePublished:publishedAt, author:{'@type':'Person', name:config.name, url:config.origin}, mainEntityOfPage:config.origin + route
  } : {'@context':'https://schema.org', '@type':'WebPage', name:fullTitle, description, url:config.origin + route};
  return `<!doctype html><html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(fullTitle)}</title><meta name="description" content="${esc(description)}">
<meta name="theme-color" content="#edf2f2"><link rel="canonical" href="${config.origin + route}">
<meta property="og:type" content="${article ? 'article' : 'website'}"><meta property="og:site_name" content="Dennis Koshta">
<meta property="og:title" content="${esc(fullTitle)}"><meta property="og:description" content="${esc(description)}">
<meta property="og:url" content="${config.origin + route}"><meta property="og:image" content="${config.origin}/assets/social-plain.png">
<meta property="og:image:alt" content="Dennis Koshta — software engineer">
<meta name="twitter:card" content="summary_large_image"><link rel="icon" href="/favicon.svg" type="image/svg+xml">
<script src="/assets/themes.js"></script>
<link rel="preload" href="/assets/fonts/dm-sans-0.woff2" as="font" type="font/woff2" crossorigin>
<link rel="manifest" href="/site.webmanifest"><link rel="stylesheet" href="/assets/site.css">
<script type="module" src="/assets/mode-toggle.js"></script>
<script type="application/ld+json">${JSON.stringify(schema).replaceAll('<','\\u003c')}</script><script type="module" src="/assets/site.js"></script>
</head><body class="${route === '/' ? 'home' : ['/work/','/studio/'].includes(route) ? 'project-index-page' : ''}"><a class="skip-link" href="#main">Skip to content</a>
<header class="site-header"><a class="site-mark" href="/" aria-label="Dennis Koshta — home">${brandMark}</a><nav aria-label="Main navigation">${[['Home','/'],['Work','/work/'],['Writing','/notes/'],['About','/about/']].map(([name,href]) => `<a href="${href}"${active === name || (name === 'Home' && route === '/') ? ' aria-current="page"' : ''}>${name}</a>`).join('')}</nav></header>
<main id="main">${body}</main>
<footer class="site-footer"><span>Dennis Koshta</span><div>${link('mailto:' + profile.email,'Email')}${link(config.github,'GitHub')}${link('/colophon/','About this site')}</div></footer><div class="appearance-controls"><button class="mode-toggle" data-mode-toggle type="button" hidden></button></div></body></html>`;
}
function intro(title, description) {
  return `<header class="page-intro"><h1>${esc(title)}</h1>${description ? `<p>${esc(description)}</p>` : ''}</header>`;
}
function resourceLinks(p) {
  const repo = p.links?.find(l => l.url.startsWith('https://github.com/'));
  const website = p.links?.find(l => /^https:\/\//.test(l.url) && !/github\.com|huggingface\.co|pypi\.org/.test(l.url));
  const links = [];
  if (p.primaryLink) links.push(link(p.primaryLink.url,p.primaryLink.resourceLabel || p.primaryLink.label));
  if (repo) links.push(link(repo.url, p.slug === 'busycoq' ? 'Merged contributions' : 'Code'));
  if (website && website.url !== p.primaryLink?.url) links.push(link(website.url, p.kind === 'Creative' ? 'Open application' : p.slug === 'upbringing' ? 'Interactive study' : 'Website'));
  return links.length ? `<p class="resource-links">${links.join('<span aria-hidden="true"> · </span>')}</p>` : '';
}
function entry(p, description = p.summary, resources = false, visual = false, href = url(p.slug)) {
  const hasImage = visual && p.image;
  return `<li class="project-entry project-tile${hasImage ? ' has-image' : ''}" data-project data-kind="${group(p)}" data-search="${esc([p.title,p.summary,...p.domains || [],...p.stack || []].join(' ').toLowerCase())}">${hasImage ? `<img class="tile-image" src="${esc(p.image)}" alt="${esc(p.imageAlt || p.title)}" width="600" height="400" loading="lazy">` : ''}<div class="tile-copy"><p class="tile-topic">${esc(p.domains?.slice(0,2).join(' · ') || p.kind)}</p><h3><a class="tile-link" href="${esc(href)}">${esc(p.title)}</a></h3><p>${esc(description)}</p>${resources ? resourceLinks(p) : ''}</div></li>`;
}
function catalog(items) {
  return groups.map(([key,title]) => {
    let itemsInGroup = items.filter(p => group(p) === key);
    if (key === 'studio') {
      const order = ['signal-garden','event-horizon','impossible-rooms',...config.studioGroups.flatMap(g => g.slugs)];
      itemsInGroup.sort((a,b) => order.indexOf(a.slug) - order.indexOf(b.slug));
    }
    const pictured = itemsInGroup.filter(p => p.image);
    const textOnly = itemsInGroup.filter(p => !p.image);
    return itemsInGroup.length ? `<section id="${key}" class="catalog-group" data-project-group><h2>${title}</h2>${pictured.length ? `<ul class="project-list tile-grid visual-grid">${pictured.map(p => entry(p,p.summary,false,true)).join('')}</ul>` : ''}${textOnly.length ? `<ul class="project-list tile-grid">${textOnly.map(p => entry(p)).join('')}</ul>` : ''}</section>` : '';
  }).join('');
}
function noteList() {
  return `<ul class="writing-list">${notes.map(n => `<li><h3>${link(`/notes/${n.slug}/`,n.title)}</h3><p>${esc(n.dek)}</p></li>`).join('')}</ul>`;
}
const demoURL = 'https://denniskoshta.github.io/studio/signal-garden/?embed=portfolio';
function demo() {
  return `<div class="live-demo" data-demo><div class="demo-heading"><h3>Signal Garden demo</h3>${link('https://denniskoshta.github.io/studio/signal-garden/','Open full app')}</div><p>Choose a scene and press Play, or try Create random scene.</p><div class="demo-stage"><div data-demo-mount><iframe title="Signal Garden music composition application" src="${demoURL}" loading="lazy" allow="autoplay; fullscreen" sandbox="allow-scripts allow-same-origin allow-downloads allow-forms" referrerpolicy="no-referrer"></iframe></div><div class="demo-rest" data-demo-rest hidden><img src="${bySlug.get('signal-garden').image}" alt="Signal Garden’s landscape and music sequencer" width="600" height="400" loading="lazy"><button type="button" data-start-demo>Start demo</button></div></div><div class="demo-bar"><p data-demo-status role="status">Starts paused. Play or create a scene to listen.</p><button type="button" data-stop-demo>Stop demo</button></div></div>`;
}
const homeBody = `<section class="bio"><div><h1>Dennis Koshta</h1>${config.intro.map(p => `<p>${esc(p)}</p>`).join('')}<p class="contact-links">${link('mailto:' + profile.email,'Email')} · ${link(config.github,'GitHub')} · ${link(config.linkedin,'LinkedIn')}</p></div><img class="portrait" src="${profile.image}" width="${profile.imageWidth}" height="${profile.imageHeight}" alt="Dennis Koshta"></section>
<section id="selected-work"><h2>Selected work</h2><ul class="project-list tile-grid selected-work">${config.selected.map(s => entry(bySlug.get(s.slug),s.description,true)).join('')}</ul><p>${link('/work/','All projects')} · ${link('/research/','Research & systems')}</p></section>
<section><h2>Writing</h2>${noteList()}</section>
<section id="interactive"><h2>Interactive projects</h2><p>Games, music tools, and small simulations developed with GPT and Claude. I set the direction, test the software, and refine the results.</p><ul class="project-list tile-grid interactive-grid">${['signal-garden','event-horizon','impossible-rooms'].map(slug => { const p = bySlug.get(slug); return entry(p,p.summary,false,true,slug === 'signal-garden' ? url(slug) : `https://denniskoshta.github.io/studio/${slug}/`); }).join('')}</ul>${demo()}<p>${link('/studio/','All 12 interactive projects')}</p></section>
<section><h2>Other software</h2><ul class="project-list tile-grid software-grid">${['rag-eval-kit','transferbatch','sheetmason'].map(slug => entry(bySlug.get(slug))).join('')}</ul><p>${link('/work/','All projects')}</p></section>`;
write('/',page({title:config.name,body:homeBody}));

write('/work/',page({title:'Work',active:'Work',route:'/work/',body:`${intro('Work','Research, software, and interactive projects.')}<div data-catalog><form class="catalog-controls" role="search"><div><label for="project-search">Find a project</label><input id="project-search" type="search" name="q" placeholder="Name, topic, or tool" autocomplete="off"></div><div><label for="project-category">Category</label><select id="project-category" name="type"><option value="all">All projects</option>${groups.map(([key,title]) => `<option value="${key}">${title}</option>`).join('')}</select></div></form><p class="result-count" data-result-count aria-live="polite">${projects.length} projects</p>${catalog(projects)}<div class="empty-results" hidden><p>No matching projects.</p><button type="button" data-clear-filters>Show all projects</button></div></div>`}));
write('/research/',page({title:'Research & systems',active:'Work',route:'/research/',body:`${intro('Research & systems','Language-model training, evaluation, formal verification, and model internals.')}<ul class="project-list tile-grid">${projects.filter(p => group(p) === 'research').map(p => entry(p,p.summary,true)).join('')}</ul><section><h2>Research notes</h2>${noteList()}</section>`}));
write('/studio/',page({title:'Interactive projects',active:'Work',route:'/studio/',body:`${intro('Interactive projects','Twelve tools, games, and simulations developed with GPT and Claude.')}<p>I set the direction, test the software, and refine the results. Project notes describe the collaboration and the limitations of each application.</p>${demo()}${config.studioGroups.map(g => `<section class="catalog-group"><h2>${esc(g.title)}</h2><ul class="project-list tile-grid visual-grid">${g.slugs.map(slug => bySlug.get(slug)).map(p => entry(p,p.summary,true,true)).join('')}</ul></section>`).join('')}`}));

function dataTable(table,title) {
  const numeric = table.columns.map((_,j) => j > 0 && table.rows.every(row => /^[-+−]?[\d,.]+\s*(?:%|pp|×|x)?$/.test(String(row[j]).trim())));
  return `<div class="table-scroll" tabindex="0" role="region" aria-label="${esc(title)} data"><table><thead><tr>${table.columns.map((c,j) => `<th scope="col"${numeric[j] ? ' class="numeric"' : ''}>${esc(c)}</th>`).join('')}</tr></thead><tbody>${table.rows.map(row => `<tr>${row.map((v,j) => `<${j === 0 ? 'th scope="row"' : 'td'}${numeric[j] ? ' class="numeric"' : ''}>${rich(v)}</${j === 0 ? 'th' : 'td'}>`).join('')}</tr>`).join('')}</tbody></table></div>`;
}
function proseSections(sections) {
  return sections.map((s,i) => `<section class="prose-section" id="section-${i+1}"><h2>${esc(s.title)}</h2>${(s.paragraphs || []).map(p => `<p>${rich(p)}</p>`).join('')}${s.bullets?.length ? `<ul>${s.bullets.map(b => `<li>${rich(b)}</li>`).join('')}</ul>` : ''}${s.code ? `<pre><code>${esc(s.code)}</code></pre>` : ''}${s.table ? dataTable(s.table,s.title) : ''}</section>`).join('');
}
function contents(sections, extra) {
  return `<details class="contents"><summary>Contents</summary><ol>${sections.map((s,i) => `<li>${link('#section-' + (i+1),s.title)}</li>`).join('')}${extra}</ol></details>`;
}
for (const p of projects) {
  const primary = p.primaryLink || p.links?.find(l => !/\.(json|csv)(?:$|\?)/i.test(l.url));
  const body = `<article class="prose"><header class="page-intro"><p class="back-link">${link(p.kind === 'Creative' ? '/studio/' : '/work/',p.kind === 'Creative' ? 'Interactive projects' : 'All work')}</p><h1>${esc(p.title)}</h1><p>${esc(p.summary)}</p><p class="project-links${primary?.featured ? ' has-featured-link' : ''}">${primary ? (primary.featured ? `<a class="project-action" href="${esc(primary.url)}">${esc(primary.label)}</a>` : link(primary.url,primary.label)) + (primary.featured ? ' ' : ' · ') : ''}${link('#sources','Source code & evidence')}</p>${primary?.note ? `<p class="small">${esc(primary.note)}</p>` : ''}</header>
<p class="contribution"><strong>My role.</strong> ${esc(p.contribution)}</p><details class="project-info"><summary>Project details</summary><dl><dt>Status</dt><dd>${esc(p.status)}</dd><dt>Focus</dt><dd>${(p.domains || []).map(esc).join(', ')}</dd><dt>Tools & methods</dt><dd>${(p.stack || []).map(esc).join(', ')}</dd></dl></details>
${p.image ? `<details class="project-image"><summary>View the application</summary><figure><img src="${p.image}" alt="${esc(p.imageAlt || p.title)}" loading="lazy">${p.imageCaption ? `<figcaption>${esc(p.imageCaption)}</figcaption>` : ''}</figure></details>` : ''}
${contents(p.sections,`${p.limitations?.length ? '<li><a href="#scope">Limitations</a></li>' : ''}<li><a href="#sources">Source code & evidence</a></li>`)}
${proseSections(p.sections)}${p.slug === 'signal-garden' ? demo() : ''}
${p.limitations?.length ? `<section id="scope"><h2>Limitations</h2><ul>${p.limitations.map(l => `<li>${rich(l)}</li>`).join('')}</ul></section>` : ''}
<section id="sources"><h2>Source code & evidence</h2>${p.links?.length ? `<ul class="sources">${p.links.map(l => `<li>${link(l.url,l.label)}</li>`).join('')}</ul>` : '<p>This archived project does not currently have a public repository or runnable artifact linked.</p>'}${p.evidenceDate ? '<p class="small">Source artifacts retain their actual dates and experimental conditions.</p>' : ''}</section>
${p.related?.length ? `<section><h2>Related work</h2><ul>${p.related.slice(0,3).map(slug => `<li>${link(url(slug),bySlug.get(slug).title)}</li>`).join('')}</ul></section>` : ''}</article>`;
  write(url(p.slug),page({title:p.title,description:p.summary,body,active:'Work',route:url(p.slug)}));
}
write('/notes/',page({title:'Writing',active:'Writing',route:'/notes/',body:`${intro('Writing','Technical notes on model behavior, evaluation, and experimental results.')}${noteList()}`}));
for (const n of notes) {
  const route = `/notes/${n.slug}/`;
  const date = new Date(n.publishedAt + 'T12:00:00Z').toLocaleDateString('en-US',{month:'long',day:'numeric',year:'numeric',timeZone:'UTC'});
  write(route,page({title:n.title,description:n.dek,active:'Writing',route,article:true,publishedAt:n.publishedAt,body:`<article class="prose"><header class="page-intro"><p class="back-link">${link('/notes/','All writing')}</p><h1>${esc(n.title)}</h1><p>${esc(n.dek)}</p><p class="byline">Dennis Koshta · <time datetime="${n.publishedAt}">${date}</time> · ${n.readingMinutes || 7} min read</p></header>${contents(n.sections,'<li><a href="#references">References</a></li>')}${proseSections(n.sections)}<section id="references"><h2>References</h2><ul class="sources">${n.sources.map(l => `<li>${link(l.url,l.label)}</li>`).join('')}</ul></section><section><h2>Related work</h2><ul>${n.related.map(slug => `<li>${link(url(slug),bySlug.get(slug).title)}</li>`).join('')}</ul></section></article>`}));
}
const aboutBody = `${intro('About')}<div class="about-bio"><img class="portrait" src="${profile.image}" width="${profile.imageWidth}" height="${profile.imageHeight}" alt="Dennis Koshta"><div>${profile.aboutParagraphs.map(p => `<p>${rich(p)}</p>`).join('')}</div></div>
<div class="about-details"><section class="about-experience"><h2>Experience</h2><ul class="experience-list">${profile.experience.map(e => `<li><h3>${esc(e.organization)}</h3><p class="small">${esc(e.role)}</p><p>${esc(e.description)}</p></li>`).join('')}</ul></section>
<div class="about-side">${profile.aboutSections.map(s => `<section id="${esc(s.id)}"><h2>${esc(s.title)}</h2>${s.paragraphs.map(p => `<p>${esc(p)}</p>`).join('')}</section>`).join('')}<section><h2>Education</h2>${profile.education.map(e => `<p><strong>${esc(e.institution)}</strong><br>${esc(e.description)}</p>`).join('')}</section><section id="contact"><h2>Contact</h2><p>${link('mailto:' + profile.email,profile.email)}<br>${link(config.github,'GitHub')} · ${link(config.linkedin,'LinkedIn')}</p></section></div></div>`;
write('/about/',page({title:'About',active:'About',route:'/about/',body:aboutBody}));
write('/colophon/',page({title:'About this site',route:'/colophon/',body:`${intro('About this site')}<div class="prose"><section><h2>Implementation</h2><p>Static HTML and CSS, with a small script for project search and the Signal Garden embed. The site uses a locally hosted copy of DM Sans. Project descriptions, research notes, and homepage selections are kept in editable content files.</p></section><section><h2>Attribution</h2><p>Individual project pages describe my contribution and credit collaborators. The Studio projects were developed with GPT and Claude. This portfolio was implemented with Codex. The portrait is the headshot I supplied.</p></section><section><h2>Evidence</h2><p>Results refer to particular recorded experiments, with conditions and limitations in the project notes. Source artifacts keep their actual timestamps. The site is organized by subject, not by chronology.</p></section><section><h2>Privacy</h2><p>There are no analytics scripts, advertising, or visitor accounts on this site. Search runs in your browser. Light/dark mode and theme colors are saved only in this browser. The Signal Garden demo loads from GitHub Pages as you approach it on the page. Audio starts only when you press Play or create a random scene; Stop demo unloads the application. Hosting providers process ordinary web requests. External applications have their own behavior and policies.</p></section><section><h2>Corrections</h2><p>${link('mailto:' + profile.email,'Email me')} if a link breaks or a claim needs clarification.</p></section></div>`}));
write('/404.html',page({title:'Page not found',route:'/404.html',body:`${intro('Page not found','This page may have moved or no longer exists.')}<p>${link('/','Home')} · ${link('/work/','All projects')}</p>`}));
fs.writeFileSync(path.join(out,'sitemap.xml'),`<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${routes.map(route => `<url><loc>${config.origin + route}</loc></url>`).join('')}</urlset>`);
fs.writeFileSync(path.join(out,'robots.txt'),`User-agent: *\nAllow: /\n\nSitemap: ${config.origin}/sitemap.xml\n`);
fs.writeFileSync(path.join(out,'_headers'),'/*\n  X-Content-Type-Options: nosniff\n  Referrer-Policy: strict-origin-when-cross-origin\n  Permissions-Policy: camera=(), microphone=(), geolocation=()\n  X-Frame-Options: SAMEORIGIN\n');
fs.writeFileSync(path.join(out,'project-index.json'),JSON.stringify(projects.map(p => ({slug:p.slug,title:p.title,summary:p.summary,kind:p.kind,status:p.status,domains:p.domains,url:url(p.slug)})),null,2));
console.log(`Built ${routes.length} pages, ${projects.length} projects, ${notes.length} notes.`);
