// Does continuous input eliminate the idle signal?
//
// The host sends an idle beat only on a present that changed nothing. So the number
// of beats is a direct readout of how often the game had nothing to show:
//
//   beats during a still window  -> expected: the game is alive, nothing changes
//   beats during driven input    -> the target: zero, meaning every present the game
//                                   produced carried a picture
//
// If driving the camera cannot get the beat to zero, then some of the silence during
// play is the game genuinely having nothing new, and a long gap cannot be called a
// freeze on its own.
import { chromium } from 'playwright';
import { mkdirSync, writeFileSync } from 'node:fs';

const BASE = process.env.DF_BASE || 'http://192.168.1.111:8484';
const DRIVE_MS = Number(process.env.DF_DRIVE_MS || 6000);
const settle = (ms) => new Promise((r) => setTimeout(r, ms));
const dir = `evidence/bench/idle-beat/${new Date().toISOString().replace(/[:.]/g, '-')}`;
mkdirSync(dir, { recursive: true });

const browser = await chromium.launch({
  headless: true,
  args: ['--disable-background-timer-throttling', '--disable-renderer-backgrounding'],
});
// Into the arena first, by the same route the bench uses. Measuring a title screen
// would report zero beats and zero pictures and look like a clean result.
{
  const setup = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  await setup.goto(`${BASE}/df`, { waitUntil: 'domcontentloaded' });
  await settle(22000);
  const b = setup.viewportSize();
  await setup.mouse.click(b.width * 0.5, b.height * (479 / 800));
  await settle(4000);
  await setup.mouse.click(b.width * (180 / 1280), b.height * (144 / 800));
  await settle(1500);
  await setup.mouse.click(b.width * (1000 / 1280), b.height * (755 / 800));
  await settle(60000);
  await setup.close();
}

const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
await page.goto(`${BASE}/df`, { waitUntil: 'domcontentloaded' });
await settle(16000);
await page.mouse.click(640, 400);
await settle(1500);

const read = () => page.evaluate(() => {
  const b = window.__dfBench || {};
  return { beats: (b.idleBeats || []).length, display: (b.display || []).length, applied: b.framesApplied || 0 };
});

// --- window 1: nothing happening -----------------------------------------
const stillA = await read();
await settle(3000);
const stillB = await read();

// --- window 2: the camera driven continuously ----------------------------
// Opposite keys alternate so the camera never runs out of room, which would
// otherwise stop the picture for a reason that is not a freeze.
await page.evaluate(() => {
  const src = document.querySelector('canvas') || document.querySelector('img');
  window.__shots = [];
  window.__stop = false;
  const c = document.createElement('canvas');
  c.width = 1280; c.height = 800;
  const g = c.getContext('2d', { willReadFrequently: true });
  const tick = () => {
    if (window.__stop) return;
    try {
      g.drawImage(src, 0, 0, 1280, 800);
      const small = document.createElement('canvas');
      small.width = 64; small.height = 40;
      const sg = small.getContext('2d', { willReadFrequently: true });
      sg.drawImage(src, 0, 0, 64, 40);
      const px = sg.getImageData(0, 0, 64, 40).data;
      const grey = new Array(64 * 40);
      for (let i = 0; i < 64 * 40; i++) grey[i] = (px[i * 4] * 77 + px[i * 4 + 1] * 150 + px[i * 4 + 2] * 29) >> 8;
      window.__shots.push({ t: performance.now(), url: c.toDataURL('image/png'), grey });
    } catch (e) { /* unreadable frame not recorded */ }
    setTimeout(tick, 200);
  };
  tick();
});

const driveA = await read();
const driveBase = await page.evaluate(() => ({
  display: ((window.__dfBench || {}).display || []).length,
  beats: ((window.__dfBench || {}).idleBeats || []).length,
}));
// A key is held at ALL times. Releasing one before pressing the next leaves the
// camera stationary for the gap between them, which shows up as an idle beat and
// makes the result look like the game stalling when it was simply not being driven.
const keys = ['a', 'd', 's', 'w'];
const end = Date.now() + DRIVE_MS;
let held = null;
let i = 0;
while (Date.now() < end) {
  const next = keys[i++ % keys.length];
  await page.keyboard.down(next);
  if (held) await page.keyboard.up(held);
  held = next;
  await settle(250);
}
if (held) await page.keyboard.up(held);
const driveB = await read();

const shots = await page.evaluate(() => { window.__stop = true; return window.__shots; });
const gapReport = await page.evaluate((base) => {
  const b = window.__dfBench || {};
  const disp = (b.display || []).slice(base.display);
  const beats = (b.idleBeats || []).slice(base.beats);
  const events = (b.wire && b.wire.events) || [];
  const out = [];
  for (let i = 1; i < disp.length; i++) {
    const from = disp[i - 1], to = disp[i];
    const nb = beats.filter((t) => t > from && t <= to).length;
    const nf = events.filter((e) => e[0] > from && e[0] <= to && (e[1] === 'frame' || e[1] === 'keyframe')).length;
    out.push({ ms: Math.round(to - from), beats: nb, frames: nf });
  }
  return out;
}, driveBase);
await browser.close();

for (let n = 0; n < shots.length; n++) {
  const ms = Math.round(shots[n].t - shots[0].t);
  writeFileSync(`${dir}/${String(n).padStart(3, '0')}_${String(ms).padStart(6, '0')}ms.png`, Buffer.from(shots[n].url.split(',')[1], 'base64'));
}

const perSec = (d, secs) => (d / secs).toFixed(1);
console.log('window            beats   beats/s   pictures shown   picture/s');
console.log(`still  (3.0s)   ${String(stillB.beats - stillA.beats).padStart(6)}   ${String(perSec(stillB.beats - stillA.beats, 3)).padStart(7)}   ${String(stillB.display - stillA.display).padStart(14)}   ${perSec(stillB.display - stillA.display, 3).padStart(9)}`);
console.log(`driven (${(DRIVE_MS / 1000).toFixed(1)}s)   ${String(driveB.beats - driveA.beats).padStart(6)}   ${String(perSec(driveB.beats - driveA.beats, DRIVE_MS / 1000)).padStart(7)}   ${String(driveB.display - driveA.display).padStart(14)}   ${perSec(driveB.display - driveA.display, DRIVE_MS / 1000).padStart(9)}`);

const driveBeats = driveB.beats - driveA.beats;
console.log();
console.log(driveBeats === 0
  ? 'driving the camera produced ZERO idle beats: every present during play carried a picture'
  : `driving the camera still produced ${driveBeats} idle beats (${perSec(driveBeats, DRIVE_MS / 1000)}/s): the game has moments with nothing new even while being driven`);
// Did every captured frame differ from the one before it?
const changed = [];
for (let i = 1; i < shots.length; i++) {
  let n = 0;
  for (let k = 0; k < 64 * 40; k++) if (Math.abs(shots[i].grey[k] - shots[i - 1].grey[k]) > 12) n++;
  changed.push({ gap: Math.round(shots[i].t - shots[i - 1].t), pct: Math.round((n / (64 * 40)) * 100) });
}
const still = changed.filter((c) => c.pct < 2);
console.log(`\ncaptured frames: ${shots.length}; consecutive pairs that did not change: ${still.length}`);
console.log('capture gaps (ms) and how much the picture changed:');
console.log('  ' + changed.map((c) => `${c.gap}ms:${c.pct}%`).join('  '));

// Gaps between displayed pictures, classified by what arrived during them.
const idle = gapReport.filter((g) => g.beats > 0 && g.frames === 0);
const stall = gapReport.filter((g) => g.frames > 0);
const silent = gapReport.filter((g) => g.beats === 0 && g.frames === 0);
const worst = (a) => (a.length ? Math.max(...a.map((g) => g.ms)) : 0);
console.log(`\ndisplay gaps: ${gapReport.length}`);
console.log(`  beats only (idle, excluded):   ${idle.length}, worst ${worst(idle)}ms`);
console.log(`  frames arrived (client stall): ${stall.length}, worst ${worst(stall)}ms`);
console.log(`  neither (host silent):         ${silent.length}, worst ${worst(silent)}ms`);

console.log(`\n${shots.length} PNGs written to ${dir}`);
