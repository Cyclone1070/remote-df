// Measures how often the picture actually changes while the camera is panned, in
// the classic object testing arena.
//
// This exists because every earlier attempt to measure the pan was wrong in a way
// that still produced confident numbers: the drag was on the title menu, the drag
// used the wrong mouse button, or the arena was still loading. A measurement that
// cannot tell "the camera moved" from "nothing happened" is not a measurement.
//
// So the instrument proves the pan works before it reports anything. If a drag
// does not change the screen, it says so and exits non-zero instead of printing a
// frame rate for a stationary picture.

import { chromium } from 'playwright';
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';

const BASE = process.env.DF_BASE || 'http://192.168.1.111:8484';
const OUT = process.argv.includes('--out')
  ? process.argv[process.argv.indexOf('--out') + 1]
  : 'evidence/bench/arena-pan';

const stats = async () => (await fetch(`${BASE}/df-stats`)).json();
const settle = (ms) => new Promise((r) => setTimeout(r, ms));

// The arena refuses to scroll the camera until a creature exists - the banner says
// "Create a creature to begin." and every drag silently does nothing. Six separate
// measurements were taken before this was noticed, and all of them described a
// camera that was not allowed to move.
async function createCreature(page) {
  await page.mouse.click(457, 780);   // the '+' creature icon
  await settle(2500);
  await page.mouse.click(1003, 82);   // Create
  await settle(2500);
  await page.keyboard.press('Escape');
  await settle(1500);
}

async function enterArena(page) {
  // title -> Object testing arena -> Classic Arena -> Create arena
  await page.mouse.click(page.viewportSize().width * 0.5, page.viewportSize().height * (479 / 800));
  await settle(4000);
  await page.mouse.click(page.viewportSize().width * (180 / 1280), page.viewportSize().height * (144 / 800));
  await settle(1500);
  await page.mouse.click(page.viewportSize().width * (1000 / 1280), page.viewportSize().height * (755 / 800));
}

// The camera is panned by holding WASD. Mouse buttons, dragging and the arrow keys
// do not move it at all; what moves under the pointer is the tile tooltip, and
// measuring a tooltip as if it were the camera is what wasted this investigation.
const PAN_KEYS = ['a', 'd', 'w', 's'];

// Hold one direction for the whole window. Tapping keys leaves the camera stopped
// between taps, which measures the stops rather than the pan and makes the frame
// rate look like whatever the duty cycle happens to be.
// RAPID=1 drives the key as fast as the client can be told to, instead of leaning
// on whatever repeat rate the held key produces. If the picture rate rises, the
// pan is limited by key repeats and not by rendering, capture or transport.
async function drag(page, seconds) {
  const key = PAN_KEYS[0];
  const t0 = Date.now();
  let i = 0;
  if (process.env.RAPID) {
    while (Date.now() - t0 < seconds * 1000) {
      await page.keyboard.press(key);
      i++;
    }
    return i;
  }
  await page.keyboard.down(key);
  while (Date.now() - t0 < seconds * 1000) {
    await page.waitForTimeout(100);
    i++;
  }
  await page.keyboard.up(key);
  return i;
}

const hash = (buf) => createHash('sha256').update(buf).digest('hex').slice(0, 16);

// The point of the whole file: can this drag change the picture at all?
async function panMovesPicture(page) {
  // Park the pointer first: hovering a tile changes the tooltip, and a tooltip is
  // not a camera move. Comparing screenshots with the pointer in different places
  // is what made a moving tooltip look like a panning camera.
  await page.mouse.move(1240, 700);
  await settle(1200);
  const before = await page.screenshot();
  await drag(page, 2);
  await page.mouse.move(1240, 700);
  await settle(1500);
  const after = await page.screenshot();
  return { moved: hash(before) !== hash(after), before: hash(before), after: hash(after) };
}

(async () => {
  const browser = await chromium.launch({
    headless: true,
    args: [
      '--disable-frame-rate-limit',
      '--disable-gpu-vsync',
      '--run-all-compositor-stages-before-draw',
      '--disable-background-timer-throttling',
      '--disable-renderer-backgrounding',
      '--disable-backgrounding-occluded-windows',
    ],
  });
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  await page.goto(`${BASE}/df`, { waitUntil: 'domcontentloaded' });

  // connect, then get into the arena
  await settle(22000);
  await enterArena(page);
  await settle(60000);
  await createCreature(page);

  // Wait for the arena to be genuinely live: a drag has to move the picture.
  let live = null;
  for (let attempt = 1; attempt <= 20; attempt++) {
    await settle(8000);
    const probe = await panMovesPicture(page);
    console.log(`readiness ${attempt}: drag moved picture = ${probe.moved} (${probe.before} -> ${probe.after})`);
    if (probe.moved) { live = attempt; break; }
  }
  if (!live) {
    console.error('REFUSING to report: a right-drag never changed the picture, so there is');
    console.error('nothing here to measure. Reporting a frame rate now would describe a still');
    console.error('image and would be exactly the mistake this file exists to prevent.');
    await browser.close();
    process.exit(3);
  }
  console.log(`arena live after readiness attempt ${live}`);

  await settle(3000);
  await page.evaluate(() => window.__trace && window.__trace.push([performance.now(), 'mark', { what: 'pan-start' }]));
  const s0 = await stats();
  // Sample the picture throughout the drag, not just at the ends: the pan pattern
  // returns to where it started, so comparing endpoints alone reports a still
  // image even when the camera swept across the map.
  const seen = new Set();
  const shots = [];
  const box = page.viewportSize();
  await page.mouse.move(box.width * 0.5, box.height * 0.5);
  await page.mouse.down({ button: 'right' });
  const tDrag = Date.now();
  let moves = 0;
  let lastShot = 0;
  while (Date.now() - tDrag < 15000) {
    const ph = (moves % 50) / 50;
    await page.mouse.move(box.width * (0.5 + 0.25 * Math.sin(ph * 2 * Math.PI)),
                          box.height * (0.5 + 0.15 * Math.sin(ph * 4 * Math.PI)));
    await page.waitForTimeout(25);
    moves++;
    if (Date.now() - lastShot >= 500) {
      const shot = await page.screenshot();
      const h = hash(shot);
      seen.add(h);
      shots.push(h);
      lastShot = Date.now();
    }
  }
  await page.mouse.up({ button: 'right' });
  await page.evaluate(() => window.__trace && window.__trace.push([performance.now(), 'mark', { what: 'pan-end' }]));
  const after = await page.screenshot();
  const s1 = await stats();
  const pictureMoved = seen.size > 1;

  const secs = (s1.now - s0.now) / 1000;
  const d = (k) => s1[k] - s0[k];
  const result = {
    clientPicturesSeen: seen.size,
    clientSamples: shots.length,
    clientPicturesPerSec: +(seen.size / secs).toFixed(1),
    seconds: +secs.toFixed(1),
    mouseMoves: moves,
    presentsPerSec: +(d('presents') / secs).toFixed(1),
    distinctFramesPerSec: +(d('frames') / secs).toFixed(1),
    encoderSaidNothingPerSec: +(d('encodeNothing') / secs).toFixed(1),
    frameBytesPerSec: Math.round(d('wireBytes') / secs),
    pictureBytesPerSec: Math.round(d('textureBytes') / secs),
    pictureShareOfTraffic: d('wireBytes') > 0 ? +(100 * d('textureBytes') / d('wireBytes')).toFixed(1) : 0,
    queueMaxDuringPan: s1.queueMax - s0.queueMax,
    sendBlockMaxUsDuringPan: s1.sendBlockMaxUs,
    nothingButPixelsChanged: d('nothingPixelsChanged'),
    pictureMovedDuringMeasurement: pictureMoved,
  };

  // The client's own account of the same window: if the server sent frames and the
  // picture still did not change, this says where the client spent the time.
  const gaps = await page.evaluate(() => {
    const t = window.__trace || [];
    const start = t.find((e) => e[1] === 'mark' && e[2].what === 'pan-start');
    const end = t.find((e) => e[1] === 'mark' && e[2].what === 'pan-end');
    if (!start || !end) return null;
    const inWin = t.filter((e) => e[0] >= start[0] && e[0] <= end[0]);
    const times = inWin.filter((e) => e[1] === 'draw').map((e) => e[0]);
    const d = [];
    for (let i = 1; i < times.length; i++) d.push(times[i] - times[i - 1]);
    const count = (k) => inWin.filter((e) => e[1] === k).length;
    return {
      draws: times.length, gaps: d, windowMs: end[0] - start[0],
      frameIns: count('frame-in'), applies: count('apply'), holds: count('hold'),
      bridgeRequests: count('bridge-request'), heldBack: count('held-back'),
      picsIn: count('pic-in'), loopGaps: count('loop-gap'),
    };
  });
  const clientTrace = await page.evaluate(() => {
    const t = window.__trace || [];
    const pick = (k) => t.filter((e) => e[1] === k);
    return {
      draws: pick('draw').length,
      applies: pick('apply').length,
      frameIns: pick('frame-in').length,
      paints: pick('paint-cost').map((e) => e[2].ms),
      loopGaps: pick('loop-gap').map((e) => e[2].ms),
      total: t.length,
    };
  });
  const q = (a, p) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.min(s.length - 1, Math.floor(s.length * p))] : -1; };
  result.client = {
    draws: clientTrace.draws,
    applies: clientTrace.applies,
    frameIns: clientTrace.frameIns,
    paintOver10msCount: clientTrace.paints.length,
    paintP50: q(clientTrace.paints, 0.5),
    paintMax: clientTrace.paints.reduce((a, b) => Math.max(a, b), 0),
    loopGapP50: q(clientTrace.loopGaps, 0.5),
    loopGapP95: q(clientTrace.loopGaps, 0.95),
    loopGapMax: clientTrace.loopGaps.reduce((a, b) => Math.max(a, b), 0),
    loopIterations: clientTrace.loopGaps.length,
  };

  if (gaps) {
    const g = [...gaps.gaps].sort((a, b) => a - b);
    const at = (p) => (g.length ? g[Math.min(g.length - 1, Math.floor(g.length * p))] : -1);
    result.smoothness = {
      drawsInPan: gaps.draws,
      drawsPerSec: +(gaps.draws / (gaps.windowMs / 1000)).toFixed(1),
      drawGapP50: Math.round(at(0.5)),
      drawGapP95: Math.round(at(0.95)),
      drawGapMax: g.length ? Math.round(g[g.length - 1]) : -1,
      gapsOver200ms: g.filter((x) => x > 200).length,
      frameIns: gaps.frameIns,
      applies: gaps.applies,
      holds: gaps.holds,
      bridgeRequests: gaps.bridgeRequests,
      heldBack: gaps.heldBack,
      picsIn: gaps.picsIn,
    };
  }

  mkdirSync(OUT, { recursive: true });
  writeFileSync(`${OUT}/result.json`, JSON.stringify(result, null, 2));
  writeFileSync(`${OUT}/after.png`, after);

  console.log(JSON.stringify(result, null, 2));

  if (!pictureMoved) {
    console.error('During the measurement drag the picture never changed; the rates above');
    console.error('describe a still image and must not be used as a frame rate.');
    await browser.close();
    process.exit(3);
  }
  await browser.close();
})();
