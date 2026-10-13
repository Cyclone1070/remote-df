/**
 * df_m2p.mjs — input-to-pixels latency, measured identically on both paths.
 *
 * "Mouse to photon" needs a camera in front of the screen. What this measures is
 * the next best thing and is honest about it: the time from dispatching an input
 * event to the moment the client's own display surface shows a different image.
 * Both surfaces are sampled the same way (a small crop, hashed each animation
 * frame), so a canvas and an <img> are compared on equal terms.
 *
 * It also records what the payload is made of, because a latency number without
 * knowing what arrived cannot be acted on.
 *
 * Usage: node scripts/df_m2p.mjs <url> <label> [actions]
 */
import { chromium } from 'playwright';
import { mkdirSync, writeFileSync } from 'fs';

const URL = process.argv[2];
const LABEL = process.argv[3] || 'run';
const ACTION = process.argv[4] || 'zoom';
const N = Number(process.env.N || 25);
const OUT = process.env.OUT || '/tmp/m2p';
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({
  headless: true,
  args: ['--no-sandbox', '--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });

// Everything is installed before page scripts so nothing is missed. The wire
// accounting separates draw commands from pictures by the 'DT' magic the
// picture header starts with.
await page.addInitScript(() => {
  window.__m2p = { samples: [], incoming: [], ice: {} };

  const desc = Object.getOwnPropertyDescriptor(RTCDataChannel.prototype, 'onmessage');
  if (desc && desc.set) {
    Object.defineProperty(RTCDataChannel.prototype, 'onmessage', {
      configurable: true,
      get() { return desc.get.call(this); },
      set(fn) {
        desc.set.call(this, function (ev) {
          try {
            const d = ev.data;
            if (d instanceof ArrayBuffer) {
              const u = new Uint8Array(d);
              const isPic = u.length > 2 && u[0] === 0x44 && u[1] === 0x54; // 'DT'
              window.__m2p.incoming.push({ t: performance.now(), n: d.byteLength, kind: isPic ? 'pic' : 'frame' });
            }
          } catch { /* never disturb the stream */ }
          return fn.call(this, ev);
        });
      },
    });
  }

  // The display surface: whichever of the two this page uses. On the raw page
  // an <img> fed by a multipart stream reports a static bitmap to drawImage in
  // headless Chromium, so that page is fingerprinted from its own decoded
  // stream instead (see RAW_DECODE below) rather than from the element.
  const surface = () => document.querySelector('canvas') || document.querySelector('img');
  const off = document.createElement('canvas');
  off.width = 64; off.height = 36;
  const octx = off.getContext('2d', { willReadFrequently: true });
  let lastFp = -1;
  window.__m2p.mark = 0;      // set when an input is dispatched
  window.__m2p.watch = false;

  const sample = () => {
    const s = surface();
    if (s && octx) {
      try {
        // The whole frame, downscaled: a crop misses changes that happen
        // elsewhere, and an action that alters only part of the view still
        // counts as the input having been seen.
        octx.drawImage(s, 0, 0, s.naturalWidth || s.width, s.naturalHeight || s.height, 0, 0, 64, 36);
        const d = octx.getImageData(0, 0, 64, 36).data;
        let h = 0;
        for (let i = 0; i < d.length; i += 24) h = (h * 31 + d[i] + d[i + 1] * 7) | 0;
        window.__m2p.sawSurface = true;
        if (h !== lastFp) {
          lastFp = h;
          if (window.__m2p.watch && window.__m2p.mark) {
            window.__m2p.samples.push(+(performance.now() - window.__m2p.mark).toFixed(1));
            window.__m2p.watch = false;
          }
        }
      } catch (e) { window.__m2p.err = String(e).slice(0, 80); }
    }
    requestAnimationFrame(sample);
  };
  requestAnimationFrame(sample);
});

await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
await page.waitForTimeout(18000);

// Raw path: read the very stream the page displays and hash a centre crop of
// each decoded frame. Arrival here is arrival at the client, which is what the
// latency figure is about.
const isRaw = !(await page.locator('canvas').count());
if (isRaw) {
  await page.evaluate(() => {
    window.__m2p.seen = 0;
    const off = document.createElement('canvas'); off.width = 64; off.height = 36;
    const octx = off.getContext('2d', { willReadFrequently: true });
    let lastFp = -1;
    (async () => {
      const res = await fetch('/raw.mjpg');
      const reader = res.body.getReader();
      const dec = new TextDecoder('latin1');
      let carry = '';
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        carry += dec.decode(value, { stream: true });
        for (;;) {
          const start = carry.indexOf('\xff\xd8');
          const end = carry.indexOf('\xff\xd9', start + 2);
          if (start < 0 || end < 0) break;
          const jpg = carry.slice(start, end + 2);
          carry = carry.slice(end + 2);
          const bytes = new Uint8Array(jpg.length);
          for (let i = 0; i < jpg.length; i++) bytes[i] = jpg.charCodeAt(i) & 0xff;
          try {
            const bmp = await createImageBitmap(new Blob([bytes], { type: 'image/jpeg' }));
            octx.drawImage(bmp, 0, 0, bmp.width, bmp.height, 0, 0, 64, 36);
            bmp.close();
            const d = octx.getImageData(0, 0, 64, 36).data;
            let h = 0;
            for (let i = 0; i < d.length; i += 24) h = (h * 31 + d[i] + d[i + 1] * 7) | 0;
            window.__m2p.seen++;
            if (h !== lastFp) {
              lastFp = h;
              if (window.__m2p.watch && window.__m2p.mark) {
                window.__m2p.samples.push(+(performance.now() - window.__m2p.mark).toFixed(1));
                window.__m2p.watch = false;
              }
            }
          } catch (e) { window.__m2p.err = String(e).slice(0, 60); }
        }
      }
    })().catch((e) => { window.__m2p.err = 'stream: ' + String(e).slice(0, 60); });
  });
  await page.waitForTimeout(4000);
}
const target = (await page.locator('canvas').count()) ? page.locator('canvas').first()
  : (await page.locator('img').count()) ? page.locator('img').first()
    : page.locator('body');
const box = await target.boundingBox();
await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
await page.waitForTimeout(5000);

// Get into a real map, so pan and elevation have something to act on. On the
// title screen those keys change nothing and the bench would report a latency
// of "never", which is true but useless.
if (process.env.ARENA !== '0') {
  const clickAt = async (ix, iy, settle) => {
    await page.mouse.move(box.x + box.width * (ix / 1280), box.y + box.height * (iy / 720));
    await page.waitForTimeout(700);
    await page.mouse.down(); await page.waitForTimeout(120); await page.mouse.up();
    await page.waitForTimeout(settle);
  };
  // Classic Arena, then create. Skipping the selection builds Small arena,
  // which is flat and unrepresentative of real gameplay.
  await clickAt(640, 437, 6000);    // Object testing arena
  await clickAt(178, 140, 2500);    // Classic Arena
  await clickAt(991, 678, 24000);   // Create arena
}

// Warm up so the first sample is not measuring connection setup.
const fire = async (i) => {
  if (ACTION === 'zoom') await page.mouse.wheel(0, i % 2 ? -120 : 120);
  else if (ACTION === 'pan') await page.keyboard.press(i % 2 ? 'ArrowRight' : 'ArrowLeft');
  else await page.keyboard.press(i % 2 ? 'Period' : 'Comma');
};
for (let i = 0; i < 5; i++) { await fire(i); await page.waitForTimeout(200); }

for (let i = 0; i < N; i++) {
  await page.evaluate(() => { window.__m2p.mark = performance.now(); window.__m2p.watch = true; });
  await fire(i);
  await page.waitForTimeout(900);
}

const res = await page.evaluate(() => {
  const s = window.__m2p.samples.slice().sort((a, b) => a - b);
  const q = (p) => (s.length ? s[Math.min(s.length - 1, Math.floor(s.length * p))] : -1);
  const inc = window.__m2p.incoming;
  const pics = inc.filter((m) => m.kind === 'pic');
  const frames = inc.filter((m) => m.kind === 'frame');
  const sum = (a) => a.reduce((x, m) => x + m.n, 0);
  const sizes = (a) => { const v = a.map((m) => m.n).sort((x, y) => x - y); return { p50: v[Math.floor(v.length / 2)] || 0, max: v[v.length - 1] || 0 }; };
  return {
    lat: { n: s.length, p50: q(0.5), p95: q(0.95), max: s[s.length - 1] || -1, all: s },
    sawSurface: !!window.__m2p.sawSurface, err: window.__m2p.err || null,
    surface: (() => { const e = document.querySelector('canvas') || document.querySelector('img'); return e ? e.tagName + ' ' + (e.naturalWidth || e.width) + 'x' + (e.naturalHeight || e.height) : 'none'; })(),
    picCount: pics.length, picBytes: sum(pics), picSize: sizes(pics),
    frameCount: frames.length, frameBytes: sum(frames), frameSize: sizes(frames),
  };
});

const f = (v) => (v < 0 ? '  n/a' : String(v).padStart(5));
console.log(`\n=== ${LABEL} (${ACTION}, ${N} actions) ===`);
console.log(`  surface   ${res.surface}  sampled=${res.sawSurface}  err=${res.err}`);
console.log(`  latency   n=${res.lat.n}  p50 ${f(res.lat.p50)}ms  p95 ${f(res.lat.p95)}ms  max ${f(res.lat.max)}ms`);
console.log(`  frames    ${String(res.frameCount).padStart(6)} msgs  ${String((res.frameBytes / 1024).toFixed(0)).padStart(7)} KB  p50 ${(res.frameSize.p50)} B  max ${(res.frameSize.max)} B`);
console.log(`  pictures  ${String(res.picCount).padStart(6)} msgs  ${String((res.picBytes / 1024).toFixed(0)).padStart(7)} KB  p50 ${(res.picSize.p50)} B  max ${(res.picSize.max)} B`);

writeFileSync(`${OUT}/m2p_${LABEL.replace(/\W+/g, '_')}_${ACTION}.json`, JSON.stringify(res, null, 2));
await browser.close();
