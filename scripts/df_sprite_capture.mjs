/**
 * df_sprite_capture.mjs — what is actually transmitted, as an image.
 *
 * Hooks the stream, reassembles every picture from its chunks, and writes two
 * artefacts: a contact sheet of the real sprite payload (so the transmitted
 * content can be looked at rather than inferred), and the size report that says
 * whether those pictures are compressed or raw.
 *
 * The decision it settles: a picture's payload either equals width*height*4, in
 * which case it is uncompressed RGBA and is being sent losslessly, or it is
 * smaller, in which case it is compressed and the size argument is different.
 *
 * Usage: node scripts/df_sprite_capture.mjs <smartUrl> [outdir]
 */
import { chromium } from 'playwright';
import { mkdirSync, writeFileSync } from 'fs';

const URL = process.argv[2];
const OUT = process.argv[3] || '/tmp/sprites';
const ACTIONS = Number(process.env.ACTIONS || 60);
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({
  headless: true,
  args: ['--no-sandbox', '--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });

await page.addInitScript(() => {
  window.__cap = { pics: new Map(), order: [], frameBytes: 0, frameCount: 0, picCount: 0 };
  const desc = Object.getOwnPropertyDescriptor(RTCDataChannel.prototype, 'onmessage');
  if (!desc || !desc.set) return;
  Object.defineProperty(RTCDataChannel.prototype, 'onmessage', {
    configurable: true,
    get() { return desc.get.call(this); },
    set(fn) {
      desc.set.call(this, function (ev) {
        try {
          const d = ev.data;
          if (d instanceof ArrayBuffer) {
            const u = new Uint8Array(d);
            if (u.length > 16 && u[0] === 0x44 && u[1] === 0x54) {   // 'DT'
              const dv = new DataView(d);
              const id = dv.getUint16(2, true);
              const w = dv.getUint16(4, true);
              const h = dv.getUint16(6, true);
              const total = dv.getUint32(8, true);
              const ci = dv.getUint16(12, true);
              const cc = dv.getUint16(14, true);
              let e = window.__cap.pics.get(id);
              if (!e) { e = { w, h, total, chunks: new Array(cc), got: 0, cc }; window.__cap.pics.set(id, e); window.__cap.order.push(id); }
              if (!e.chunks[ci]) { e.chunks[ci] = u.slice(16); e.got++; }
              window.__cap.picCount++;
            } else {
              window.__cap.frameBytes += u.length;
              window.__cap.frameCount++;
            }
          }
        } catch { /* capture must never disturb the stream */ }
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
await clickAt(640, 437, 6000);
await clickAt(992, 676, 20000);
await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);

// A zoom makes the game re-rasterise its sprites, which is exactly the payload
// worth looking at.
for (let i = 0; i < ACTIONS; i++) {
  await page.mouse.wheel(0, i % 20 < 10 ? -120 : 120);
  await page.waitForTimeout(40);
}
await page.waitForTimeout(4000);

// Build the contact sheet inside the page: the pixels never leave the browser,
// only the finished PNG does.
const sheet = await page.evaluate((maxTiles) => {
  const cap = window.__cap;
  const done = [];
  for (const id of cap.order) {
    const e = cap.pics.get(id);
    if (!e || e.got !== e.cc || !e.chunks[0]) continue;
    const total = e.total;
    const buf = new Uint8Array(total);
    let off = 0;
    for (let i = 0; i < e.chunks.length; i++) {
      const c = e.chunks[i];
      if (!c) { off = -1; break; }
      buf.set(c, off); off += c.length;
    }
    if (off !== total) continue;
    done.push({ id, w: e.w, h: e.h, total, rgba: buf });
  }
  if (!done.length) return { tiles: 0, png: null };

  // Verify the payload shape before drawing: RGBA means exactly w*h*4 bytes.
  const exact = done.filter((d) => d.total === d.w * d.h * 4).length;

  // Draw the largest sprites first: they are the ones that cost the most.
  done.sort((a, b) => b.total - a.total);
  const pick = done.slice(0, maxTiles);
  const COLS = 8, CELL = 128, PAD = 4;
  const rows = Math.ceil(pick.length / COLS);
  const cv = document.createElement('canvas');
  cv.width = COLS * (CELL + PAD) + PAD;
  cv.height = rows * (CELL + PAD) + PAD;
  const ctx = cv.getContext('2d');
  ctx.fillStyle = '#101014';
  ctx.fillRect(0, 0, cv.width, cv.height);
  ctx.imageSmoothingEnabled = false;

  pick.forEach((d, i) => {
    const cx = PAD + (i % COLS) * (CELL + PAD);
    const cy = PAD + Math.floor(i / COLS) * (CELL + PAD);
    const tmp = document.createElement('canvas');
    tmp.width = d.w; tmp.height = d.h;
    const tctx = tmp.getContext('2d');
    const img = tctx.createImageData(d.w, d.h);
    img.data.set(d.rgba.subarray(0, d.w * d.h * 4));
    tctx.putImageData(img, 0, 0);
    // Checkerboard so transparency is visible rather than reading as black.
    for (let y = 0; y < CELL; y += 16) for (let x = 0; x < CELL; x += 16) {
      ctx.fillStyle = ((x + y) / 16) % 2 ? '#2a2a33' : '#1c1c22';
      ctx.fillRect(cx + x, cy + y, 16, 16);
    }
    const s = Math.min(CELL / d.w, CELL / d.h);
    const dw = Math.max(1, Math.floor(d.w * s)), dh = Math.max(1, Math.floor(d.h * s));
    ctx.drawImage(tmp, cx + ((CELL - dw) >> 1), cy + ((CELL - dh) >> 1), dw, dh);
  });

  const sizes = done.map((d) => d.total).sort((a, b) => a - b);
  const wh = done.map((d) => d.w * d.h * 4).sort((a, b) => a - b);
  return {
    tiles: pick.length, total: done.length, exactRGBA: exact,
    p50: sizes[Math.floor(sizes.length / 2)], max: sizes[sizes.length - 1],
    p50WH4: wh[Math.floor(wh.length / 2)],
    sumBytes: sizes.reduce((a, b) => a + b, 0),
    png: cv.toDataURL('image/png'),
  };
}, 96);

const stats = await page.evaluate(() => ({
  picCount: window.__cap.picCount,
  distinct: window.__cap.pics.size,
  frameCount: window.__cap.frameCount,
  frameBytes: window.__cap.frameBytes,
}));
await page.screenshot({ path: `${OUT}/smart_screen.png` });
await browser.close();

if (sheet.png) {
  writeFileSync(`${OUT}/transmitted_sprites.png`, Buffer.from(sheet.png.split(',')[1], 'base64'));
}
const kb = (b) => (b / 1024).toFixed(0);
console.log(`\ndistinct pictures      ${stats.distinct}   (${stats.picCount} chunk messages)`);
console.log(`payload per picture    p50 ${sheet.p50} B   max ${sheet.max} B`);
console.log(`width*height*4         p50 ${sheet.p50WH4} B`);
console.log(`pictures matching w*h*4 exactly: ${sheet.exactRGBA} of ${sheet.total}`);
console.log(`all pictures together  ${kb(sheet.sumBytes)} KB`);
console.log(`draw commands          ${stats.frameCount} msgs  ${kb(stats.frameBytes)} KB`);
console.log(`contact sheet          ${sheet.tiles} tiles -> ${OUT}/transmitted_sprites.png`);
