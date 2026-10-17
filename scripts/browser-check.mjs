import {chromium} from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
const base=process.env.TEST_BASE_URL||'http://127.0.0.1:4173';
const browser=await chromium.launch({headless:true,...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE?{executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE}:{})});
const result={base,checks:[],failures:[]};
const routes=['/','/work/','/research/','/studio/','/notes/','/about/','/colophon/'];
for(const p of JSON.parse(fs.readFileSync('dist/project-index.json','utf8')))routes.push(p.url);
for(const n of JSON.parse(fs.readFileSync('content/notes.json','utf8')))routes.push(`/notes/${n.slug}/`);
const qa=path.resolve('research/qa');fs.mkdirSync(qa,{recursive:true});
try {
 for(const width of [1440,390]){
  const context=await browser.newContext({viewport:{width,height:900},reducedMotion:'reduce'});
  const page=await context.newPage();
  const exceptions=[];page.on('pageerror',e=>exceptions.push(e.message));
  for(const route of routes){
   const response=await page.goto(base+route,{waitUntil:'networkidle'});
   if(response.status()!==200)result.failures.push({width,route,error:`HTTP ${response.status()}`});
   const overflow=await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1);
   if(overflow)result.failures.push({width,route,error:'Horizontal overflow'});
   const a11y=await new AxeBuilder({page}).withTags(['wcag2a','wcag2aa','wcag21aa']).analyze();
   const violations=a11y.violations.map(v=>({id:v.id,impact:v.impact,description:v.description,nodes:v.nodes.map(n=>({target:n.target,summary:n.failureSummary}))}));
   if(violations.length)result.failures.push({width,route,violations});
   result.checks.push({width,route,status:response.status(),overflow,a11yViolations:violations.length});
  }
  if(exceptions.length)result.failures.push({width,exceptions});
  // Padding, text, and images must follow the primary link; resource links stay independent.
  await page.goto(base+'/');
  const selectedTile=page.locator('#selected-work .project-tile').first();
  const tileBox=await selectedTile.boundingBox();
  await selectedTile.click({position:{x:tileBox.width-12,y:tileBox.height-12}});
  await page.waitForURL(base+'/work/upbringing/');
  await page.goto(base+'/');
  const code=page.locator('#selected-work .project-tile').first().getByRole('link',{name:'Code',exact:true});
  const codeURL=await code.getAttribute('href');
  await page.route(codeURL,route=>route.fulfill({contentType:'text/html',body:'<title>Code link test</title>'}));
  await code.click();await page.waitForURL(codeURL);await page.unroute(codeURL);
  await page.goto(base+'/');
  await page.locator('#selected-work .tile-link').first().focus();
  await page.keyboard.press('Enter');await page.waitForURL(base+'/work/upbringing/');
  await page.goto(base+'/work/');
  await page.locator('.project-tile').filter({has:page.getByRole('link',{name:'TransferBatch',exact:true})}).click({position:{x:40,y:40}});
  await page.waitForURL(base+'/work/transferbatch/');
  await page.goto(base+'/work/');
  await page.getByLabel('Category',{exact:true}).selectOption('research');
  assert.equal(await page.locator('[data-project]:visible').count(),7);
  await page.getByRole('searchbox').fill('curiosity');
  assert.equal(await page.locator('[data-project]:visible').count(),1);
  await page.reload();assert.equal(await page.getByRole('searchbox').inputValue(),'curiosity');
  assert.equal(await page.locator('[data-project]:visible').count(),1);
  await page.getByRole('searchbox').fill('no-such-project-xyz');
  assert.equal(await page.locator('.empty-results').isVisible(),true);
  assert.equal(await page.locator('[data-project-group]:visible').count(),0);
  assert.equal(await page.locator('.tile-grid:visible').count(),0);
  await page.getByRole('button',{name:'Show all projects'}).click();
  assert.equal(await page.locator('[data-project]:visible').count(),28);
  await page.getByRole('searchbox').fill('rag-eval-kit');
  await page.getByRole('link',{name:'rag-eval-kit',exact:true}).click();
  assert.equal(new URL(page.url()).pathname,'/work/rag-eval-kit/');
  await page.goto(base+'/work/curiosity-satisfaction/');
  assert.equal(await page.locator('.project-links a').first().getAttribute('href'),'/notes/when-steering-changes-nothing/');
  await page.locator('.contents summary').click();
  await page.locator('.contents a[href="#sources"]').click();
  assert.equal(new URL(page.url()).hash,'#sources');
  await page.goto(base+'/',{waitUntil:'networkidle'});
  const demo=page.locator('[data-demo]');
  assert.equal(await demo.locator('iframe').count(),0);
  await demo.scrollIntoViewIfNeeded();
  await demo.getByRole('button',{name:'Start demo',exact:true}).click();
  const app=page.frameLocator('[data-demo] iframe');
  await app.getByRole('button',{name:'Play',exact:true}).waitFor({timeout:30000});
  assert.equal(await app.locator('dialog[open]').count(),0);
  assert.equal(await app.locator('.tab').filter({hasText:'Scenes'}).getAttribute('aria-pressed'),'true');
  await app.getByRole('button',{name:'Play',exact:true}).click();
  await app.getByRole('button',{name:'Pause',exact:true}).click();
  const sceneName=await app.locator('.scene-title').textContent();
  await app.getByRole('button',{name:/Create random scene/}).click();
  assert.notEqual(await app.locator('.scene-title').textContent(),sceneName);
  await app.getByRole('button',{name:'Pause',exact:true}).waitFor({timeout:10000});
  const stop=demo.getByRole('button',{name:'Stop demo',exact:true});
  await stop.scrollIntoViewIfNeeded();
  await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
  await stop.click();
  await demo.locator('iframe').waitFor({state:'detached'});
  assert.equal(await page.locator(':focus').textContent(),'Start demo');
  await demo.getByRole('button',{name:'Start demo',exact:true}).click();
  await app.getByRole('button',{name:'Play',exact:true}).waitFor({timeout:30000});
  assert.equal(await app.locator('.tab').filter({hasText:'Scenes'}).getAttribute('aria-pressed'),'true');
  assert.equal(await demo.locator('iframe').count(),1);
  await page.goto(base+'/');await page.keyboard.press('Tab');assert.equal(await page.locator(':focus').textContent(),'Skip to content');
  for(const route of ['/','/work/','/work/upbringing/','/work/curiosity-satisfaction/','/studio/','/about/']){
   await page.goto(base+route,{waitUntil:'networkidle'});
   await page.evaluate(async()=>{for(let y=0;y<document.body.scrollHeight;y+=600){window.scrollTo(0,y);await new Promise(r=>setTimeout(r,25));}await Promise.all([...document.images].filter(i=>i.getClientRects().length).map(i=>i.decode().catch(()=>{})));window.scrollTo(0,0);});
   const broken=await page.locator('img').evaluateAll(imgs=>imgs.filter(i=>i.getClientRects().length&&(!i.complete||!i.naturalWidth)).map(i=>i.src));
   if(broken.length)result.failures.push({route,width,brokenImages:broken});
   await page.screenshot({path:path.join(qa,`${route.replaceAll('/','-')||'home'}-${width}.png`),fullPage:true});
  }
  const bad=await page.goto(base+'/a-page-that-does-not-exist/');assert.equal(bad.status(),404);assert.equal(await page.locator('h1').count(),1);
  await context.close();
 }
 result.interactions='Passed whole-tile padding/image clicks, independent resource links, keyboard activation, project search and category filters, URL persistence, no-results/reset, project navigation, contents links, visible paused demo, Scenes default, random scene, playback, stop/restart, skip link, and 404';
}catch(error){result.failures.push({error:error.stack});}
finally{await browser.close();fs.writeFileSync(path.join(qa,'browser-report.json'),JSON.stringify(result,null,2));}
console.log(JSON.stringify({pageChecks:result.checks.length,failures:result.failures.length,interactions:result.interactions,report:path.join(qa,'browser-report.json')}));
if(result.failures.length)process.exitCode=1;
