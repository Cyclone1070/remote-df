/**
 * df_input_fidelity.mjs — does one physical key press reach the game as one press?
 *
 * The existing benches all measure how smoothly pictures arrive. None of them
 * look at input at all, so a press that the game registers three times is
 * completely invisible to them. This bench closes that gap.
 *
 * It sends a known number of discrete taps, then reads the host's own log of
 * what it injected into the game, and compares the two. The interesting number
 * is not the count but the HOLD DURATION: a 120ms tap that the game sees as a
 * 1500ms hold means the page froze between the press and the release, and the
 * game will have auto-repeated while it waited.
 *
 * Usage:
 *   node scripts/df_input_fidelity.mjs [outdir]
 *
 * Env:
 *   QA_URL       page to drive          (default http://192.168.1.111:8484/df)
 *   QA_HEADLESS  "0" for a real window  (default headless)
 *   TAPS         number of taps         (default 8)
 *   TAP_MS       how long each tap is held down (default 120)
 *   TAP_GAP_MS   gap between taps       (default 2500)
 *   KEY          key to tap             (default "Period" = the > key)
 *   DF_HOST      ssh destination        (default cyc@192.168.1.111)
 *   DF_CONTAINER container name         (default remote-df)
 */
import { chromium } from 'playwright';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';

const OUT = process.argv[2] || '/tmp/input_fidelity';
const URL = process.env.QA_URL || 'http://192.168.1.111:8484/df';
const HEADLESS = process.env.QA_HEADLESS !== '0';
const TAPS = Number(process.env.TAPS || 8);
const TAP_MS = Number(process.env.TAP_MS || 120);
const TAP_GAP_MS = Number(process.env.TAP_GAP_MS || 2500);
const KEY = process.env.KEY || 'Period';
const HOST = process.env.DF_HOST || 'cyc@192.168.1.111';
const CONTAINER = process.env.DF_CONTAINER || 'remote-df';

mkdirSync(OUT, { recursive: true });

const ssh = (cmd) => execFileSync('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15', HOST, cmd],
  { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });

// The host logs every key event it pushes into the game, timestamped, so the
// game's own view of the input can be read back rather than inferred.
function readInjectedKeys() {
  const raw = ssh(`podman logs -t ${CONTAINER} 2>&1 | grep -a '\\[INPUT\\] key=' | tail -400`);
  return raw.split('\n').filter(Boolean).map((line) => {
    // 2026-10-11T00:12:34.567890000Z [INPUT] key=46 scancode=55 mod=0 DOWN winID=1 push=1
    const m = line.match(/^(\S+?)\s.*key=(\d+) scancode=(\d+) mod=(\d+) (DOWN|UP)/);
    if (!m) return null;
    return { t: Date.parse(m[1]), key: Number(m[2]), scancode: Number(m[3]), dir: m[5] };
  }).filter(Boolean);
}

const before = readInjectedKeys();
const t0 = Date.now();

const browser = await chromium.launch({
  headless: HEADLESS,
  args: ['--no-sandbox', '--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
// The normal client draws into a canvas; the raw baseline is a plain <img>. Both
// are accepted so the same bench can measure either path.
await page.waitForSelector('canvas, img, body', { timeout: 120000 });
await page.waitForTimeout(6000);

// Focus the surface so key events land on the game rather than the page chrome.
const target = (await page.locator('canvas').count()) ? page.locator('canvas').first()
  : (await page.locator('img').count()) ? page.locator('img').first()
    : page.locator('body');
const box = await target.boundingBox();
await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
await page.waitForTimeout(1500);

// A press on an idle title screen is faithfully delivered, so tapping alone
// proves nothing. The symptom appears under load, which is also when the page
// freezes between the press and the release - so optionally run a zoom storm
// alongside the taps, exactly the condition the human described.
const LOAD = process.env.LOAD !== '0';
let stormDone = Promise.resolve();
if (LOAD) {
  stormDone = (async () => {
    for (let i = 0; i < 400; i++) {
      await page.mouse.wheel(0, i % 20 < 10 ? -120 : 120);
      await page.waitForTimeout(8);
    }
  })();
}

const tapsSentAt = [];
for (let i = 0; i < TAPS; i++) {
  tapsSentAt.push(Date.now());
  await page.keyboard.down(KEY);
  await page.waitForTimeout(TAP_MS);
  await page.keyboard.up(KEY);
  if (i < TAPS - 1) await page.waitForTimeout(TAP_GAP_MS);
}
await stormDone;
await page.waitForTimeout(2500);

const after = readInjectedKeys();
await browser.close();

// Keep only events produced during this run.
const cutoff = t0 - 1000;
const events = after.filter((e) => e.t >= cutoff);
const downs = events.filter((e) => e.dir === 'DOWN');
const ups = events.filter((e) => e.dir === 'UP');

// Pair each DOWN with the next UP to get how long the game believed the key was
// held. A tap that reads as a long hold is the freeze stretching it.
const holds = [];
const pending = [];
for (const e of events) {
  if (e.dir === 'DOWN') pending.push(e.t);
  else if (pending.length) holds.push(e.t - pending.shift());
}

holds.sort((a, b) => a - b);
const q = (p) => (holds.length ? holds[Math.min(holds.length - 1, Math.floor(holds.length * p))] : 0);

const report = {
  when: new Date().toISOString(),
  url: URL,
  headless: HEADLESS,
  key: KEY,
  tapsSent: TAPS,
  tapHeldMs: TAP_MS,
  injectedDown: downs.length,
  injectedUp: ups.length,
  holdMs: { median: q(0.5), p90: q(0.9), max: holds[holds.length - 1] || 0, samples: holds },
  // One press should be one press. More downs than taps means the game was told
  // to press the key more times than the human did.
  extraPresses: downs.length - TAPS,
  stretchedHolds: holds.filter((h) => h > TAP_MS * 2).length,
};

writeFileSync(`${OUT}/input_fidelity.json`, JSON.stringify(report, null, 2));

console.log(`df_input_fidelity — ${URL}  (load: ${LOAD ? 'zoom storm' : 'none'})`);
console.log(`  taps sent            : ${TAPS} (each held ${TAP_MS}ms)`);
console.log(`  key downs the game got: ${downs.length}   ${downs.length === TAPS ? 'OK' : `MISMATCH (${report.extraPresses > 0 ? '+' : ''}${report.extraPresses})`}`);
console.log(`  key ups the game got  : ${ups.length}`);
console.log(`  hold duration         : median ${report.holdMs.median}ms  p90 ${report.holdMs.p90}ms  max ${report.holdMs.max}ms`);
console.log(`  holds over ${TAP_MS * 2}ms      : ${report.stretchedHolds} of ${holds.length}  <- a tap the game saw as a hold`);
console.log(`  wrote ${OUT}/input_fidelity.json`);
