// Compare the two paths frame for frame, on one timeline.
//
// Both clients run against the same game at the same time, so every instruction
// frame has a pixel frame that was displayed at the same instant. Pairing them by
// timestamp is the only honest comparison; pairing them by index drifts, and
// comparing their totals compares different amounts of work.
import { readFileSync } from 'node:fs';

const dir = process.argv[2];
if (!dir) { console.error('usage: pair-frames.mjs <run-dir>'); process.exit(2); }

const steps = readFileSync(`${dir}/steps.ndjson`, 'utf8').split('\n').filter(Boolean).map((l) => {
  try { return JSON.parse(l); } catch { return null; }
}).filter(Boolean);

const origin = steps.find((s) => s.what === 'timeOrigin')?.epochMs ?? null;
if (!origin) { console.error('no timeOrigin in the log: the clocks cannot be bridged'); process.exit(2); }

// Instruction frames: the page's own instants, moved onto the epoch clock.
const frames = steps
  .filter((s) => s.src === 'client' && s.interaction === 'parallel-instruction' && s.ev === 'frame-in')
  .map((s) => ({ seq: s.data?.seq, epoch: origin + s.at, at: s.at }))
  .filter((f) => Number.isFinite(f.seq))
  .sort((a, b) => a.epoch - b.epoch);

// Host side: per-frame bytes, and artwork bytes attributed to the interval since
// the previous frame (chunks do not carry a frame sequence, so the interval is the
// honest attribution available).
const hostPath = `${dir}/host-parallel.log`;
const host = readFileSync(hostPath, 'utf8').split('\n').filter(Boolean).map((l) => l.split(' '));
const frameBytes = new Map();
const chunkEvents = [];
for (const p of host) {
  if (p[1] === '6') frameBytes.set(Number(p[2]), Number(p[4]));
  if (p[1] === '15') chunkEvents.push({ t: Number(p[0]), bytes: Number(p[4]) });
}
// Monotonic frame times to attribute chunks between consecutive frames.
const monoFrames = host.filter((p) => p[1] === '6').map((p) => ({ t: Number(p[0]), seq: Number(p[2]) }));
chunkEvents.sort((a, b) => a.t - b.t);
const artBySeq = new Map();
let ci = 0;
for (let i = 0; i < monoFrames.length; i++) {
  const from = monoFrames[i].t;
  const to = i + 1 < monoFrames.length ? monoFrames[i + 1].t : Infinity;
  let sum = 0;
  while (ci < chunkEvents.length && chunkEvents[ci].t < to) {
    if (chunkEvents[ci].t >= from) sum += chunkEvents[ci].bytes;
    ci++;
  }
  artBySeq.set(monoFrames[i].seq, sum);
}

// Pixel frames: epoch microseconds, straight from the relay.
const pixel = readFileSync(`${dir}/server-parallel.log`, 'utf8').split('\n').filter(Boolean)
  .map((l) => l.split(' '))
  .filter((p) => p[1] === '102')
  .map((p) => ({ epoch: Number(p[0]) / 1000, bytes: Number(p[4]) }))
  .sort((a, b) => a.epoch - b.epoch);

// Nearest-in-time pairing.
let j = 0;
const pairs = [];
for (const f of frames) {
  while (j + 1 < pixel.length && Math.abs(pixel[j + 1].epoch - f.epoch) <= Math.abs(pixel[j].epoch - f.epoch)) j++;
  if (!pixel[j]) continue;
  const ib = (frameBytes.get(f.seq) || 0) + (artBySeq.get(f.seq) || 0);
  pairs.push({ dt: pixel[j].epoch - f.epoch, instr: ib, pix: pixel[j].bytes, seq: f.seq });
}
const q = (a, f) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.min(s.length - 1, Math.floor(s.length * f))] : 0; };
const absDt = pairs.map((p) => Math.abs(p.dt));
const ratio = pairs.filter((p) => p.pix > 0).map((p) => p.instr / p.pix);
const more = pairs.filter((p) => p.instr > p.pix);

console.log(`paired frames: ${pairs.length}  (of ${frames.length} instruction paints and ${pixel.length} pixel frames)`);
console.log(`clock alignment: median |dt| ${q(absDt, 0.5).toFixed(1)} ms, p95 ${q(absDt, 0.95).toFixed(1)} ms`);
console.log(`\ninstruction bytes per frame (delta + artwork in its interval):`);
console.log(`  p50 ${q(pairs.map((p) => p.instr), 0.5)} B   p95 ${q(pairs.map((p) => p.instr), 0.95)} B   max ${Math.max(...pairs.map((p) => p.instr))} B`);
console.log(`pixel bytes per frame:`);
console.log(`  p50 ${q(pairs.map((p) => p.pix), 0.5)} B   p95 ${q(pairs.map((p) => p.pix), 0.95)} B   max ${Math.max(...pairs.map((p) => p.pix))} B`);
console.log(`\nframes where instruction moved MORE than the pixel frame shown at that instant: ${more.length} of ${pairs.length}`);
if (more.length) {
  const worst = more.sort((a, b) => b.instr / b.pix - a.instr / a.pix).slice(0, 5);
  for (const m of worst) console.log(`  seq ${m.seq}: ${m.instr} B vs ${m.pix} B = ${(m.instr / m.pix).toFixed(1)}x`);
}
console.log(`ratio instr/pixel: p50 ${q(ratio, 0.5).toFixed(3)}  p95 ${q(ratio, 0.95).toFixed(3)}`);
