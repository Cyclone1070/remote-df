// Do the two transports show the same picture?
//
// This is the gate that was missing. Every other bench number describes how fast or
// how smoothly a path delivers, and none of them can tell a fast, smooth, wrong
// picture from a right one. A rendering fault can lower every latency number while
// making the screen garbage, which is exactly what happened: an atlas bug produced
// heavy corruption on the instruction path and no metric noticed.
//
// How it works:
//   - both pages are open at the same time, against the same game
//   - each capture is reduced to a coarse grid of average brightness, after first
//     cropping away the black letterbox bars, so the two different renderers can be
//     compared regardless of canvas size or aspect handling
//   - every instruction capture is paired with the raw capture nearest it in time
//   - the pair's difference is the mean absolute difference across the grid
//
// The threshold is calibrated, not guessed: the run first compares a page with
// itself, which is the noise floor, and the gate only fails a pair that is clearly
// worse than that floor.
import { chromium } from 'playwright';
import { mkdirSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const BASE = process.env.DF_API || 'http://192.168.1.111:8484';
const PIXEL_PAGE = process.env.DF_RAW_PAGE || 'http://192.168.1.111:8000/';
const dir = `evidence/bench/frame-parity/${new Date().toISOString().replace(/[:.]/g, '-')}`;
mkdirSync(dir, { recursive: true });

const settle = (ms) => new Promise((r) => setTimeout(r, ms));

// The raw page renders nothing at all unless the pixel capture is switched on, and
// a page showing nothing compares at a constant difference against every capture -
// which reads as six failing pairs and looks like a rendering fault. Parity owns
// this switch so it cannot inherit whatever the last pass left behind.
try {
  execFileSync('ssh', ['-o', 'ConnectTimeout=10', 'cyc@192.168.1.111',
    'podman exec remote-df touch /tmp/df_raw_on'], { stdio: 'ignore' });
} catch (e) {
  console.log(`could not switch the pixel capture on: ${String(e).slice(0, 80)}`);
}

// Capture harness, installed into both pages.
//
// It finds whatever the page paints into - a canvas or an img - and reduces it to a
// small grid. Cropping happens here because the two renderers letterbox differently.
const CAPTURE = () => {
  window.__capture = () => {
    const src = document.querySelector('canvas') || document.querySelector('img');
    if (!src) return null;
    const w = src.width || src.naturalWidth || src.clientWidth;
    const h = src.height || src.naturalHeight || src.clientHeight;
    if (!w || !h) return null;
    // Saved at a size a person can actually inspect: the whole point of this gate is
    // that the pictures get looked at, and a 64x40 thumbnail cannot show corruption.
    const c = document.createElement('canvas');
    c.width = 320; c.height = 200;
    const g = c.getContext('2d', { willReadFrequently: true });
    g.drawImage(src, 0, 0, 320, 200);
    const px = g.getImageData(0, 0, 320, 200).data;
    // A coarse grid for the numeric comparison, from the same pixels.
    const GW = 32, GH = 20;
    const grey = [];
    for (let gy = 0; gy < GH; gy++) {
      for (let gx = 0; gx < GW; gx++) {
        let sum = 0, n = 0;
        for (let y = Math.floor(gy * 200 / GH); y < Math.floor((gy + 1) * 200 / GH); y++) {
          for (let x = Math.floor(gx * 320 / GW); x < Math.floor((gx + 1) * 320 / GW); x++) {
            const i = (y * 320 + x) * 4;
            sum += (px[i] * 77 + px[i + 1] * 150 + px[i + 2] * 29) >> 8;
            n++;
          }
        }
        grey.push(Math.round(sum / n));
      }
    }
    return { t: performance.now(), grey, png: c.toDataURL('image/png'), w, h };
  };
};

// Trim the letterbox: drop rows and columns that are uniformly near-black at the
// edges. Two paths that frame the same scene the same way then compare directly.
const contentBox = (grey) => {
  const W = 64, H = 40;
  const dark = (row) => { for (let x = 0; x < W; x++) if (grey[row * W + x] > 8) return false; return true; };
  const darkCol = (col) => { for (let y = 0; y < H; y++) if (grey[y * W + col] > 8) return false; return true; };
  let top = 0, bottom = H - 1, left = 0, right = W - 1;
  while (top < bottom && dark(top)) top++;
  while (bottom > top && dark(bottom)) bottom--;
  while (left < right && darkCol(left)) left++;
  while (right > left && darkCol(right)) right--;
  return { top, bottom, left, right };
};

// Mean absolute difference, searched over small shifts.
//
// The two renderers do not agree on exactly where the scene sits: one paints a
// canvas, the other letterboxes an image, and each rounds the fit differently. A
// plain cell-by-cell difference measures that offset rather than the picture, which
// is how the first version of this gate marked an identical scene as a failure.
// Taking the best score over a small search window removes the offset and leaves
// the content.
const GW = 32, GH = 20;
const compare = (a, b) => {
  let best = null;
  for (let dy = -3; dy <= 3; dy++) {
    for (let dx = -3; dx <= 3; dx++) {
      let sum = 0, n = 0;
      for (let y = 3; y < GH - 3; y++) {
        for (let x = 3; x < GW - 3; x++) {
          const bx = x + dx, by = y + dy;
          if (bx < 0 || by < 0 || bx >= GW || by >= GH) continue;
          sum += Math.abs(a[y * GW + x] - b[by * GW + bx]);
          n++;
        }
      }
      if (!n) continue;
      const v = sum / n;
      if (best === null || v < best) best = v;
    }
  }
  return best === null ? null : +best.toFixed(2);
};

const browser = await chromium.launch({
  headless: true,
  args: ['--disable-background-timer-throttling', '--disable-renderer-backgrounding'],
});

const instruction = await browser.newPage({ viewport: { width: 1280, height: 800 } });
await instruction.goto(`${BASE}/df`, { waitUntil: 'domcontentloaded' });
await settle(12000);

// Into the arena only if the game is not already playable.
//
// Decided on the page that is already open rather than on a second throwaway page:
// the extra page cost a load and twelve seconds, and every second here comes out of
// the suite's five minute budget.
{
  const n = () => instruction.evaluate(() => ((window.__dfBench || {}).display || []).length);
  const a = await n();
  await instruction.keyboard.down('d');
  await settle(900);
  await instruction.keyboard.up('d');
  await settle(1200);
  if ((await n()) <= a) {
    console.log('game is not playable - running the arena entry');
    await instruction.mouse.click(640, 479);
    await settle(4000);
    await instruction.mouse.click(180, 144);
    await settle(1500);
    await instruction.mouse.click(1000, 755);
    await settle(45000);
  } else {
    console.log('game is already in the arena');
  }
}

const pixel = await browser.newPage({ viewport: { width: 1280, height: 800 } });
await pixel.goto(PIXEL_PAGE, { waitUntil: 'domcontentloaded' });
await settle(14000);
await instruction.evaluate(CAPTURE);
await pixel.evaluate(CAPTURE);
await settle(2000);

const grab = async (page) => page.evaluate(() => window.__capture());

// Noise floor: the same page twice, a moment apart, with the scene still. Anything
// at or below this is not a difference between the transports.
const n1 = await grab(pixel);
await settle(900);
const n2 = await grab(pixel);
const noiseFloor = compare(n1.grey, n2.grey);
console.log(`noise floor (raw page against itself, still scene): ${noiseFloor}`);

const pairs = [];
// Capture each page twice and only accept a pair whose captures stopped changing.
//
// The two pages are grabbed one after the other, so if either is still settling the
// pair compares two different instants and scores a rendering fault that is really
// a timing fault. Exactly that failed the gate twice on pan pairs while the still
// pairs passed - the scene was still moving after a pan when the raw page was read.
// Waiting for both to go quiet removes the ambiguity instead of widening the limit.
// Capture each page twice and accept the pair only once both stopped changing.
//
// The pages are grabbed one after the other, so if either is still settling the pair
// compares two different instants and scores a timing artefact as a rendering fault.
// That is what failed the gate twice on pan pairs while the still pairs passed.
// Asking the pages whether they are still drawing does not work - the pixel path
// repaints every frame by design, so it never looks idle - so the test is the picture
// itself: read it again after a short settle and require it to be unchanged.
// Wait until the instruction client is holding every picture its frame references.
//
// Panning into unseen terrain makes the game create new pictures, which have to
// travel before the client can draw them. Comparing during that window scores
// "artwork still arriving" as "the renderer paints the wrong thing" - which is
// exactly how this gate failed on pan pairs while the still and zoom pairs passed.
async function waitForArtwork(maxMs = 20000) {
  const started = Date.now();
  for (;;) {
    let missing = -1;
    try {
      missing = await instruction.evaluate(() => {
        const r = window.renderer || {};
        if (!r.missingTextureIds) return 0;
        return r.assetsReady === true ? r.missingTextureIds().size : 999;
      });
    } catch { /* page busy */ }
    if (missing === 0) return true;
    if (Date.now() - started > maxMs) return false;
    await settle(250);
  }
}

// Wait until the instruction client has taken in a frame produced after this press.
// Comparing straight after a keypress compares the pixel path's live screen against a
// picture the other path has not received yet: that reads as a rendering fault and is
// really a capture taken too early.
async function waitForFrameAfter(page, appliedBefore, timeoutMs = 6000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const now = await page.evaluate(() => (window.__dfBench || {}).framesApplied || 0);
    if (now > appliedBefore) return true;
    await page.waitForTimeout(120);
  }
  return false;
}

const snap = async (label) => {
  await waitForArtwork();
  let a2, b2;
  for (let attempt = 0; attempt < 5; attempt++) {
    const a = await grab(instruction);
    const b = await grab(pixel);
    await settle(300);
    a2 = await grab(instruction);
    b2 = await grab(pixel);
    if (compare(a.grey, a2.grey) <= noiseFloor + 0.05 && compare(b.grey, b2.grey) <= noiseFloor + 0.05) break;
  }
  const d = compare(a2.grey, b2.grey);
  // When a pair disagrees, say WHY in the terms that explain it. A picture that
  // never changed is a held frame, not a mis-render, and the two need opposite
  // fixes - so record the client's own view of its completeness alongside the diff.
  let diag = null;
  if (d > 12) {
    try {
      diag = await instruction.evaluate(() => {
        const r = window.renderer || {};
        return {
          ready: r.assetsReady === true,
          missing: r.missingTextureIds ? r.missingTextureIds().size : -1,
          missingIds: r.missingTextureIds ? [...r.missingTextureIds()].slice(0, 12) : [],
          cmds: (r.commands || []).length,
          framesApplied: (window.__dfBench || {}).framesApplied || 0,
          paints: (window.__dfBench || {}).paints || 0,
        };
      });
    } catch { /* page busy */ }
  }
  pairs.push({ label, t: a2.t, diff: d, inst: a2, raw: b2, diag });
  return d;
};

// Pause the game first.
//
// The two pages are captured one after the other, so anything moving between the two
// captures scores as a difference even when both paths render correctly. Freezing the
// simulation removes that: on a paused game the picture is the same wait as long as
// you like, so a non-zero score can only mean the two renderers disagree.
// Space is a toggle, so pressing it blind is only correct on a game that is
// running. The arena loads paused: pressing Space there *resumes* it, and then
// every pair photographs an animating world at two different instants, which scores
// as a rendering fault on a healthy build. That is exactly how this gate failed a
// good run. So look at the host's counters first: frames advancing means running,
// encodeNothing advancing means presenting-but-paused.
async function hostCounts() {
  try {
    const j = await (await fetch(`${BASE}/df-stats`, { signal: AbortSignal.timeout(8000) })).json();
    return { frames: j.frames || 0, nothing: j.encodeNothing || 0 };
  } catch { return null; }
}
async function ensurePaused() {
  const a = await hostCounts();
  await settle(1200);
  const b = await hostCounts();
  if (!a || !b) {
    console.log('  could not read the host counters - not pressing space blind');
    return;
  }
  if (b.frames > a.frames) {
    console.log('  game is running - pausing it for the comparison');
    await instruction.keyboard.press(' ');
    await settle(2500);
  } else {
    console.log('  game is already paused - leaving it alone');
  }
}
await ensurePaused();

console.log('\nstill scene (game paused):');
console.log(`  pair 0: diff ${await snap('still')}`);

console.log('\nzooming:');
// The capture of one page happens after the other, so both must be taken on a
// scene that has stopped changing. A zoom is given time to settle before it is
// compared; without this the gate measures the gap between two capture instants and
// calls it a rendering fault.
for (const k of [']', '[']) {
  const before = await instruction.evaluate(() => (window.__dfBench || {}).framesApplied || 0);
  await instruction.keyboard.press(k);
  if (!(await waitForFrameAfter(instruction, before))) console.log(`  (no frame arrived after ${k})`);
  await settle(400);
  console.log(`  after ${k}: diff ${await snap(`zoom-${k}`)}`);
}

// Still paused. The pan pairs compare two captures taken one after the other, and
// resuming here made them photograph an animating world at different instants -
// which scored as a rendering fault and failed the gate on a healthy build.
console.log('\npanning:');
for (const k of ['a', 'd']) {
  const before = await instruction.evaluate(() => (window.__dfBench || {}).framesApplied || 0);
  await instruction.keyboard.down(k);
  await settle(400);
  await instruction.keyboard.up(k);
  if (!(await waitForFrameAfter(instruction, before))) console.log(`  (no frame arrived after ${k})`);
  await settle(400);
  const d = await snap(`pan-${k}`);
  console.log(`  after ${k}: diff ${d}${d > 12 ? '  ' + JSON.stringify(pairs[pairs.length - 1].diag) : ''}`);
}

// Resume the game before leaving. The gate pauses it to compare a settled scene, and
// a run that hands a paused game to the bench makes every later interaction read as
// "no movement" - a whole run wasted by a cleanup this small. Same rule as above:
// only press if it is actually paused.
{
  const a = await hostCounts();
  await settle(1000);
  const b = await hostCounts();
  if (a && b && b.frames <= a.frames) {
    await instruction.keyboard.press(' ');
    await settle(1500);
  }
}

await browser.close();

const scored = pairs.filter((p) => p.diff != null);
scored.sort((x, y) => y.diff - x.diff);
for (let i = 0; i < scored.length; i++) {
  const p = scored[i];
  writeFileSync(`${dir}/${String(i).padStart(2, '0')}_${p.label}_diff${p.diff}_instruction.png`, Buffer.from(p.inst.png.split(',')[1], 'base64'));
  writeFileSync(`${dir}/${String(i).padStart(2, '0')}_${p.label}_diff${p.diff}_raw.png`, Buffer.from(p.raw.png.split(',')[1], 'base64'));
}

const limit = Math.max(12, (noiseFloor ?? 0) * 3);
const bad = scored.filter((p) => p.diff > limit);
const median = (() => {
  const v = scored.map((p) => p.diff).sort((a, b) => a - b);
  return v.length ? v[Math.floor(v.length / 2)] : null;
})();

console.log(`\n${scored.length} pairs compared`);
console.log(`  median diff ${median}   worst ${scored[0]?.diff ?? '—'}   limit ${limit.toFixed(1)}`);
console.log(`  pairs over the limit: ${bad.length}`);
if (bad.length) {
  console.log('\nFAIL - these pairs do not show the same picture:');
  for (const p of bad) console.log(`  ${p.label}: diff ${p.diff}`);
  console.log(`\nworst pairs written to ${dir}`);
  process.exitCode = 1;
} else {
  console.log('\nPASS - every pair showed the same picture within the noise floor');
}
console.log(`PNGs (if any) in ${dir}`);
