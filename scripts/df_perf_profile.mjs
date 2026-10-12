/**
 * df_perf_profile.mjs — attribute the main-thread blocking during rapid input.
 *
 * The symptom is long frozen frames on scroll / zoom / elevation change. Rather
 * than guess, this wraps every expensive browser call the client can make during
 * those operations and times it, so the blocking is charged to a specific cause.
 *
 * Measured:
 *   - atlas allocation  (reallocating a 64MB sheet is a full wipe)
 *   - texture upload    (copying pixels into the sheet)
 *   - pixel readback    (getImageData is a synchronous GPU stall)
 *   - image decode      (createImageBitmap)
 *   - the draw itself
 *   - total long-task blocking, for a denominator
 *
 * Output: /tmp/dfperf/profile.json
 */
import { chromium } from 'playwright';
import fs from 'node:fs';

const URL = process.env.QA_URL || 'http://192.168.1.111:8484/';
const OUT = process.env.PERF_OUT || '/tmp/dfperf';
const ROUNDS = Number(process.env.ROUNDS || 3);
const PER_ROUND = Number(process.env.PER_ROUND || 30);

fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({
  headless: true,
  // Hardware by default: SwiftShader is software rendering and turns every
  // GPU cost into a main-thread stall, which is not what a real user sees.
  args: process.env.SOFTWARE_GL === '1'
      ? ['--no-sandbox', '--use-gl=swiftshader', '--enable-unsafe-swiftshader']
      : ['--no-sandbox', '--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const consoleLines = [];
page.on('console', (m) => consoleLines.push(`[${m.type()}] ${m.text()}`));

await page.addInitScript(() => {
  const P = { calls: {}, longTasks: [], armed: false, window: [] };
  window.__P = P;

  const charge = (name, ms) => {
    if (!P.armed) return;
    const c = P.calls[name] || (P.calls[name] = { n: 0, ms: 0, max: 0, over50: 0 });
    c.n++; c.ms += ms;
    if (ms > c.max) c.max = ms;
    if (ms > 50) c.over50++;
  };
  const wrap = (proto, fn, name) => {
    const orig = proto[fn];
    if (!orig) return;
    proto[fn] = function (...a) {
      const t0 = performance.now();
      const r = orig.apply(this, a);
      charge(name, performance.now() - t0);
      return r;
    };
  };

  if (typeof WebGL2RenderingContext !== 'undefined') {
    const G = WebGL2RenderingContext.prototype;
    wrap(G, 'texImage2D', 'sheet allocate (wipe)');
    wrap(G, 'texSubImage2D', 'texture upload');
    wrap(G, 'drawArraysInstanced', 'draw frame');
    wrap(G, 'drawArrays', 'draw other');
    wrap(G, 'readPixels', 'readPixels');
    wrap(G, 'bufferSubData', 'buffer upload');
  }
  if (typeof CanvasRenderingContext2D !== 'undefined') {
    wrap(CanvasRenderingContext2D.prototype, 'getImageData', 'pixel readback');
    wrap(CanvasRenderingContext2D.prototype, 'drawImage', 'canvas drawImage');
  }
  if (typeof OffscreenCanvasRenderingContext2D !== 'undefined') {
    wrap(OffscreenCanvasRenderingContext2D.prototype, 'getImageData', 'pixel readback (off)');
    wrap(OffscreenCanvasRenderingContext2D.prototype, 'drawImage', 'canvas drawImage (off)');
  }
  if (typeof createImageBitmap === 'function') {
    const o = createImageBitmap;
    window.createImageBitmap = function (...a) {
      const t0 = performance.now();
      return o.apply(this, a).then((r) => { charge('image decode', performance.now() - t0); return r; });
    };
  }
  // Decompression is pure CPU and can be large
  if (typeof DecompressionStream !== 'undefined') {
    const O = DecompressionStream;
    window.DecompressionStream = function (...a) {
      const t0 = performance.now();
      const s = new O(...a);
      charge('decompress constructed', performance.now() - t0);
      return s;
    };
  }

  try {
    new PerformanceObserver((l) => {
      for (const e of l.getEntries()) P.longTasks.push(Math.round(e.duration));
    }).observe({ entryTypes: ['longtask'] });
  } catch {}
});

await page.goto(URL, { waitUntil: 'domcontentloaded' });
const launch = page.locator('text=Launch Game');
try { await launch.waitFor({ state: 'visible', timeout: 8000 }); await launch.click(); }
catch { console.log('attaching to running session'); }
await page.waitForSelector('canvas', { timeout: 120000 });
const box = await page.locator('canvas').first().boundingBox();

await page.waitForTimeout(18000);
const click = async (x, y, settle = 7000) => {
  await page.mouse.move(box.x + x, box.y + y);
  await page.waitForTimeout(400);
  await page.mouse.click(box.x + x, box.y + y);
  await page.waitForTimeout(settle);
};
console.log('-> arena');
await click(631, 472);
await click(180, 137, 3000);
await click(991, 678, 26000);

await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
await page.evaluate(() => { window.__P.armed = true; window.__P.longTasks.length = 0; });

console.log(`rapid input: ${ROUNDS} rounds x ${PER_ROUND} events (out, in, and elevation)`);
for (let r = 0; r < ROUNDS; r++) {
  for (let i = 0; i < PER_ROUND; i++) { await page.mouse.wheel(0, 400);  await page.waitForTimeout(20); }
  for (let i = 0; i < PER_ROUND; i++) { await page.mouse.wheel(0, -400); await page.waitForTimeout(20); }
  console.log(`  round ${r + 1} done`);
}
await page.waitForTimeout(3000);

const P = await page.evaluate(() => ({ calls: window.__P.calls, longTasks: window.__P.longTasks }));
fs.writeFileSync(`${OUT}/profile.json`, JSON.stringify(P, null, 1));
fs.writeFileSync(`${OUT}/console.log`, consoleLines.join('\n'));

console.log('\n=== WHERE THE MAIN THREAD WENT ===');
const rows = Object.entries(P.calls).sort((a, b) => b[1].ms - a[1].ms);
console.log('operation                     calls     total ms   worst ms   >50ms');
for (const [name, c] of rows) {
  console.log(name.padEnd(28), String(c.n).padStart(7), c.ms.toFixed(0).padStart(11),
              c.max.toFixed(0).padStart(11), String(c.over50).padStart(8));
}
const accounted = rows.reduce((s, [, c]) => s + c.ms, 0);
const blocked = P.longTasks.reduce((a, b) => a + b, 0);
console.log('\ntotal long tasks      :', P.longTasks.length);
console.log('total blocked         :', blocked, 'ms');
console.log('attributed to wrapped :', accounted.toFixed(0), 'ms',
            `(${blocked ? (100 * accounted / blocked).toFixed(0) : 0}% of blocking)`);
console.log('worst long tasks      :', [...P.longTasks].sort((a, b) => b - a).slice(0, 8).join(', '), 'ms');
await browser.close();
