// Render the link-preview card from HTML, using the supplied photo unchanged.
// Run after `npm run build` with the local preview server running, then rebuild.
import {chromium} from '@playwright/test';
import fs from 'node:fs';

const profile = JSON.parse(fs.readFileSync('content/profile.json', 'utf8'));
const base = process.env.TEST_BASE_URL || 'http://127.0.0.1:4173';
const esc = s => String(s).replace(/[&<>"']/g, c => ({'&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;'}[c]));
const browser = await chromium.launch({headless:true, ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ? {executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE} : {})});
try {
  const page = await browser.newPage({viewport:{width:1200,height:630},deviceScaleFactor:1});
  await page.goto(base);
  const palette = await page.evaluate(() => Object.fromEntries(['bg','heading','muted','rule'].map(key => [key,getComputedStyle(document.documentElement).getPropertyValue('--'+key).trim()])));
  await page.setContent(`<!doctype html><html><head><meta charset="utf-8"><style>
    @font-face { font-family:'DM Sans'; src:url('${base}/assets/fonts/dm-sans-0.woff2') format('woff2'); font-weight:400 700; }
    * { box-sizing:border-box; } body { margin:0; background:${palette.bg}; color:${palette.heading}; font-family:'DM Sans',Arial,sans-serif; }
    main { padding:68px 70px; } .intro { display:flex; justify-content:space-between; align-items:start; }
    h1 { margin:22px 0 24px; font-size:60px; line-height:1.15; font-weight:500; letter-spacing:-2px; }
    p { margin:0; font-size:26px; line-height:1.55; color:${palette.muted}; }
    img { width:205px; height:235px; object-fit:cover; object-position:center 25%; border-radius:4px; }
    footer { display:flex; justify-content:space-between; gap:24px; margin-top:70px; padding-top:30px; border-top:1px solid ${palette.rule}; color:${palette.muted}; font-size:18px; }
    .topics { display:flex; gap:28px; }
  </style></head><body><main><div class="intro"><div><h1>Dennis Koshta</h1><p>Software engineer.</p></div><img src="${base}${esc(profile.image)}" alt="Dennis Koshta"></div><footer><div class="topics"><span>AI systems</span><span>Tools &amp; games</span><span>Experiments</span></div><span>denniskoshta.com</span></footer></main></body></html>`, {waitUntil:'networkidle'});
  await page.evaluate(async () => {await document.fonts.ready; await Promise.all([...document.images].map(i => i.decode()));});
  await page.screenshot({path:'public/assets/social-plain.png'});
  console.log('Rendered public/assets/social-plain.png');
} finally { await browser.close(); }
