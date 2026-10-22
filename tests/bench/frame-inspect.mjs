// Does the bench's "the picture changed" actually mean "the camera moved"?
//
// The bench credits an input with a response when a hash of a downsampled canvas
// changes. That hash changes for a blinking cursor as readily as for a pan, so the
// latency it reports rests on an assumption nobody had tested: that the change it
// caught was the input's effect.
//
// This captures the whole canvas on every frame around a keypress and looks at the
// frames themselves. For each frame it answers two questions:
//
//   how much of the screen changed, and
//   did it change by moving, or by something small redrawing?
//
// A pan moves most of the screen by a consistent offset. An animation changes a
// small area. Measuring both, and the offset that best explains the change, tells
// apart what the bench has been treating as one thing.
import { chromium } from 'playwright';
import { mkdirSync, writeFileSync } from 'node:fs';

const BASE = process.env.DF_BASE || 'http://192.168.1.111:8484';
const KEY = process.env.DF_PAN_KEY || 'a';
const settle = (ms) => new Promise((r) => setTimeout(r, ms));

const W = 96;   // grid the canvas is reduced to; fine enough to see a shift
const H = 60;

const browser = await chromium.launch({
  headless: true,
  args: ['--disable-background-timer-throttling', '--disable-renderer-backgrounding'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
await page.goto(`${BASE}/df`, { waitUntil: 'domcontentloaded' });
await settle(18000);
await page.mouse.click(640, 400);
await settle(1500);

// Start sampling, press the key mid-stream, keep sampling through and after.
const result = await page.evaluate(async ({ W, H, KEY }) => {
  const src = document.querySelector('canvas') || document.querySelector('img');
  if (!src) return { error: 'no canvas' };
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const g = c.getContext('2d', { willReadFrequently: true });

  const frames = [];
  let keyAt = null;
  const grab = () => {
    try {
      g.drawImage(src, 0, 0, W, H);
      const d = g.getImageData(0, 0, W, H).data;
      return new Uint8Array(d);
    } catch (e) { return null; }
  };

  let stop = false;
  const tick = () => {
    if (stop) return;
    const px = grab();
    if (px) frames.push({ t: performance.now(), px });
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);

  await new Promise((r) => setTimeout(r, 700));
  keyAt = performance.now();
  window.dispatchEvent(new KeyboardEvent('keydown', { key: KEY, code: `Key${KEY.toUpperCase()}`, bubbles: true }));
  await new Promise((r) => setTimeout(r, 1800));
  window.dispatchEvent(new KeyboardEvent('keyup', { key: KEY, code: `Key${KEY.toUpperCase()}`, bubbles: true }));
  await new Promise((r) => setTimeout(r, 400));
  stop = true;

  const grey = frames.map((f) => {
    const out = new Uint8Array(W * H);
    for (let i = 0; i < W * H; i++) {
      const o = i * 4;
      out[i] = (f.px[o] * 77 + f.px[o + 1] * 150 + f.px[o + 2] * 29) >> 8;
    }
    return { t: f.t, g: out };
  });
  return { keyAt, frames: grey.map((f) => ({ t: f.t, g: Array.from(f.g) })), W, H };
}, { W, H, KEY });

await browser.close();

if (result.error) {
  console.log(result.error);
  process.exit(1);
}

const { keyAt, frames, W: w, H: h } = result;
const at = (f, x, y) => f.g[y * w + x];

// Baseline: the last frame before the key. Everything is measured against it.
const before = frames.filter((f) => f.t <= keyAt);
const base = before[before.length - 1];
if (!base) {
  console.log('no frame captured before the keypress');
  process.exit(1);
}

function changedFraction(a, b, thresh = 12) {
  let n = 0;
  for (let i = 0; i < w * h; i++) if (Math.abs(a.g[i] - b.g[i]) > thresh) n++;
  return n / (w * h);
}

// The shift that best explains the change, and the error left after applying it.
// A pan is dominated by one offset; an animation is not.
function bestShift(a, b, maxDx = 24, maxDy = 6) {
  let best = { dx: 0, dy: 0, err: Infinity };
  const step = 2;
  for (let dy = -maxDy; dy <= maxDy; dy += step) {
    for (let dx = -maxDx; dx <= maxDx; dx += step) {
      let err = 0, n = 0;
      for (let y = maxDy; y < h - maxDy; y += 3) {
        for (let x = maxDx; x < w - maxDx; x += 3) {
          err += Math.abs(at(a, x + dx, y + dy) - at(b, x, y));
          n++;
        }
      }
      err /= n;
      if (err < best.err) best = { dx, dy, err };
    }
  }
  // Error with no shift at all, for comparison.
  let baseErr = 0, n = 0;
  for (let y = maxDy; y < h - maxDy; y += 3) {
    for (let x = maxDx; x < w - maxDx; x += 3) { baseErr += Math.abs(at(a, x, y) - at(b, x, y)); n++; }
  }
  return { ...best, baseErr: baseErr / n };
}

console.log(`canvas sampled ${w}x${h}, ${frames.length} frames captured around the keypress\n`);
console.log('  time   changed%   best shift   err(shift)  err(no shift)   verdict');
for (const f of frames) {
  const ms = Math.round(f.t - keyAt);
  if (ms < -60 || ms > 1400) continue;
  const ch = changedFraction(base, f) * 100;
  const s = bestShift(base, f);
  // A pan: most of the screen moves, and one offset explains it far better than none.
  const isPan = ch > 20 && s.err < s.baseErr * 0.6 && (Math.abs(s.dx) >= 2 || Math.abs(s.dy) >= 2);
  if (ms % 1 === 0 && (ms < 400 || ch > 8)) {
    console.log(
      `${String(ms).padStart(6)}ms ${ch.toFixed(1).padStart(8)}%   ` +
      `dx=${String(s.dx).padStart(3)} dy=${String(s.dy).padStart(2)}   ` +
      `${s.err.toFixed(1).padStart(9)}   ${s.baseErr.toFixed(1).padStart(11)}   ` +
      `${isPan ? 'PAN' : ch < 2 ? 'still' : 'change'}`,
    );
  }
}

// The answer the bench assumes: the first frame that is the pan.
const pan = frames.find((f) => f.t > keyAt && changedFraction(base, f) > 0.2);
console.log(
  pan
    ? `\nfirst frame with a large change: ${Math.round(pan.t - keyAt)}ms after the keypress`
    : '\nno frame after the keypress changed more than 20% of the screen',
);
const stills = frames.filter((f) => f.t > keyAt && f.t < keyAt + 400 && changedFraction(base, f) < 0.02);
console.log(`frames in the 400ms after the key that were essentially unchanged: ${stills.length}`);

const dir = `evidence/bench/frame-inspect/${new Date().toISOString().replace(/[:.]/g, '-')}`;
mkdirSync(dir, { recursive: true });
writeFileSync(`${dir}/frames.json`, JSON.stringify({ keyAt, W: w, H: h, times: frames.map((f) => f.t) }));
console.log(`\nwrote ${dir}`);
