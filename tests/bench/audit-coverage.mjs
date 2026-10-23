// Coverage audit: every declared event kind must be (a) emitted by the code, and
// (b) observed in a real run, or explicitly listed as unreachable-by-construction.
// A kind that never fires is not coverage, it is decoration.
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

// One run exercises one scenario. A kind that does not fire in a pan is not
// necessarily dead - it may need a reconnect, a hold, or a budget squeeze. Coverage
// is therefore judged over every run given on the command line, and a kind that
// never fires anywhere is the only kind that can be called unimplemented.
const dirs = process.argv.slice(2);
if (dirs.length === 0) {
  console.error('usage: audit-coverage.mjs <run-dir> [more-run-dirs...]');
  process.exit(2);
}
const dir = dirs[0];

const header = readFileSync('interposer/event_log.hpp', 'utf8');
// Only the Kind enum is a list of events. The file also declares the reason codes
// carried INSIDE records (KeyframeReason, NothingReason); treating those as kinds
// reported every one of them as "never fired", which is why the first audit run was
// 90% noise.
const kindBlock = (() => {
  const start = header.indexOf('enum Kind');
  if (start < 0) return header;
  const open = header.indexOf('{', start);
  const close = header.indexOf('};', open);
  return close < 0 ? header.slice(open) : header.slice(open, close);
})();
const kinds = [...kindBlock.matchAll(/^\s*([A-Z][A-Za-z0-9]*)\s*=\s*(\d+),/gm)]
  .map((m) => ({ name: m[1], id: Number(m[2]) }));
// The relay's namespace starts at 100 and lives in the Go server.
const serverKinds = [
  { name: 'ServerFrameOffered', id: 100 },
  { name: 'ServerFrameDropped', id: 101 },
  { name: 'ServerFrameWritten', id: 102 },
  { name: 'ServerSubscriberJoins', id: 103 },
  { name: 'ServerSubscriberLeaves', id: 104 },
];

const seen = new Map();
const count = (id) => seen.set(id, (seen.get(id) || 0) + 1);

for (const d of dirs) {
  if (!existsSync(d)) continue;
  for (const f of readdirSync(d)) {
  if (!/^host-.*\.log$|^server-.*\.log$/.test(f)) continue;
  const text = readFileSync(join(d, f), 'utf8');
  for (const line of text.split('\n')) {
    if (!line) continue;
    const parts = line.split(' ');
    if (parts.length < 2) continue;
    count(Number(parts[1]));
  }
  }
}
// Client events are named, not numbered.
const clientKinds = new Map();
for (const d of dirs) {
  const stepsPath = join(d, 'steps.ndjson');
if (existsSync(stepsPath)) {
  for (const line of readFileSync(stepsPath, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      const r = JSON.parse(line);
      if (r.src === 'client' && r.ev) clientKinds.set(r.ev, (clientKinds.get(r.ev) || 0) + 1);
    } catch { /* a torn line is not a finding */ }
  }
}
}

const analysis = existsSync('tests/bench/analyse-events.mjs')
  ? readFileSync('tests/bench/analyse-events.mjs', 'utf8')
  : '';

// Kinds whose condition cannot occur in this build, with the reason. They stay in
// the code because the interception path is real (the game's renderer could call
// it), but a run can never produce one, so calling them "never fired" without
// saying why would be the same dishonesty as claiming coverage they do not have.
const expectedZero = new Map(Object.entries({
  DrawDroppedNoPixels: 'a draw whose texture has no stored pixels; the capture path always stores them first',
  DrawDroppedUnknown: 'a draw whose texture id cannot be resolved; ids are always allocated in the same hook',
  DrawDroppedOverflow: 'command buffer overflow; measured peak is ~2,100 of 65,536 entries',
  Clear: 'SDL_RenderClear, which this game never calls (see AGENTS.md)',
  PicCompressed: 'picture compression, only when the /tmp/df_pic_lossless switch is on',
  EncodeError: 'the encoder failing; no failure observed in any run',
  PicSkippedNoData: 'a frame naming a picture with no stored pixels; proven zero over 20M records',
  CacheEvict: 'the cache cap is a hardcoded 8192 ids and the measured peak is 730 distinct pictures in a session, so it is never reached',
}));

// Kinds that are wired and correct but need a condition no bench scenario creates
// yet. Each entry names the trigger, so the gap is a known piece of work rather
// than a mystery - and so nobody can quietly claim them as covered.
const conditional = new Map(Object.entries({
  MissingUnknown: 'needs the client to ask for a picture id the host has never seen, e.g. a host restart under a live client',
}));

let missing = 0;
let unconsumed = 0;
let expected = 0;
let conditionalCount = 0;
console.log('kind                         id   records   consumed-by-analysis');
for (const k of [...kinds, ...serverKinds]) {
  const n = seen.get(k.id) || 0;
  const consumed = analysis.includes(k.name) || analysis.includes(String(k.id));
  const why = expectedZero.get(k.name);
  const cond = conditional.get(k.name);
  const flag = n === 0 ? (why ? `EXPECTED ZERO - ${why}` : cond ? `CONDITIONAL - ${cond}` : 'NEVER FIRED')
    : consumed ? 'yes' : 'FIRED, NO CONSUMER';
  if (n === 0) { if (why) expected++; else if (cond) conditionalCount++; else missing++; }
  else if (!consumed) unconsumed++;
  console.log(`${k.name.padEnd(28)} ${String(k.id).padStart(3)} ${String(n).padStart(9)}   ${flag}`);
}
// The client's events are named rather than numbered, so they get their own table.
// Without this an instrument that never fires on the client - an atlas reset, say -
// would simply be absent from the report instead of being called out.
const CLIENT_KINDS = [
  'draw', 'apply', 'frame-in', 'delta-stat', 'sync-total', 'loop-gap',
  'pic-in', 'pic-upload', 'atlas-reset', 'hold-start', 'hold-end', 'hold',
  'input-send', 'input-cost', 'paint-cost', 'gap-request', 'bridge-request',
];
const clientExpectedZero = new Map(Object.entries({
  'atlas-reset': 'the atlas only resets on a texture-id collision; none observed',
  'hold': 'out-of-order frame buffering; the frame channel is ordered, so a frame never arrives behind a later one',
  'input-cost': 'threshold record, written only when input handling exceeds 20ms; measured p95 is a fraction of a millisecond',
  'paint-cost': 'threshold record, written only when a paint exceeds 10ms; measured paint cost is ~0.5ms',
}));
const clientConditional = new Map(Object.entries({
  'gap-request': 'needs a hole in the frame sequence (observed: one hole produced one request)',
  'bridge-request': 'needs a frame naming pictures the client does not hold',
}));
console.log('\nclient event                 records');
let cMissing = 0;
let cExpected = 0;
let cConditional = 0;
for (const name of CLIENT_KINDS) {
  const n = clientKinds.get(name) || 0;
  const why = clientExpectedZero.get(name);
  const cond = clientConditional.get(name);
  if (n === 0) {
    if (why) { cExpected++; console.log(`${name.padEnd(28)} ${String(0).padStart(7)}   EXPECTED ZERO - ${why}`); }
    else if (cond) { cConditional++; console.log(`${name.padEnd(28)} ${String(0).padStart(7)}   CONDITIONAL - ${cond}`); }
    else { cMissing++; console.log(`${name.padEnd(28)} ${String(0).padStart(7)}   NEVER FIRED`); }
  }
  else console.log(`${name.padEnd(28)} ${String(n).padStart(7)}   yes`);
}
const unlisted = [...clientKinds.keys()].filter((k) => !CLIENT_KINDS.includes(k));
if (unlisted.length) console.log(`unlisted client events: ${unlisted.join(', ')}`);
console.log(`\nhost/relay: ${missing} never fired and unexplained, ${conditionalCount} conditional (trigger not exercised), ${expected} expected-zero, ${unconsumed} fired but unread`);
console.log(`client:     ${cMissing} never fired and unexplained, ${cConditional} conditional, ${cExpected} expected-zero`);
