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
  await page.goto(base+'/work/');
  await page.getByRole('button',{name:'Research',exact:true}).click();
  assert.equal(await page.locator('[data-project]:visible').count(),4);
  await page.getByRole('searchbox').fill('curiosity');
  assert.equal(await page.locator('[data-project]:visible').count(),1);
  await page.reload();assert.equal(await page.getByRole('searchbox').inputValue(),'curiosity');
  assert.equal(await page.locator('[data-project]:visible').count(),1);
  await page.getByRole('searchbox').fill('no-such-project-xyz');
  assert.equal(await page.locator('.empty-results').isVisible(),true);
  await page.getByRole('button',{name:'Show all projects'}).click();
  assert.equal(await page.locator('[data-project]:visible').count(),28);
  await page.goto(base+'/work/upbringing/');
  await page.getByRole('button',{name:'8 / (3 − 8 / 3)',exact:true}).click();
  assert.equal(await page.locator('[data-check=numeric] b').textContent(),'Pass');
  assert.equal(await page.locator('[data-check=contract] b').textContent(),'Pass');
  await page.getByRole('button',{name:'24',exact:true}).click();
  assert.equal(await page.locator('[data-check=numeric] b').textContent(),'Pass');
  assert.equal(await page.locator('[data-check=contract] b').textContent(),'Fail');
  await page.locator('#expression').fill('8/(3-3)');await page.getByRole('button',{name:'Check',exact:true}).click();
  assert.equal(await page.locator('#expression').getAttribute('aria-invalid'),'true');
  await page.goto(base+'/');await page.keyboard.press('Tab');assert.equal(await page.locator(':focus').textContent(),'Skip to content');
  if(width===390){const menu=page.getByRole('button',{name:'Menu',exact:true});await menu.click();assert.equal(await menu.getAttribute('aria-expanded'),'true');await page.keyboard.press('Escape');assert.equal(await menu.getAttribute('aria-expanded'),'false');}
  for(const route of ['/','/work/','/work/upbringing/','/work/curiosity-satisfaction/','/studio/','/about/']){
   await page.goto(base+route,{waitUntil:'networkidle'});
   await page.evaluate(async()=>{for(let y=0;y<document.body.scrollHeight;y+=600){window.scrollTo(0,y);await new Promise(r=>setTimeout(r,25));}await Promise.all([...document.images].map(i=>i.decode().catch(()=>{})));window.scrollTo(0,0);});
   const broken=await page.locator('img').evaluateAll(imgs=>imgs.filter(i=>!i.complete||!i.naturalWidth).map(i=>i.src));
   if(broken.length)result.failures.push({route,width,brokenImages:broken});
   await page.screenshot({path:path.join(qa,`${route.replaceAll('/','-')||'home'}-${width}.png`),fullPage:true});
  }
  const bad=await page.goto(base+'/a-page-that-does-not-exist/');assert.equal(bad.status(),404);assert.equal(await page.locator('h1').count(),1);
  await context.close();
 }
 result.interactions='Passed search, filters, URL persistence, no-results/reset, exact-arithmetic verifier, skip link, mobile menu, and 404';
}catch(error){result.failures.push({error:error.stack});}
finally{await browser.close();fs.writeFileSync(path.join(qa,'browser-report.json'),JSON.stringify(result,null,2));}
console.log(JSON.stringify({pageChecks:result.checks.length,failures:result.failures.length,interactions:result.interactions,report:path.join(qa,'browser-report.json')}));
if(result.failures.length)process.exitCode=1;
