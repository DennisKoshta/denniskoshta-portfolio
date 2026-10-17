import {chromium} from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import assert from 'node:assert/strict';
import fs from 'node:fs';
const base=process.env.TEST_BASE_URL||'http://127.0.0.1:4173';
const browser=await chromium.launch({headless:true,...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE?{executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE}:{})});
const failures=[];let checks=0;
try {
  for(const width of [1440,390,320]){
    const context=await browser.newContext({viewport:{width,height:900}});
    const page=await context.newPage();
    await page.goto(base);await page.evaluate(()=>document.fonts.ready);
    assert.equal(await page.locator('html').getAttribute('data-theme'),'mist');
    assert.equal(await page.locator('.theme-lab').count(),0);
    assert.equal(await page.getByRole('button',{name:'Theme lab',exact:true}).count(),0);
    await page.getByRole('button',{name:'Switch to dark mode',exact:true}).click();
    assert.equal((await page.evaluate(()=>window.portfolioTheme.current)).bg,'#0c0d0e');
    assert.equal((await page.evaluate(()=>window.portfolioTheme.current)).accent,'#a8bad2');
    await page.getByRole('button',{name:'Switch to light mode',exact:true}).click();
    assert.equal(await page.locator('.theme-lab').count(),0);
    await page.getByRole('button',{name:/Switch to .* mode/}).click({modifiers:['Shift']});
    for(const name of ['Mist','Paper','Porcelain','Sand','Monochrome','Midnight','Graphite','Ink','Night mist','Charcoal','Warm gray','Blue slate']){
      if(name==='Midnight')await page.getByRole('button',{name:'Dark',exact:true}).click();
      await page.getByRole('button',{name,exact:true}).click();
      assert.equal(await page.getByRole('button',{name,exact:true}).getAttribute('aria-pressed'),'true');
      assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
      const a11y=await new AxeBuilder({page}).withTags(['wcag2a','wcag2aa','wcag21aa']).analyze();
      if(a11y.violations.length)failures.push({width,name,violations:a11y.violations.map(v=>({id:v.id,nodes:v.nodes.map(n=>({target:n.target,summary:n.failureSummary}))}))});
      checks++;
    }
    await page.getByRole('button',{name:'Light',exact:true}).click();
    assert.equal(await page.locator('html').getAttribute('data-theme'),'mono');
    await page.getByLabel('Background',{exact:true}).fill('#eeeeeb');
    await page.getByLabel('Accent',{exact:true}).fill('#795b89');
    assert.equal(await page.locator('html').getAttribute('data-theme'),'custom');
    const theme=await page.evaluate(()=>window.portfolioTheme.current);
    await page.keyboard.press('Escape');
    assert.equal(await page.locator(':focus').getAttribute('data-mode-toggle'),'');
    await page.getByRole('navigation').getByRole('link',{name:'Work',exact:true}).click();
    await page.waitForURL(base+'/work/');
    assert.deepEqual(await page.evaluate(()=>window.portfolioTheme.current),theme);
    await page.getByRole('button',{name:'Switch to dark mode',exact:true}).click();
    assert.equal(await page.locator('html').getAttribute('data-theme'),'slate');
    await page.reload();assert.equal(await page.locator('html').getAttribute('data-theme'),'slate');
    await page.getByRole('button',{name:'Switch to light mode',exact:true}).click();
    assert.deepEqual(await page.evaluate(()=>window.portfolioTheme.current),theme);
    await page.reload();assert.deepEqual(await page.evaluate(()=>window.portfolioTheme.current),theme);
    await page.getByRole('button',{name:/Switch to .* mode/}).click({modifiers:['Shift']});
    // Explicitly exercise the clipboard-denied fallback.
    await page.evaluate(()=>Object.defineProperty(navigator,'clipboard',{value:{writeText:async()=>{throw new Error('denied');}},configurable:true}));
    await page.getByRole('button',{name:'Copy theme',exact:true}).click();
    assert.match(await page.getByLabel('Theme settings to copy').inputValue(),/#eeeeeb/);
    await page.getByRole('button',{name:'Reset',exact:true}).click();
    assert.equal(await page.locator('html').getAttribute('data-theme'),'mist');
    assert.equal(await page.evaluate(()=>JSON.parse(localStorage.getItem('portfolio-appearance-v3')).dark.id),'slate');
    await page.getByRole('button',{name:'Dark',exact:true}).click();
    await page.getByRole('button',{name:'Reset',exact:true}).click();
    assert.equal(await page.locator('html').getAttribute('data-theme'),'midnight');
    await page.getByRole('button',{name:'Light',exact:true}).click();
    assert.equal(await page.locator('html').getAttribute('data-theme'),'mist');
    if(width!==320){await page.screenshot({path:`research/qa/theme-panel-${width}.png`});}
    await page.getByRole('button',{name:'Close theme panel'}).click();
    await page.getByRole('navigation').getByRole('link',{name:'Home',exact:true}).click();
    await page.waitForURL(base+'/');
    if(width===1440)await page.screenshot({path:'research/qa/theme-paper-home.png'});
    await context.close();
  }
  const blocked=await browser.newContext();
  await blocked.addInitScript(()=>{Storage.prototype.getItem=()=>{throw new Error('blocked');};Storage.prototype.setItem=()=>{throw new Error('blocked');};Storage.prototype.removeItem=()=>{throw new Error('blocked');};});
  const page=await blocked.newPage();await page.goto(base);await page.getByRole('button',{name:/Switch to .* mode/}).click({modifiers:['Shift']});await page.getByRole('button',{name:'Sand',exact:true}).click();assert.equal(await page.locator('html').getAttribute('data-theme'),'sand');await blocked.close();
  for(const legacy of [{bg:'#edf2f2',accent:'#426b70'},{bg:'#242e40',accent:'#9acdf7'}]){
    const migrated=await browser.newContext();await migrated.addInitScript(value=>localStorage.setItem('portfolio-theme-preview-v1',JSON.stringify(value)),legacy);
    const p=await migrated.newPage();await p.goto(base);assert.equal((await p.evaluate(()=>window.portfolioTheme.current)).bg,legacy.bg==='#edf2f2'?'#edf2f2':'#0c0d0e');
    await p.getByRole('button',{name:/Switch to .* mode/}).click();assert.equal(await p.evaluate(()=>localStorage.getItem('portfolio-theme-preview-v1')),null);await migrated.close();
  }
  const old=await browser.newContext();await old.addInitScript(()=>localStorage.setItem('portfolio-appearance-v2',JSON.stringify({mode:'dark',dark:{bg:'#202326',accent:'#adc6c8'},light:{bg:'#f6f5f1',accent:'#526779'}})));const prior=await old.newPage();await prior.goto(base);assert.equal(await prior.locator('html').getAttribute('data-theme'),'midnight');await prior.getByRole('button',{name:'Switch to light mode'}).click();assert.equal(await prior.locator('html').getAttribute('data-theme'),'mist');await old.close();
  const direct=await browser.newContext({viewport:{width:390,height:700}});const hidden=await direct.newPage();await hidden.goto(base+'/?theme-lab=1');await hidden.getByRole('heading',{name:'Theme lab',exact:true}).waitFor();await hidden.getByRole('button',{name:'Close theme panel'}).click();assert.equal(await hidden.locator('#theme-panel').isVisible(),false);await direct.close();
  const corrupt=await browser.newContext();await corrupt.addInitScript(()=>localStorage.setItem('portfolio-appearance-v3','broken json'));const repaired=await corrupt.newPage();await repaired.goto(base);assert.equal(await repaired.locator('html').getAttribute('data-theme'),'mist');await corrupt.close();
  const noJS=await browser.newContext({javaScriptEnabled:false});const plain=await noJS.newPage();await plain.goto(base);assert.equal(await plain.locator('.theme-lab').count(),0);assert.equal(await plain.locator('body').evaluate(e=>getComputedStyle(e).getPropertyValue('--bg').trim()),'#edf2f2');await noJS.close();
} finally {await browser.close();}
fs.writeFileSync('research/qa/theme-report.json',JSON.stringify({checks,failures},null,2));
console.log(JSON.stringify({checks,failures:failures.length,report:'research/qa/theme-report.json'}));
if(failures.length)process.exitCode=1;
