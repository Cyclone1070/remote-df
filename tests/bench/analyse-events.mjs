// Answer questions from the event log, not from the bench's printed overview.
//
// The printed lines are a summary someone chose; the log is the run. Everything
// here is arithmetic over steps.ndjson, so a claim can be checked by re-running
// this file against the same directory.
//
// Usage: node tests/bench/analyse-events.mjs <run-dir> [interaction]
import { readFileSync, readdirSync } from 'node:fs';

const dir = process.argv[2];
const onlyInteraction = process.argv[3] || '';
if (!dir) {
  console.error('usage: analyse-events.mjs <run-dir> [interaction]');
  process.exit(2);
}

// Host event kinds, mirroring interposer/event_log.hpp. Kept as a table so a
// wrong number shows up as "unknown" instead of being silently mislabelled.
const HOST_KIND = {
  0: 'draw-captured', 1: 'draw-drop-nopixels', 2: 'draw-drop-unknown', 3: 'draw-drop-overflow',
  5: 'present', 6: 'frame-sent',
  8: 'present-no-receiver', 9: 'clear', 10: 'pic-alloc', 11: 'pic-created',
  13: 'pic-compressed', 14: 'pic-sent', 15: 'pic-chunk-sent',
  16: 'pic-skip-cached', 17: 'pic-queued', 19: 'cache-evict',
  20: 'cache-reset', 21: 'encode-full', 22: 'encode-delta', 23: 'encode-keyframe',
  24: 'encode-nothing', 25: 'encode-error', 26: 'gap-ack', 27: 'bridge-request',
  28: 'resend-missing', 29: 'missing-unknown', 30: 'input-recv', 31: 'input-pushed',
  33: 'client-connect', 34: 'client-disconnect', 36: 'pic-skip-no-data',
};

// The relay's own decisions, from its separate file. Same line format, different
// namespace: these start at 100 so a relay decision can never be read as a capture.
const RELAY_KIND = {
  100: 'ServerFrameOffered',
  101: 'ServerFrameDropped',
  102: 'ServerFrameWritten',
  103: 'ServerSubscriberJoins',
  104: 'ServerSubscriberLeaves',
};
const kindName = (k) => HOST_KIND[k] || `unknown(${k})`;

const lines = readFileSync(`${dir}/steps.ndjson`, 'utf8').split('\n').filter(Boolean);
const recs = [];
for (const line of lines) {
  try { recs.push(JSON.parse(line)); } catch { /* truncated tail */ }
}

const inScope = (r) => !onlyInteraction || r.interaction === onlyInteraction;
const host = recs.filter((r) => r.src === 'host' && r.ev === 'event' && inScope(r));
const client = recs.filter((r) => r.src === 'client' && inScope(r));

const count = (arr, pred) => arr.filter(pred).length;
const hostKind = (k) => host.filter((r) => r.k === k);
const clientKind = (name) => client.filter((r) => r.ev === name);

const pct = (arr, p) => {
  if (!arr.length) return null;
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
};

console.log(`\n== ${dir}`);
console.log(`   log lines: ${recs.length}   host events: ${host.length}   client events: ${client.length}`);
if (onlyInteraction) console.log(`   interaction: ${onlyInteraction}`);

if (!host.length) {
  console.log('\n   NO HOST EVENTS. The host drain is missing or the endpoint failed;');
  console.log('   everything below would be a statement about nothing.\n');
}

// ── frames: the question that could not be answered before ────────────────────
const sent = hostKind(6).length;          // frame-sent, host side
const presented = hostKind(5).length;     // present
const noReceiver = hostKind(8).length;
const recv = clientKind('frame-in').length;
const drawn = clientKind('draw').length;
const held = clientKind('hold').length;
const bridge = clientKind('bridge-request').length;
const gapAck = hostKind(26).length;

console.log('\n-- frames');
console.log(`   presents observed        ${presented}`);
console.log(`   frames sent by host      ${sent}`);
console.log(`   presents with no client  ${noReceiver}`);
console.log(`   frames received (client) ${recv}`);
console.log(`   frames painted (client)  ${drawn}`);
console.log(`   frames held for a gap    ${held}`);
console.log(`   bridge requests (client) ${bridge}`);
console.log(`   GAP_ACKs (host)          ${gapAck}`);
if (sent > 0) {
  const lost = sent - recv;
  console.log(`   sent minus received      ${lost}   (${((lost / sent) * 100).toFixed(1)}% of frames)`);
}
console.log(`   received minus painted   ${recv - drawn}`);

// ── relay decisions ───────────────────────────────────────────────────────────
// The relay keeps its own file. Reading it here is what makes those records
// instrumentation rather than decoration: a record nobody reads is a record nobody
// can act on.
let relayRecs = [];
try {
  for (const f of readdirSync(dir)) {
    if (!f.startsWith('server-')) continue;
    if (onlyInteraction && !f.includes(onlyInteraction)) continue;
    for (const line of readFileSync(`${dir}/${f}`, 'utf8').split('\n')) {
      if (!line) continue;
      const p2 = line.split(' ');
      relayRecs.push({ kind: Number(p2[1]), seq: Number(p2[2]), viewer: Number(p2[3]), a: Number(p2[4]) });
    }
  }
} catch { /* no relay file for this path: the instruction path has none */ }

if (relayRecs.length) {
  const relayKind = (k) => relayRecs.filter((r) => r.kind === k);
  const offered = relayKind(100);
  const dropped = relayKind(101);
  const written = relayKind(102);
  console.log('\n-- relay (pixel path)');
  console.log(`   frames offered           ${offered.length}`);
  console.log(`   frames written           ${written.length}   (${offered.length ? ((written.length / offered.length) * 100).toFixed(1) : 0}% of offered)`);
  console.log(`   frames dropped stale     ${dropped.length}`);
  if (dropped.length) {
    const first = dropped.slice(0, 5).map((r) => r.seq).join(', ');
    console.log(`   dropped frame seqs       ${first}${dropped.length > 5 ? ', ...' : ''}`);
    console.log(`   (a drop means the viewer had not taken the previous frame; the seq names which frame it lost)`);
  }
  const joins = relayKind(103).length;
  const leaves = relayKind(104).length;
  console.log(`   viewers joined / left    ${joins} / ${leaves}`);
} else if (!onlyInteraction || onlyInteraction === 'pan') {
  console.log('\n-- relay (pixel path)');
  console.log('   no relay records in this run (instruction path frames do not pass through it)');
}

// ── artwork ───────────────────────────────────────────────────────────────────
const created = hostKind(11);
const picSent = hostKind(14).length;
const picSkip = hostKind(16).length;
const chunks = hostKind(15);
const picBytes = chunks.reduce((n, r) => n + (r.a || 0), 0);
const picIn = clientKind('pic-in').length;

console.log('\n-- artwork');
console.log(`   pictures created         ${created.length}`);
console.log(`   pictures sent            ${picSent}`);
console.log(`   sends skipped (cached)   ${picSkip}`);
console.log(`   chunks on the wire       ${chunks.length}  totalling ${(picBytes / 1024).toFixed(0)} KB`);
console.log(`   chunks received (client) ${picIn}`);
if (picSent) console.log(`   chunks per picture       ${(chunks.length / picSent).toFixed(2)}`);
if (created.length) {
  const dims = created.map((r) => `${r.a}x${r.b}`);
  const big = created.filter((r) => (r.a || 0) * (r.b || 0) > 0);
  if (big.length) console.log(`   largest picture          ${big.reduce((m, r) => Math.max(m, r.a * r.b), 0)} px`);
  console.log(`   sample dims              ${dims.slice(0, 5).join(', ')}`);
}

// ── what the game actually drew ───────────────────────────────────────────────
const draws = hostKind(0).length;
const drops = {
  nopixels: hostKind(1).length,
  unknown: hostKind(2).length,
  overflow: hostKind(3).length,
  failed: hostKind(4).length,
};
const totalDrops = Object.values(drops).reduce((a, b) => a + b, 0);

console.log('\n-- draw capture');
console.log(`   draws captured           ${draws}`);
console.log(`   draws dropped            ${totalDrops}  (nopixels ${drops.nopixels}, unknown ${drops.unknown}, overflow ${drops.overflow}, failed ${drops.failed})`);

// ── encoding ─────────────────────────────────────────────────────────────────
const enc = {
  full: hostKind(21).length,
  delta: hostKind(22).length,
  keyframe: hostKind(23).length,
  nothing: hostKind(24).length,
  error: hostKind(25).length,
};
const KF_REASON = { 1: 'connect', 2: 'client-asked', 3: 'base-expired', 4: 'resend', 5: 'resize', 6: 'pixels-moved', 7: 'unknown' };
const NOTHING_REASON = { 1: 'unchanged', 2: 'no-receiver', 3: 'no-commands', 4: 'encode-error' };

console.log('\n-- encoding');
console.log(`   full ${enc.full}   delta ${enc.delta}   keyframe ${enc.keyframe}   nothing ${enc.nothing}   error ${enc.error}`);
const kf = {};
for (const r of hostKind(23)) kf[KF_REASON[r.a] || `?${r.a}`] = (kf[KF_REASON[r.a] || `?${r.a}`] || 0) + 1;
if (Object.keys(kf).length) console.log(`   keyframe reasons         ${Object.entries(kf).map(([k, v]) => `${k}=${v}`).join(' ')}`);
const nr = {};
for (const r of hostKind(24)) nr[NOTHING_REASON[r.a] || `?${r.a}`] = (nr[NOTHING_REASON[r.a] || `?${r.a}`] || 0) + 1;
if (Object.keys(nr).length) console.log(`   nothing reasons          ${Object.entries(nr).map(([k, v]) => `${k}=${v}`).join(' ')}`);
if (enc.error) console.log(`   !! encode errors         ${enc.error}  (these used to be indistinguishable from "unchanged")`);

// ── compression cost, measured on the host ───────────────────────────────────
const comp = hostKind(13);
if (comp.length) {
  const us = comp.map((r) => r.c || 0);
  const ratios = comp.filter((r) => r.b > 0).map((r) => r.b / r.a);
  console.log('\n-- picture compression');
  console.log(`   pictures compressed      ${comp.length}`);
  console.log(`   cost p50/p90/worst       ${pct(us, 50)} / ${pct(us, 90)} / ${Math.max(...us)} us`);
  console.log(`   ratio p50                ${(pct(ratios, 50) * 100).toFixed(1)}%`);
}

// ── the gate: held frames and what released them ─────────────────────────────
const heldBack = clientKind('held-back');
if (heldBack.length) {
  const missing = heldBack.map((r) => (r.data && r.data.missing) || 0);
  console.log('\n-- completeness gate');
  console.log(`   held-back ticks          ${heldBack.length}`);
  console.log(`   missing pictures         p50 ${pct(missing, 50)}  worst ${Math.max(...missing)}`);
}

// ── client-side costs ────────────────────────────────────────────────────────
const paintCost = clientKind('paint-cost').map((r) => (r.data && r.data.ms) || 0);
const loopGap = clientKind('loop-gap').map((r) => (r.data && r.data.ms) || 0);
if (paintCost.length || loopGap.length) {
  console.log('\n-- client cost');
  if (paintCost.length) console.log(`   paint ms (slow only)     p50 ${pct(paintCost, 50)}  p90 ${pct(paintCost, 90)}  worst ${Math.max(...paintCost)}`);
  if (loopGap.length) console.log(`   loop gap ms              p50 ${pct(loopGap, 50)}  p90 ${pct(loopGap, 90)}  worst ${Math.max(...loopGap)}`);
}

console.log('');
