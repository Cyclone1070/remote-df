// Every frame between the keypress and the frame the bench would mark, inspected.
//
// The bench credits an input with the first frame whose 48x48 probe hash changes,
// and it only does so when the picture was still beforehand. That rule is an
// assumption: it says nothing changed in between. This records every frame from the
// keypress onward, with the same probe hash the bench uses and the pixels
// themselves, then reports which frame the bench would mark and which frames
// actually moved the camera.
//
// A camera pan has a signature that animation does not: most of the screen shifts,
// and a single offset explains the difference far better than no offset at all. So
// each frame is scored both ways, and the PNGs are kept so the scores can be checked
// against the pictures.
import { chromium } from 'playwright';
import { mkdirSync, writeFileSync } from 'node:fs';

const BASE = process.env.DF_BASE || 'http://192.168.1.111:8484';
const KEY = process.env.DF_PAN_KEY || 'a';
const HOLD = Number(process.env.DF_HOLD_MS || 700);
const SETTLE_MS = 200;   // the bench's stability window, applied identically
const settle = (ms) => new Promise((r) => setTimeout(r, ms));
const dir = `evidence/bench/pan-trace/${new Date().toISOString().replace(/[:.]/g, '-')}`;
mkdirSync(dir, { recursive: true });

const browser = await chromium.launch({
  headless: true,
  args: ['--disable-background-timer-throttling', '--disable-renderer-backgrounding'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
await page.goto(`${BASE}/df`, { waitUntil: 'domcontentloaded' });
await settle(16000);
await page.mouse.click(640, 400);
await settle(1500);

const W = 80, H = 50;
await page.evaluate(({ W, H }) => {
  const src = document.querySelector('canvas') || document.querySelector('img');
  window.__f = [];
  window.__stop = false;
  const small = document.createElement('canvas');
  small.width = W; small.height = H;
  const g = small.getContext('2d', { willReadFrequently: true });
  const full = document.createElement('canvas');
  full.width = 1280; full.height = 800;
  const fg = full.getContext('2d', { willReadFrequently: true });

  const probe = () => {
    const c = document.createElement('canvas');
    c.width = 48; c.height = 48;
    const pg = c.getContext('2d', { willReadFrequently: true });
    pg.drawImage(src, 0, 0, 48, 48);
    const d = pg.getImageData(0, 0, 48, 48).data;
    let h = 2166136261;
    for (let i = 0; i < d.length; i += 11) { h ^= d[i]; h = (h * 16777619) >>> 0; }
    return h;
  };

  const tick = () => {
    if (window.__stop) return;
    try {
      g.drawImage(src, 0, 0, W, H);
      const px = g.getImageData(0, 0, W, H).data;
      const grey = new Uint8Array(W * H);
      for (let i = 0; i < W * H; i++) {
        const o = i * 4;
        grey[i] = (px[o] * 77 + px[o + 1] * 150 + px[o + 2] * 29) >> 8;
      }
      fg.drawImage(src, 0, 0, 1280, 800);
      window.__f.push({ t: performance.now(), hash: probe(), grey: Array.from(grey), png: full.toDataURL('image/png') });
    } catch (e) { /* unreadable frame not recorded */ }
    requestAnimationFrame(tick);
  };
  tick();
}, { W, H });

await settle(600);
await page.keyboard.down(KEY);
const keyAt = await page.evaluate(() => performance.now());
await settle(HOLD);
await page.keyboard.up(KEY);
await settle(1200);

const frames = await page.evaluate(() => { window.__stop = true; return window.__f; });
await browser.close();

// ---- scoring -------------------------------------------------------------
const at = (f, x, y) => f.grey[y * W + x];

function shiftScore(a, b, maxDx = 30, maxDy = 10) {
  let best = { dx: 0, dy: 0, err: Infinity };
  for (let dy = -maxDy; dy <= maxDy; dy += 2) {
    for (let dx = -maxDx; dx <= maxDx; dx += 2) {
      let err = 0, n = 0;
      for (let y = maxDy; y < H - maxDy; y += 4) {
        for (let x = maxDx; x < W - maxDx; x += 4) { err += Math.abs(at(a, x + dx, y + dy) - at(b, x, y)); n++; }
      }
      err /= n;
      if (err < best.err) best = { dx, dy, err };
    }
  }
  let still = 0, n = 0;
  for (let y = maxDy; y < H - maxDy; y += 4) {
    for (let x = maxDx; x < W - maxDx; x += 4) { still += Math.abs(at(a, x, y) - at(b, x, y)); n++; }
  }
  still /= n;
  return { ...best, still };
}

function changedFraction(a, b, thresh = 12) {
  let n = 0;
  for (let i = 0; i < W * H; i++) if (Math.abs(a.grey[i] - b.grey[i]) > thresh) n++;
  return n / (W * H);
}

const rows = [];
for (let i = 1; i < frames.length; i++) {
  const prev = frames[i - 1], cur = frames[i];
  const s = shiftScore(prev, cur);
  const moved = s.err < s.still * 0.75 && (Math.abs(s.dx) >= 2 || Math.abs(s.dy) >= 2);
  rows.push({
    i, ms: Math.round(cur.t - keyAt), hashChanged: cur.hash !== prev.hash,
    changed: +(changedFraction(prev, cur) * 100).toFixed(1),
    dx: s.dx, dy: s.dy, panned: moved,
  });
}

// ---- what the bench would say -------------------------------------------
// Still for SETTLE_MS before the key, then the first frame whose hash changes.
const before = rows.filter((r) => r.ms <= 0);
const lastChangeBefore = before.filter((r) => r.hashChanged).pop();
const stableBefore = !lastChangeBefore || Math.abs(lastChangeBefore.ms) >= SETTLE_MS;
const marked = rows.find((r) => r.ms > 0 && r.hashChanged);
const firstPan = rows.find((r) => r.ms > 0 && r.panned);

// ---- the pictures --------------------------------------------------------
const keep = rows.filter((r) => r.ms > -400 && r.ms < 1400);
for (const r of keep) {
  writeFileSync(`${dir}/${String(r.i).padStart(3, '0')}_${String(r.ms).padStart(5, '0')}ms.png`,
    Buffer.from(frames[r.i].png.split(',')[1], 'base64'));
}
writeFileSync(`${dir}/index.json`, JSON.stringify({ keyAt, W, H, rows, marked, firstPan }, null, 2));

console.log(`key held ${HOLD}ms; ${frames.length} frames captured, ${keep.length} saved as PNG`);
console.log(`picture still for ${SETTLE_MS}ms before the key: ${stableBefore}`);

console.log('\n  ms   hash changed   screen changed   shift          verdict');
for (const r of rows.filter((x) => x.ms > -300 && x.ms < 1200)) {
  const mark = marked && r.i === marked.i ? '  <- bench marks this' : '';
  const pan = r.panned ? ' PAN' : '';
  console.log(
    `${String(r.ms).padStart(5)}   ${String(r.hashChanged).padStart(12)}   ${String(r.changed).padStart(13)}%   ` +
    `dx=${String(r.dx).padStart(3)} dy=${String(r.dy).padStart(2)}   ${pan}${mark}`,
  );
}

console.log();
console.log(marked ? `bench would mark the frame at ${marked.ms}ms` : 'bench would mark nothing (never stable, or no hash change)');
console.log(firstPan ? `camera actually pans first at ${firstPan.ms}ms` : 'camera never pans in the window');

if (marked && firstPan) {
  const between = rows.filter((r) => r.ms > 0 && r.ms < firstPan.ms);
  const pannedBetween = between.filter((r) => r.panned);
  console.log(`\nframes between the keypress and the first pan: ${between.length}, of which ${pannedBetween.length} panned`);
  console.log(marked.i === firstPan.i
    ? 'the bench marks the first pan: attribution correct'
    : `the bench marks ${marked.ms}ms but the pan is at ${firstPan.ms}ms: attribution ${marked.ms > firstPan.ms ? 'LATE' : 'EARLY'}`);
}
console.log(`\nPNGs and index in ${dir}`);
