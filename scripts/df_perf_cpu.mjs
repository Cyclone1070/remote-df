/**
 * df_perf_cpu.mjs — find the hot functions during rapid input, using the
 * browser's own CPU profiler.
 *
 * Wrapping individual browser calls only accounted for ~2% of the blocking, so
 * guessing which calls are expensive does not work here. This takes a real
 * sampling profile over the input burst and reports self-time per function,
 * which names the culprit instead of narrowing it.
 *
 * Rapid input matters: at 20ms between wheel events the stall does not appear;
 * at 8ms it does. The burst rate is the trigger, so it is reproduced exactly.
 *
 * Output: /tmp/dfperf/cpu.json  (+ a printed top-25 self-time table)
 */
import { chromium } from 'playwright';
import fs from 'node:fs';

const URL = process.env.QA_URL || 'http://192.168.1.111:8484/';
const OUT = process.env.PERF_OUT || '/tmp/dfperf';
const GAP = Number(process.env.GAP || 8);          // ms between wheel events
const EVENTS = Number(process.env.EVENTS || 900);

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
  window.__lt = [];
  try {
    new PerformanceObserver((l) => { for (const e of l.getEntries()) window.__lt.push(Math.round(e.duration)); })
      .observe({ entryTypes: ['longtask'] });
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
await page.evaluate(() => { window.__lt.length = 0; });

// Real sampling profile over the burst
const cdp = await page.context().newCDPSession(page);
await cdp.send('Profiler.enable');
await cdp.send('Profiler.setSamplingInterval', { interval: 200 });   // 200us
await cdp.send('Profiler.start');

console.log(`rapid input: ${EVENTS} wheel events at ${GAP}ms gaps`);
for (let i = 0; i < EVENTS; i++) {
  await page.mouse.wheel(0, i % 2 === 0 ? 400 : -400);
  await page.waitForTimeout(GAP);
}
await page.waitForTimeout(2500);

const { profile } = await cdp.send('Profiler.stop');
const longTasks = await page.evaluate(() => window.__lt);
fs.writeFileSync(`${OUT}/cpu.json`, JSON.stringify(profile));
fs.writeFileSync(`${OUT}/longtasks.json`, JSON.stringify(longTasks));
fs.writeFileSync(`${OUT}/console.log`, consoleLines.join('\n'));

// Self time per function: samples are a stack of node ids; the leaf is the
// function actually on the CPU. Time per sample is the sampling interval.
const byId = new Map(profile.nodes.map((n) => [n.id, n]));
const self = new Map();
const usPerSample = (profile.endTime - profile.startTime) / profile.samples.length;
for (const id of profile.samples) {
  const n = byId.get(id);
  if (!n) continue;
  const f = n.callFrame;
  const name = `${f.functionName || '(anonymous)'}  ${(f.url || '').split('/').pop()}:${f.lineNumber + 1}`;
  self.set(name, (self.get(name) || 0) + usPerSample);
}
const total = [...self.values()].reduce((a, b) => a + b, 0);
console.log('\n=== TOP 25 BY SELF TIME (total CPU during the burst) ===');
console.log('ms      %      function');
[...self.entries()].sort((a, b) => b[1] - a[1]).slice(0, 25).forEach(([n, us]) => {
  const ms = us / 1000;
  console.log(ms.toFixed(0).padStart(7), ((100 * us / total).toFixed(1) + '%').padStart(7), ' ', n.slice(0, 88));
});

// Roll up by file, which shows whether the cost is ours or a library's
const byFile = new Map();
for (const [name, us] of self) {
  const file = name.split('  ')[1]?.split(':')[0] || '?';
  byFile.set(file, (byFile.get(file) || 0) + us);
}
console.log('\n=== BY FILE ===');
[...byFile.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10).forEach(([f, us]) => {
  console.log((us / 1000).toFixed(0).padStart(7), 'ms ', ((100 * us / total).toFixed(1) + '%').padStart(7), ' ', f);
});

console.log('\n=== BLOCKING ===');
console.log('long tasks:', longTasks.length, ' total blocked:', longTasks.reduce((a, b) => a + b, 0), 'ms');
console.log('worst    :', [...longTasks].sort((a, b) => b - a).slice(0, 8).join(', '), 'ms');
console.log('profile span:', ((profile.endTime - profile.startTime) / 1000).toFixed(1), 's');
await browser.close();
