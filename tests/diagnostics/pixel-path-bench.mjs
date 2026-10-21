// Benches the pixel codec path against the same pan as the command path.
//
// The two paths are different pages and different transports, so they are not
// comparable unless the camera actually moves in exactly the same way and the
// measurement is taken from each page's own display sampler. Both pages expose a
// bench object; this reads the one that exists rather than inventing a second
// definition of a freeze.
import { chromium } from 'playwright';

const RAW = process.env.DF_RAW_PAGE || 'http://192.168.1.111:8000/';
const CMD = process.env.DF_BASE || 'http://192.168.1.111:8484';

const stats = async (base) => (await fetch(base === CMD ? `${CMD}/df-stats` : `${RAW}stats`)).json().catch(() => null);
const settle = (ms) => new Promise((r) => setTimeout(r, ms));

function gaps(times) {
  const g = [];
  for (let i = 1; i < times.length; i++) g.push(times[i] - times[i - 1]);
  if (!g.length) return null;
  const s = [...g].sort((a, b) => a - b);
  const at = (p) => Math.round(s[Math.min(s.length - 1, Math.floor(s.length * p))]);
  return { n: g.length, p50: at(0.5), p95: at(0.95), max: Math.round(s[s.length - 1]), over200: g.filter((x) => x > 200).length };
}

async function pan(page, keys, seconds) {
  const t0 = Date.now();
  let i = 0;
  while (Date.now() - t0 < seconds * 1000) {
    const k = keys[i % keys.length];
    await page.keyboard.down(k);
    await page.waitForTimeout(700);
    await page.keyboard.up(k);
    i++;
  }
}

const browser = await chromium.launch({
  headless: true,
  args: ['--disable-frame-rate-limit', '--disable-gpu-vsync', '--run-all-compositor-stages-before-draw',
         '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows'],
});

const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
await page.goto(RAW, { waitUntil: 'domcontentloaded' });
await settle(12000);

// the raw page has its own input socket; the same keys move the camera
const before = await page.evaluate(() => ({
  display: (window.__dfBench?.display || []).length,
  startedAt: performance.now(),
}));
await pan(page, ['a', 'd', 'w', 's'], 12);
const after = await page.evaluate(() => {
  const b = window.__dfBench || {};
  const disp = b.display || [];
  return {
    displayTimes: disp.map((d) => (Array.isArray(d) ? d[0] : d)),
    changes: (b.changeMagnitude || []).length,
    longTasks: (b.longTasks || []).length,
    inputsSent: b.inputsSent || 0,
    path: b.path,
    nativeSamples: b.nativeSamples || 0,
  };
});

const during = after.displayTimes.filter((t) => t > 0);
const g = gaps(during);
const rawStats = await (await fetch('http://192.168.1.111:8484/df-stats')).json();

console.log(JSON.stringify({
  path: after.path || 'raw',
  displaySamplesDuringPan: during.length,
  displayGaps: g,
  changesObserved: after.changes,
  longTasks: after.longTasks,
  inputsSent: after.inputsSent,
  raw: rawStats.raw,
}, null, 2));

await page.screenshot({ path: 'evidence/bench/pixel-path.png' });
await browser.close();
