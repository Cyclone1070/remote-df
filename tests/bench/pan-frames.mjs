// The bench's own pan sequence, with the frames saved so they can be looked at.
//
// This does not re-implement the bench: it calls the same entry routine, waits the
// same time, and holds a/d/w/s for the same 700ms each. The only difference is that
// it keeps the pictures instead of a summary, because "the input moved the picture"
// is a claim about pictures.
import { chromium } from 'playwright';
import { mkdirSync, writeFileSync } from 'node:fs';

const BASE = process.env.DF_BASE || 'http://192.168.1.111:8484';
const SECS = Number(process.env.DF_PAN_SECONDS || 10);
const settle = (ms) => new Promise((r) => setTimeout(r, ms));
const dir = `evidence/bench/pan-frames/${new Date().toISOString().replace(/[:.]/g, '-')}`;
mkdirSync(dir, { recursive: true });

const browser = await chromium.launch({
  headless: true,
  args: ['--disable-background-timer-throttling', '--disable-renderer-backgrounding'],
});

// --- exactly the bench's entry routine ------------------------------------
async function enterArenaOnce() {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  await page.goto(`${BASE}/df`, { waitUntil: 'domcontentloaded' });
  await settle(22000);
  const b = page.viewportSize();
  await page.mouse.click(b.width * 0.5, b.height * (479 / 800));
  await settle(4000);
  await page.mouse.click(b.width * (180 / 1280), b.height * (144 / 800));
  await settle(1500);
  await page.mouse.click(b.width * (1000 / 1280), b.height * (755 / 800));
  await settle(60000);
  await page.close();
}

await enterArenaOnce();

// --- the page the bench measures on --------------------------------------
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
await page.goto(`${BASE}/df`, { waitUntil: 'domcontentloaded' });
await settle(14000);
await page.mouse.click(640, 400);
await settle(1500);

const headline = await page.evaluate(() => document.body.innerText.slice(0, 200).replace(/\s+/g, ' '));
console.log(`screen says: "${headline.slice(0, 120)}"`);

// Sampler runs alongside; it never blocks the input.
await page.evaluate(() => {
  const src = document.querySelector('canvas') || document.querySelector('img');
  window.__shots = [];
  window.__stop = false;
  const c = document.createElement('canvas');
  c.width = 1280; c.height = 800;
  const g = c.getContext('2d', { willReadFrequently: true });
  const tick = () => {
    if (window.__stop) return;
    try {
      g.drawImage(src, 0, 0, 1280, 800);
      window.__shots.push({ t: performance.now(), url: c.toDataURL('image/png') });
    } catch (e) { /* unreadable frame, not recorded */ }
    setTimeout(tick, 250);
  };
  tick();
});

// --- exactly the bench's pan driver --------------------------------------
const keys = ['a', 'd', 'w', 's'];
const end = Date.now() + SECS * 1000;
let i = 0;
while (Date.now() < end) {
  const k = keys[i++ % keys.length];
  await page.keyboard.down(k);
  await settle(700);
  await page.keyboard.up(k);
}
await settle(800);

const shots = await page.evaluate(() => { window.__stop = true; return window.__shots; });
await browser.close();

for (let n = 0; n < shots.length; n++) {
  const ms = Math.round(shots[n].t - shots[0].t);
  writeFileSync(`${dir}/${String(n).padStart(3, '0')}_${String(ms).padStart(6, '0')}ms.png`, Buffer.from(shots[n].url.split(',')[1], 'base64'));
}

console.log(`\ncaptured ${shots.length} frames over ${Math.round(shots[shots.length - 1].t - shots[0].t)}ms`);
console.log(`wrote ${dir}`);
console.log('\ncompare the first and last: if the terrain is in the same place, the pan did nothing.');
