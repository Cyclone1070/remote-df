#!/usr/bin/env node
// One run, every event, then the analysis.
//
// Aggregates cannot explain a freeze: "p95 frame gap 280ms" describes the symptom
// and says nothing about which frame was held, behind which gap, for how long.
// This drives the camera and records every arrival and every decision the client
// makes, then reads the trace back to attribute the time.
//
//   node tests/diagnostics/motion-trace.mjs [--seconds 10] [--label name]
//
// Writes evidence/bench/motion-trace/<label>/{trace.json,report.md}.

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { connect, closeBrowser, restartSession, stats, BASE, DEADLINE_MS, loopBaseline, MAX_BASELINE_P50_MS } from '../tier3-integration/lib/harness.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '../..');
const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : d; };
const SECONDS = Number(arg('seconds', '10'));
const LABEL = arg('label', new Date().toISOString().replace(/[:.]/g, '-'));
const OUT = resolve(REPO, `evidence/bench/motion-trace/${LABEL}`);

const P = (s = '') => console.log(s);

await restartSession();
const c = await connect();
try {
  const up = await c.waitForPicture({ deadlineMs: DEADLINE_MS });
  if (!up.ok) { console.error('picture never appeared'); process.exit(1); }
  // Get into the arena before measuring: the arena carries 13,327 draw commands
  // against the title screen's few, and the difference is the whole story.
  if (process.argv.includes('--arena')) {
    const bw = c.page.viewportSize().width, bh = c.page.viewportSize().height;
    await c.page.mouse.click(bw * 0.5, bh * (479 / 800));
    await c.page.waitForTimeout(4000);
    await c.page.mouse.click(bw * (180 / 1280), bh * (144 / 800));
    await c.page.waitForTimeout(1500);
    await c.page.mouse.click(bw * (1000 / 1280), bh * (755 / 800));
    await c.page.waitForTimeout(60000);
  }

  const floor = await loopBaseline(c.page);
  console.log(`browser frame floor: p50=${floor.p50}ms p95=${floor.p95}ms max=${floor.max}ms`);
  if (floor.p50 > MAX_BASELINE_P50_MS) {
    console.error(`REFUSING to analyse: this browser cannot even call requestAnimationFrame ` +
      `faster than ${floor.p50}ms, so any stall measured through it is the browser's, not the stream's.`);
    process.exit(3);
  }
  await c.page.waitForTimeout(2000);

  // Mark the start of the drag inside the trace, so everything before it is the
  // settling period and everything after is the thing being explained.
  await c.page.evaluate(() => window.__trace.push([performance.now(), 'mark', { what: 'drag-start' }]));
  const box = c.page.viewportSize();
  const cy = box.height / 2;
  await c.page.mouse.move(box.width * 0.3, cy);
  await c.page.mouse.down({ button: 'right' });
  const t0 = Date.now();
  let step = 0;
  while (Date.now() - t0 < SECONDS * 1000) {
    const phase = (step % 60) / 60;
    await c.page.mouse.move(
      box.width * (0.3 + 0.4 * Math.sin(phase * 2 * Math.PI)),
      cy + 40 * Math.sin(phase * 4 * Math.PI));
    step++;
  }
  await c.page.mouse.up({ button: 'right' });
  await c.page.evaluate(() => window.__trace.push([performance.now(), 'mark', { what: 'drag-end' }]));

  // Control: how often can this browser call requestAnimationFrame with no app
  // work at all? If a bare loop is also slow, the numbers above describe the
  // browser, not the stream, and no amount of tuning the app will change them.
  const rafBaseline = await c.page.evaluate(() => new Promise((res) => {
    const t = [];
    const f = () => { t.push(performance.now()); if (t.length < 61) requestAnimationFrame(f); else res(t); };
    requestAnimationFrame(f);
  }));
  const rafGaps = rafBaseline.slice(1).map((t, i) => t - rafBaseline[i]);

  const trace = await c.page.evaluate(() => window.__trace);
  const srv = await stats();
  mkdirSync(OUT, { recursive: true });
  writeFileSync(resolve(OUT, 'trace.json'), JSON.stringify(trace));
  writeFileSync(resolve(OUT, 'server.json'), JSON.stringify(srv, null, 1));

  // ── analysis ──────────────────────────────────────────────────────────────
  const start = trace.find((e) => e[1] === 'mark' && e[2].what === 'drag-start')?.[0] ?? trace[0][0];
  const end = trace.find((e) => e[1] === 'mark' && e[2].what === 'drag-end')?.[0] ?? trace[trace.length - 1][0];
  const during = trace.filter((e) => e[0] >= start && e[0] <= end);
  const count = (k) => during.filter((e) => e[1] === k).length;
  const secs = (end - start) / 1000;

  const draws = during.filter((e) => e[1] === 'draw').map((e) => e[0]);
  const drawGaps = [];
  for (let i = 1; i < draws.length; i++) drawGaps.push(draws[i] - draws[i - 1]);

  // Which frame the display was actually showing, over time. A flat stretch here
  // is the freeze the user sees.
  const applies = during.filter((e) => e[1] === 'apply');
  const held = during.filter((e) => e[1] === 'hold');
  const bridgeReq = during.filter((e) => e[1] === 'bridge-request');
  const heldBack = during.filter((e) => e[1] === 'held-back');

  // How long each bridge took: request to the next apply.
  const bridgeLatency = [];
  for (const br of bridgeReq) {
    const next = applies.find((a) => a[0] > br[0]);
    if (next) bridgeLatency.push(next[0] - br[0]);
  }
  const sorted = (a) => [...a].sort((x, y) => x - y);
  const q = (a, p) => (a.length ? Math.round(sorted(a)[Math.min(a.length - 1, Math.floor(a.length * p))]) : -1);

  // Frames that arrived but were never applied by the end of the drag.
  const arrivedSeqs = new Set(during.filter((e) => e[1] === 'frame-in').map((e) => e[2].seq));
  const appliedSeqs = new Set(applies.map((e) => e[2].seq));
  const neverApplied = [...arrivedSeqs].filter((q2) => !appliedSeqs.has(q2));

  // Duplicate arrivals at the same sequence: a resend the client did not need.
  const dupCount = during.filter((e) => e[1] === 'frame-in').length - arrivedSeqs.size;

  const L = [];
  const W = (s2 = '') => L.push(s2);
  W(`# Motion trace: ${LABEL}`);
  W();
  W(`drag ${secs.toFixed(1)}s · target ${BASE}`);
  W();
  W('## Per second, during the drag');
  W();
  W('| event | count | per second |');
  W('|---|---|---|');
  for (const k of ['frame-in', 'apply', 'hold', 'bridge-request', 'draw', 'pic-in', 'held-back', 'loop-gap', 'paint-cost', 'input-cost', 'sync-total', 'delta-stat']) {
    const n = count(k);
    W(`| ${k} | ${n} | ${(n / secs).toFixed(1)} |`);
  }
  W();
  W('## Frames');
  W();
  W(`- distinct sequence numbers that arrived: ${arrivedSeqs.size}`);
  W(`- applied: ${appliedSeqs.size}`);
  W(`- arrived but never applied during the drag: ${neverApplied.length}`);
  W(`- duplicate arrivals (same seq twice): ${dupCount}`);
  W();
  W('## Where the time went');
  W();
  W(`- draw gaps: n=${drawGaps.length} p50=${q(drawGaps, 0.5)}ms p95=${q(drawGaps, 0.95)}ms max=${Math.round(Math.max(0, ...drawGaps))}ms`);
  W(`- bridge request -> next apply: n=${bridgeLatency.length} p50=${q(bridgeLatency, 0.5)}ms p95=${q(bridgeLatency, 0.95)}ms`);
  W(`- frames held for a picture (held-back samples): ${heldBack.length}`);
  W(`- frames held for a sequence gap: ${held.length}`);
  const paints = during.filter((e) => e[1] === 'paint-cost').map((e) => e[2].ms);
  const loops = during.filter((e) => e[1] === 'loop-gap').map((e) => e[2].ms);
  W(`- paint cost when over 10ms: n=${paints.length} p50=${q(paints, 0.5)}ms p95=${q(paints, 0.95)}ms max=${Math.round(Math.max(0, ...paints))}ms`);
  const syncTot = during.filter((e) => e[1] === 'sync-total');
  const syncMs = syncTot.reduce((a, e) => a + e[2].ms, 0);
  const syncN = syncTot.reduce((a, e) => a + e[2].calls, 0);
  const cmds = syncTot.length ? syncTot[syncTot.length - 1][2].cmds : -1;
  const loopN = loops.length;
  const ds = during.filter((e) => e[1] === 'delta-stat');
  const dsN = ds.reduce((a, e) => a + e[2].n, 0);
  const dsEmpty = ds.reduce((a, e) => a + e[2].changedNothing, 0);
  const dsUp = ds.reduce((a, e) => a + e[2].updates, 0);
  W(`- deltas applied: ${dsN}, of which changed nothing: ${dsEmpty} (${(100*dsEmpty/Math.max(1,dsN)).toFixed(0)}%), total updates carried: ${dsUp}`);
  W(`- syncAssets: ${syncN} calls costing ${syncMs}ms total (${(syncMs / Math.max(1, end - start) * 1000 / 1000).toFixed(1)}% of wall time), command buffer ${cmds} commands`);
  W(`- render loop interval: n=${loops.length} p50=${q(loops, 0.5)}ms p95=${q(loops, 0.95)}ms max=${Math.round(Math.max(0, ...loops))}ms`);
  W();
  W('## Baseline: this browser with no app work');
  W();
  W(`- bare requestAnimationFrame interval: n=${rafGaps.length} p50=${q(rafGaps, 0.5)}ms p95=${q(rafGaps, 0.95)}ms max=${Math.round(Math.max(0, ...rafGaps))}ms`);
  W(`- ${q(rafGaps, 0.5) > 30 ? 'THE BROWSER ITSELF IS SLOW - app numbers above are not attributable to the app' : 'the browser can run at full rate, so the stalls above belong to the app'}`);
  W();
  W('## Verdict');
  W();
  const slowPaint = q(paints, 0.5) > 60;
  W(slowPaint
    ? '- each paint is slow, so the display is limited by the renderer itself'
    : '- paints are cheap, so the display is limited by how often the loop runs');
  W(`- a bridge costs ${q(bridgeLatency, 0.5)}ms (p50), and there were ${bridgeReq.length} of them in ${secs.toFixed(0)}s`);
  W();

  const report = L.join('\n');
  writeFileSync(resolve(OUT, 'report.md'), report);
  P(report);
  P(`written to ${OUT}`);
} finally {
  await c.close();
  await closeBrowser();
}
