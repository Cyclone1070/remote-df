/**
 * df_mainthread_compare.mjs — measure what each path does to the browser's main
 * thread under identical load.
 *
 * Both paths were benched and the smart one is worse on latency despite moving
 * roughly an eighth of the data, which rules out bandwidth as the cause. The
 * remaining difference is how much work each one asks the main thread to do:
 * the raw path hands a JPEG to the browser's own image decoder, while the smart
 * path decodes draw commands and uploads textures in JavaScript. This measures
 * that directly, on both pages, with the same input.
 *
 * Usage: node scripts/df_mainthread_compare.mjs
 */
import { chromium } from 'playwright';

const TARGETS = [
  { name: 'smart (draw commands)', url: process.env.SMART_URL || 'http://192.168.1.111:8484/df' },
  { name: 'raw (jpeg frames)', url: process.env.RAW_URL || 'http://192.168.1.111:8000/' },
];
const ZOOMS = Number(process.env.ZOOMS || 350);
const GAP_MS = Number(process.env.ZOOM_GAP_MS || 8);

const browser = await chromium.launch({
  headless: true,
  args: ['--no-sandbox', '--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'],
});

const results = [];
for (const t of TARGETS) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  // Installed before any page script runs, so nothing is missed.
  await page.addInitScript(() => {
    window.__lt = [];
    window.__rafGaps = [];
    try {
      new PerformanceObserver((l) => {
        for (const e of l.getEntries()) window.__lt.push(Math.round(e.duration));
      }).observe({ entryTypes: ['longtask'] });
    } catch { /* longtask not supported: leave empty rather than fake it */ }
    let last = 0;
    const tick = (ts) => { if (last) window.__rafGaps.push(+(ts - last).toFixed(1)); last = ts; requestAnimationFrame(tick); };
    requestAnimationFrame(tick);
  });

  await page.goto(t.url, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(12000);
  await page.evaluate(() => { window.__lt = []; window.__rafGaps = []; });

  const target = (await page.locator('canvas').count()) ? page.locator('canvas').first()
    : (await page.locator('img').count()) ? page.locator('img').first()
      : page.locator('body');
  const box = await target.boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);

  for (let i = 0; i < ZOOMS; i++) {
    await page.mouse.wheel(0, i % 20 < 10 ? -120 : 120);
    await page.waitForTimeout(GAP_MS);
  }
  await page.waitForTimeout(3000);

  const s = await page.evaluate(() => {
    const lt = window.__lt.slice().sort((a, b) => a - b);
    const g = window.__rafGaps.slice().sort((a, b) => a - b);
    const q = (arr, p) => (arr.length ? arr[Math.min(arr.length - 1, Math.floor(arr.length * p))] : 0);
    return {
      longTasks: lt.length,
      ltTotalMs: lt.reduce((a, b) => a + b, 0),
      ltMaxMs: lt[lt.length - 1] || 0,
      ltOver50: lt.filter((x) => x > 50).length,
      rafFrames: g.length,
      rafMedian: q(g, 0.5),
      rafP90: q(g, 0.9),
      rafP99: q(g, 0.99),
      rafMax: g[g.length - 1] || 0,
    };
  });
  results.push({ ...t, ...s });
  await page.close();
}
await browser.close();

console.log(`\nmain-thread cost under ${ZOOMS} wheel events at ${GAP_MS}ms apart\n`);
console.log('path                    longtasks  blocked_ms  max_ms  >50ms   raf_med  raf_p90  raf_p99  raf_max');
for (const r of results) {
  console.log(
    `${r.name.padEnd(23)} ${String(r.longTasks).padStart(9)} ${String(r.ltTotalMs).padStart(11)} ` +
    `${String(r.ltMaxMs).padStart(7)} ${String(r.ltOver50).padStart(6)} ${String(r.rafMedian).padStart(8)} ` +
    `${String(r.rafP90).padStart(8)} ${String(r.rafP99).padStart(8)} ${String(r.rafMax).padStart(8)}`);
}
