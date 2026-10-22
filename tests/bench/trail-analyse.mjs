// Reads one captured trail and says where the time went, per input.
//
// The two machines have different clocks, so the analysis is split by what it
// needs:
//
//   * the host's share needs NO alignment - the input arrival and the frame
//     leaving are both host-clock events, and their difference is exact.
//   * the client's share needs no alignment either - arrival, apply and paint are
//     all page-clock events.
//   * only the wire needs alignment, and that is derived from the inputs and
//     reported with its own uncertainty rather than assumed away.
//
// An earlier version matched the two sides by stamp. Stamps are one byte and
// repeat, so that paired the wrong events and produced a 281-second clock spread
// and per-input waits of 11 seconds that never happened.
import { readdirSync, readFileSync } from 'node:fs';

const ROOT = 'evidence/bench/latency-trail';
const dir = process.argv[2] || `${ROOT}/${readdirSync(ROOT).sort().pop()}`;
const client = JSON.parse(readFileSync(`${dir}/client.json`, 'utf8'));
const host = JSON.parse(readFileSync(`${dir}/host.json`, 'utf8'));

const pct = (arr, p) => {
  if (!arr.length) return null;
  const s = [...arr].sort((a, b) => a - b);
  return Math.round(s[Math.min(s.length - 1, Math.floor(s.length * p))]);
};

const events = host.events;
const inputs = events.filter((e) => e[1] === 5);
const frames = events.filter((e) => e[1] === 0 || e[1] === 1);
const presents = events.filter((e) => e[1] === 6);

console.log(`trail: ${dir}`);
console.log(`host events ${events.length}: inputs ${inputs.length}, frames ${frames.length}, presents ${presents.length}, artwork ${events.filter((e) => e[1] === 2).length}`);

// ---- host side, exact, no alignment needed -------------------------------
console.log('\nHOST (exact, one clock)');
const encodeUs = presents.map((e) => e[4]);
console.log(`  encode per present: p50 ${pct(encodeUs, 0.5)}us  p95 ${pct(encodeUs, 0.95)}us  max ${pct(encodeUs, 1)}us`);
console.log(`  artwork chunks sent: ${events.filter((e) => e[1] === 2).length}`);

const waits = [];
const presentsSkipped = [];
for (const inp of inputs) {
  const next = frames.find((f) => f[0] >= inp[0]);
  if (!next) continue;
  waits.push(next[0] - inp[0]);
  presentsSkipped.push(presents.filter((p) => p[0] >= inp[0] && p[0] < next[0]).length);
}
console.log(`  input arrival -> first frame out: p50 ${pct(waits, 0.5)}ms  p95 ${pct(waits, 0.95)}ms  max ${pct(waits, 1)}ms  (n=${waits.length})`);
console.log(`  presents that went out between arrival and that frame: p50 ${pct(presentsSkipped, 0.5)}  max ${pct(presentsSkipped, 1)}`);

// did the frame that went out even carry the stamp?
const carrying = frames.filter((f) => f[5] !== 0).length;
console.log(`  frames carrying a stamp: ${carrying} of ${frames.length}`);

// ---- client side, exact, no alignment needed -----------------------------
console.log('\nCLIENT (exact, one clock)');
console.log(`  arrival -> applied : p50 ${pct(client.arrivalToApply, 0.5)}ms  p95 ${pct(client.arrivalToApply, 0.95)}ms  max ${pct(client.arrivalToApply, 1)}ms  (n=${client.arrivalToApply.length})`);
console.log(`  applied -> screen  : p50 ${pct(client.frameToDraw, 0.5)}ms  p95 ${pct(client.frameToDraw, 0.95)}ms  max ${pct(client.frameToDraw, 1)}ms  (n=${client.frameToDraw.length})`);
const loop = client.trace.filter((e) => e[1] === 'loop-gap').map((e) => (e[2] && e[2].ms) || 0);
console.log(`  render loop gap    : p50 ${pct(loop, 0.5)}ms  p95 ${pct(loop, 0.95)}ms  max ${pct(loop, 1)}ms  (${loop.length} iterations)`);
console.log(`  paints ${client.paints}, frames applied ${client.framesApplied}, messages in ${client.wireEvents.length}`);

// ---- the wire, which DOES need alignment --------------------------------
//
// Both logs carry a timestamp taken within a few milliseconds of each other: the
// page recorded performance.now() and Date.now() when it handed its log over, and
// the host stamped its own log at the moment it served it. Their difference is the
// clock offset, with an uncertainty of however long that handover took.
//
// Pairing by stamp was tried first and failed: a stamp is one byte and repeats, so
// it matched the wrong events and produced a 281-second spread and per-input waits
// of 11 seconds that never happened. An anchor cannot go wrong the same way.
const meta = JSON.parse(readFileSync(`${dir}/meta.json`, 'utf8'));
const offset = meta.anchor.hostAt - meta.anchor.clientPerf;
const anchorUncertainty = meta.anchor.uncertaintyMs;

console.log('\nWIRE (aligned on capture time)');
console.log(`  clock offset ${offset} ms; anchor uncertainty ${anchorUncertainty} ms`);

const wireMs = [];
for (const f of frames) {
  const sentClientClock = f[0] - offset;
  const got = client.wireEvents.find((w) => (w[1] === 'frame' || w[1] === 'keyframe') && w[3] === f[4]);
  if (got) wireMs.push(got[0] - sentClientClock);
}
const plausible = wireMs.filter((v) => v > -anchorUncertainty - 5 && v < 5000);
console.log(`  frame sent -> arrived: p50 ${pct(plausible, 0.5)}ms  p95 ${pct(plausible, 0.95)}ms  max ${pct(plausible, 1)}ms  (n=${plausible.length} of ${frames.length} frames matched)`);

const artMs = [];
for (const a of events.filter((e) => e[1] === 2)) {
  const sentClientClock = a[0] - offset;
  const near = client.wireEvents.find((w) => w[1] === 'artwork' && Math.abs(w[0] - sentClientClock) < 3000);
  if (near) artMs.push(near[0] - sentClientClock);
}
console.log(`  artwork sent -> arrived: p50 ${pct(artMs, 0.5)}ms  p95 ${pct(artMs, 0.95)}ms  max ${pct(artMs, 1)}ms  (n=${artMs.length})`);

// ---- from the keypress to the pixel -------------------------------------
//
// Every other number here stops at a boundary. The player does not: what they feel
// is the time from pressing a key to the picture changing. That needs no clock
// alignment at all, because both ends are page-clock events - the input leaving,
// and the paint that shows its effect.
//
// The split below says which part of that wait belongs to the host, which to the
// wire, and which to the browser. Without it a total is just a number to argue
// about.
const displays = client.display || [];
const felt = [];
for (const [stamp, sentAt] of client.inputs) {
  const shown = displays.find((t) => t > sentAt);
  if (shown) felt.push(shown - sentAt);
}
console.log('\nKEYPRESS TO PIXEL (one clock, no alignment)');
console.log(`  input sent -> picture changed: p50 ${pct(felt, 0.5)}ms  p95 ${pct(felt, 0.95)}ms  max ${pct(felt, 1)}ms  (n=${felt.length})`);
console.log(`  host share (input arrival -> frame out): p50 ${pct(waits, 0.5)}ms`);
console.log(`  wire (frame sent -> client handler):     p50 ${pct(plausible, 0.5)}ms`);
console.log(`  browser (arrival -> applied):           p50 ${pct(client.arrivalToApply, 0.5)}ms`);
console.log(`  browser (applied -> pixels changed):    p50 ${pct(client.frameToDraw, 0.5)}ms`);
const accounted = (pct(waits, 0.5) || 0) + (pct(plausible, 0.5) || 0)
  + (pct(client.arrivalToApply, 0.5) || 0) + (pct(client.frameToDraw, 0.5) || 0);
console.log(`  sum of the parts: ${Math.round(accounted)}ms vs total ${pct(felt, 0.5)}ms`);
console.log(`  unaccounted: ${Math.round((pct(felt, 0.5) || 0) - accounted)}ms`);
console.log(`  display events in window: ${displays.length}, frames applied: ${client.framesApplied}`);

// ---- what the slow cases have in common ---------------------------------
//
// A median of 14ms with a p95 above a second is not a slow system, it is a fast
// one that stalls. The stall is the thing to explain, so the slow inputs are
// listed with what else was happening during their wait: pictures arriving, frames
// applied, and the longest gap in the render loop.
const slow = [];
for (const [stamp, sentAt] of client.inputs) {
  const shown = displays.find((t) => t > sentAt);
  if (!shown || shown - sentAt <= 500) continue;
  const art = client.wireEvents.filter((w) => w[1] === 'artwork' && w[0] >= sentAt && w[0] <= shown).length;
  const fr = client.wireEvents.filter((w) => (w[1] === 'frame' || w[1] === 'keyframe') && w[0] >= sentAt && w[0] <= shown).length;
  const gaps = client.trace.filter((e) => e[1] === 'loop-gap' && e[0] >= sentAt && e[0] <= shown)
    .map((e) => (e[2] && e[2].ms) || 0);
  slow.push({ ms: Math.round(shown - sentAt), art, fr, worstGap: Math.round(Math.max(0, ...gaps)) });
}
console.log(`\nSLOW CASES (over 500ms), n=${slow.length} of ${felt.length}`);
for (const r of slow.slice(0, 10)) {
  console.log(`  ${String(r.ms).padStart(5)}ms  artwork ${String(r.art).padStart(4)}  frames ${String(r.fr).padStart(3)}  worst render-loop gap ${r.worstGap}ms`);
}
if (slow.length) {
  const med = (k) => pct(slow.map((r) => r[k]), 0.5);
  console.log(`  median during a stall: ${med('art')} artwork msgs, ${med('fr')} frames, render-loop gap ${med('worstGap')}ms`);
}

console.log('\nNOTE the two exact shares are additive without alignment:');
console.log('  felt latency >= host wait + arrival->applied + applied->screen, plus wire time.');
