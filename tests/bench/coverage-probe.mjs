// Forces the event kinds that a normal pan does not reach: connect, cache reset,
// forced keyframe, "nothing to send", and the client's bridge requests. Coverage
// that is never exercised is a claim, not a fact, so this drives each condition on
// purpose and then hands the log slice to audit-coverage.mjs.
import { chromium } from 'playwright';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';

const HOST = process.env.GAME_HOST || 'cyc@192.168.1.111';
const CONTAINER = process.env.DF_CONTAINER || 'remote-df';
const LOG = '/tmp/df_events.log';
const outDir = `evidence/bench/coverage/${new Date().toISOString().replace(/[:.]/g, '-')}`;
mkdirSync(outDir, { recursive: true });

const ssh = (cmd) => execFileSync('ssh', [HOST, `podman exec ${CONTAINER} sh -c "${cmd}"`],
  { maxBuffer: 1 << 30, encoding: 'utf8' });
const logSize = () => parseInt(ssh(`stat -c %s ${LOG}`).trim(), 10) || 0;

const browser = await chromium.launch({ headless: true,
  args: ['--disable-background-timer-throttling', '--disable-renderer-backgrounding'] });

const start = logSize();

const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
await page.goto('http://192.168.1.111:8484/df', { waitUntil: 'domcontentloaded' });
for (let i = 0; i < 80; i++) {
  if (await page.evaluate(() => !!(window.renderer && window.renderer.assetsReady))) break;
  await page.waitForTimeout(500);
}

// Pausing the game makes every present produce the same picture, which is the only
// way the encoder reports "nothing changed" instead of a delta.
await page.keyboard.press(' ');
await page.waitForTimeout(2500);

// Panning while paused into unseen terrain is what makes a frame reference pictures
// the client does not hold: that is the bridge request and the re-send.
for (const k of ['a', 'a', 'w', 'w', 'd', 'd', 's', 's']) {
  await page.keyboard.press(k);
  await page.waitForTimeout(400);
}
await page.waitForTimeout(2000);
await page.close();          // client disconnect
await new Promise((r) => setTimeout(r, 1500));
await browser.close();

// Relay decisions, including the drop path. A viewer that reads slowly is the only
// way the "slot was still full" branch happens, and a branch that is never taken is
// never proven.
const SERVER_LOG = '/tmp/df_server_events.log';
const serverStart = parseInt(ssh(`stat -c %s ${SERVER_LOG} 2>/dev/null || echo 0`).trim(), 10) || 0;
const slow = (await import('node:child_process')).spawn('curl',
  ['-s', '--limit-rate', '2k', '--max-time', '10', 'http://192.168.1.111:8000/raw.mjpg', '-o', '/dev/null']);
await new Promise((r) => setTimeout(r, 2000));
const fast = (await import('node:child_process')).spawn('curl',
  ['-s', '--max-time', '6', 'http://192.168.1.111:8000/raw.mjpg', '-o', '/dev/null']);
await new Promise((r) => setTimeout(r, 8000));
slow.kill('SIGKILL');
fast.kill('SIGKILL');
await new Promise((r) => setTimeout(r, 1500));
try {
  const serverText = ssh(`tail -c +${serverStart + 1} ${SERVER_LOG} 2>/dev/null`);
  writeFileSync(`${outDir}/server-coverage-probe.log`, serverText);
  const sk = [...new Set(serverText.split('\n').filter(Boolean).map((l) => Number(l.split(' ')[1])))].sort((a, b) => a - b);
  console.log(`relay probe records: ${serverText.split('\n').length - 1}, kinds: ${sk.join(',')}`);
} catch (e) {
  console.log('relay probe failed:', String(e).slice(0, 120));
}

const end = logSize();
const text = ssh(`tail -c +${start + 1} ${LOG}`);
writeFileSync(`${outDir}/host-coverage-probe.log`, text);
// The analysis reads a run's step log. A probe is a run like any other, so it
// writes one instead of making the analyser special-case its directory.
writeFileSync(`${outDir}/steps.ndjson`, JSON.stringify({
  t: Date.now(), phase: 'coverage-probe', what: 'done', records: text.split('\n').length - 1,
}) + '\n');

const kinds = [...new Set(text.split('\n').filter(Boolean).map((l) => Number(l.split(' ')[1])))].sort((a, b) => a - b);
console.log(`probe wrote ${text.split('\n').length - 1} records, kinds: ${kinds.join(',')}`);
console.log(`dir: ${outDir}`);
