// A filmstrip of the real frames around a keypress, saved as PNGs.
//
// The numbers said the first pan is at 508ms and that a 2.8% change at 236ms is
// animation. That is a claim about pictures, so it should be checkable by looking
// at the pictures rather than by trusting a diff score. This writes the actual
// frames to disk, in order, with the time each was taken.
import { chromium } from 'playwright';
import { mkdirSync, writeFileSync } from 'node:fs';

const BASE = process.env.DF_BASE || 'http://192.168.1.111:8484';
const KEY = process.env.DF_PAN_KEY || 'a';
const settle = (ms) => new Promise((r) => setTimeout(r, ms));
const dir = `evidence/bench/frames/${new Date().toISOString().replace(/[:.]/g, '-')}`;
mkdirSync(dir, { recursive: true });

const browser = await chromium.launch({
  headless: true,
  args: ['--disable-background-timer-throttling', '--disable-renderer-backgrounding'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
await page.goto(`${BASE}/df`, { waitUntil: 'domcontentloaded' });
await settle(18000);
await page.mouse.click(640, 400);
await settle(1500);

// The sampler is installed and left running, and the key is pressed by Playwright.
//
// The first version dispatched a synthetic KeyboardEvent from inside the page and
// the picture never moved: the app's listener is not reached that way, so the run
// recorded a still screen and any "response" found in it would have been noise.
// Real input is the only input worth attributing a frame to.
await page.evaluate(({ w, h }) => {
  const src = document.querySelector('canvas') || document.querySelector('img');
  window.__shots = [];
  window.__shotStop = false;
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const g = c.getContext('2d', { willReadFrequently: true });
  const tick = () => {
    if (window.__shotStop) return;
    try {
      g.drawImage(src, 0, 0, w, h);
      window.__shots.push({ t: performance.now(), url: c.toDataURL('image/png') });
    } catch (e) { /* an unreadable frame is simply not recorded */ }
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
  window.__shotStart = performance.now();
}, { w: 1280, h: 800 });

await settle(700);
await page.keyboard.down(KEY);
// Read the page clock immediately after the key lands: the shots carry page time,
// and guessing the offset from wall clocks afterwards was off by whole frames.
const keyAt = await page.evaluate(() => performance.now());
await settle(1100);
await page.keyboard.up(KEY);
await settle(400);

const result = await page.evaluate(() => {
  window.__shotStop = true;
  return { shots: window.__shots, start: window.__shotStart };
});

await browser.close();

if (result.error) {
  console.log(result.error);
  process.exit(1);
}

const { shots, w, h } = result;
const index = [];
for (let i = 0; i < shots.length; i++) {
  const ms = Math.round(shots[i].t - keyAt);
  const name = `${String(i).padStart(3, '0')}_${ms >= 0 ? 'p' : 'm'}${String(Math.abs(ms)).padStart(5, '0')}ms.png`;
  writeFileSync(`${dir}/${name}`, Buffer.from(shots[i].url.split(',')[1], 'base64'));
  index.push({ i, ms, file: name });
}
writeFileSync(`${dir}/index.json`, JSON.stringify({ keyAt, w, h, frames: index }, null, 2));

console.log(`wrote ${index.length} frames at ${w}x${h} to ${dir}`);
console.log(`keypress falls at index ${index.filter((f) => f.ms < 0).length}`);
console.log('frames:');
for (const f of index) console.log(`  ${f.file}  (${f.ms}ms)`);
