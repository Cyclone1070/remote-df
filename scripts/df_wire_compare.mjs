/**
 * df_wire_compare.mjs — how many bytes each strategy actually puts on the link,
 * measured on the same gameplay.
 *
 * The hard part of comparing these two designs is fairness. Running them one
 * after the other compares two different game states, and any difference in
 * what is on screen shows up as a difference in bytes. So instead this leans on
 * the fact that there is only one Dwarf Fortress: the smart client drives the
 * input, and a plain whole-picture viewer watches the very same game at the very
 * same time. Both are then measuring identical content, and the only variable
 * left is the delivery strategy.
 *
 * Both totals are counted where the bytes are received by a client, so neither
 * side is estimated from the other:
 *   smart — every data-channel message the page receives
 *   raw   — every byte of the multipart frame stream the viewer receives
 *
 * Usage: node scripts/df_wire_compare.mjs [outdir]
 */
import { chromium } from 'playwright';
import { mkdirSync, writeFileSync } from 'fs';

// An env var, not argv[2]: argv[2] is the smart URL, so reading the output dir
// from there made the script create a directory literally named after the URL.
const OUT = process.env.OUT || '/tmp/wirecmp';
const SMART = process.env.SMART_URL || 'http://192.168.1.111:8484/df';
const RAW = process.env.RAW_URL || 'http://192.168.1.111:8000';
const SAMPLE_MS = Number(process.env.SAMPLE_MS || 250);

mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({
  headless: true,
  args: ['--no-sandbox', '--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'],
});

// ---------------------------------------------------------------- raw viewer
// Counts the frame stream in the page's own process. A second viewer costs the
// server a second write but changes nothing about what the smart client gets.
const rawPage = await browser.newPage();
await rawPage.goto(RAW + '/', { waitUntil: 'domcontentloaded', timeout: 30000 });
const rawBytes = await rawPage.evaluate(() => {
  window.__raw = { bytes: 0, frames: 0, samples: [] };
  (async () => {
    const res = await fetch('/raw.mjpg');
    const reader = res.body.getReader();
    const decoder = new TextDecoder('latin1');
    let carry = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      window.__raw.bytes += value.length;
      // Count frames from the boundary markers rather than guessing from size.
      carry += decoder.decode(value, { stream: true });
      const marks = carry.split('--dfrawframe').length - 1;
      window.__raw.frames += marks;
      carry = carry.slice(-32);
    }
  })().catch(() => {});
  return true;
});
void rawBytes;

// ------------------------------------------------------------------- smart
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
// Counted before any page script runs, by wrapping the onmessage property the
// client assigns to. Summing here is the only place both message shapes
// (framed commands and pictures) are seen together.
await page.addInitScript(() => {
  window.__wire = { bytes: 0, messages: 0 };
  const desc = Object.getOwnPropertyDescriptor(RTCDataChannel.prototype, 'onmessage');
  if (!desc || !desc.set) return;
  Object.defineProperty(RTCDataChannel.prototype, 'onmessage', {
    configurable: true,
    get() { return desc.get.call(this); },
    set(fn) {
      const wrapped = function (ev) {
        try {
          const d = ev.data;
          if (d instanceof ArrayBuffer) window.__wire.bytes += d.byteLength;
          else if (ArrayBuffer.isView(d)) window.__wire.bytes += d.byteLength;
          else if (d instanceof Blob) window.__wire.bytes += d.size;
          window.__wire.messages++;
        } catch { /* counting must never break the stream */ }
        return fn.call(this, ev);
      };
      desc.set.call(this, wrapped);
    },
  });
});

await page.goto(SMART, { waitUntil: 'domcontentloaded', timeout: 30000 });
await page.waitForTimeout(18000);
const box = await page.locator('canvas').first().boundingBox();
const cx = box.x + box.width / 2;
const cy = box.y + box.height / 2;
const click = async (ix, iy, settle) => {
  await page.mouse.move(box.x + box.width * (ix / 1280), box.y + box.height * (iy / 720));
  await page.waitForTimeout(600);
  await page.mouse.down(); await page.waitForTimeout(120); await page.mouse.up();
  await page.waitForTimeout(settle);
};

// ------------------------------------------------------------------ scenario
// A real session in the object testing arena: get into a map, then do the things
// a player does. Keys are the ones the arena actually answers to; anything the
// game ignores simply contributes nothing, which is the honest outcome.
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const phases = [];
const phase = (name, fn, ms) => phases.push({ name, fn, ms });

phase('nav to arena', async () => { await click(640, 437, 4000); }, 5000);
// Classic Arena, not the default: see the note in df_m2p.mjs.
phase('select classic', async () => { await click(178, 140, 2000); }, 3000);
phase('create arena', async () => { await click(991, 678, 16000); }, 17000);
phase('pan', async () => {
  for (let i = 0; i < 200; i++) { await page.keyboard.press(i % 2 ? 'ArrowRight' : 'ArrowDown'); await sleep(25); }
}, 6000);
phase('zoom', async () => {
  for (let i = 0; i < 120; i++) { await page.mouse.wheel(0, i % 20 < 10 ? -120 : 120); await sleep(40); }
}, 6000);
phase('elevation', async () => {
  for (let i = 0; i < 120; i++) { await page.keyboard.press(i % 2 ? 'Period' : 'Comma'); await sleep(40); }
}, 6000);
phase('spawn creatures', async () => {
  for (let i = 0; i < 30; i++) { await page.keyboard.press('c'); await sleep(200); }
}, 7000);
phase('menus', async () => {
  for (const k of ['z', 'Escape', 'b', 'Escape', 'v', 'Escape', 'c', 'Escape']) {
    await page.keyboard.press(k); await sleep(700);
  }
}, 6000);
phase('mixed pan+zoom', async () => {
  for (let i = 0; i < 150; i++) {
    await page.keyboard.press('ArrowRight');
    if (i % 10 === 0) await page.mouse.wheel(0, i % 20 < 10 ? -120 : 120);
    await sleep(30);
  }
}, 6000);

// ------------------------------------------------------------------- measure
// Samples are tagged with the phase they landed in so the percentiles can be
// reported per action: an average over a whole session hides that panning and
// sitting in a menu cost wildly different amounts.
const samples = [];
let t0 = 0;
let currentPhase = 'startup';
const sampler = setInterval(async () => {
  try {
    const smart = await page.evaluate(() => window.__wire.bytes);
    const raw = await rawPage.evaluate(() => window.__raw.bytes);
    samples.push({ t: Date.now() - t0, phase: currentPhase, smart, raw });
  } catch { /* page busy: a missed sample is not a zero */ }
}, SAMPLE_MS);

console.log('running scenario against one live game, both strategies watching...\n');
const phaseStats = [];
for (const ph of phases) {
  const before = await Promise.all([
    page.evaluate(() => window.__wire.bytes).catch(() => 0),
    rawPage.evaluate(() => window.__raw.bytes).catch(() => 0),
  ]);
  t0 = Date.now();
  currentPhase = ph.name;
  await ph.fn();
  const after = await Promise.all([
    page.evaluate(() => window.__wire.bytes).catch(() => before[0]),
    rawPage.evaluate(() => window.__raw.bytes).catch(() => before[1]),
  ]);
  const secs = (Date.now() - t0) / 1000;
  const d = { name: ph.name, secs: +secs.toFixed(2), smart: after[0] - before[0], raw: after[1] - before[1] };
  d.smartMbps = +((d.smart * 8) / secs / 1e6).toFixed(2);
  d.rawMbps = +((d.raw * 8) / secs / 1e6).toFixed(2);
  phaseStats.push(d);
}
clearInterval(sampler);

const q = (arr, p) => (arr.length ? arr.slice().sort((a, b) => a - b)[Math.min(arr.length - 1, Math.floor(arr.length * p))] : 0);
const kbps = (v) => +(v / 1024).toFixed(0);

// Per-phase instantaneous rates, so p95 and the worst spike are attributable to
// an action rather than to the session as a whole.
const ratesFor = (name) => {
  const s = samples.filter((x) => x.phase === name);
  const smart = [], raw = [];
  for (let i = 1; i < s.length; i++) {
    const dt = (s[i].t - s[i - 1].t) / 1000;
    if (dt <= 0) continue;
    smart.push((s[i].smart - s[i - 1].smart) / dt);
    raw.push((s[i].raw - s[i - 1].raw) / dt);
  }
  return { smart, raw };
};

console.log('per phase, KB/s of instantaneous rate (samples every ' + SAMPLE_MS + 'ms)\n');
console.log('phase              smart p50  smart p95  smart max   raw p50   raw p95   raw max   ratio');
for (const p of phaseStats) {
  const r = ratesFor(p.name);
  const sp95 = kbps(q(r.smart, 0.95)), rm95 = kbps(q(r.raw, 0.95));
  p.smartP95 = sp95; p.rawP95 = rm95;
  p.smartMax = kbps(Math.max(...r.smart, 0));
  p.rawMax = kbps(Math.max(...r.raw, 0));
  const ratio = (p.raw / Math.max(1, p.smart)).toFixed(1);
  console.log(`${p.name.padEnd(18)} ${String(kbps(q(r.smart, 0.5))).padStart(9)} ${String(sp95).padStart(10)} ${String(p.smartMax).padStart(10)} ${String(kbps(q(r.raw, 0.5))).padStart(9)} ${String(rm95).padStart(9)} ${String(p.rawMax).padStart(9)} ${(ratio + 'x').padStart(7)}`);
}

const allSmart = phaseStats.flatMap((p) => ratesFor(p.name).smart);
const allRaw = phaseStats.flatMap((p) => ratesFor(p.name).raw);
const summary = {
  smart: {
    totalBytes: phaseStats.reduce((a, p) => a + p.smart, 0),
    rateP50: kbps(q(allSmart, 0.5)),
    rateP95: kbps(q(allSmart, 0.95)),
    rateMax: kbps(Math.max(...allSmart, 0)),
  },
  raw: {
    totalBytes: phaseStats.reduce((a, p) => a + p.raw, 0),
    rateP50: kbps(q(allRaw, 0.5)),
    rateP95: kbps(q(allRaw, 0.95)),
    rateMax: kbps(Math.max(...allRaw, 0)),
  },
};

const mb = (b) => (b / 1048576).toFixed(1);
console.log('\n--- totals over the whole session ---');
console.log(`  smart  ${mb(summary.smart.totalBytes).padStart(8)} MB`);
console.log(`  raw    ${mb(summary.raw.totalBytes).padStart(8)} MB`);
console.log(`  ratio  raw/smart = ${(summary.raw.totalBytes / Math.max(1, summary.smart.totalBytes)).toFixed(2)}x`);
console.log('\n--- instantaneous rate (KB/s per sample interval) ---');
console.log('           p50      p95      max');
console.log(`  smart ${String(summary.smart.rateP50).padStart(7)} ${String(summary.smart.rateP95).padStart(8)} ${String(summary.smart.rateMax).padStart(8)}`);
console.log(`  raw   ${String(summary.raw.rateP50).padStart(7)} ${String(summary.raw.rateP95).padStart(8)} ${String(summary.raw.rateMax).padStart(8)}`);

writeFileSync(OUT + '/wire_compare.json', JSON.stringify({ phases: phaseStats, summary, samples }, null, 2));
console.log(`\nwrote ${OUT}/wire_compare.json`);
await browser.close();
