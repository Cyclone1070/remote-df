#!/usr/bin/env node
// Tier 3 runner: live stack, real browser, real stream.
//
//   node tests/tier3-integration/run.mjs              # all suites, clean session
//   node tests/tier3-integration/run.mjs 02 03        # named suites only
//   node tests/tier3-integration/run.mjs --no-restart # reuse the running session
//
// A suite that fails writes its evidence before the runner moves on. The point of
// this tier is to answer "does a user see the game", and a red line on its own
// answers nothing - so every failure leaves behind the session state, the stream
// counters, the client's own numbers and the server log around the failure.
//
// Sessions are restarted once, at the start, not between suites: the suites build
// on a warm game on purpose, because "a client joins a game that is already
// running" is a case that fails differently from "a client joins a cold one".

import { mkdirSync, writeFileSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  restartSession, session, stats, serverLog, connect, closeBrowser, gamePid, BASE,
} from './lib/harness.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '../..');
const SUITE_DIR = resolve(HERE, 'suites');

const argv = process.argv.slice(2);
const noRestart = argv.includes('--no-restart');
const wanted = argv.filter((a) => !a.startsWith('--'));

const runId = new Date().toISOString().replace(/[:.]/g, '-');
const OUT = resolve(REPO, `evidence/tier3/${runId}`);

const suites = readdirSync(SUITE_DIR)
  .filter((f) => f.endsWith('.mjs'))
  .sort()
  .filter((f) => wanted.length === 0 || wanted.some((w) => f.startsWith(w)));

if (suites.length === 0) {
  console.error(`no suites matched ${wanted.join(', ')} in ${SUITE_DIR}`);
  process.exit(2);
}

/** Everything the harness can see, captured on failure. */
async function evidence(error) {
  mkdirSync(OUT, { recursive: true });
  const lines = [];
  const P = (s = '') => lines.push(s);
  P(`# Tier 3 failure: ${runId}`);
  P();
  P('```');
  P(error && error.stack ? error.stack : String(error));
  P('```');
  P();
  P('## Session');
  P('```json');
  P(JSON.stringify(await session(), null, 1));
  P('```');
  P('## Stream counters');
  P('```json');
  P(JSON.stringify(await stats(), null, 1));
  P('```');
  P(`game pid: \`${gamePid()}\``);
  P();
  P('## Server log (tail)');
  P('```');
  P(serverLog(2500).slice(-250).join('\n'));
  P('```');

  // A screenshot from a fresh connection is often the fastest way to see whether
  // the failure is "no picture" or "picture, wrong".
  try {
    const c = await connect();
    const lit = await c.lit();
    const st = await c.state();
    await c.shot(resolve(OUT, 'screen.png'));
    P();
    P('## Fresh connection at failure time');
    P(`lit fraction: ${lit}`);
    P('```json');
    P(JSON.stringify(st, null, 1));
    P('```');
    P('```');
    P(c.console_.filter((l) => /Assets|progress|Giving up|error/i.test(l)).slice(-20).join('\n'));
    P('```');
    await c.close();
  } catch (e) {
    P(`(could not open a page for evidence: ${e.message})`);
  }

  const file = resolve(OUT, 'failure.md');
  writeFileSync(file, lines.join('\n'));
  return file;
}

let passed = 0;
const failed = [];

console.log('');
console.log('=== Tier 3: integration ===');
console.log(`target ${BASE}`);

if (!noRestart) {
  process.stdout.write('  restarting session ... ');
  const t = Date.now();
  try {
    await restartSession();
    console.log(`up in ${((Date.now() - t) / 1000).toFixed(1)}s`);
  } catch (e) {
    console.log('FAILED');
    const f = await evidence(e);
    console.log(`\n  could not start a session - evidence: ${f}`);
    await closeBrowser();
    process.exit(1);
  }
} else {
  console.log('  reusing the running session (--no-restart)');
}

for (const file of suites) {
  const mod = await import(pathToFileURL(resolve(SUITE_DIR, file)).href);
  const label = `${file.replace(/\.mjs$/, '')} ${mod.name || ''}`.trim();
  process.stdout.write(`\n  ${label}\n`);
  const t = Date.now();
  try {
    await mod.run();
    console.log(`    ok    (${((Date.now() - t) / 1000).toFixed(1)}s)`);
    passed++;
  } catch (e) {
    const f = await evidence(e);
    console.log(`    FAIL  (${((Date.now() - t) / 1000).toFixed(1)}s)`);
    console.log(`          ${String(e.message).split('\n').join('\n          ')}`);
    console.log(`          evidence: ${f}`);
    failed.push(label);
    // A broken stack fails everything after it, so stop rather than produce a
    // wall of derivative failures that hides the first, real one.
    if (String(e.message).includes('could not start') || String(e.message).includes('unreachable')) break;
  }
}

await closeBrowser();

console.log('');
console.log(`  ${passed} passed, ${failed.length} failed`);
if (failed.length) {
  console.log('');
  for (const f of failed) console.log(`  - ${f}`);
  process.exit(1);
}
