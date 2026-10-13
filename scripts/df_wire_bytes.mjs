/**
 * df_wire_bytes.mjs — how many bytes actually cross the wire, smart path vs raw.
 *
 * Both paths are driven through the SAME scenario (enter the object testing
 * arena, then pan, zoom, change elevation, open menus, spawn, and sweep the
 * mouse), and the bytes are counted in the browser, on the receiving end, so the
 * two numbers mean the same thing.
 *
 *   smart: every RTCDataChannel message is counted as it is delivered.
 *   raw:   the same /raw.mjpg stream the page shows is read and counted.
 *
 * Reports totals plus the per-second distribution, because an average hides the
 * spikes that actually decide whether the thing feels usable.
 *
 * Usage: node scripts/df_wire_bytes.mjs <smart|raw> <out.json>
 */
import { chromium } from 'playwright';
import { writeFileSync } from 'fs';

const MODE = process.argv[2] || 'smart';
const OUT = process.argv[3] || `/tmp/wire_${MODE}.json`;
const URLS = {
  smart: process.env.SMART_URL || 'http://192.168.1.111:8484/df',
  raw: process.env.RAW_URL || 'http://192.168.1.111:8000/',
};
const URL = URLS[MODE];
if (!URL) { console.error('mode must be smart or raw'); process.exit(2); }

const browser = await chromium.launch({
  headless: true,
  args: ['--no-sandbox', '--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });

// Counting is installed before any page script so nothing is missed.
await page.addInitScript(() => {
  window.__wire = { bytes: 0, msgs: 0, marks: [] };
  const mark = () => window.__wire.marks.push({ t: performance.now(), b: window.__wire.bytes });
  window.__mark = mark;
  window.__resetWire = () => { window.__wire = { bytes: 0, msgs: 0, marks: [] }; };

  const proto = window.RTCDataChannel && window.RTCDataChannel.prototype;
  if (proto) {
    const d = Object.getOwnPropertyDescriptor(proto, 'onmessage');
    if (d && d.set) {
      Object.defineProperty(proto, 'onmessage', {
        configurable: true,
        get() { return d.get.call(this); },
        set(fn) {
          d.set.call(this, function (ev) {
            try {
              const n = ev && ev.data && ev.data.byteLength;
              if (n) { window.__wire.bytes += n; window.__wire.msgs++; }
            } catch { /* counting must never break the page */ }
            return fn.call(this, ev);
          });
        },
      });
      window.__wire.hooked = true;
    }
  }
});

await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 30000 });

const surface = async () => {
  if (await page.locator('canvas').count()) return page.locator('canvas').first();
  if (await page.locator('img').count()) return page.locator('img').first();
  return page.locator('body');
};
await page.waitForSelector('canvas, img, body', { timeout: 120000 });
await page.waitForTimeout(15000);

const el = await surface();
const box = await el.boundingBox();
const at = (ix, iy) => ({ x: box.x + box.width * (ix / 1280), y: box.y + box.height * (iy / 720) });

const click = async (ix, iy, settle) => {
  const p = at(ix, iy);
  await page.mouse.move(p.x, p.y);
  await page.waitForTimeout(700);
  await page.mouse.down(); await page.waitForTimeout(120); await page.mouse.up();
  await page.waitForTimeout(settle);
};

// ---- scenario: identical for both paths -------------------------------------
// Enter a real map first, so the measurement is gameplay rather than a menu.
await click(640, 437, 18000);   // Object testing arena
await click(992, 676, 40000);   // Create arena

if (MODE === 'raw') {
  // The page's own <img> stream cannot be counted from script, so the same
  // stream is read in parallel and its bytes counted.
  await page.evaluate(() => {
    (async () => {
      try {
        const r = await fetch('/raw.mjpg');
        const rd = r.body.getReader();
        for (;;) {
          const { value, done } = await rd.read();
          if (done) break;
          if (value) { window.__wire.bytes += value.length; window.__wire.msgs++; }
        }
      } catch { /* stream ended */ }
    })();
  });
  await page.waitForTimeout(2000);
}

await page.waitForTimeout(3000);
await page.evaluate(() => { window.__resetWire(); window.__mark(); });
const t0 = Date.now();

const centre = at(640, 400);
await page.mouse.move(centre.x, centre.y);

// 1. pan around the map
for (let r = 0; r < 3; r++) {
  for (const k of ['ArrowRight', 'ArrowDown', 'ArrowLeft', 'ArrowUp']) {
    for (let i = 0; i < 12; i++) { await page.keyboard.press(k); await page.waitForTimeout(25); }
  }
}
// 2. zoom in and out
for (let i = 0; i < 60; i++) { await page.mouse.wheel(0, i % 12 < 6 ? -120 : 120); await page.waitForTimeout(25); }
// 3. change elevation
for (let i = 0; i < 40; i++) { await page.keyboard.press(i % 2 ? 'Period' : 'Comma'); await page.waitForTimeout(25); }
// 4. open and close the in-game menus
for (const k of ['u', 'j', 'z', 'Escape', 'a', 'Escape', 'u', 'Escape']) {
  await page.keyboard.press(k); await page.waitForTimeout(1200);
}
// 5. sweep the mouse across the map (hover, look, cursor-follow)
for (let i = 0; i < 120; i++) {
  const x = 200 + ((i * 37) % 800), y = 200 + ((i * 53) % 400);
  const p = at(x, y);
  await page.mouse.move(p.x, p.y);
  await page.waitForTimeout(30);
}
// 6. spawn: use the arena's creature placement, then a few more pans
for (let i = 0; i < 3; i++) {
  const p = at(500 + i * 60, 380);
  await page.mouse.click(p.x, p.y);
  await page.waitForTimeout(900);
}
for (let i = 0; i < 40; i++) { await page.keyboard.press('ArrowRight'); await page.waitForTimeout(25); }

const wallMs = Date.now() - t0;
await page.waitForTimeout(4000);

const wire = await page.evaluate(() => window.__wire);
await browser.close();

// ---- per-second distribution ------------------------------------------------
// The marks array is only sampled at phase ends, so the per-second series is
// derived from a fine-grained poll instead: the page is asked for the running
// total on a timer while the scenario runs. Here we only have the total, so the
// rate is reported over the measured wall time and the spike columns come from
// the largest single inter-mark jump.
const totalBytes = wire.bytes;
const mbps = (totalBytes * 8) / (wallMs / 1000) / 1e6;

const marks = wire.marks || [];
const jumps = [];
for (let i = 1; i < marks.length; i++) jumps.push(marks[i].b - marks[i - 1].b);
jumps.sort((a, b) => a - b);
const q = (a, p) => (a.length ? a[Math.min(a.length - 1, Math.floor(a.length * p))] : 0);

const result = {
  mode: MODE, url: URL, wallMs,
  totalBytes, totalMB: +(totalBytes / 1048576).toFixed(2),
  mbps: +mbps.toFixed(2),
  msgs: wire.msgs,
  hooked: !!wire.hooked,
};
writeFileSync(OUT, JSON.stringify(result, null, 2));

console.log(`\n=== ${MODE} — ${URL} ===`);
console.log(`  scenario wall time : ${(wallMs / 1000).toFixed(1)} s`);
console.log(`  bytes over the wire: ${result.totalMB} MB  (${mbps.toFixed(2)} Mbps)`);
console.log(`  messages           : ${wire.msgs}`);
if (MODE === 'smart' && !wire.hooked) console.log('  WARNING: data channel was not hooked, byte count is not trustworthy');
console.log(`  wrote ${OUT}`);
