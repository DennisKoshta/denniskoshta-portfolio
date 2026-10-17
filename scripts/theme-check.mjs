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
    assert.equal(await page.locator('html').getAttribute('data-theme'),'paper');
    await page.getByRole('button',{name:'Theme lab',exact:true}).click();
    for(const name of ['Paper','Porcelain','Sand','Mist','Monochrome','Blue slate']){
      await page.getByRole('button',{name,exact:true}).click();
      assert.equal(await page.getByRole('button',{name,exact:true}).getAttribute('aria-pressed'),'true');
      assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
      const a11y=await new AxeBuilder({page}).withTags(['wcag2a','wcag2aa','wcag21aa']).analyze();
      if(a11y.violations.length)failures.push({width,name,violations:a11y.violations.map(v=>({id:v.id,nodes:v.nodes.map(n=>({target:n.target,summary:n.failureSummary}))}))});
      checks++;
    }
    await page.getByLabel('Background',{exact:true}).fill('#eeeeeb');
    await page.getByLabel('Accent',{exact:true}).fill('#795b89');
    assert.equal(await page.locator('html').getAttribute('data-theme'),'custom');
    const theme=await page.evaluate(()=>window.portfolioTheme.current);
    await page.keyboard.press('Escape');
    assert.equal(await page.locator(':focus').textContent(),'Theme lab');
    await page.getByRole('navigation').getByRole('link',{name:'Work',exact:true}).click();
    assert.deepEqual(await page.evaluate(()=>window.portfolioTheme.current),theme);
    await page.reload();assert.deepEqual(await page.evaluate(()=>window.portfolioTheme.current),theme);
    await page.getByRole('button',{name:'Theme lab',exact:true}).click();
    // Explicitly exercise the clipboard-denied fallback.
    await page.evaluate(()=>Object.defineProperty(navigator,'clipboard',{value:{writeText:async()=>{throw new Error('denied');}},configurable:true}));
    await page.getByRole('button',{name:'Copy theme',exact:true}).click();
    assert.match(await page.getByLabel('Theme settings to copy').inputValue(),/#eeeeeb/);
    await page.getByRole('button',{name:'Reset',exact:true}).click();
    assert.equal(await page.locator('html').getAttribute('data-theme'),'paper');
    assert.equal(await page.evaluate(()=>localStorage.getItem('portfolio-theme-preview-v1')),null);
    if(width!==320){await page.screenshot({path:`research/qa/theme-panel-${width}.png`});}
    await page.getByRole('button',{name:'Close theme panel'}).click();
    await page.getByRole('navigation').getByRole('link',{name:'Home',exact:true}).click();
    if(width===1440)await page.screenshot({path:'research/qa/theme-paper-home.png'});
    await context.close();
  }
  const blocked=await browser.newContext();
  await blocked.addInitScript(()=>{Storage.prototype.getItem=()=>{throw new Error('blocked');};Storage.prototype.setItem=()=>{throw new Error('blocked');};Storage.prototype.removeItem=()=>{throw new Error('blocked');};});
  const page=await blocked.newPage();await page.goto(base);await page.getByRole('button',{name:'Theme lab',exact:true}).click();await page.getByRole('button',{name:'Sand',exact:true}).click();assert.equal(await page.locator('html').getAttribute('data-theme'),'sand');await blocked.close();
  const noJS=await browser.newContext({javaScriptEnabled:false});const plain=await noJS.newPage();await plain.goto(base);assert.equal(await plain.locator('.theme-lab').count(),0);assert.equal(await plain.locator('body').evaluate(e=>getComputedStyle(e).getPropertyValue('--bg').trim()),'#f6f5f1');await noJS.close();
} finally {await browser.close();}
fs.writeFileSync('research/qa/theme-report.json',JSON.stringify({checks,failures},null,2));
console.log(JSON.stringify({checks,failures:failures.length,report:'research/qa/theme-report.json'}));
if(failures.length)process.exitCode=1;
