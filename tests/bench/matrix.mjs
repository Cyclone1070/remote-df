// What this bench must satisfy. Written down because every one of these has been
// quietly dropped at some point, and a bench that forgets one of them reports a
// number that looks fine and means nothing.
//
//   1. Under five minutes for the whole run. 300s, hard. Over it is a rejection,
//      not a warning.
//   2. One run, both transports. Instruction and pixel measured in the same
//      session against the same game, never stitched together across runs.
//   3. A realistic, imperfect, deterministic simulated network.
//   4. Input covers pan, zoom and elevation, using the game's own keys: pan is
//      a/d and w/s, zoom is ] and [, elevation is > and <. Nothing else pans -
//      the arrow keys are not pan keys in this build, and a check that presses
//      them will conclude the camera is stuck when it is not.
//   5. The game is running, not paused. The arena loads paused; unpause it before
//      measuring, because a paused game changes nothing and every row then
//      describes a frozen picture.
//   6. Every event carries a timestamp, however small, so a gap can be attributed
//      afterwards to the wire, the host or the page's own main thread.
//   7. One structured, machine-readable log per run.
//   8. A gate that cannot fail is not a gate. If an interaction moves nothing, exit
//      loudly rather than printing withheld rows as if they were results.
//   9. The lossy pixel page is never ground truth for picture equality.
//  10. Report the tail, p90/p95/worst, not just the middle. The median hides
//      exactly the stalls a player notices.
//  11. Report payload per frame and in total, so both transports are compared on
//      the same footing.
//  12. Prove that the artwork sent is artwork the frames actually reference.
//  13. Every run starts from a cold game and a cold connection. No visited terrain
//      and no warmed client cache carried over from a previous run, because those
//      are exactly what make two runs of the same code disagree: a camera that has
//      already seen a tile ships no artwork for it, so the second run measures a
//      cheaper path than the first and neither says so.
//
// The log is the report. What this file prints is an OVERVIEW: one line per
// interaction, enough to see the shape and catch a catastrophic regression. It
// cannot answer "where did the stall come from", and it is not meant to. The
// ndjson log contains every step with its own timestamp, which is the only thing
// specific enough to attribute a delay to a link in the chain. Any analysis of a
// bench run must therefore do its arithmetic and filtering on the log, never on
// the overview alone. If a claim cannot be reconstructed from the log, it is not
// a finding.

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
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync, appendFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

const GAME_HOST = process.env.DF_GAME_HOST || 'cyc@192.168.1.111';

// Measurement isolation (plan.md R11).
//
// The pixel path's capture runs on every present: a full 2560x1440 readback, a
// 14.7 MB compare and a 14.7 MB copy. Left on while the instruction path is measured
// it is charged to the instruction path, which is how the two transports came to be
// compared under different conditions. Each pass now switches the other path off.
function setRawCapture(on) {
  const cmd = on
    ? 'podman exec remote-df touch /tmp/df_raw_on'
    : 'podman exec remote-df rm -f /tmp/df_raw_on';
  try {
    execFileSync('ssh', ['-o', 'ConnectTimeout=10', GAME_HOST, cmd], { stdio: 'ignore' });
    return true;
  } catch (e) {
    console.log(`  could not switch the pixel capture ${on ? 'on' : 'off'}: ${String(e).slice(0, 80)}`);
    return false;
  }
}

const CMD_BASE = process.env.DF_BASE || 'http://192.168.1.111:8484';
const PIXEL_PAGE = process.env.DF_RAW_PAGE || 'http://192.168.1.111:8000/';
// Interactions drive themselves now: a fixed few inputs each, so there is no
// window length to configure.

const ONLY = process.env.DF_MATRIX_ONLY || process.env.DF_ONLY || '';
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
    idleBeats: (b.idleBeats || []).map(num).filter((x) => typeof x === 'number'),
    // Each sample is {stamp, sentAt, shownAt, ms}. Reading it with Number(x) gave
    // NaN and the filter dropped every one, which is why the report showed no
    // latency at all for either transport while stamped frames were arriving.
    latency: (b.latency || []).map((x) => {
      if (Array.isArray(x)) return Number(x[1] ?? x[0]);
      if (x && typeof x === 'object') return Number(x.ms);
      return Number(x);
    }).filter((x) => Number.isFinite(x)),
    longTasks: (b.longTasks || []).map((x) => (Array.isArray(x) ? x[1] : x)).filter((x) => Number.isFinite(x)),
    inputsSent: b.inputsSent || 0,
    stampedFrames: b.stampedFrames || b.stampFramesSeen || 0,
    paints: b.paints || 0,
    glRenderer: b.glRenderer || null,
    wireEvents: (b.wire && b.wire.events ? b.wire.events.length : 0),
    // Only the arrival times: the classification asks "did a frame land during this
    // gap", and shipping every event would be tens of thousands of rows per read.
    frameArrivals: ((b.wire && b.wire.events) || [])
      .filter((e) => e[1] === 'frame' || e[1] === 'keyframe')
      .map((e) => e[0]),
    frameToDraw: (b.frameToDraw || []).slice(),
    arrivalToApply: (b.arrivalToApply || []).slice(),
    framesApplied: b.framesApplied || 0,
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
// Nothing is injected to "attribute" an input to a frame any more.
//
// There used to be a probe here that hashed a patch of the canvas, waited for the
// picture to hold still, and then credited the next hash change to the input. It
// was removed because it was wrong in both directions, and the frames proved it:
// on a measured run it marked a frame at 226ms that had changed 0.2% of the screen
// and had not moved the camera at all, while the real pan arrived at 483ms. When
// the scene animated it refused every input and reported nothing instead.
//
// What replaced it needs no attribution. The page records when the picture actually
// changed, and the host now sends an idle beat when it has nothing to say. Those two
// streams answer the question directly:
//
//   beats arriving, no frames   -> the game was alive with nothing to show: IDLE
//   frames arriving, no picture -> the client had updates it did not show: STALL
//   neither arriving            -> the host went quiet: HOST SILENT
const IDLE_BEAT_ONLY = () => {
  // Kept as a name because the page needs no injected code at all now; the beat is
  // recognised by the client itself.
  window.__enableM2P = false;
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
// How long to wait after a pan keypress.
//
// Too short and the game swallows presses: the camera moves once for three keys,
// so a 5x5 sweep silently becomes a 3x3 and the row is shorter than it claims.
// Too long and 32 presses per path do not fit the five minute budget. Verified by
// hand against the running game - each press must produce its own visible change
// before this value is trusted.
const PAN_STEP_MS = 250;

const INTERACTIONS = {
  // A few inputs, not a window.
  //
  // The old drivers held keys for the whole measurement window, which meant a run
  // spent most of its time waiting to accumulate a distribution nobody read. What
  // matters is what happens after a handful of real inputs, so each driver presses
  // a few times and stops. A key is always released before the next press so each
  // input is a distinct event, and the pairs alternate so the camera cannot run out
  // of room and stop for a reason that is not a fault.
  // Every driver steps once each way and ends where it started.
  //
  // Holding a key for a quarter second scrolls many tiles, so a pan that was
  // meant to be one step off centre ended up several off centre and then ran out
  // of map. One press out, one press back: the camera never moves more than a
  // single tile from where it began, so no interaction can fail because the map
  // ended rather than because the transport was slow.
  // Pan a 5x5 area around the centre, then come back to it.
  //
  // Cancelling pairs measured almost nothing: one step out and straight back
  // touches a couple of tiles and leaves the rest of the view cached, so the row
  // described a camera that barely moved. A 5x5 sweep visits every tile within
  // two steps of the centre - twenty-five positions, each one revealing artwork
  // the previous position did not need - and then returns to the centre so the
  // next interaction starts from the same place.
  //
  // The route is a serpentine: get to one corner, walk each row, step down, walk
  // back. That is 32 presses, which is why the spacing between them has to be
  // short enough to fit the budget and long enough that the game does not swallow
  // a press. PAN_STEP_MS is the compromise, verified by hand against the live game
  // rather than assumed: see the note on that constant.
  pan: async (page) => {
    const press = async (k) => {
      await page.keyboard.press(k);
      await settle(PAN_STEP_MS);
    };
    for (const k of ['a', 'a', 'w', 'w']) await press(k);   // to the far corner
    for (let row = 0; row < 5; row++) {
      const across = row % 2 === 0 ? 'd' : 'a';
      for (let i = 0; i < 4; i++) await press(across);
      if (row < 4) await press('s');
    }
    for (const k of ['a', 'a', 'w', 'w']) await press(k);    // back to the centre
  },
  zoom: async (page) => {
    for (const k of [']', '[']) {
      const other = k === ']' ? '[' : ']';
      if (!(await pressUntilChange(page, k, 2))) await pressUntilChange(page, other, 2);
      await settle(250);
    }
  },
  elevation: async (page) => {
    for (const k of ['>', '<']) {
      const other = k === '>' ? '<' : '>';
      if (!(await pressUntilChange(page, k, 2))) await pressUntilChange(page, other, 2);
      await settle(250);
    }
  },
};

// Did the picture change while the input was applied?
//
// This no longer hashes anything. It counts how many times the page actually
// painted a changed picture during the window, which is the same thing the player
// would see, and it is used only as a liveness gate: zero means the interaction
// moved nothing and its numbers are not worth printing.
async function movesPicture(page, fn) {
  await page.mouse.move(1240, 700);
  await settle(900);
  const before = await page.evaluate(() => ((window.__dfBench || {}).display || []).length);
  await fn(page);
  await settle(600);
  const after = await page.evaluate(() => ((window.__dfBench || {}).display || []).length);
  return after > before;
}

// Can the camera move at all right now?
//
// Every blocked round so far ended the same way: a row of zeros that looked like
// a transport result but was really "the game was never in a pannable map". A
// fixed-coordinate arena entry can miss, and the camera can walk off the map
// mid-sweep, so liveness has to be established before each interaction rather
// than assumed once at the start.
//
// The command list is the signal, not the pixels: it is what changes when the
// camera moves, and it does not change on its own while the world animates. An
// ambient animation therefore cannot masquerade as a successful pan.
async function viewMoves(page, key) {
  const sig = () => page.evaluate(() => {
    const c = (window.renderer || {}).commands || [];
    let h = 2166136261;
    for (let i = 0; i < c.length; i++) {
      const x = c[i];
      h = (h ^ ((x.tex_id * 31) + (x.src_x | 0) * 7 + (x.src_y | 0) + (x.dst_x | 0) * 13)) >>> 0;
      h = (h * 16777619) >>> 0;
    }
    return `${c.length}:${h.toString(16)}`;
  });
  const before = await sig();
  await page.keyboard.press(key);
  await settle(600);
  return (await sig()) !== before;
}

// Press until the view changes, or give up.
//
// Zoom and elevation top out: once the view is at its deepest or shallowest level
// the key does nothing, and the interaction then reports "applied its input and the
// picture never changed" for a reason that is not a fault. Trying the opposite
// direction first makes the interaction satisfiable from whatever level it starts
// at, instead of depending on what an earlier interaction left behind.
async function pressUntilChange(page, key, tries) {
  for (let i = 0; i < tries; i++) {
    if (await viewMoves(page, key)) return true;
  }
  return false;
}

// True if the camera answers, after one attempt to resume a paused game.
async function requireMovable(page, where) {
  for (const key of ['w', 's']) {
    if (await viewMoves(page, key)) return true;
  }
  await page.keyboard.press(' ');
  await settle(1500);
  for (const key of ['w', 's']) {
    if (await viewMoves(page, key)) return true;
  }
  console.log(
    `FATAL: the camera will not move before ${where}. ` +
    'The game is not in a pannable map, so nothing measured here would describe a transport.',
  );
  return false;
}

const runId = new Date().toISOString().replace(/[:.]/g, '-');
const dir = `${OUT_ROOT}/${NET_LABEL}-${runId}`;
mkdirSync(dir, { recursive: true });
const stepsPath = `${dir}/steps.ndjson`;
writeFileSync(stepsPath, '');

const step = (o) => appendFileSync(stepsPath, JSON.stringify({ t: Date.now(), ...o }) + '\n');

const results = [];

// Every event, one JSON object per line, stamped where it happened.
//
// Phase averages hide the single slow event that is the cause, so nothing here is
// aggregated: the host's own wire log and the client's own trace are both dumped
// whole and merged onto one timeline. Both sides are put on the epoch clock -
// the client through performance.timeOrigin - so a frame's life can be followed
// from the host sending it to the client painting it, line by line.
const WIRE_KINDS = { 0: 'frame.sent', 1: 'keyframe.sent', 2: 'picture.chunk.sent', 4: 'raw.sent', 5: 'input.received', 6: 'present', 7: 'idle.beat' };

async function dumpEvents(page, pathName) {
  const files = [];
  let host = [];
  try {
    const r = await fetch(`${CMD_BASE}/df-wire`);
    const body = await r.json();
    host = (body.events || []).map(([tw, kind, bytes, queue, extra, stamp]) => ({
      tw,
      run: NET_LABEL,
      path: pathName,
      src: 'host',
      ev: WIRE_KINDS[kind] || `kind.${kind}`,
      bytes,
      queue,
      seq: kind === 5 ? null : extra,
      encodeUs: kind === 6 ? extra : null,
      stamp: stamp || null,
    }));
  } catch (e) {
    host = [{ tw: Date.now(), run: NET_LABEL, path: pathName, src: 'bench', ev: 'log.error', error: 'host wire log unavailable: ' + String(e).slice(0, 120) }];
  }

  let client = [];
  try {
    const raw = await page.evaluate(() => ({
      origin: performance.timeOrigin,
      trace: window.__trace || [],
    }));
    client = raw.trace.map(([t, kind, data]) => {
      const d = (data && typeof data === 'object') ? data : { value: data };
      return { tw: Math.round(raw.origin + t), run: NET_LABEL, path: pathName, src: 'client', ev: kind, t: +t.toFixed(3), ...d };
    });
  } catch (e) {
    client = [{ tw: Date.now(), run: NET_LABEL, path: pathName, src: 'bench', ev: 'log.error', error: 'client trace unavailable: ' + String(e).slice(0, 120) }];
  }

  // Per-path files. Both passes write into the same run directory, and writing one
  // fixed filename meant the second pass silently destroyed the first pass's log -
  // which was the only record of the transport under investigation.
  const all = [...host, ...client].sort((a, b) => a.tw - b.tw);
  for (const [name, rows] of [['host', host], ['client', client]]) {
    writeFileSync(`${dir}/events-${pathName}-${name}.ndjson`, rows.map((r) => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : ''));
    files.push([name, rows.length]);
  }
  writeFileSync(`${dir}/events-${pathName}.ndjson`, all.map((r) => JSON.stringify(r)).join('\n') + (all.length ? '\n' : ''));
  appendFileSync(`${dir}/events.ndjson`, all.map((r) => JSON.stringify(r)).join('\n') + (all.length ? '\n' : ''));
  console.log(`  events: ${all.length} lines (host ${host.length}, client ${client.length}) -> ${dir}/events.ndjson`);
  return files;
}

async function measurePath(pathName, pageUrl) {
  // One connection for every interaction on this transport.
  //
  // A fresh page and a fresh WebRTC handshake before each interaction cost about
  // fourteen seconds each and measured nothing: the connection is not what was
  // under test, and six of them per transport made a run take hours across repeats.
  // The page is opened once and reused, and every interaction is still its own
  // measured window against its own baseline.
  // Only the transport under test is running.
  setRawCapture(pathName === 'pixel');
  await settle(1500);

  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  await page.goto(pageUrl, { waitUntil: 'domcontentloaded' });
  await settle(10000);
  await page.mouse.move(1240, 700);
  await settle(1000);

  // A paused game presents but never changes, so no frames are sent and every
  // interaction reads as "no movement". That is not a slow transport, it is a stopped
  // game - and it silently produced a complete run of withheld rows. The host's frame
  // counter is the honest check: it advances only when the game is really running.
  async function ensureGameRunning() {
    // Three counters, because "no frames were sent" has three different causes and
    // only one of them is a paused game.
    //
    //   frames advancing            -> running
    //   encodeNothing advancing     -> presenting, nothing changing: paused
    //   neither advancing           -> nobody is receiving, so pressing space would
    //                                  pause a running game and make it worse
    // Transport-aware: the pixel path has its own send counter, and the instruction
    // counters do not move while only the pixel transport is running. Checking the
    // wrong one made the pixel pass abort on its own isolation.
    const counts = async () => {
      try {
        const r = await fetch(`${CMD_BASE}/df-stats`);
        const j = await r.json();
        if (pathName === 'pixel') {
          return { frames: (j.raw && j.raw.sent) || 0, nothing: 0, rawOn: !!(j.raw && j.raw.on) };
        }
        return { frames: j.frames || 0, nothing: j.encodeNothing || 0, rawOn: !!(j.raw && j.raw.on) };
      } catch { return { frames: 0, nothing: 0, rawOn: false }; }
    };
    for (let attempt = 0; attempt < 3; attempt++) {
      const a = await counts();
      await page.keyboard.down('d');
      await settle(1200);
      await page.keyboard.up('d');
      await settle(900);
      const b = await counts();
      if (b.frames > a.frames) {
        step({ path: pathName, phase: 'game-running', attempt });
        return true;
      }
      if (b.nothing > a.nothing) {
        console.log(`  game is presenting but nothing changes - paused, resuming (attempt ${attempt + 1})`);
        await page.keyboard.press(' ');
        await settle(1800);
        continue;
      }
      console.log(`  no ${pathName === 'pixel' ? 'pictures' : 'frames'} are being sent (capture ${b.rawOn ? 'on' : 'off'}): this client is not receiving`);
      return false;
    }
    return false;
  }
  if (!(await ensureGameRunning())) {
    console.log(`${pathName.padEnd(12)} ABORT: the game is not producing frames, so nothing here would measure the transport`);
    await page.close().catch(() => {});
    return;
  }

  try {
  for (const [name, fn] of Object.entries(INTERACTIONS)) {
    if (ONLY && !ONLY.split(',').includes(name)) continue;
    if (!(await requireMovable(page, `${pathName}/${name}`))) {
      step({ path: pathName, interaction: name, phase: 'fatal', reason: 'camera will not move' });
      process.exit(4);
    }
    try {
      step({ path: pathName, interaction: name, phase: 'ready' });
      // The interaction is run once, inside the measured window. A separate
      // three-second proving run beforehand doubled the cost to establish something
      // the window itself records: whether the picture changed while the input was
      // applied.

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
      await settle(1200);
      const idleB = await idleAmount();
      const idleSecs = Math.max(0.1, (Date.now() - idleT0) / 1000);
      const idleBytesPerSec = Math.round((idleB - idleA) / idleSecs);
      step({ path: pathName, interaction: name, phase: 'idle-baseline', idleBytesPerSec });

      const b0 = await page.evaluate(READ_BENCH);
      const winT0 = Date.now();
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

      await fn(page);
      sampling = false;
      await sampler;

      const recvB = pathName === 'pixel' ? (await pixelStats()).bytes : (await page.evaluate(READ_RECEIVED)).bytes;
      const b1 = await page.evaluate(READ_BENCH);
      // What happened between two displayed pictures, and what the host was doing
      // meanwhile. No attribution: the beat tells idle apart from a stalled host,
      // and the frames tell a stalled client apart from both.
      const b0Marks = b0.display;
      const disp = b1.display.slice(b0Marks.length);
      const gaps = [];
      for (let i = 1; i < disp.length; i++) {
        const from = disp[i - 1], to = disp[i];
        const beats = b1.idleBeats.filter((t) => t > from && t <= to).length;
        const frames = b1.frameArrivals.filter((t) => t > from && t <= to).length;
        gaps.push({ ms: +(to - from).toFixed(1), beats, frames });
      }
      // Only long gaps are worth classifying. A 30ms gap between pictures contains
      // no frame simply because frames arrive every 33ms - calling that a stall
      // labels normal operation as a fault, which is how a metric stops meaning
      // anything.
      //
      // For a LONG gap the question is what the host was doing:
      //   beats, no frames  -> alive with nothing to show     (idle, not a fault)
      //   frames arriving   -> it had updates the client held (client stall)
      //   neither           -> it stopped speaking            (host silent)
      const LONG_GAP_MS = 250;
      const long = gaps.filter((g) => g.ms > LONG_GAP_MS);
      const idleGaps = long.filter((g) => g.beats > 0 && g.frames === 0);
      const stalls = long.filter((g) => g.frames > 0);
      const silent = long.filter((g) => g.beats === 0 && g.frames === 0);
      const pct = (arr, p) => {
        if (!arr.length) return null;
        const v = [...arr].sort((x, y) => x - y);
        return Math.round(v[Math.min(v.length - 1, Math.floor(v.length * p))]);
      };
      const gapMs = gaps.map((g) => g.ms);

      // When the frames themselves arrived, before the page did anything with them.
      //
      // This is the number that splits the two possible causes of a long display
      // gap: if arrivals are also sparse, the cadence is set upstream of the client;
      // if arrivals are frequent while the picture sits still, the client received
      // them and did not paint, and no amount of transport work will fix that.
      const arrivals = b1.frameArrivals.slice(b0.frameArrivals.length);
      const arrivalGaps = [];
      for (let i = 1; i < arrivals.length; i++) arrivalGaps.push(+(arrivals[i] - arrivals[i - 1]).toFixed(1));

      const s1 = await serverStats();
      const secs = Math.max(0.1, (Date.now() - winT0) / 1000);
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
        screen: { changes: disp.length },
        // Where a frame spends its time inside the client. These two split the
        // client's share of latency: waiting for the artwork a frame needs, and
        // then getting it onto the screen. If the payload falls but this grows,
        // the cost is reconstruction rather than transport.
        clientBudget: {
          arrivalToApplied: latSummary(b1.arrivalToApply || []),
          appliedToScreen: latSummary(b1.frameToDraw || []),
        },
        // What the screen did, with no attribution anywhere.
        //
        // `gapMs` is the interval between two displayed pictures: how long the screen
        // sat still. On its own that cannot be judged, because a still screen is
        // correct when the game has nothing new. The beat answers the rest:
        //
        //   beats only  -> the host was alive with nothing to show   (idle, excluded)
        //   frames      -> the client had updates and did not show them (stall)
        //   neither     -> the host stopped speaking                 (host silent)
        display: {
          gapP50: pct(gapMs, 0.5),
          gapP95: pct(gapMs, 0.95),
          gapP99: pct(gapMs, 0.99),
          worstGap: gapMs.length ? Math.round(Math.max(...gapMs)) : null,
          gaps: gaps.length,
          idleGaps: idleGaps.length,
          idleGapP95: pct(idleGaps.map((g) => g.ms), 0.95),
          stalls: stalls.length,
          stallP95: pct(stalls.map((g) => g.ms), 0.95),
          silentGaps: silent.length,
          silentP95: pct(silent.map((g) => g.ms), 0.95),
          beatsSeen: b1.idleBeats.length - b0.idleBeats.length,
          framesSeen: b1.frameArrivals.length - b0.frameArrivals.length,
        },
        arrival: {
          gapP50: pct(arrivalGaps, 0.5),
          gapP95: pct(arrivalGaps, 0.95),
          count: arrivals.length,
        },
        // Kept for the display of transport-level facts, not for latency.
        transport: {
          framesApplied: b1.framesApplied - b0.framesApplied,
          paints: b1.paints - b0.paints,
        },
        health: {
          longTasks: b1.longTasks.length - b0.longTasks.length,
          inputsSent: b1.inputsSent - b0.inputsSent,
          stampedFrames: b1.stampedFrames - b0.stampedFrames,
          paints: b1.paints - b0.paints,
          glRenderer: b1.glRenderer,
        },
      };
      // Proof of movement comes from the measured window: if the screen never
      // changed while the input was applied, the window did not measure the
      // interaction and its numbers are withheld rather than printed.
      row.verified = name === 'idle' ? true : disp.length > 0;
      if (!row.verified) {
        row.note = 'input did not change the picture during the measured window';
        // Fatal, not an annotation. A run where the input moves nothing has
        // measured nothing, and printing rows with the numbers withheld lets it
        // exit 0 and be mistaken for a passing bench. It did exactly that: six
        // rows, both transports, all withheld, exit 0.
        console.error(
          `\nFATAL: ${pathName}/${name} applied its input and the picture never changed.\n` +
          'The game is not in a playable map, so this run measures nothing. Fix the scenario; do not read these numbers.',
        );
        step({ path: pathName, interaction: name, phase: 'fatal', reason: 'no movement' });
        process.exit(3);
      }
      results.push(row);
      step({ path: pathName, interaction: name, phase: 'done', row });
      console.log(
        `${pathName.padEnd(12)} ${name.padEnd(11)} ` +
        `payload ${(row.payload.bytesPerSec / 1024).toFixed(0).padStart(6)} KB/s ` +
        `(${row.payload.bytesPerPicture ?? '-'} B/pic)  ` +
        `pics ${String(row.delivery.picturesPerSec).padStart(5)}/s  ` +
        `gap p50 ${row.display.gapP50 ?? '-'} p95 ${row.display.gapP95 ?? '-'} worst ${row.display.worstGap ?? '-'} ms  ` +
        `arrive p50 ${row.arrival.gapP50 ?? '-'} p95 ${row.arrival.gapP95 ?? '-'} (${row.arrival.count})  ` +
        `stalls ${row.display.stalls}  idle ${row.display.idleGaps}  silent ${row.display.silentGaps}` +
        (row.verified ? '' : '  [NO MOVEMENT - withheld]'),
      );
    } catch (e) {
      results.push({ path: pathName, interaction: name, error: String(e).slice(0, 300) });
      step({ path: pathName, interaction: name, phase: 'error', error: String(e).slice(0, 300) });
      console.log(`${pathName.padEnd(12)} ${name.padEnd(11)} ERROR ${String(e).slice(0, 120)}`);
    }
  }
  } finally {
    // Dumped before the page goes away: this is the only moment both sides still
    // hold their logs.
    await dumpEvents(page, pathName).catch((e) => console.log(`  events: dump failed ${String(e).slice(0, 100)}`));
    await page.close().catch(() => {});
  }
}

// Entering the arena costs ninety seconds and is only needed once per session.
// Repeats and the second network pass used to pay it again every time.
async function gameIsLive() {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  try {
    await page.goto(`${CMD_BASE}/df`, { waitUntil: 'domcontentloaded' });
    await settle(12000);
    const before = await page.evaluate(() => ((window.__dfBench || {}).display || []).length);
    await page.keyboard.down('d');
    await settle(800);
    await page.keyboard.up('d');
    await settle(1200);
    const after = await page.evaluate(() => ((window.__dfBench || {}).display || []).length);
    return after > before;
  } finally {
    await page.close().catch(() => {});
  }
}

// Cold start, every run.
//
// A warmed game is a different measurement: terrain already visited ships no
// artwork, and the client already holds pictures it would otherwise have to wait
// for. Restarting costs time out of the five minute budget, which is the price of
// the numbers meaning the same thing twice.
{
  const target = CMD_BASE.replace(/^https?:\/\//, '');
  console.log('restarting the game so this run starts with no cache');
  try {
    execFileSync('bash', ['scripts/df_restart.sh', target], { stdio: 'ignore' });
    await new Promise((r) => setTimeout(r, 6000));
  } catch (e) {
    console.log(`  could not restart the game: ${String(e).slice(0, 80)}`);
  }
}

if (await gameIsLive()) {
  console.log('game is already in the arena - skipping the 90s entry');
} else {
  await enterArenaOnce();
}

// The first input after the arena loads is Space: the arena comes up paused.
// A paused game changes nothing, so every row measured after it is a measurement
// of a frozen picture - which is how this suite reported "the picture never
// changed" for a client that was working correctly all along.
{
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  await page.goto(`${CMD_BASE}/df`, { waitUntil: 'domcontentloaded' });
  await new Promise((r) => setTimeout(r, 15000));
  const activity = async () => {
    try {
      const j = await (await fetch(`${CMD_BASE}/df-stats`)).json();
      return (j.frames || 0) + ((j.raw && j.raw.changed) || 0);
    } catch { return 0; }
  };
  for (let attempt = 0; attempt < 3; attempt++) {
    const before = await activity();
    await new Promise((r) => setTimeout(r, 2500));
    const after = await activity();
    if (after > before) {
      console.log(`game is running (${after - before} changes in 2.5s)`);
      break;
    }
    console.log(`game is paused - pressing space to resume (attempt ${attempt + 1})`);
    await page.keyboard.press(' ');
  }
  await page.close().catch(() => {});
}
const PATHS = (process.env.DF_PATHS || 'instruction,pixel').split(',');
if (PATHS.includes('instruction')) await measurePath('instruction', `${CMD_BASE}/df`);
if (PATHS.includes('pixel')) await measurePath('pixel', PIXEL_PAGE);

const overview = { runId, network: NET_LABEL, glRenderer: results.find((r) => r.health?.glRenderer)?.health?.glRenderer || null, results };
writeFileSync(`${dir}/results.json`, JSON.stringify(overview, null, 2));
console.log(`\nOVERVIEW above. The report is the log: ${dir}/steps.ndjson`);
console.log(`Do arithmetic and filtering on the log, not on these lines.`);
await browser.close();
