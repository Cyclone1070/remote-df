// Prints the newest result of each network side by side, so the bench ends with
// a readable answer instead of a directory of timestamps.
//
// It reads only what the matrix wrote. Nothing here recomputes a metric: a summary
// that measures differently from the run it summarises is a second, silent bench.
import { readdirSync, readFileSync } from 'node:fs';

const ROOT = 'evidence/bench/interaction-matrix';

function newest(label) {
  const dirs = readdirSync(ROOT)
    .filter((d) => d.startsWith(`${label}-`))
    .sort();
  if (!dirs.length) return null;
  const dir = `${ROOT}/${dirs[dirs.length - 1]}`;
  return { dir, data: JSON.parse(readFileSync(`${dir}/results.json`, 'utf8')) };
}

const runs = ['lan', 'simulated'].map((l) => [l, newest(l)]).filter(([, r]) => r);
if (!runs.length) {
  console.log('no matrix results found - run tests/bench/matrix.sh first');
  process.exit(0);
}

const num = (r, ...ks) => {
  let v = r;
  for (const k of ks) {
    if (!v || typeof v !== 'object' || v[k] == null) return null;
    v = v[k];
  }
  return v;
};
const cell = (v, f = (x) => String(Math.round(x))) => (v == null ? '—' : f(v));

const index = new Map();
for (const [label, run] of runs) {
  for (const r of run.data.results) {
    if (!r.verified) continue;
    index.set(`${r.path}|${r.interaction}`, { ...(index.get(`${r.path}|${r.interaction}`) || {}), [label]: r });
  }
}

const width = (s, n) => String(s).padEnd(n);
console.log(`${width('path', 12)}${width('interaction', 12)}${width('lan KB/s', 11)}${width('sim KB/s', 11)}${width('lan lat', 9)}${width('sim lat', 9)}${width('lan gap95', 11)}sim gap95`);
for (const [key, byNet] of [...index.entries()].sort()) {
  const [path, interaction] = key.split('|');
  const g = (label, ...ks) => {
    const r = byNet[label];
    return r ? num(r, ...ks) : null;
  };
  const kb = (label) => {
    const b = g(label, 'payload', 'bytesPerSec');
    return b == null ? null : b / 1024;
  };
  console.log(
    width(path, 12) + width(interaction, 12) +
    width(cell(kb('lan'), (x) => Math.round(x)), 11) + width(cell(kb('simulated'), (x) => Math.round(x)), 11) +
    width(cell(g('lan', 'latency', 'e2e', 'p50')), 9) + width(cell(g('simulated', 'latency', 'e2e', 'p50')), 9) +
    width(cell(g('lan', 'smoothness', 'gapP95')), 11) + cell(g('simulated', 'smoothness', 'gapP95')),
  );
}
console.log('\n— means not measured: either the input did not move the picture, or too few');
console.log('  inputs were attributable to quote. It never means "fast".');
