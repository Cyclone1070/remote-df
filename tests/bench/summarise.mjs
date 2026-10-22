// The bench's answer: both transports over the simulated network, side by side.
//
// It reads only what the runs wrote. Nothing here recomputes a metric: a summary
// that measures differently from the run it summarises is a second, silent bench.
//
// Usage:
//   node tests/bench/summarise.mjs        # median of the newest three runs
//   node tests/bench/summarise.mjs 5      # median of the newest five
import { readdirSync, readFileSync } from 'node:fs';

const ROOT = 'evidence/bench/interaction-matrix';
const REPEATS = Number(process.argv[2] || 1);

function runs(prefix, n) {
  // Sorted by the timestamp at the END of the name: `simulated-v4-...` sorts after
  // `simulated-2026-...` as a plain string, which once made the "newest" run a
  // baseline from hours earlier and every delta read as zero.
  const dirs = readdirSync(ROOT)
    .filter((d) => d.startsWith(`${prefix}-`))
    .map((d) => {
      const m = d.match(/(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z)$/);
      return { d, at: m ? m[1] : '' };
    })
    .filter((x) => x.at)
    .sort((a, b) => a.at.localeCompare(b.at));
  if (!dirs.length) return null;
  const picked = dirs.slice(-n).map((x) => JSON.parse(readFileSync(`${ROOT}/${x.d}/results.json`, 'utf8')));
  const byKey = new Map();
  for (const run of picked) {
    for (const r of run.results || []) {
      const k = `${r.path}|${r.interaction}`;
      if (!byKey.has(k)) byKey.set(k, []);
      byKey.get(k).push(r);
    }
  }
  const med = (xs) => {
    const v = xs.filter((x) => typeof x === 'number' && Number.isFinite(x)).sort((a, b) => a - b);
    return v.length ? v[Math.floor(v.length / 2)] : null;
  };
  const spread = (xs) => {
    const v = xs.filter((x) => typeof x === 'number' && Number.isFinite(x));
    return v.length > 1 ? Math.max(...v) - Math.min(...v) : null;
  };
  const out = [];
  for (const [k, rows] of byKey) {
    const [path, interaction] = k.split('|');
    out.push({
      path,
      interaction,
      verified: rows.filter((r) => r.verified).length > rows.length / 2,
      payload: { bytesPerSec: med(rows.map((r) => r.payload?.bytesPerSec)) },
      delivery: { picturesPerSec: med(rows.map((r) => r.delivery?.picturesPerSec)) },
      display: {
        gapP50: med(rows.map((r) => r.display?.gapP50)),
        gapP95: med(rows.map((r) => r.display?.gapP95)),
        gapSpread: spread(rows.map((r) => r.display?.gapP95)),
        worstGap: med(rows.map((r) => r.display?.worstGap)),
        stalls: med(rows.map((r) => r.display?.stalls)),
        idleGaps: med(rows.map((r) => r.display?.idleGaps)),
        silentGaps: med(rows.map((r) => r.display?.silentGaps)),
      },
    });
  }
  return { label: `${picked.length} runs, newest ${dirs[dirs.length - 1].d}`, results: out };
}

const run = runs('simulated', REPEATS);
if (!run) {
  console.log('no simulated run found - run tests/bench/matrix.sh first');
  process.exit(1);
}

const get = (o, ...ks) => {
  let v = o;
  for (const k of ks) {
    if (!v || typeof v !== 'object' || v[k] == null) return null;
    v = v[k];
  }
  return v;
};
const w = (s, n) => String(s).padEnd(n);
const c = (v, f = (x) => String(Math.round(x))) => (v == null ? '—' : f(v));
const kb = (row) => {
  const b = get(row, 'payload', 'bytesPerSec');
  return b == null ? null : b / 1024;
};

const byKey = new Map(run.results.map((r) => [`${r.path}|${r.interaction}`, r]));
const keys = [...byKey.keys()].sort();

console.log(`run: ${run.label}\n`);
console.log(
  w('path', 12) + w('interaction', 12) +
  w('KB/s', 9) + w('pics/s', 8) +
  w('gap50', 8) + w('gap95', 8) + w('+/-', 7) +
  w('worst', 8) + w('stalls', 8) + w('idle', 7) + 'silent',
);
for (const key of keys) {
  const r = byKey.get(key);
  const [path, interaction] = key.split('|');
  console.log(
    w(path, 12) + w(interaction, 12) +
    w(c(kb(r)), 9) + w(c(get(r, 'delivery', 'picturesPerSec')), 8) +
    w(c(get(r, 'display', 'gapP50')), 8) + w(c(get(r, 'display', 'gapP95')), 8) +
    w(c(get(r, 'display', 'gapSpread')), 7) +
    w(c(get(r, 'display', 'worstGap')), 8) +
    w(c(get(r, 'display', 'stalls')), 8) + w(c(get(r, 'display', 'idleGaps')), 7) +
    c(get(r, 'display', 'silentGaps')) + (r.verified ? '' : '  [no movement]'),
  );
}

// The comparison the bench exists for: the same interaction on both transports.
console.log('\nsame interaction, both transports:');
for (const interaction of [...new Set(keys.map((k) => k.split('|')[1]))].sort()) {
  const ins = byKey.get(`instruction|${interaction}`);
  const pix = byKey.get(`pixel|${interaction}`);
  if (!ins || !pix) continue;
  const a = get(ins, 'display', 'gapP95');
  const b = get(pix, 'display', 'gapP95');
  const ka = kb(ins), kbp = kb(pix);
  console.log(
    `  ${w(interaction, 10)} gap95 instruction ${String(a ?? '—').padStart(5)}ms  pixel ${String(b ?? '—').padStart(5)}ms` +
    (a != null && b != null && b > 0 ? `   (pixel ${(a / b).toFixed(1)}x better)` : '') +
    `   |  bytes instruction ${Math.round(ka ?? 0)} KB/s  pixel ${Math.round(kbp ?? 0)} KB/s`,
  );
}

console.log('\n— means not measured. gap50/gap95 are the intervals between pictures the');
console.log('  client actually displayed; stalls are long gaps with frames arriving,');
console.log('  idle are long gaps the host said were unchanged, silent are neither.');
