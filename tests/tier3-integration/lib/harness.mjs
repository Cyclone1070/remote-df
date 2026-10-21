// Shared harness for the tier 3 integration suites.
//
// This is the only place that knows how to talk to a running stack. A suite
// describes what a user should see; it does not open sockets, restart sessions
// or scrape logs itself. That split is the point: when the stack changes, one
// file changes, and a suite that was written a year ago still means the same
// thing.
//
// Every assertion carries the claim it is checking, and every failure carries
// the measurements that settled it, so a red suite is a diagnosis rather than a
// starting point for one.

import { chromium } from 'playwright';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';

export const HOST = process.env.DF_HOST_ADDR || '192.168.1.111';
export const SSH = process.env.DF_SSH || `cyc@${HOST}`;
export const CONTAINER = process.env.DF_CONTAINER || 'remote-df';
export const BASE = process.env.DF_QA_URL || `http://${HOST}:8484`;
export const DEADLINE_MS = Number(process.env.DF_QA_DEADLINE_MS || 45000);

// ── server ──────────────────────────────────────────────────────────────────

export const sh = (args, timeout = 30000) => {
  try {
    return execFileSync(args[0], args.slice(1), { encoding: 'utf8', timeout });
  } catch (e) {
    return `<<command failed: ${e.message}>>`;
  }
};

export async function session() {
  try {
    const r = await fetch(`${BASE}/api/session`, { signal: AbortSignal.timeout(8000) });
    return await r.json();
  } catch {
    return { error: 'unreachable' };
  }
}

export async function stats() {
  try {
    const r = await fetch(`${BASE}/df-stats`, { signal: AbortSignal.timeout(8000) });
    const d = await r.json();
    return {
      frames: d.frames,
      textures: d.textureNew,
      clients: d.clients,
      wireBytes: d.wireBytes,
      // The size the game is drawing at. The page draws in the game's own
      // coordinates, so this is what decides whether the picture fills the
      // window or covers only part of it.
      window: d.window || {},
      dc: d.dc || {},
    };
  } catch {
    return { error: 'unreachable' };
  }
}

export const serverLog = (lines = 3000) =>
  sh(['ssh', '-o', 'ConnectTimeout=8', SSH, `podman logs --tail ${lines} ${CONTAINER} 2>&1`]).split('\n');

export const gamePid = () => sh(['ssh', '-o', 'ConnectTimeout=8', SSH, `podman exec ${CONTAINER} pidof dwarfort`]).trim();

/** Start a clean session. Returns once the server reports it running. */
export async function restartSession({ timeoutMs = 90000 } = {}) {
  sh(['sh', 'scripts/df_restart.sh', `${HOST}:8484`], 120000);
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const s = await session();
    if (s.state === 'running') return s;
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`session did not come up within ${timeoutMs}ms`);
}

// Records what the user is looking at, from before the app starts.
//
// The interesting moment is the one between the loading indicator going away and
// the picture appearing. Sampling after `goto` has returned misses it entirely,
// so this runs on a timer from the first parse: each entry is
// [ms since start, is the indicator up, is there anything on the canvas].
const LOAD_TRACE = `(() => {
  const trace = window.__loadTrace = [];
  const t0 = performance.now();
  const tick = () => {
    const overlay = !!document.querySelector('[data-df-overlay]');
    const c = document.querySelector('canvas');
    let lit = -1;
    if (c && c.width > 0) {
      const t = document.createElement('canvas');
      t.width = 40; t.height = 25;
      const g = t.getContext('2d', { willReadFrequently: true });
      g.drawImage(c, 0, 0, 40, 25);
      const d = g.getImageData(0, 0, 40, 25).data;
      let n = 0;
      for (let i = 0; i < d.length; i += 4) if (d[i] + d[i+1] + d[i+2] > 24) n++;
      lit = n / (40 * 25);
    }
    trace.push([Math.round(performance.now() - t0), overlay ? 1 : 0, lit]);
  };
  setInterval(tick, 50);

  // What the user sees is a draw, not a frame arrival: frames that arrive while
  // the previous one is still missing textures are not shown. Polled rather than
  // hooked so it measures the client's own counter rather than a copy of it.
  let lastDrawn = -1;
  setInterval(() => {
    const n = window.__dfFrameCount || 0;
    if (n !== lastDrawn) { lastDrawn = n; window.__wire.drawTimes.push(performance.now()); }
  }, 10);
})();`;

// ── browser ─────────────────────────────────────────────────────────────────

let browserPromise = null;
export function browser() {
  if (!browserPromise) {
    browserPromise = chromium.launch({
      headless: true,
      args: [
        // Without these, headless Chromium will not drive requestAnimationFrame
        // at a display rate: a bare loop was measured at a 263ms median here,
        // which is slower than the thing being measured. Every number taken
        // through such a browser describes the browser, not the stream, and the
        // mistake is invisible because the numbers still look like numbers.
        '--disable-frame-rate-limit',
        '--disable-gpu-vsync',
        '--run-all-compositor-stages-before-draw',
        '--disable-new-content-rendering-timeout',
        '--disable-background-timer-throttling',
        '--disable-renderer-backgrounding',
        '--disable-backgrounding-occluded-windows',
        '--disable-features=CalculateNativeWinOcclusion',
      ],
    });
  }
  return browserPromise;
}

/**
 * Measures how fast this browser can call requestAnimationFrame with no app work.
 *
 * Every performance claim in this suite is only meaningful relative to this
 * number. If the floor is already slow, a slow result says nothing about the
 * code, and reporting it as a defect sends the next investigation somewhere else
 * entirely - which is exactly what happened here.
 */
export async function loopBaseline(page) {
  const t = await page.evaluate(() => new Promise((res) => {
    const times = [];
    const f = () => {
      times.push(performance.now());
      if (times.length < 61) requestAnimationFrame(f); else res(times);
    };
    requestAnimationFrame(f);
  }));
  const gaps = t.slice(1).map((v, i) => v - t[i]);
  const sorted = [...gaps].sort((a, b) => a - b);
  const at = (p) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
  return { p50: Math.round(at(0.5)), p95: Math.round(at(0.95)), max: Math.round(sorted[sorted.length - 1]) };
}

/** The slowest floor this suite is willing to draw conclusions from. */
export const MAX_BASELINE_P50_MS = 30;
export async function closeBrowser() {
  if (browserPromise) await (await browserPromise).close();
  browserPromise = null;
}

// Counts what arrives on the data channel, decoded in the page before any page
// script runs. Without this the suite can only see what the client chose to
// report; with it a suite can tell "the server never sent it" from "the client
// never kept it", which are different bugs with the same symptom.
const WIRE_HOOK = `(() => {
  const T = { frames: 0, lastSeq: null, pictures: {}, frameTimes: [], drawTimes: [], picTimes: [] };
  window.__wire = T;
  const note = (buf) => {
    if (!(buf instanceof ArrayBuffer) || buf.byteLength < 4) return;
    const v = new DataView(buf);
    const m0 = v.getUint8(0), m1 = v.getUint8(1);
    if (m0 === 0x44 && m1 === 0x46) { T.frames++; T.lastSeq = v.getUint32(2, true); T.frameTimes.push(performance.now()); return; }
    if (m0 === 0x44 && (m1 === 0x54 || m1 === 0x5a)) {
      const id = v.getUint16(2, true), n = Math.max(1, v.getUint16(14, true));
      const e = T.pictures[id] || (T.pictures[id] = { n, seen: {} });
      e.seen[v.getUint16(12, true)] = 1;
      T.picTimes.push(performance.now());
    }
  };
  const D = RTCDataChannel.prototype;
  const desc = Object.getOwnPropertyDescriptor(D, 'onmessage');
  if (desc && desc.set) {
    Object.defineProperty(D, 'onmessage', {
      configurable: true,
      get() { return this.__w; },
      set(fn) {
        const w = function (ev) { try { note(ev.data); } catch (_) {} return fn.call(this, ev); };
        this.__w = w; desc.set.call(this, w);
      },
    });
  }
})();`;

/** A connected page, with the observables a suite needs. */
export async function connect({ url = `${BASE}/df`, viewport = { width: 1280, height: 800 } } = {}) {
  const b = await browser();
  const page = await b.newPage({ viewport });
  await page.addInitScript(WIRE_HOOK);
  await page.addInitScript(LOAD_TRACE);
  const console_ = [];
  page.on('console', (m) => console_.push(`${m.type()}: ${m.text()}`));
  page.on('pageerror', (e) => console_.push(`pageerror: ${String(e)}`));
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });

  const handle = {
    page,
    console_,
    /** Fraction of the canvas that is not near-black. 0 means the user sees black. */
    async lit() {
      return page.evaluate(() => {
        const c = document.querySelector('canvas');
        if (!c) return -1;
        const t = document.createElement('canvas');
        t.width = 80; t.height = 50;
        const g = t.getContext('2d');
        g.drawImage(c, 0, 0, 80, 50);
        const d = g.getImageData(0, 0, 80, 50).data;
        let n = 0;
        for (let i = 0; i < d.length; i += 4) if (d[i] + d[i + 1] + d[i + 2] > 24) n++;
        return n / (80 * 50);
      });
    },
    /** What the client says it still needs, and what arrived on the wire. */
    async state() {
      return page.evaluate(() => {
        const T = window.__wire || { frames: 0, lastSeq: null, pictures: {} };
        const incomplete = {};
        for (const [id, e] of Object.entries(T.pictures)) {
          const held = Object.keys(e.seen).length;
          if (held < e.n) {
            // Name the chunks that did NOT arrive. "36/37" says a chunk is
            // missing; it does not say which one, and the difference decides
            // whether the fault is the sender, the transport or the receiver.
            const gap = [];
            for (let i = 0; i < e.n; i++) if (!e.seen[i]) gap.push(i);
            incomplete[id] = `${held}/${e.n} missing chunks [${gap.join(',')}]`;
          }
        }
        return {
          frames: window.__dfFrameCount || 0,
          missing: window.__dfAssetsMissing,
          unfetchable: window.__dfAssetsUnfetchable,
          wireFrames: T.frames,
          wireLastSeq: T.lastSeq,
          incompletePictures: incomplete,
        };
      });
    },
    /** Wait until the canvas is lit, returning the measurements either way. */
    async waitForPicture({ deadlineMs = DEADLINE_MS, pollMs = 500 } = {}) {
      const t0 = Date.now();
      let lit = 0;
      let st = null;
      while (Date.now() - t0 < deadlineMs) {
        lit = await handle.lit();
        st = await handle.state();
        if (lit > 0.05) return { ok: true, lit, state: st, ms: Date.now() - t0 };
        await page.waitForTimeout(pollMs);
      }
      return { ok: false, lit, state: st, ms: Date.now() - t0 };
    },
    /** Arrival times of frames, and of draws, for measuring freezes. */
    async timings() {
      return page.evaluate(() => ({
        frameTimes: (window.__wire || {}).frameTimes || [],
        picTimes: (window.__wire || {}).picTimes || [],
        drawTimes: (window.__wire || {}).drawTimes || [],
      }));
    },
    /** [ms, indicatorUp, litFraction] samples taken since before the app started. */
    async loadTrace() { return page.evaluate(() => window.__loadTrace || []); },
    async shot(path) { await page.screenshot({ path }); },
    async close() { await page.close(); },
  };
  return handle;
}

// ── assertions ──────────────────────────────────────────────────────────────

export class SuiteFailure extends Error {}

/**
 * Assert a claim. On failure the message carries the evidence, because a bare
 * "expected true" turns a finished diagnosis back into an open question.
 */
export function that(claim, condition, evidence = {}) {
  // DF_EVIDENCE=1 prints the numbers for passing checks too. A bench that only
  // shows its figures when it fails cannot be used to tell whether it is measuring
  // anything at all, which is exactly how it reported smoothness on a still image.
  if (condition) {
    if (process.env.DF_EVIDENCE) {
      const flat = Object.entries(evidence)
        .map(([k, v]) => `${k}=${typeof v === 'object' ? JSON.stringify(v) : v}`)
        .join(' ');
      console.log(`      ok   ${claim}${flat ? `  { ${flat} }` : ''}`);
    }
    return;
  }
  const detail = Object.entries(evidence)
    .map(([k, v]) => `      ${k}: ${typeof v === 'object' ? JSON.stringify(v) : v}`)
    .join('\n');
  throw new SuiteFailure(claim + (detail ? `\n${detail}` : ''));
}

/**
 * Puts the game into the classic object testing arena.
 *
 * Needed by any test about movement: the arena is the only view here with a large
 * scrolling map, and the main menu has nothing to move around.
 */
export async function enterArena(page) {
  const box = page.viewportSize();
  await page.mouse.click(box.width * 0.5, box.height * (479 / 800));      // Object testing arena
  await page.waitForTimeout(4000);
  await page.mouse.click(box.width * (180 / 1280), box.height * (144 / 800)); // Classic Arena
  await page.waitForTimeout(1500);
  await page.mouse.click(box.width * (1000 / 1280), box.height * (755 / 800)); // Create arena
  await page.waitForTimeout(60000);                                        // loading
  await page.mouse.move(1240, 700);
  return box;
}

/**
 * Holds a camera direction and returns nothing. WASD moves the camera; a mouse
 * drag does not, however much the tile tooltip under the pointer moves.
 *
 * Verified against the v53.16 controls: "wasd ... to move the camera around on the
 * same elevation", with shift doubling the distance.
 */
export async function holdPanKey(page, key, ms) {
  await page.keyboard.down(key);
  await page.waitForTimeout(ms);
  await page.keyboard.up(key);
}

/**
 * Proves the camera can actually move before anything is measured.
 *
 * A smoothness test that drives an input which does not move the camera measures a
 * still picture: every gap is short, every threshold passes, and the test reports
 * success while the thing it exists to catch is never exercised. Screenshots are
 * compared with the pointer parked in the same corner each time, because hovering
 * a tile changes the tooltip and a tooltip is not a camera move.
 */
export async function cameraCanMove(page) {
  await page.mouse.move(1240, 700);
  await page.waitForTimeout(1200);
  const before = createHash('sha256').update(await page.screenshot()).digest('hex');
  await holdPanKey(page, 'a', 900);
  await page.mouse.move(1240, 700);
  await page.waitForTimeout(1500);
  const after = createHash('sha256').update(await page.screenshot()).digest('hex');
  return before !== after;
}
