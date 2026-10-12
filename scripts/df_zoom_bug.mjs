/**
 * df_zoom_bug.mjs — reproduce the rapid-zoom corruption and capture every
 * frame the client renders during the final zoom.
 *
 * Zoom is a wheel event forwarded to the game. Each new scale makes the game
 * emit textures at that size, and the client packs them into an append-only
 * 4096x4096 atlas. This script zooms hard, then grabs every rendered frame so
 * the failure can be inspected frame by frame rather than inferred.
 *
 * Captures:
 *   frames/NNNN.png     one image per rendered frame during the last zoom
 *   console.log         browser console, including any atlas-full errors
 *   texuploads.json     every atlas write: size, and running fill estimate
 */
import { chromium } from 'playwright';
import fs from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

const URL = process.env.QA_URL || 'http://192.168.1.111:8484/';
const OUT = process.env.ZOOM_OUT || '/tmp/zoombug';
const ZOOMS = Number(process.env.ZOOMS || 300);

fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(`${OUT}/frames`, { recursive: true });

const browser = await chromium.launch({
  headless: true,
  // Hardware by default: SwiftShader is software rendering and turns every
  // GPU cost into a main-thread stall, which is not what a real user sees.
  args: process.env.SOFTWARE_GL === '1'
      ? ['--no-sandbox', '--use-gl=swiftshader', '--enable-unsafe-swiftshader']
      : ['--no-sandbox', '--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });

const consoleLines = [];
page.on('console', (m) => consoleLines.push(`[${m.type()}] ${m.text()}`));
page.on('pageerror', (e) => consoleLines.push(`[pageerror] ${String(e)}`));

// Instrument before any app code runs: every frame ends at the instanced draw,
// and every texture the atlas receives arrives via texSubImage2D.
await page.addInitScript(() => {
  // Long tasks are the browser's own measure of main-thread blocking: any
  // single task over 50ms is one. This says where the stall is, rather than
  // inferring it from frame gaps.
  window.__longTasks = [];
  try {
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) window.__longTasks.push(Math.round(e.duration));
    }).observe({ entryTypes: ['longtask'] });
  } catch (e) { /* not supported */ }

  window.__rec = { ring: [], saved: [], uploads: [], resets: [], assetLog: [], hashes: [], times: [], armed: false, idx: 0, keepUntil: 0 };

  const toURL = (bmp) => {
    const t = document.createElement('canvas');
    t.width = bmp.width; t.height = bmp.height;
    t.getContext('2d').drawImage(bmp, 0, 0);
    return t.toDataURL('image/png');
  };

  const DA = WebGL2RenderingContext.prototype.drawArraysInstanced;
  WebGL2RenderingContext.prototype.drawArraysInstanced = function (...a) {
    const r = DA.apply(this, a);
    if (window.__rec.armed) {
      const idx = window.__rec.idx++;
      window.__rec.times.push(performance.now());
      // rolling window: bitmaps are cheap to take, so keep the recent past
      const p = createImageBitmap(this.canvas).catch(() => null);
      // drawArraysInstanced(mode, first, count, instanceCount): instanceCount is
      // exactly how many sprites survived into the draw, so it measures the holes.
      window.__rec.assetLog.push([idx, window.__dfAssetsMissing|0, window.__dfAssetsUnfetchable|0,
                                  a[3]|0]);
      window.__rec.ring.push({ idx, p });
      if (window.__rec.ring.length > 28) window.__rec.ring.shift();
      // while marked, also convert the current frame for the output
      if (window.__rec.armed) {
        window.__rec.saved.push(p.then((b) => (b ? toURL(b) : null)).catch(() => null));
      }
    }
    return r;
  };

  // resetAtlas() clears the atlas by reallocating it with no pixel data.
  // That wipes every texture the client holds, so detecting it is the whole
  // point: the reclaim is silent, and the frames right after it are the ones
  // that render wrong.
  const TI = WebGL2RenderingContext.prototype.texImage2D;
  WebGL2RenderingContext.prototype.texImage2D = function (...a) {
    const isReset = a.length === 9 && a[8] === null && a[3] === 4096 && a[4] === 4096;
    if (isReset && window.__rec.armed) {
      const at = window.__rec.idx;
      window.__rec.resets.push(at);
      for (const e of window.__rec.ring) {
        window.__rec.saved.push(e.p.then((b) => (b ? toURL(b) : null)).catch(() => null));
      }
      window.__rec.keepUntil = at + 28;
    }
    return TI.apply(this, a);
  };

    // the renderer sets this each frame; lets instanceCount be read as "drawn of wanted"
  const RP = WebGL2RenderingContext.prototype.drawArraysInstanced;

  const TS = WebGL2RenderingContext.prototype.texSubImage2D;
  WebGL2RenderingContext.prototype.texSubImage2D = function (target, level, x, y, w, h, ...rest) {
    window.__rec.uploads.push([x, y, w, h]);
    // Fingerprint the pixels going into the atlas. If the same image is stored
    // again under a fresh id, that is a duplicate the cache did not need.
    const px = rest[rest.length - 1];
    if (window.__rec.armed && px && px.length) {
      let hsh = 2166136261;
      for (let i = 0; i < px.length; i += 13) { hsh ^= px[i]; hsh = Math.imul(hsh, 16777619); }
      window.__rec.hashes.push(w + 'x' + h + ':' + ((hsh >>> 0).toString(36)));
    }
    return TS.call(this, target, level, x, y, w, h, ...rest);
  };
});

await page.goto(URL, { waitUntil: 'domcontentloaded' });
const launch = page.locator('text=Launch Game');
try {
  await launch.waitFor({ state: 'visible', timeout: 8000 });
  console.log('lobby - launching');
  await launch.click();
} catch { console.log('attaching to running session'); }
await page.waitForSelector('canvas', { timeout: 120000 });
const canvas = await page.locator('canvas').first();
const box = await canvas.boundingBox();
console.log('canvas', JSON.stringify(box));

// Let the game settle, then walk into the arena: zoom only means anything on
// the map, so zooming the title screen proves nothing.
await page.waitForTimeout(18000);

const cx0 = box.x + box.width / 2, cy0 = box.y + box.height / 2;
const click = async (x, y, settle = 7000) => {
  await page.mouse.move(box.x + x, box.y + y);
  await page.waitForTimeout(400);
  await page.mouse.click(box.x + x, box.y + y);
  await page.waitForTimeout(settle);
};

console.log('-> Object testing arena');
await click(631, 472);
console.log('-> Classic Arena, then Create arena');
await click(180, 137, 3000);
await click(991, 678, 26000);
console.log('in the arena');

const cx = cx0, cy = cy0;
await page.mouse.move(cx, cy);
await page.waitForTimeout(500);

// ---- measure what the zoom alone causes ----
// The interposer reports a running texture count; sampling it either side of
// the zoom separates the zoom's cost from the arena load's.
const ssh = (c) => {
  try {
    return require('node:child_process').execSync(
      `ssh -o BatchMode=yes -o ConnectTimeout=20 ${process.env.DF_SSH_HOST || 'cyc@192.168.1.111'} ${JSON.stringify(c)}`,
      { encoding: 'utf8', maxBuffer: 8 << 20 });
  } catch { return ''; }
};
const texCount = () => {
  const out = ssh('podman logs --since 5m remote-df 2>&1 | grep -aoE "TEX_n=[0-9]+" | tail -1');
  const m = out.match(/TEX_n=(\d+)/);
  return m ? +m[1] : null;
};

const before = texCount();
console.log('textures emitted before zoom:', before);

console.log(`rapid zooming: ${ZOOMS} wheel events`);
for (let i = 0; i < ZOOMS; i++) {
  await page.mouse.wheel(0, i % 2 === 0 ? -240 : 240);
  await page.waitForTimeout(8);
}
await page.waitForTimeout(2500);
const after = texCount();
console.log('textures emitted after zoom :', after);
if (before != null && after != null) {
  console.log(`=> the zoom alone emitted ${after - before} textures`);
}

// Arm capture. Snapshots are taken around each atlas reset, wherever it lands.
await page.evaluate(() => {
  window.__rec.saved.length = 0;
  window.__rec.ring.length = 0;
  window.__rec.idx = 0;
  window.__rec.keepUntil = 0;
  window.__rec.armed = true;
});
console.log('capture armed - full zoom sweep, capturing every frame');
const SLOW = process.env.SLOW === '1';
const NOZOOM = process.env.NOZOOM === '1';
const GAP = SLOW ? 900 : 35;
if (NOZOOM) {
  // Control: identical capture window, no wheel input at all. If the blank
  // frames still appear, they are ordinary rendering, not a zoom artefact.
  console.log('NO-ZOOM CONTROL: idling for the same duration, no wheel input');
  await page.waitForTimeout(3 * 60 * GAP + 8000);
}
for (let pass = 0; NOZOOM !== true && pass < 3; pass++) {
  for (let i = 0; i < 30; i++) { await page.mouse.wheel(0, 400);  await page.waitForTimeout(GAP); }
  for (let i = 0; i < 30; i++) { await page.mouse.wheel(0, -400); await page.waitForTimeout(GAP); }
  console.log(`  sweep pass ${pass + 1} done${SLOW ? ' (slow control)' : ''}`);
}
await page.waitForTimeout(4000);
await page.evaluate(() => { window.__rec.armed = false; });

const rec = await page.evaluate(async () => {
  const urls = await Promise.all(window.__rec.saved);
  return { urls: urls.filter(Boolean), uploads: window.__rec.uploads,
           resets: window.__rec.resets, totalFrames: window.__rec.idx, assetLog: window.__rec.assetLog, hashes: window.__rec.hashes, times: window.__rec.times };
});
console.log('frames rendered during storm:', rec.totalFrames);
console.log('ATLAS RESETS (at frame #):', rec.resets.length, rec.resets.slice(0, 20));

console.log(`kept ${rec.urls.length} frames around resets, ${rec.uploads.length} atlas writes`);

// Save frames
rec.urls.forEach((u, i) => {
  const b64 = u.split(',')[1];
  if (b64) fs.writeFileSync(`${OUT}/frames/${String(i).padStart(4, '0')}.png`, Buffer.from(b64, 'base64'));
});
fs.writeFileSync(`${OUT}/texuploads.json`, JSON.stringify(rec.uploads));
fs.writeFileSync(`${OUT}/assetlog.json`, JSON.stringify(rec.assetLog));
fs.writeFileSync(`${OUT}/hashes.json`, JSON.stringify(rec.hashes));
fs.writeFileSync(`${OUT}/times.json`, JSON.stringify(rec.times));
const lt = await page.evaluate(() => window.__longTasks || []);
fs.writeFileSync(`${OUT}/longtasks.json`, JSON.stringify(lt));
const sorted = [...lt].sort((a, b) => b - a);
console.log(`long tasks (>50ms main-thread blocks): ${lt.length}`);
if (lt.length) {
  console.log(`  total blocked: ${lt.reduce((a, b) => a + b, 0)}ms`);
  console.log(`  worst: ${sorted.slice(0, 8).join(', ')}ms`);
}
fs.writeFileSync(`${OUT}/console.log`, consoleLines.join('\n'));

// Atlas fill estimate: the packer shelves textures, so track the high-water mark
// the same way it does (row height = tallest texture in the row).
let ax = 1, ay = 1, rowH = 0, maxY = 1, sizes = new Map();
for (const [x, y, w, h] of rec.uploads) {
  sizes.set(`${w}x${h}`, (sizes.get(`${w}x${h}`) || 0) + 1);
  if (x + w + 1 >= 4096) { ax = 1; ay += rowH + 1; rowH = 0; }
  ax = x + w + 1;
  if (h > rowH) rowH = h;
  if (ay > maxY) maxY = ay;
}
console.log('\n=== ATLAS WRITES DURING CAPTURE ===');
console.log('distinct texture sizes written:', sizes.size);
[...sizes.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12)
  .forEach(([s, n]) => console.log(`   ${s.padEnd(12)} x${n}`));
console.log('lowest atlas row reached:', maxY, 'of 4096');

const atlasErrors = consoleLines.filter((l) => /atlas/i.test(l));
console.log('\n=== ATLAS-RELATED CONSOLE OUTPUT ===');
atlasErrors.length ? atlasErrors.slice(0, 10).forEach((l) => console.log('  ', l))
                   : console.log('   (none)');

await browser.close();
console.log('\nwrote ->', OUT);
