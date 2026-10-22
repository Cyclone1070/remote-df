// Is the instruction path starved on the host or on the client?
//
// The bench showed frames collapsing while artwork flows, but that alone does not say
// where they are lost: the host may not be sending them, or it may be sending them and
// the client may not be handling them. Those have different causes and different fixes.
//
// So this measures the same input window on both sides at once:
//   host   - frame.sent and picture.chunk.sent from the host's own wire log
//   client - frame-in, pic-in, held-back and display from the page's own trace
//
// and it runs the window twice: once with artwork flowing normally, once with the
// picture budget at zero. If the host's frame rate recovers when artwork stops, the
// starvation is on the host. If the host keeps sending but the client stops receiving,
// it is on the client.
//
// The picture budget is a runtime switch (/tmp/df_tex_budget), not a code change, so
// the two conditions differ in exactly one variable.
import { chromium } from 'playwright';
import { mkdirSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const BASE = process.env.DF_API || 'http://192.168.1.111:8484';
const GAME_HOST = process.env.DF_GAME_HOST || 'cyc@192.168.1.111';
const WINDOW_MS = Number(process.env.DF_WINDOW_MS || 6000);
const dir = `evidence/bench/artwork-starvation/${new Date().toISOString().replace(/[:.]/g, '-')}`;
mkdirSync(dir, { recursive: true });
const settle = (ms) => new Promise((r) => setTimeout(r, ms));

const setBudget = (value) => {
  const cmd = value === null
    ? 'podman exec remote-df rm -f /tmp/df_tex_budget'
    : `podman exec remote-df sh -c 'echo ${value} > /tmp/df_tex_budget'`;
  execFileSync('ssh', ['-o', 'ConnectTimeout=10', GAME_HOST, cmd], { stdio: 'ignore' });
};

// Monotonic counters from the host, not the wire log.
//
// The wire log is a ring buffer. During an artwork burst it fills and wraps inside a
// single window, so a difference across it is meaningless - it even goes negative.
// /df-stats counters only ever go up.
const hostCounts = async () => {
  const r = await fetch(`${BASE}/df-stats`);
  const j = await r.json();
  return { frames: j.frames || 0, pics: j.textures || 0, presents: j.presents || 0, nothing: j.encodeNothing || 0 };
};

const clientCounts = (page) => page.evaluate(() => {
  const b = window.__dfBench || {};
  const t = window.__trace || [];
  const c = {};
  for (const e of t) c[e[1]] = (c[e[1]] || 0) + 1;
  return {
    frames: c['frame-in'] || 0,
    pics: c['pic-in'] || 0,
    held: c['held-back'] || 0,
    display: (b.display || []).length,
  };
});

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
await page.goto(`${BASE}/df`, { waitUntil: 'domcontentloaded' });
await settle(16000);

// Make sure the game is actually running before measuring anything.
//
// A paused game still presents - the presents counter climbs - but nothing changes, so
// no frames are sent and every window reads zero. That is not a slow transport, it is a
// stopped game, and it silently poisons a whole run. The host's frame counter is the
// honest check: if it does not advance while input is held, the game is paused.
async function ensureRunning() {
  for (let attempt = 0; attempt < 3; attempt++) {
    const a = await hostCounts();
    await page.keyboard.down('d');
    await settle(1200);
    await page.keyboard.up('d');
    await settle(900);
    const b = await hostCounts();
    if (b.frames > a.frames) return true;
    await page.keyboard.press(' ');
    await settle(1800);
  }
  return false;
}
if (!(await ensureRunning())) {
  console.log('the game would not start producing frames - aborting rather than reporting zeros');
  process.exit(1);
}

async function runWindow(label) {
  const h0 = await hostCounts();
  const c0 = await clientCounts(page);
  const t0 = Date.now();
  await page.keyboard.down('d');
  await settle(WINDOW_MS);
  await page.keyboard.up('d');
  await settle(800);
  const secs = (Date.now() - t0) / 1000;
  const h1 = await hostCounts();
  const c1 = await clientCounts(page);
  return {
    label,
    secs: +secs.toFixed(2),
    hostFrames: h1.frames - h0.frames,
    hostPics: h1.pics - h0.pics,
    clientFrames: c1.frames - c0.frames,
    clientPics: c1.pics - c0.pics,
    held: c1.held - c0.held,
    display: c1.display - c0.display,
  };
}

const rows = [];
rows.push(await runWindow('artwork on, run 1'));
rows.push(await runWindow('artwork on, run 2'));

// The one variable changes.
setBudget(0);
await settle(2500);
rows.push(await runWindow('artwork off, run 1'));
rows.push(await runWindow('artwork off, run 2'));
setBudget(null);

await browser.close();

writeFileSync(`${dir}/artwork-starvation.json`, JSON.stringify(rows, null, 2));
const w = (s, n) => String(s).padEnd(n);
console.log(w('condition', 22) + w('host frames', 13) + w('host pics', 11) + w('client frames', 15) + w('client pics', 13) + w('held', 7) + 'display');
for (const r of rows) {
  console.log(
    w(r.label, 22) + w(r.hostFrames, 13) + w(r.hostPics, 11) +
    w(r.clientFrames, 15) + w(r.clientPics, 13) + w(r.held, 7) + r.display,
  );
}
console.log(`\nwritten to ${dir}/artwork-starvation.json`);
