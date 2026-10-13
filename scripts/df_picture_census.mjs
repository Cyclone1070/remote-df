/**
 * df_picture_census.mjs — what every transmitted picture actually is.
 *
 * The previous contact sheet sorted by size and drew the biggest 96, which
 * showed only the outliers and made the whole payload look like minimap blocks.
 * This samples across the size distribution instead, and reports how the bytes
 * split between glyphs, tiles and large blocks, so "is this the map or is this
 * one panel" is answered by the data rather than by whichever tile happened to
 * be largest.
 *
 * Usage: node scripts/df_picture_census.mjs <smartUrl> [outdir]
 */
import { chromium } from 'playwright';
import { writeFileSync, mkdirSync } from 'fs';

const URL = process.argv[2];
const OUT = process.argv[3] || '/tmp/census';
const ACTIONS = Number(process.env.ACTIONS || 60);
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({
  headless: true,
  args: ['--no-sandbox', '--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });

await page.addInitScript(() => {
  window.__c = { pics: new Map() };
  const d = Object.getOwnPropertyDescriptor(RTCDataChannel.prototype, 'onmessage');
  if (!d || !d.set) return;
  Object.defineProperty(RTCDataChannel.prototype, 'onmessage', {
    configurable: true,
    get() { return d.get.call(this); },
    set(fn) {
      d.set.call(this, function (ev) {
        try {
          const x = ev.data;
          if (x instanceof ArrayBuffer) {
            const u = new Uint8Array(x);
            if (u.length > 16 && u[0] === 0x44 && u[1] === 0x54) {
              const dv = new DataView(x);
              const id = dv.getUint16(2, true), w = dv.getUint16(4, true), h = dv.getUint16(6, true), t = dv.getUint32(8, true);
              const ci = dv.getUint16(12, true), cc = dv.getUint16(14, true);
              let e = window.__c.pics.get(id);
              if (!e) { e = { w, h, t, chunks: new Array(cc), got: 0, cc }; window.__c.pics.set(id, e); }
              if (!e.chunks[ci]) { e.chunks[ci] = u.slice(16); e.got++; }
            }
          }
        } catch { /* census must not disturb the stream */ }
        return fn.call(this, ev);
      });
    },
  });
});

await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
await page.waitForTimeout(18000);
const box = await page.locator('canvas').first().boundingBox();
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
for (let i = 0; i < ACTIONS; i++) { await page.mouse.wheel(0, i % 20 < 10 ? -120 : 120); await page.waitForTimeout(40); }
await page.waitForTimeout(4000);
await page.screenshot({ path: `${OUT}/screen.png` });

const census = await page.evaluate(() => {
  const done = [];
  for (const [id, e] of window.__c.pics) {
    if (e.got !== e.cc || !e.chunks[0]) continue;
    const buf = new Uint8Array(e.t);
    let off = 0, ok = true;
    for (const c of e.chunks) { if (!c) { ok = false; break; } buf.set(c, off); off += c.length; }
    if (!ok || off !== e.t) continue;
    done.push({ id, w: e.w, h: e.h, t: e.t, rgba: buf });
  }
  // Distinct colour count is what says whether a picture is a flat panel or
  // real artwork: a few colours means it compresses to nothing.
  const colours = (b, w, h) => {
    const s = new Set();
    const step = Math.max(1, Math.floor((w * h) / 4000)) * 4;
    for (let i = 0; i < w * h * 4; i += step) s.add((b[i] << 16) | (b[i + 1] << 8) | b[i + 2]);
    return s.size;
  };
  const withStats = done.map((d) => ({ ...d, colours: colours(d.rgba, d.w, d.h) }));

  // Sample evenly across the size distribution, not from the top.
  withStats.sort((a, b) => a.t - b.t);
  const picks = [];
  for (let i = 0; i < 32; i++) picks.push(withStats[Math.floor((i / 32) * (withStats.length - 1))]);

  const COLS = 8, CELL = 120, PAD = 4;
  const rows = Math.ceil(picks.length / COLS);
  const cv = document.createElement('canvas');
  cv.width = COLS * (CELL + PAD) + PAD;
  cv.height = rows * (CELL + PAD) + PAD;
  const ctx = cv.getContext('2d');
  ctx.fillStyle = '#0e0e12'; ctx.fillRect(0, 0, cv.width, cv.height);
  ctx.imageSmoothingEnabled = false;
  picks.forEach((d, i) => {
    const cx = PAD + (i % COLS) * (CELL + PAD), cy = PAD + Math.floor(i / COLS) * (CELL + PAD);
    for (let y = 0; y < CELL; y += 12) for (let x = 0; x < CELL; x += 12) {
      ctx.fillStyle = ((x + y) / 12) % 2 ? '#26262e' : '#1a1a20';
      ctx.fillRect(cx + x, cy + y, 12, 12);
    }
    const tmp = document.createElement('canvas'); tmp.width = d.w; tmp.height = d.h;
    const tc = tmp.getContext('2d');
    const im = tc.createImageData(d.w, d.h);
    im.data.set(d.rgba.subarray(0, d.w * d.h * 4));
    tc.putImageData(im, 0, 0);
    const s = Math.min(CELL / d.w, CELL / d.h);
    ctx.drawImage(tmp, cx + ((CELL - d.w * s) >> 1), cy + ((CELL - d.h * s) >> 1), Math.max(1, d.w * s), Math.max(1, d.h * s));
    ctx.fillStyle = '#9fe'; ctx.font = '11px monospace';
    ctx.fillText(`${d.w}x${d.h} c${d.colours}`, cx + 2, cy + CELL - 3);
  });

  // Bytes by shape family, which is the number that says where the cost is.
  const fam = { glyph: 0, tile: 0, block: 0, huge: 0 };
  const famN = { glyph: 0, tile: 0, block: 0, huge: 0 };
  for (const d of withStats) {
    const k = d.w * d.h <= 256 ? 'glyph' : d.w * d.h <= 4096 ? 'tile' : d.w * d.h <= 65536 ? 'block' : 'huge';
    fam[k] += d.t; famN[k]++;
  }
  const sizes = withStats.map((d) => d.t);
  return {
    n: withStats.length, total: sizes.reduce((a, b) => a + b, 0),
    fam, famN,
    shapes: withStats.map((d) => `${d.w}x${d.h}`),
    flat: withStats.filter((d) => d.colours <= 24).length,
    png: cv.toDataURL('image/png'),
  };
});

writeFileSync(`${OUT}/census.png`, Buffer.from(census.png.split(',')[1], 'base64'));
const cnt = {};
for (const s of census.shapes) cnt[s] = (cnt[s] || 0) + 1;
const top = Object.entries(cnt).sort((a, b) => b[1] - a[1]).slice(0, 10);
const mb = (b) => (b / 1048576).toFixed(1);
console.log(`\ndistinct pictures ${census.n}   total ${mb(census.total)} MB`);
console.log(`pictures with <=24 distinct colours: ${census.flat} of ${census.n}`);
console.log('\nby shape family:');
console.log(`  glyph  (<=256 px)     ${String(census.famN.glyph).padStart(6)} pics  ${mb(census.fam.glyph).padStart(7)} MB`);
console.log(`  tile   (<=4096 px)    ${String(census.famN.tile).padStart(6)} pics  ${mb(census.fam.tile).padStart(7)} MB`);
console.log(`  block  (<=65536 px)   ${String(census.famN.block).padStart(6)} pics  ${mb(census.fam.block).padStart(7)} MB`);
console.log(`  huge   (>65536 px)    ${String(census.famN.huge).padStart(6)} pics  ${mb(census.fam.huge).padStart(7)} MB`);
console.log('\nmost common shapes:', top.map(([k, v]) => `${k} x${v}`).join('  '));
console.log(`census sheet -> ${OUT}/census.png`);
await browser.close();
