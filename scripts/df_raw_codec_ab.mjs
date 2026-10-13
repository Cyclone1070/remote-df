/**
 * df_raw_codec_ab.mjs — isolates the codec on the raw path.
 *
 * Swapping JPEG for a lossless encoder changed more than the byte count in
 * principle: it changed how long the interposer spends encoding, how long the
 * browser spends decoding, and how many frames a second actually cross the
 * link. A latency difference could come from any of those, and blaming the
 * codec without separating them would be a guess.
 *
 * This measures the same session twice, toggling only the codec, and reports
 * bytes per frame, frames per second and input-to-pixels for each.
 *
 * Usage: node scripts/df_raw_codec_ab.mjs <rawUrl> <label>
 */
import { chromium } from 'playwright';

const URL = process.argv[2];
const LABEL = process.argv[3] || 'codec';
const N = Number(process.env.N || 20);
const STATS = process.env.STATS || 'http://192.168.1.111:8000/raw-stats';

const browser = await chromium.launch({
  headless: true,
  args: ['--no-sandbox', '--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });

await page.addInitScript(() => {
  window.__m = { samples: [], mark: 0, watch: false };
  const off = document.createElement('canvas');
  off.width = 64; off.height = 36;
  const octx = off.getContext('2d', { willReadFrequently: true });
  let lastFp = -1;
  (async () => {
    const res = await fetch('/raw.mjpg');
    const reader = res.body.getReader();
    // Parsed as multipart rather than by scanning for JPEG markers: the server
    // now sends PNG parts too, and a marker scan would silently find nothing and
    // report a latency of "never".
    const BOUND = '--dfrawframe';
    let buf = new Uint8Array(0);
    const push = (chunk) => {
      const next = new Uint8Array(buf.length + chunk.length);
      next.set(buf); next.set(chunk, buf.length);
      buf = next;
    };
    const latin = (a) => { let s = ''; for (let i = 0; i < a.length; i++) s += String.fromCharCode(a[i]); return s; };

    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      push(value);
      for (;;) {
        const text = latin(buf);
        const start = text.indexOf(BOUND);
        if (start < 0) break;
        const hdrEnd = text.indexOf('\r\n\r\n', start);
        if (hdrEnd < 0) break;
        const head = text.slice(start, hdrEnd);
        const m = /Content-Length:\s*(\d+)/i.exec(head);
        if (!m) break;
        const len = parseInt(m[1], 10);
        const bodyAt = hdrEnd + 4;
        if (buf.length < bodyAt + len) break;   // wait for the rest
        const part = buf.slice(bodyAt, bodyAt + len);
        buf = buf.slice(bodyAt + len);
        try {
          const bmp = await createImageBitmap(new Blob([part]));
          octx.drawImage(bmp, 0, 0, bmp.width, bmp.height, 0, 0, 64, 36);
          bmp.close();
          const d = octx.getImageData(0, 0, 64, 36).data;
          let h = 0;
          for (let i = 0; i < d.length; i += 24) h = (h * 31 + d[i] + d[i + 1] * 7) | 0;
          if (h !== lastFp) {
            lastFp = h;
            if (window.__m.watch && window.__m.mark) {
              window.__m.samples.push(+(performance.now() - window.__m.mark).toFixed(1));
              window.__m.watch = false;
            }
          }
        } catch { /* a part that will not decode is not a latency reading */ }
      }
    }
  })().catch(() => {});
});

await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
await page.waitForTimeout(15000);
const box = await page.locator('img').first().boundingBox();
await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
await page.waitForTimeout(3000);

// A title screen that is not being clicked produces no presents, so there would
// be no frames to time. Real input on a real map is the only state worth
// measuring latency in.
const clickAt = async (ix, iy, settle) => {
  await page.mouse.move(box.x + box.width * (ix / 1280), box.y + box.height * (iy / 720));
  await page.waitForTimeout(700);
  await page.mouse.down(); await page.waitForTimeout(120); await page.mouse.up();
  await page.waitForTimeout(settle);
};
// Classic Arena, then create. Skipping the selection builds Small arena,
// which is flat and unrepresentative of real gameplay.
await clickAt(640, 437, 6000);
await clickAt(178, 140, 2500);
await clickAt(991, 678, 24000);
await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
await page.waitForTimeout(2000);

const stats = async () => {
  try { return await (await fetch(STATS)).json(); } catch { return null; }
};

const before = await stats();
const t0 = Date.now();
for (let i = 0; i < N; i++) {
  await page.evaluate(() => { window.__m.mark = performance.now(); window.__m.watch = true; });
  await page.mouse.wheel(0, i % 20 < 10 ? -120 : 120);
  await page.waitForTimeout(500);
}
const elapsed = (Date.now() - t0) / 1000;
const after = await stats();

const res = await page.evaluate(() => {
  const s = window.__m.samples.slice().sort((a, b) => a - b);
  const q = (p) => (s.length ? s[Math.min(s.length - 1, Math.floor(s.length * p))] : -1);
  return { n: s.length, p50: q(0.5), p95: q(0.95), max: s[s.length - 1] || -1 };
});

let line = `  latency  n=${res.n}  p50 ${res.p50}ms  p95 ${res.p95}ms  max ${res.max}ms`;
if (before && after) {
  const dFrames = after.frames - before.frames;
  const dBytes = after.bytes - before.bytes;
  const avg = dFrames ? Math.round(dBytes / dFrames / 1024) : 0;
  line += `\n  stream   ${dFrames} frames in ${elapsed.toFixed(1)}s = ${(dFrames / elapsed).toFixed(1)} fps` +
          `   ${(dBytes / 1048576).toFixed(1)} MB   ${avg} KB/frame  (${(dBytes * 8 / elapsed / 1e6).toFixed(1)} Mbps)`;
}
console.log(`\n=== raw, ${LABEL} ===\n${line}`);
await browser.close();
