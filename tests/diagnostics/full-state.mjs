#!/usr/bin/env node
// One-shot diagnosis of "the client connects and the screen stays black".
//
// Written after a session of blind probing, where each iteration answered one
// question, cost a rebuild, and several questions were asked twice. This asks
// all of them at once and answers from a single run:
//
//   - Did the client receive frames? How many, and how far did the sequence get?
//   - Which pictures does the client name as missing, and when does that change?
//   - For each of those pictures: how many chunks did the SERVER send and how
//     many did the CLIENT receive? A mismatch localises the loss exactly.
//   - Did the server ever send a picture again in response to a request, or did
//     that path never run at all?
//   - Did the client give up on a picture, and how far had it got when it did?
//   - How much of the canvas is actually lit, over time?
//
// The client's traffic is decoded in the page itself by wrapping the data
// channel before any page script runs, so nothing here depends on the client
// exposing internals - except the counters it already publishes (window.__df*),
// which are read as corroboration, not as the primary evidence.
//
// Usage:
//   node scripts/df_diagnose.mjs --host 192.168.1.111 --label before-fix [--seconds 120]

import { chromium } from 'playwright';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const argv = process.argv.slice(2);
const arg = (name, dflt) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt;
};

const HOST = arg('host', '192.168.1.111');
const SSH = arg('ssh', `cyc@${HOST}`);
const CONTAINER = arg('container', 'remote-df');
const LABEL = arg('label', `run-${Date.now()}`);
const SECONDS = Number(arg('seconds', '150'));
const SAMPLE_MS = Number(arg('sample', '5000'));
// Resolved from this file, not the shell's directory: run from anywhere and
// the evidence still lands in the repo rather than beside the caller.
const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const OUT = `${REPO}/evidence/bench/diagnose/${LABEL}`;

mkdirSync(OUT, { recursive: true });

const sh = (cmd, args) => {
  try {
    return execFileSync(cmd, args, { encoding: 'utf8', timeout: 30000 });
  } catch (e) {
    return `<<command failed: ${e.message}>>`;
  }
};

// The decode table is injected into the page. It sees every binary message on
// every data channel and sorts them by magic, which is the only thing that can
// tell "the server never sent it" apart from "the client never kept it".
const HOOK = `
(() => {
  const T = { frames: [], chunks: {}, other: 0, channels: [] };
  window.__diag = T;
  const note = (buf) => {
    if (!(buf instanceof ArrayBuffer) || buf.byteLength < 4) { T.other++; return; }
    const v = new DataView(buf);
    const m0 = v.getUint8(0), m1 = v.getUint8(1);
    const t = performance.now();
    if (m0 === 0x44 && m1 === 0x46) {                       // 'D','F' frame
      T.frames.push({ t, seq: v.getUint32(2, true), flags: v.getUint16(6, true),
                      count: v.getUint16(8, true), bytes: buf.byteLength });
      return;
    }
    if (m0 === 0x44 && (m1 === 0x54 || m1 === 0x5a)) {       // 'D','T' / 'D','Z' picture
      const texId = v.getUint16(2, true), w = v.getUint16(4, true), h = v.getUint16(6, true);
      const totalLen = v.getUint32(8, true);
      const idx = v.getUint16(12, true), n = Math.max(1, v.getUint16(14, true));
      const e = T.chunks[texId] || (T.chunks[texId] = { w, h, totalLen, chunkCount: n,
                                                        seen: {}, bytes: 0, first: t, last: t });
      e.seen[idx] = (e.seen[idx] || 0) + 1;
      e.bytes += buf.byteLength; e.last = t;
      return;
    }
    T.other++;
  };
  const D = RTCDataChannel.prototype;
  const desc = Object.getOwnPropertyDescriptor(D, 'onmessage');
  if (desc && desc.set) {
    Object.defineProperty(D, 'onmessage', {
      configurable: true,
      get() { return this.__diagWrapped; },
      set(fn) {
        const wrapped = function (ev) { try { note(ev.data); } catch (_) {} return fn.call(this, ev); };
        this.__diagWrapped = wrapped;
        desc.set.call(this, wrapped);
      },
    });
  }
  const add = D.addEventListener;
  D.addEventListener = function (type, fn, opts) {
    if (type === 'message') {
      const wrapped = function (ev) { try { note(ev.data); } catch (_) {} return fn.call(this, ev); };
      return add.call(this, type, wrapped, opts);
    }
    return add.call(this, type, fn, opts);
  };
  const open = D.__proto__ && null;
  const OrigDC = window.RTCPeerConnection;
  window.RTCPeerConnection = function (...a) {
    const pc = new OrigDC(...a);
    pc.addEventListener('datachannel', (e) => { try { T.channels.push(e.channel.label); } catch (_) {} });
    return pc;
  };
  window.RTCPeerConnection.prototype = OrigDC.prototype;
})();
`;

const stats = async () => {
  try {
    const r = await fetch(`http://${HOST}:8484/df-stats`, { signal: AbortSignal.timeout(6000) });
    const d = await r.json();
    const dc = d.dc || {};
    return {
      frames: d.frames, textures: d.textureNew, clients: d.clients,
      wireBytes: d.wireBytes, sendCalls: dc.sendCalls, buffered: dc.bufferedMax,
    };
  } catch {
    return { error: 'df-stats unreachable' };
  }
};

const logLines = () =>
  sh('ssh', ['-o', 'ConnectTimeout=8', SSH,
    `podman logs --tail 4000 ${CONTAINER} 2>&1`]).split('\n');

const litFraction = (page) => page.evaluate(() => {
  const c = document.querySelector('canvas');
  if (!c) return -1;
  const t = document.createElement('canvas');
  t.width = 80; t.height = 50;
  const g = t.getContext('2d');
  g.drawImage(c, 0, 0, 80, 50);
  const d = g.getImageData(0, 0, 80, 50).data;
  let n = 0;
  for (let i = 0; i < d.length; i += 4) if (d[i] + d[i + 1] + d[i + 2] > 24) n++;
  return n / (80 * 50);
});

const clientState = (page) => page.evaluate(() => {
  const T = window.__diag || { frames: [], chunks: {}, other: 0, channels: [] };
  const pending = {};
  for (const [id, e] of Object.entries(T.chunks)) {
    // Only the ones that are not done. A frame names dozens of pictures and all
    // but one or two are single-chunk and complete immediately; listing those
    // buries the one that matters under a wall of "1/1".
    const held = Object.keys(e.seen).length;
    if (held < e.chunkCount) pending[id] = `${held}/${e.chunkCount}`;
  }
  return {
    frameCount: window.__dfFrameCount || 0,
    missing: window.__dfAssetsMissing,
    unfetchable: window.__dfAssetsUnfetchable,
    lastSeq: T.frames.length ? T.frames[T.frames.length - 1].seq : null,
    channels: T.channels,
    pictures: pending,
    otherMessages: T.other,
  };
});

const timeline = [];
const console_ = [];

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
await page.addInitScript(HOOK);
page.on('console', (m) => console_.push(`${(Date.now() / 1000).toFixed(1)} ${m.type()}: ${m.text()}`));
page.on('pageerror', (e) => console_.push(`PAGEERROR ${String(e).slice(0, 200)}`));

const t0 = Date.now();
await page.goto(`http://${HOST}:8484/df`, { waitUntil: 'domcontentloaded', timeout: 30000 });

while (Date.now() - t0 < SECONDS * 1000) {
  await page.waitForTimeout(SAMPLE_MS);
  const el = ((Date.now() - t0) / 1000).toFixed(0);
  const [lit, cs, st] = [await litFraction(page), await clientState(page), await stats()];
  timeline.push({ t: el, lit: +lit.toFixed(3), ...cs, server: st });
}

const server = await stats();
const logs = logLines();
const shot = `${OUT}/screen.png`;
await page.screenshot({ path: shot });
await browser.close();

const bad = (s) => s.includes('<<command failed');
const frames = logs.filter((l) => l.includes('FRAME_STATS'));
const bridges = logs.filter((l) => l.includes('ASSET_BRIDGE'));
const dumps = logs.filter((l) => l.includes('TEXDUMP'));
const svcsend = logs.filter((l) => l.includes('SVCSEND'));
const webrtc = logs.filter((l) => l.includes('DataChannel') && (l.includes('OPEN') || l.includes('CLOSED')));

// Which pictures the client named as missing, and how the server answered.
const requested = new Map();
for (const l of bridges) {
  const m = l.match(/Frame (\d+) asked for (\d+) asset\(s\); (\d+) queued for delivery, (\d+) not held here/);
  if (m) requested.set(`${m[1]}:${m[2]}`, { seq: +m[1], want: +m[2], queued: +m[3], notHeld: +m[4] });
}

const final = timeline[timeline.length - 1] || {};
const everLit = timeline.filter((r) => r.lit > 0.05).length;
const maxFrames = Math.max(...timeline.map((r) => r.frameCount), 0);

const lines = [];
const P = (s = '') => lines.push(s);
P(`# Diagnosis: ${LABEL}`);
P();
P(`host \`${HOST}\`  window ${SECONDS}s  sampled every ${SAMPLE_MS}ms`);
P(`screen: ${shot}`);
P();
P('## Timeline');
P();
P('| t | lit | frames | last seq | missing | unfetch | pictures held | server frames | clients |');
P('|---|---|---|---|---|---|---|---|---|');
for (const r of timeline) {
  P(`| ${r.t}s | ${r.lit} | ${r.frameCount} | ${r.lastSeq} | ${r.missing} | ${r.unfetchable} | ` +
    `${Object.entries(r.pictures).map(([k, v]) => `${k}:${v}`).join(' ') || '-'} | ` +
    `${r.server.frames ?? '?'} | ${r.server.clients ?? '?'} |`);
}
P();
P('## What the client received on the wire (decoded in the page)');
P();
const last = timeline[timeline.length - 1];
if (last && last.pictures && Object.keys(last.pictures).length) {
  P('| picture id | chunks received / total | bytes |');
  P('|---|---|---|');
  for (const [id, v] of Object.entries(last.pictures)) P(`| ${id} | ${v} | - |`);
} else {
  P('_no picture messages observed on any data channel_');
}
P();
P(`channels opened: ${JSON.stringify(last ? last.channels : [])}`);
P(`frames observed on the wire: ${maxFrames} (client counter), ` +
  `${(timeline[timeline.length - 1] || {}).lastSeq ?? '-'} (last server sequence seen)`);
P();
P('## What the server did');
P();
P(`- texture dumps to the client: ${dumps.length}`);
P(`- picture requests from the client: ${bridges.length}`);
P(`- final stats: ${JSON.stringify(server)}`);
P();
if (requested.size) {
  P('| request (seq:wanted) | queued | not held here |');
  P('|---|---|---|');
  for (const [k, v] of [...requested.entries()].slice(-14)) P(`| ${k} | ${v.queued} | ${v.notHeld} |`);
  P();
}
P(`- server-side send calls (SVCSEND) seen: ${svcsend.length}`);
if (svcsend.length) {
  const forced = svcsend.filter((l) => /force=1/.test(l)).length;
  P(`  - of which forced (a send triggered by something other than a draw): ${forced}`);
  P('  - last few:');
  for (const l of svcsend.slice(-4)) P(`    - \`${l.trim()}\``);
}
P(`- last FRAME_STATS: ${frames.length ? '`' + frames[frames.length - 1].trim() + '`' : '(none emitted)'}`);
P();
P('## Verdict');
P();
const verdicts = [];
if (bad(logs.join('\n'))) verdicts.push('could not read the server log - server unreachable?');
if (maxFrames === 0) verdicts.push('the client never received a single frame');
else if (everLit === 0) verdicts.push(`the client received ${maxFrames} frame(s) but never drew: ` +
  `the block is downstream of frame delivery, i.e. missing pictures`);
else verdicts.push(`the client drew (${everLit} samples lit)`);
if (final.missing > 0 && everLit === 0) verdicts.push(`blocked on ${final.missing} missing picture(s)`);
if (final.unfetchable > 0) verdicts.push(`${final.unfetchable} picture(s) abandoned by the client`);
if (bridges.length && svcsend.filter((l) => /force=1/.test(l)).length === 0)
  verdicts.push('the client asked for pictures and the server NEVER sent a forced frame in reply ' +
    '(the request path is not answering)');
for (const v of verdicts) P(`- ${v}`);
P();
P('## Client console (asset + render lines)');
P();
P('```');
P((console_.filter((l) => /Assets|progress|Giving up|DFRenderer|error|Error/.test(l)).slice(-20)
  .join('\n')) || '(nothing)');
P('```');

writeFileSync(`${OUT}/report.md`, lines.join('\n'));
writeFileSync(`${OUT}/server.log`, logs.join('\n'));
writeFileSync(`${OUT}/console.log`, console_.join('\n'));
writeFileSync(`${OUT}/timeline.json`, JSON.stringify(timeline, null, 1));

console.log(`wrote ${OUT}/report.md`);
console.log(lines.slice(lines.indexOf('## Verdict') + 2).filter((l) => l.startsWith('- ')).join('\n'));
