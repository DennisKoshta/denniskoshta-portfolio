import {chromium} from '@playwright/test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import fs from 'node:fs';

const base = process.env.TEST_BASE_URL || 'http://127.0.0.1:4173';
const paper = JSON.parse(fs.readFileSync('content/papers.json','utf8')).find(p => p.livePdf);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const browser = await chromium.launch({headless:true,...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ? {executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE} : {})});
const context = await browser.newContext();
const page = await context.newPage();
const requests = [];
page.on('request', request => { if (request.url().startsWith(paper.livePdf)) requests.push(request.url()); });
const state = name => page.locator(`[data-paper-state="${name}"]`).waitFor({timeout:35000});
const displayedHash = () => page.evaluate(async () => {
  const bytes = await (await fetch(document.querySelector('[data-paper-open]').href)).arrayBuffer();
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))].map(b => b.toString(16).padStart(2,'0')).join('');
});

try {
  const responsePromise = page.waitForResponse(r => r.url().startsWith(paper.livePdf));
  await page.goto(base + paper.url);
  const response = await responsePromise;
  assert.equal(response.status(),200);
  const currentPDF = await response.body();
  assert.equal(currentPDF.subarray(0,5).toString(),'%PDF-');
  await state('ready');
  assert.equal(await displayedHash(),hash(currentPDF));
  assert.match(await page.locator('.paper-pdf').getAttribute('src'),/^blob:/);

  fs.mkdirSync('research/qa',{recursive:true});
  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('link',{name:'Download PDF',exact:true}).click();
  const download = await downloadPromise;
  await download.saveAs('research/qa/live-paper-download.pdf');
  assert.equal(hash(fs.readFileSync('research/qa/live-paper-download.pdf')),hash(currentPDF));

  // A valid PDF with a different hash stands in for a new upstream commit.
  const updatedPDF = Buffer.concat([currentPDF,Buffer.from('\n% Updated upstream revision for mirror test\n')]);
  let mode = 'updated';
  await page.route(paper.livePdf + '*',route => route.fulfill({
    status:mode === 'unavailable' ? 503 : 200,
    contentType:mode === 'invalid' ? 'text/html' : 'application/octet-stream',
    headers:{'access-control-allow-origin':'*','cache-control':'max-age=300'},
    body:mode === 'updated' ? updatedPDF : '<html>Upstream unavailable</html>'
  }));
  await page.getByRole('button',{name:'Reload PDF',exact:true}).click();
  await state('ready');
  assert.equal(await displayedHash(),hash(updatedPDF));
  await page.reload();
  await state('ready');
  assert.equal(await displayedHash(),hash(updatedPDF));

  for (const failure of ['unavailable','invalid']) {
    mode = failure;
    await page.getByRole('button',{name:'Reload PDF',exact:true}).click();
    await state('error');
    assert.equal(await page.locator('.paper-pdf').isVisible(),false);
    assert.equal(await page.locator('.paper-pdf').getAttribute('src'),null);
    assert.equal(await page.locator('[data-paper-download]').getAttribute('href'),null);
  }
  mode = 'updated';
  await page.getByRole('button',{name:'Reload PDF',exact:true}).click();
  await state('ready');
  assert.equal(await displayedHash(),hash(updatedPDF));
  for (const width of [1440,390]) {
    await page.setViewportSize({width,height:1000});
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),false);
    await page.screenshot({path:`research/qa/live-paper-${width}.png`,fullPage:true});
  }
  assert.ok(requests.length >= 6);
  assert.equal(new Set(requests).size,requests.length);
  assert.ok(requests.every(url => new URL(url).searchParams.has('refresh')));
  console.log(JSON.stringify({upstreamSHA256:hash(currentPDF),checks:'Current upstream bytes displayed and downloaded; new revision on reload and page refresh; no stale fallback on HTTP error or invalid PDF; recovery; unique source request URLs; desktop/mobile layout.'}));
} finally {
  await browser.close();
}
