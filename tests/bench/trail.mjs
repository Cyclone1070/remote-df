// One run, every timestamped event from both ends, written to disk.
//
// The question this exists for: the instruction path ships a fraction of the bytes
// the pixel path does and has higher latency anyway. A payload number cannot say
// where the time goes, and neither can a percentile. Only the order of events can.
//
// What is captured:
//   host   /df-wire  - every message handed to a link (frame, keyframe, artwork,
//                      input arriving, and each present with its encode cost),
//                      plus one record per answered stamp with the host's share.
//   client window.__trace      - the page's own event stream with timestamps
//          bench.wire.events   - every message received, with size and kind
//          bench.inputSent     - every input sent, with its stamp
//          bench.frameToDraw   - applied -> pixels changed
//          bench.arrivalToApply- frame arrived -> frame applied
//
// The two clocks are different machines. They are aligned afterwards from the
// inputs, which carry a stamp on both sides: the tightest client-send to
// host-arrival gap is the best estimate of the offset. That is stated here because
// an aligned timeline that does not say how it was aligned is not evidence.
import { chromium } from 'playwright';
import { mkdirSync, writeFileSync } from 'node:fs';

const BASE = process.env.DF_BASE || 'http://192.168.1.111:8484';
const PAN_KEY = process.env.DF_PAN_KEY || 'a';
const PAN_MS = Number(process.env.DF_PAN_MS || 8000);
const settle = (ms) => new Promise((r) => setTimeout(r, ms));

// The starvation flags are opt-out, not mandatory.
//
// --disable-frame-rate-limit makes the page's render loop spin flat out, which is
// how a still screen gets a clean sample. It also starves the message queue, and a
// delay measured with it on may be a delay the bench itself created. Both settings
// are measured and compared rather than one being assumed correct.
const PLAIN = process.env.DF_PLAIN_BROWSER === '1';
const args = PLAIN
  ? ['--disable-background-timer-throttling', '--disable-renderer-backgrounding']
  : ['--disable-frame-rate-limit', '--disable-gpu-vsync', '--run-all-compositor-stages-before-draw',
     '--disable-background-timer-throttling', '--disable-renderer-backgrounding',
     '--disable-backgrounding-occluded-windows'];
console.log(`browser mode: ${PLAIN ? 'plain (no starvation flags)' : 'unthrottled rAF'}`);
const browser = await chromium.launch({ headless: true, args });
// Into the arena only if the game is not already there.
//
// Clicking the menu path blind is destructive once the arena is loaded: the clicks
// land on the arena itself and change its state. This run was first written that
// way and the client ended up silent, which the freshness check below then refused
// to measure - the refusal was right, the setup was wrong.
async function isLive(page) {
  const before = await page.evaluate(() => ((window.__dfBench?.wire?.events) || []).length);
  await settle(3000);
  const after = await page.evaluate(() => ((window.__dfBench?.wire?.events) || []).length);
  return after > before;
}

{
  const probe = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  await probe.addInitScript(() => { window.__enableM2P = true; });
  await probe.goto(`${BASE}/df`, { waitUntil: 'domcontentloaded' });
  await settle(14000);
  const live = await isLive(probe);
  await probe.close();

  if (!live) {
    const setup = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    await setup.goto(`${BASE}/df`, { waitUntil: 'domcontentloaded' });
    await settle(22000);
    const vp = setup.viewportSize();
    await setup.mouse.click(vp.width * 0.5, vp.height * (479 / 800));
    await settle(4000);
    await setup.mouse.click(vp.width * (180 / 1280), vp.height * (144 / 800));
    await settle(1500);
    await setup.mouse.click(vp.width * (1000 / 1280), vp.height * (755 / 800));
    await settle(60000);
    await setup.close();
    console.log('entered the arena');
  } else {
    console.log('game already in the arena - not touching the menus');
  }
}

const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
await page.addInitScript(() => { window.__enableM2P = true; });
await page.goto(`${BASE}/df`, { waitUntil: 'domcontentloaded' });
await settle(20000);
await page.mouse.move(1240, 700);
await settle(3000);

// Refuse to measure a client that cannot see the game.
//
// Freshness was the first rule and it was wrong: an arena where nothing is
// happening is static, and a static screen sends nothing, so "no recent messages"
// described a healthy quiet game as a dead one. The question is not whether
// messages are flowing but whether an input changes the picture - the same gate
// the rest of the bench uses.
{
  const before = await page.evaluate(() => {
    const b = window.__dfBench || {};
    return { seq: window.__dfSequencer ? window.__dfSequencer.lastSeq : 0,
             display: (b.display || []).length };
  });
  // A fresh page is not necessarily the focused one: the previous run's page was
  // closed and key events can land nowhere. Click first, then press.
  await page.mouse.click(640, 400);
  await settle(1200);
  await page.keyboard.down('a');
  await settle(900);
  await page.keyboard.up('a');
  await settle(2500);
  const after = await page.evaluate(() => {
    const b = window.__dfBench || {};
    return { seq: window.__dfSequencer ? window.__dfSequencer.lastSeq : 0,
             display: (b.display || []).length };
  });
  const moved = after.display > before.display || after.seq > before.seq;
  if (!moved) {
    console.error(`client shows no response to input (display ${before.display}->${after.display}, seq ${before.seq}->${after.seq}) - refusing to measure`);
    await browser.close();
    process.exit(3);
  }
  console.log(`gate: input moved the picture (display ${before.display}->${after.display})`);
}

const transportBefore = await page.evaluate(() => (window.__dfBench && window.__dfBench.transport ? window.__dfBench.transport() : null));
await page.evaluate(() => { if (window.__trace) window.__trace.length = 0; });

// Taps, not a hold. Holding a key produced three inputs in eight seconds, which
// is too few to say anything about a distribution; each tap produces a press and a
// release, so the same window yields dozens.
const startedAt = Date.now();
const taps = Number(process.env.DF_TAPS || 25);
const keys = ['a', 'd'];
for (let i = 0; i < taps; i++) {
  await page.keyboard.down(keys[i % 2]);
  await settle(120);
  await page.keyboard.up(keys[i % 2]);
  await settle(180);
}
await settle(1200);

const transportAfter = await page.evaluate(() => (window.__dfBench && window.__dfBench.transport ? window.__dfBench.transport() : null));

const client = await page.evaluate(() => {
  const b = window.__dfBench || {};
  const sent = b.inputSent || {};
  return {
    performanceNow: performance.now(),
    dateNow: Date.now(),
    trace: (window.__trace || []).slice(),
    wireEvents: (b.wire && b.wire.events ? b.wire.events : []).slice(),
    inputs: (sent.entries ? sent.entries.slice() : []),
    frameToDraw: (b.frameToDraw || []).slice(),
    arrivalToApply: (b.arrivalToApply || []).slice(),
    display: (b.display || []).slice(),
    paints: b.paints || 0,
    framesApplied: b.framesApplied || 0,
    glRenderer: b.glRenderer || null,
  };
});

// Clock anchor: bracketed on both sides by a cheap request, so the offset carries
// a measured uncertainty rather than an assumed one. The first attempt anchored on
// the big wire-log fetch, which took three seconds, and the resulting "wire time"
// was nothing but that error.
const anchorA = (await (await fetch(`${BASE}/df-stats`)).json()).now ?? Date.now();
const clientAnchor = await page.evaluate(() => performance.now());
const anchorB = (await (await fetch(`${BASE}/df-stats`)).json()).now ?? Date.now();

const host = await (await fetch(`${BASE}/df-wire`)).json();

const dir = `evidence/bench/latency-trail/${new Date().toISOString().replace(/[:.]/g, '-')}`;
mkdirSync(dir, { recursive: true });
writeFileSync(`${dir}/client.json`, JSON.stringify(client));
writeFileSync(`${dir}/host.json`, JSON.stringify(host));
writeFileSync(`${dir}/transport.json`, JSON.stringify({ before: transportBefore, after: transportAfter }, null, 2));
writeFileSync(`${dir}/meta.json`, JSON.stringify({
  startedAt, taps, PAN_MS, base: BASE,
  anchor: { a: anchorA, b: anchorB, clientPerf: clientAnchor, uncertaintyMs: (anchorB - anchorA) / 2, hostAt: (anchorA + anchorB) / 2 },
}, null, 2));

console.log(`wrote ${dir}`);
console.log(`client: trace ${client.trace.length}, wire ${client.wireEvents.length}, inputs ${client.inputs.length}, ftd ${client.frameToDraw.length}`);
console.log(`host:   events ${host.events.length}`);
console.log(`anchor: uncertainty ${((anchorB - anchorA) / 2).toFixed(1)}ms`);
if (transportBefore && transportAfter) {
  const b = transportBefore.channel, a = transportAfter.channel;
  for (const k of Object.keys(a)) {
    const pb = b[k] || { messages: 0, bytes: 0 };
    console.log(`transport[${k}]: messages ${a[k].messages - pb.messages}, bytes ${a[k].bytes - pb.bytes}`);
  }
  console.log(`transport pair: ${JSON.stringify(transportAfter.pair)}`);
}

await browser.close();
