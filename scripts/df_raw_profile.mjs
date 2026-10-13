/**
 * df_raw_profile.mjs — measure the raw-pixel baseline the same way the normal
 * path is measured, so the two numbers are directly comparable.
 *
 * df_wire_profile.mjs watches the WebRTC data channel and times how far apart
 * frames arrive. This does the same job for the raw stream by connecting to the
 * MJPEG endpoint itself and timing the multipart parts. Same statistics, same
 * meaning, different transport - which is the only way the comparison is fair.
 *
 * Optionally drives a browser at the same time so the stream is under the same
 * kind of load a human would create.
 *
 * Usage:
 *   node scripts/df_raw_profile.mjs [outdir]
 *
 * Env:
 *   RAW_URL      base URL of the raw baseline   (default http://192.168.1.111:8490)
 *   RAW_PAGE     page to drive, "" to skip      (default RAW_URL + "/")
 *   QA_HEADLESS  "0" for a real window          (default headless)
 *   ZOOMS        wheel events to send           (default 400)
 *   ZOOM_GAP_MS  gap between them               (default 8)
 *   DURATION_MS  how long to watch the stream   (default 30000)
 */
import http from 'node:http';
import { mkdirSync, writeFileSync } from 'node:fs';

const OUT = process.argv[2] || '/tmp/raw_profile';
const BASE = process.env.RAW_URL || 'http://192.168.1.111:8490';
const PAGE = process.env.RAW_PAGE === '' ? '' : (process.env.RAW_PAGE || `${BASE}/`);
const HEADLESS = process.env.QA_HEADLESS !== '0';
const ZOOMS = Number(process.env.ZOOMS || 400);
const ZOOM_GAP_MS = Number(process.env.ZOOM_GAP_MS || 8);
const DURATION_MS = Number(process.env.DURATION_MS || 30000);

mkdirSync(OUT, { recursive: true });

const frames = [];
let bytes = 0;
let stopped = false;

// The stream is multipart/x-mixed-replace: a boundary line, a small header
// block, then the JPEG bytes. Timing each part as it completes gives the
// arrival time of each picture.
function watchStream() {
  return new Promise((resolve, reject) => {
    const url = new URL('/raw.mjpg', BASE);
    const req = http.get(url, (res) => {
      if (res.statusCode !== 200) {
        reject(new Error(`/raw.mjpg returned HTTP ${res.statusCode}`));
        return;
      }
      let buf = Buffer.alloc(0);
      let boundary = null;
      res.on('data', (chunk) => {
        if (stopped) return;
        buf = Buffer.concat([buf, chunk]);
        if (!boundary) {
          const m = buf.toString('latin1').match(/boundary=([^\s;]+)/i);
          const ct = res.headers['content-type'] || '';
          const m2 = ct.match(/boundary=([^\s;]+)/i);
          boundary = (m2 && m2[1]) || (m && m[1]) || '--dfraw';
          if (!boundary.startsWith('--')) boundary = '--' + boundary;
        }
        // Split on the boundary; every complete part except the trailing one
        // is a finished frame.
        for (;;) {
          const start = buf.indexOf(boundary);
          if (start === -1) break;
          const next = buf.indexOf(boundary, start + boundary.length);
          if (next === -1) break;
          const part = buf.subarray(start + boundary.length, next);
          const sep = part.indexOf('\r\n\r\n');
          if (sep !== -1) {
            const body = part.subarray(sep + 4);
            if (body.length > 0) {
              frames.push({ t: Date.now(), size: body.length });
              bytes += body.length;
            }
          }
          buf = buf.subarray(next);
        }
        if (buf.length > 8 * 1024 * 1024) buf = buf.subarray(buf.length - 1024 * 1024);
      });
      res.on('end', resolve);
      res.on('error', resolve);
    });
    req.on('error', reject);
    setTimeout(() => { req.destroy(); resolve(); }, DURATION_MS + 8000);
  });
}

const streamDone = watchStream().catch((e) => { console.log('stream error:', e.message); });

// Drive the page at the same time so the stream is loaded the way a human loads it.
let browser = null;
let driveDone = Promise.resolve();
if (PAGE) {
  const { chromium } = await import('playwright');
  browser = await chromium.launch({
    headless: HEADLESS,
    args: ['--no-sandbox', '--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'],
  });
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  page.on('console', (m) => {
    const t = m.text();
    if (/error|fail|refused/i.test(t)) console.log('  [page]', t.slice(0, 160));
  });
  // domcontentloaded, not load: the page's only subresource is the MJPEG stream,
  // which never completes, so the load event may never fire at all.
  await page.goto(PAGE, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(5000);
  driveDone = (async () => {
    const box = await page.locator('body').boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    for (let i = 0; i < ZOOMS; i++) {
      await page.mouse.wheel(0, i % 20 < 10 ? -120 : 120);
      await page.waitForTimeout(ZOOM_GAP_MS);
    }
  })().catch(() => {});
}

await Promise.all([streamDone, driveDone]);
stopped = true;
if (browser) await browser.close();

const span = frames.length > 1 ? frames[frames.length - 1].t - frames[0].t : 0;
const gaps = [];
for (let i = 1; i < frames.length; i++) gaps.push(frames[i].t - frames[i - 1].t);
gaps.sort((a, b) => a - b);
const q = (p) => (gaps.length ? gaps[Math.min(gaps.length - 1, Math.floor(gaps.length * p))] : 0);
const sizes = frames.map((f) => f.size).sort((a, b) => a - b);
const sq = (p) => (sizes.length ? sizes[Math.min(sizes.length - 1, Math.floor(sizes.length * p))] : 0);

const report = {
  when: new Date().toISOString(),
  base: BASE,
  durationMs: span,
  frames: frames.length,
  fps: span ? +(frames.length / (span / 1000)).toFixed(1) : 0,
  mbps: span ? +((bytes * 8) / (span / 1000) / 1e6).toFixed(1) : 0,
  gapMs: { median: q(0.5), p90: q(0.9), p99: q(0.99), max: gaps[gaps.length - 1] || 0 },
  jpegKB: { median: +(sq(0.5) / 1024).toFixed(1), p90: +(sq(0.9) / 1024).toFixed(1) },
  gapsOver100: gaps.filter((g) => g > 100).length,
  gapsOver250: gaps.filter((g) => g > 250).length,
  gapsOver500: gaps.filter((g) => g > 500).length,
};
writeFileSync(`${OUT}/raw_profile.json`, JSON.stringify(report, null, 2));

console.log(`df_raw_profile — ${BASE}`);
console.log(`  frames received   : ${report.frames} over ${(span / 1000).toFixed(1)}s  = ${report.fps} fps`);
console.log(`  throughput        : ${report.mbps} Mbps`);
console.log(`  jpeg size         : median ${report.jpegKB.median} KB  p90 ${report.jpegKB.p90} KB`);
console.log(`  arrival gap       : median ${report.gapMs.median}ms  p90 ${report.gapMs.p90}ms  p99 ${report.gapMs.p99}ms  max ${report.gapMs.max}ms`);
console.log(`  gaps >100/250/500 : ${report.gapsOver100} / ${report.gapsOver250} / ${report.gapsOver500}`);
console.log(`  wrote ${OUT}/raw_profile.json`);
