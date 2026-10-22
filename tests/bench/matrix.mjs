// The interaction matrix: every input the bench knows how to drive, measured on
// both transports, with a per-step log so a failure can be read back later
// without re-running anything.
//
// Why a matrix: the bench only ever exercised panning. Zoom, elevation, spawning
// creatures and unpausing time all change how much new artwork the game produces,
// and the stall is driven by artwork, so testing only panning was testing the one
// case least likely to break.
//
// Why every step is logged: a single smoothness number cannot say which link was
// slow. Every sample carries a timestamp, so a gap can be attributed afterwards
// to the wire, the page's own main thread, or the host.
//
// Nothing here invents a definition. Gaps, latency and freeze counts all come from
// the pages' own bench objects, which share measure.js, so the two transports are
// measured with one ruler rather than two.
import { chromium } from 'playwright';
import { mkdirSync, writeFileSync, appendFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

const CMD_BASE = process.env.DF_BASE || 'http://192.168.1.111:8484';
const PIXEL_PAGE = process.env.DF_RAW_PAGE || 'http://192.168.1.111:8000/';
const SECONDS = Number(process.env.DF_MATRIX_SECONDS || 10);
const ONLY = process.env.DF_MATRIX_ONLY || '';
const PIXEL_STATS = process.env.DF_RAW_STATS || 'http://192.168.1.111:8000/raw-stats';
const OUT_ROOT = 'evidence/bench/interaction-matrix';
// Which network the numbers were taken on. A matrix measured only on a bare LAN
// cannot say anything about a real connection, and two runs are only comparable
// if the label travels with the results.
const NET_LABEL = process.env.DF_NET_LABEL || 'lan';

const settle = (ms) => new Promise((r) => setTimeout(r, ms));
const hash = (b) => createHash('sha256').update(b).digest('hex').slice(0, 12);
const serverStats = async () => (await fetch(`${CMD_BASE}/df-stats`)).json();
// The pixel relay's per-viewer egress. Its own clock is returned alongside so the
// window can be measured on the relay's timeline rather than guessed at.
const pixelStats = async () => (await fetch(`${PIXEL_STATS}`)).json();

const q = (arr, p) => {
  if (!arr.length) return null;
  const s = [...arr].sort((a, b) => a - b);
  return Math.round(s[Math.min(s.length - 1, Math.floor(s.length * p))]);
};
const summarize = (times) => {
  const g = [];
  for (let i = 1; i < times.length; i++) g.push(times[i] - times[i - 1]);
  return {
    samples: times.length,
    gapP50: q(g, 0.5), gapP95: q(g, 0.95), gapMax: g.length ? Math.round(Math.max(...g)) : null,
    over100: g.filter((x) => x > 100).length,
    over250: g.filter((x) => x > 250).length,
    over500: g.filter((x) => x > 500).length,
  };
};
const latSummary = (v) => ({
  n: v.length,
  p50: q(v, 0.5), p95: q(v, 0.95), max: v.length ? Math.round(Math.max(...v)) : null,
});

// One place that knows how to read either page's bench, so the two transports are
// compared on identical fields rather than on whatever each page happens to expose.
// Bytes actually delivered to THIS one client, not bytes the server offered.
//
// The server's wireBytes counter is global: a second tab doubles it, and the pixel
// path's interposer counter counts a single upstream copy before any viewer exists.
// Those two numbers are taken at different hops, so comparing them was comparing
// two different things. The page's own record of what arrived is the only number
// that means the same on both sides.
const READ_RECEIVED = () => {
  const b = window.__dfBench || {};
  const ev = (b.wire && b.wire.events) || [];
  let bytes = 0;
  for (let i = 0; i < ev.length; i++) bytes += ev[i][2] || 0;
  return { bytes, events: ev.length, at: performance.now() };
};

const READ_BENCH = () => {
  const b = window.__dfBench || {};
  const num = (x) => (Array.isArray(x) ? x[x.length - 1] : x);
  return {
    display: (b.display || []).map(num).filter((x) => typeof x === 'number'),
    latency: (b.latency || []).map((x) => (Array.isArray(x) ? Number(x[1] ?? x[0]) : Number(x))).filter((x) => Number.isFinite(x)),
    longTasks: (b.longTasks || []).map((x) => (Array.isArray(x) ? x[1] : x)).filter((x) => Number.isFinite(x)),
    inputsSent: b.inputsSent || 0,
    stampedFrames: b.stampedFrames || b.stampFramesSeen || 0,
    paints: b.paints || 0,
    glRenderer: b.glRenderer || null,
    wireEvents: (b.wire && b.wire.events ? b.wire.events.length : 0),
  };
};

// Latency measured the same way on both transports: the moment the page receives
// an input, to the moment the page records a changed picture.
//
// The pages' own latency counters depend on a stamp surviving the round trip to
// the host and back, and on the instruction path those counters never increment at
// all, so they cannot be used to compare the two. This watches the picture itself,
// which both pages already record, and attributes it to the input that preceded it.
// Photographs the picture the user is actually looking at.
//
// The pages' own counters only tick when their internal "did the paint change"
// flag says so, and on some interactions that flag stays false while the screen
// is visibly moving - which produced an elevation run with 25 pictures/s arriving
// and no samples recorded. Reading the pixels cannot disagree with the screen,
// because it IS the screen.
const PIXEL_PROBE = () => {
  // The instruction path only stamps inputs when this flag is set: without it
  // getNextDebugStamp() returns 0, no stamp ever reaches the host, and the page's
  // latency counter can never record anything. That is why every instruction run
  // reported an empty latency column. It is a measurement switch, not a behaviour
  // change - the same frames and the same transport are used either way.
  window.__enableM2P = true;

  window.__probe = () => {
    const src = document.querySelector('canvas') || document.querySelector('img');
    if (!src) return null;
    try {
      const c = document.createElement('canvas');
      c.width = 48; c.height = 48;
      const g = c.getContext('2d', { willReadFrequently: true });
      g.drawImage(src, 0, 0, 48, 48);
      const d = g.getImageData(0, 0, 48, 48).data;
      let h = 2166136261;
      for (let i = 0; i < d.length; i += 11) { h ^= d[i]; h = (h * 16777619) >>> 0; }
      return h;
    } catch (e) { return null; }
  };

  // A change is credited to an input only if that input is genuinely responsible.
  //
  // Five ways the previous version could invent a latency, each closed here:
  //
  //  1. It recorded the last SEEN hash rather than probing at input time, so a
  //     hash that had already changed was treated as the starting point. Now the
  //     probe is taken at the moment the input arrives.
  //  2. It credited any change to a pending input, with no causality check, so a
  //     game animation frame could "answer" a key that did nothing. Now an input
  //     is only answerable if the picture was STABLE for a moment before it, which
  //     is what makes the following change attributable to it.
  //  3. It fixed the sampling resolution from one interval measured at tick 30.
  //     A single stall inflated that permanently, and the inflated floor then
  //     silently discarded genuine fast samples. Now it is a running minimum.
  //  4. Unreadable pixels returned null and were ignored, so a change during the
  //     gap was first seen late - inflating latency in one direction only. They
  //     are now counted, and reported.
  //  5. Nothing reported how many inputs were never answerable, so a path with
  //     mostly-unattributable inputs looked identical to one with clean samples.
  const STABLE_MS = 200;
  window.__lat = {
    pending: [], samples: [], changedAt: [], last: null,
    minResolution: Infinity, nullProbes: 0, lastChangeAt: 0, inputs: 0, unattributable: 0,
  };
  const mark = (ev) => {
    // A held key repeats keydown every ~30ms. Those repeats are not new inputs,
    // and queueing them meant a held key was answered by the OLDEST entry - so
    // the reported latency became "how long ago you first pressed", which is how
    // a 200ms response was being reported as 1635ms.
    if (ev && ev.repeat) return;
    const now = performance.now();
    const h = window.__probe();
    window.__lat.inputs++;
    if (h === null) { window.__lat.nullProbes++; window.__lat.unattributable++; return; }
    window.__lat.pending.push({ t: now, h, stable: now - window.__lat.lastChangeAt >= STABLE_MS });
    if (window.__lat.pending.length > 64) { window.__lat.pending.shift(); window.__lat.unattributable++; }
  };
  window.addEventListener('keydown', mark, true);
  window.addEventListener('mousedown', mark, true);
  let lastTick = performance.now();
  const tick = () => {
    const now = performance.now();
    const dt = now - lastTick; lastTick = now;
    if (dt > 0) window.__lat.minResolution = Math.min(window.__lat.minResolution, dt);
    const h = window.__probe();
    if (h === null) {
      window.__lat.nullProbes++;
      requestAnimationFrame(tick);
      return;
    }
    if (h !== window.__lat.last) {
      window.__lat.last = h;
      window.__lat.changedAt.push(now);
      window.__lat.lastChangeAt = now;
      while (window.__lat.pending.length && now - window.__lat.pending[0].t > 2000) {
        window.__lat.pending.shift();
        window.__lat.unattributable++;
      }
      const floor = Math.max(1, window.__lat.minResolution === Infinity ? 1 : window.__lat.minResolution);
      const idx = window.__lat.pending.findIndex((e) => e.h !== h && e.stable && now - e.t >= floor);
      if (idx >= 0) {
        window.__lat.samples.push(+(now - window.__lat.pending[idx].t).toFixed(1));
        window.__lat.pending.splice(0, idx + 1);
      }
    }
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
};

const browser = await chromium.launch({
  headless: true,
  args: ['--disable-frame-rate-limit', '--disable-gpu-vsync', '--run-all-compositor-stages-before-draw',
         '--disable-background-timer-throttling', '--disable-renderer-backgrounding',
         '--disable-backgrounding-occluded-windows'],
});

// ---------- get the game into the arena once: every interaction needs a map ---
async function enterArenaOnce() {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  await page.goto(`${CMD_BASE}/df`, { waitUntil: 'domcontentloaded' });
  await settle(22000);
  const b = page.viewportSize();
  await page.mouse.click(b.width * 0.5, b.height * (479 / 800));
  await settle(4000);
  await page.mouse.click(b.width * (180 / 1280), b.height * (144 / 800));
  await settle(1500);
  await page.mouse.click(b.width * (1000 / 1280), b.height * (755 / 800));
  await settle(60000);
  await page.close();
}

// ---------- interactions ----------
// Each returns a function that drives the input for the whole window, and is
// applied through whichever page is being measured so both transports receive
// the same thing.
const INTERACTIONS = {
  idle: async () => {},
  pan: async (page, secs) => {
    const keys = ['a', 'd', 'w', 's'];
    const end = Date.now() + secs * 1000;
    let i = 0;
    while (Date.now() < end) {
      const k = keys[i++ % keys.length];
      await page.keyboard.down(k); await settle(700); await page.keyboard.up(k);
    }
  },
  zoom: async (page, secs) => {
    const end = Date.now() + secs * 1000;
    let i = 0;
    while (Date.now() < end) {
      await page.keyboard.press(i++ % 2 ? '[' : ']');
      await settle(400);
    }
  },
  elevation: async (page, secs) => {
    const end = Date.now() + secs * 1000;
    let i = 0;
    while (Date.now() < end) {
      await page.keyboard.press(i++ % 2 ? '>' : '<');
      await settle(500);
    }
  },
  spawn: async (page, secs) => {
    // open the creature panel, create the top entry, then place: the arena refuses
    // to draw anything alive until a creature exists
    const b = page.viewportSize();
    const end = Date.now() + secs * 1000;
    while (Date.now() < end) {
      await page.mouse.click(457, 780);        // creature icon
      await settle(1200);
      await page.mouse.click(1003, 82);        // Create
      await settle(1200);
      await page.keyboard.press('Escape');
      await settle(800);
    }
    void b;
  },
  unpause: async (page, secs) => {
    // Space toggles. Pressing it blind measures whichever state the game happened
    // to be in - one run recorded ten seconds of zero change because it had just
    // PAUSED the game and called the result "unpause". Establish the state first,
    // and leave time running afterwards so the next interaction inherits the same
    // world the label claims.
    const running = async () => {
      const a = await page.evaluate(() => (window.__lat ? window.__lat.last : null));
      await settle(900);
      const b = await page.evaluate(() => (window.__lat ? window.__lat.last : null));
      return a !== b;
    };
    if (!(await running())) {
      await page.keyboard.press(' ');
      await settle(1800);
    }
    await settle(secs * 1000);
  },
};

// A number is only worth printing if the input did something to the picture.
// Sampling only the endpoints declares "no change" for anything that returns to
// where it started - zooming in and back out does exactly that. Sample throughout
// and count how many distinct pictures were seen.
async function movesPicture(page, fn) {
  await page.mouse.move(1240, 700);
  await settle(900);
  await page.evaluate(() => { if (window.__lat) { window.__lat.changedAt.length = 0; window.__lat.last = window.__probe(); } });
  const seen = new Set();
  let done = false;
  const watcher = (async () => {
    while (!done) {
      const h = await page.evaluate(() => (window.__lat ? window.__lat.last : null)).catch(() => null);
      if (h !== null) seen.add(h);
      await settle(120);
    }
  })();
  await fn(page, 3);
  done = true;
  await watcher;
  return seen.size > 1;
}

const runId = new Date().toISOString().replace(/[:.]/g, '-');
const dir = `${OUT_ROOT}/${NET_LABEL}-${runId}`;
mkdirSync(dir, { recursive: true });
const stepsPath = `${dir}/steps.ndjson`;
writeFileSync(stepsPath, '');

const step = (o) => appendFileSync(stepsPath, JSON.stringify({ t: Date.now(), ...o }) + '\n');

const results = [];

async function measurePath(pathName, pageUrl) {
  for (const [name, fn] of Object.entries(INTERACTIONS)) {
    if (ONLY && !ONLY.split(',').includes(name)) continue;
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    try {
      await page.addInitScript(PIXEL_PROBE);
      await page.goto(pageUrl, { waitUntil: 'domcontentloaded' });
      await settle(pathName === 'pixel' ? 12000 : 14000);
      await page.mouse.move(1240, 700);
      await settle(1000);

      step({ path: pathName, interaction: name, phase: 'ready' });
      // idle is the control: it deliberately sends no input, so it is the one case
      // where the screen is expected not to move.
      const verified = name === 'idle' ? true : await movesPicture(page, fn);
      step({ path: pathName, interaction: name, phase: 'verified', moved: verified });
      if (!verified) {
        results.push({ path: pathName, interaction: name, verified: false, note: 'input did not change the picture; no metrics recorded' });
        console.log(`${pathName.padEnd(12)} ${name.padEnd(11)} input did not move the picture - skipped`);
        await page.close();
        continue;
      }

      // Idle baseline: the same measurement with no input at all. Payload depends
      // on how much artwork the session already cached, so an interaction's cost is
      // only meaningful next to what the session was paying while doing nothing.
      // Without this, two runs of the same code differ by 10x and neither is wrong.
      // Per-path, receiver-side. Summing both paths' server counters into one
      // baseline and then subtracting it from each path let the pixel path's idle
      // traffic leak into the instruction path's numbers.
      const idleAmount = async () => (pathName === 'pixel'
        ? (await pixelStats()).bytes
        : (await page.evaluate(READ_RECEIVED)).bytes);
      const idleA = await idleAmount();
      const idleT0 = Date.now();
      await settle(3000);
      const idleB = await idleAmount();
      const idleSecs = Math.max(0.1, (Date.now() - idleT0) / 1000);
      const idleBytesPerSec = Math.round((idleB - idleA) / idleSecs);
      step({ path: pathName, interaction: name, phase: 'idle-baseline', idleBytesPerSec });

      const b0 = await page.evaluate(READ_BENCH);
      await page.evaluate(() => { if (window.__lat) { window.__lat.pending.length = 0; window.__lat.samples.length = 0; window.__lat.changedAt.length = 0; } });
      const s0 = await serverStats();
      const recvA = pathName === 'pixel' ? (await pixelStats()).bytes : (await page.evaluate(READ_RECEIVED)).bytes;
      step({ path: pathName, interaction: name, phase: 'start', baseline: { display: b0.display.length, latency: b0.latency.length, server: { frames: s0.frames, wire: s0.wireBytes, tex: s0.textureBytes } } });

      // sample the wire and the page while the interaction runs, so a stall can be
      // attributed later instead of guessed at
      let sampling = true;
      const sampler = (async () => {
        while (sampling) {
          const s = await serverStats().catch(() => null);
          if (s) step({ path: pathName, interaction: name, phase: 'sample', server: { frames: s.frames, wire: s.wireBytes, tex: s.textureBytes, presents: s.presents, raw: s.raw ? { sent: s.raw.sent, bytes: s.raw.bytes } : null } });
          await settle(500);
        }
      })();

      await fn(page, SECONDS);
      sampling = false;
      await sampler;

      const recvB = pathName === 'pixel' ? (await pixelStats()).bytes : (await page.evaluate(READ_RECEIVED)).bytes;
      const b1 = await page.evaluate(READ_BENCH);
      const measured = await page.evaluate(() => (window.__lat ? window.__lat.samples.slice() : []));
      const changedAt = await page.evaluate(() => (window.__lat ? window.__lat.changedAt.slice() : []));
      const lead = await page.evaluate(() => {
        const l = window.__lat;
        if (!l) return null;
        return { minResolution: l.minResolution, nullProbes: l.nullProbes, inputs: l.inputs, unattributable: l.unattributable };
      });
      const s1 = await serverStats();
      const secs = SECONDS;
      const disp = b1.display.slice(b0.display.length);
      const lat = b1.latency.slice(b0.latency.length);
      const wireDelta = s1.wireBytes - s0.wireBytes;
      const texDelta = s1.textureBytes - s0.textureBytes;
      const framesDelta = s1.frames - s0.frames;
      const rawBytesDelta = s1.raw ? s1.raw.bytes - s0.raw.bytes : 0;
      const rawSentDelta = s1.raw ? s1.raw.sent - s0.raw.sent : 0;
      const pictures = pathName === 'pixel' ? rawSentDelta : framesDelta;
      // Headline payload: bytes that actually reached this client.
      const receivedBytes = recvB - recvA;
      const totalBytes = receivedBytes;

      const row = {
        path: pathName,
        interaction: name,
        verified: true,
        seconds: secs,
        payload: {
          totalBytes,
          serverOfferedBytes: pathName === 'pixel' ? rawBytesDelta : wireDelta,
          bytesPerSec: Math.round(totalBytes / secs),
          pictureBytes: pathName === 'pixel' ? totalBytes : texDelta,
          pictureBytesPerSec: Math.round((pathName === 'pixel' ? totalBytes : texDelta) / secs),
          bytesPerPicture: pictures > 0 ? Math.round(totalBytes / pictures) : null,
          idleBytesPerSec,
          aboveIdleBytesPerSec: Math.round(totalBytes / secs) - idleBytesPerSec,
        },
        delivery: {
          picturesFromServer: pictures,
          picturesPerSec: +(pictures / secs).toFixed(1),
          displaySamples: disp.length,
          displayPerSec: +(disp.length / secs).toFixed(1),
        },
        smoothness: summarize(disp),
        screen: summarize(changedAt),
        latency: {
          // The pages' own stamp-based measurement: input stamped, host echoes the
          // stamp on the frame that answers it, paint change attributed. This is the
          // designed mechanism and the one comparable across both transports.
          stamped: latSummary(lat),
          ...latSummary(lat),
          e2e: latSummary(measured),
          samplerMinResolutionMs: lead && Number.isFinite(lead.minResolution) ? +lead.minResolution.toFixed(2) : null,
          inputsObserved: lead ? lead.inputs : null,
          inputsUnattributable: lead ? lead.unattributable : null,
          unreadablePixelFrames: lead ? lead.nullProbes : null,
        },
        health: {
          longTasks: b1.longTasks.length - b0.longTasks.length,
          inputsSent: b1.inputsSent - b0.inputsSent,
          stampedFrames: b1.stampedFrames - b0.stampedFrames,
          paints: b1.paints - b0.paints,
          glRenderer: b1.glRenderer,
        },
      };
      results.push(row);
      step({ path: pathName, interaction: name, phase: 'done', row });
      console.log(
        `${pathName.padEnd(12)} ${name.padEnd(11)} ` +
        `payload ${(row.payload.bytesPerSec / 1024).toFixed(0).padStart(6)} KB/s ` +
        `(${row.payload.bytesPerPicture ?? '-'} B/pic)  ` +
        `pics ${String(row.delivery.picturesPerSec).padStart(5)}/s  ` +
        `latency p50 ${row.latency.e2e.p50 ?? '-'} ms  gap p95 ${row.smoothness.gapP95 ?? '-'} ms  max ${row.smoothness.gapMax ?? '-'} ms`,
      );
    } catch (e) {
      results.push({ path: pathName, interaction: name, error: String(e).slice(0, 300) });
      step({ path: pathName, interaction: name, phase: 'error', error: String(e).slice(0, 300) });
      console.log(`${pathName.padEnd(12)} ${name.padEnd(11)} ERROR ${String(e).slice(0, 120)}`);
    } finally {
      await page.close().catch(() => {});
    }
  }
}

await enterArenaOnce();
await measurePath('instruction', `${CMD_BASE}/df`);
await measurePath('pixel', PIXEL_PAGE);

const summary = { runId, network: NET_LABEL, seconds: SECONDS, glRenderer: results.find((r) => r.health?.glRenderer)?.health?.glRenderer || null, results };
writeFileSync(`${dir}/results.json`, JSON.stringify(summary, null, 2));
console.log(`\nwritten to ${dir}/results.json and ${dir}/steps.ndjson`);
await browser.close();
