// Discovers, by trying them, which controls the game actually responds to.
//
// The bench can only be trusted for the inputs it has verified. Guessing bindings
// is how a smoothness test ended up driving a mouse drag that moved nothing but a
// tooltip. This records what each key does - screen changed or not - so the rest
// of the suite is built on observed behaviour rather than on documentation that
// may describe a different version.
import { chromium } from 'playwright';
import { createHash } from 'node:crypto';

const BASE = process.env.DF_BASE || 'http://192.168.1.111:8484';
const settle = (ms) => new Promise((r) => setTimeout(r, ms));
const hash = (buf) => createHash('sha256').update(buf).digest('hex').slice(0, 12);

const browser = await chromium.launch({
  headless: true,
  args: ['--disable-frame-rate-limit', '--disable-gpu-vsync', '--run-all-compositor-stages-before-draw'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
await page.goto(`${BASE}/df`, { waitUntil: 'domcontentloaded' });
await settle(22000);

const b = page.viewportSize();
await page.mouse.click(b.width * 0.5, b.height * (479 / 800));       // Object testing arena
await settle(4000);
await page.mouse.click(b.width * (180 / 1280), b.height * (144 / 800)); // Classic Arena
await settle(1500);
await page.mouse.click(b.width * (1000 / 1280), b.height * (755 / 800)); // Create arena
await settle(60000);
await page.mouse.move(1240, 700);   // park the pointer: a tooltip is not the game
await settle(1500);

const results = [];
const shot = async () => { await page.mouse.move(1240, 700); await settle(1200); return hash(await page.screenshot()); };

// Canary: panning is known to work, so if it stops working the game is no longer
// in the state the rest of the probes assume and every later answer is worthless.
async function stateIsLive() {
  const before = await shot();
  await page.keyboard.down('a'); await settle(600); await page.keyboard.up('a');
  return (await shot()) !== before;
}

async function probe(label, fn) {
  if (!(await stateIsLive())) {
    results.push({ label, changed: null, note: 'state lost - result discarded' });
    console.log(`STATE LOST before ${label} - stopping`);
    return false;
  }
  const before = await shot();
  await fn();
  const changed = (await shot()) !== before;
  results.push({ label, changed });
  console.log(`${changed ? 'RESPONDS  ' : 'no change '}${label}`);
  return true;
}

for (const key of [']', '[', '>', '<', 'c', 'k', 'x', 'u', 'v']) {
  const ok = await probe(`key ${JSON.stringify(key)} (tap)`, async () => {
    await page.keyboard.press(key); await settle(1200);
    // toggle back with the same key so the next probe starts from the same screen
    await page.keyboard.press(key); await settle(900);
  });
  if (!ok) break;
}

if (await stateIsLive()) {
  await probe('space (unpause time)', async () => {
    await page.keyboard.press(' ');
    await settle(3000);
    await page.keyboard.press(' ');
    await settle(800);
  });
}

console.log('\n--- summary ---');
console.log(JSON.stringify(results, null, 2));
await browser.close();
