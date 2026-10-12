/**
 * df_wire_profile.mjs — measure where the delay actually is during rapid input.
 *
 * On hardware GL the client's main thread is ~98% idle during a rapid-input
 * burst, so the frozen frames are not client CPU. The client is waiting for
 * frames. This measures the wait itself:
 *
 *   - arrival time and size of every message from the game
 *   - the gap between consecutive frame deliveries (a stall is a long gap)
 *   - how much of the traffic is pictures vs frame data
 *   - how much of it is re-sent pictures the client asked for again
 *
 * The suspicion is that a sheet wipe makes the client ask for every picture at
 * once, the game then floods the wire with image data, and frames are starved
 * behind it. That is testable: image bytes and frame gaps should rise together.
 *
 * Output: /tmp/dfperf/wire.json
 */
import { chromium } from 'playwright';
import fs from 'node:fs';

const URL = process.env.QA_URL || 'http://192.168.1.111:8484/';
const OUT = process.env.PERF_OUT || '/tmp/dfperf';
const GAP = Number(process.env.GAP || 8);
const EVENTS = Number(process.env.EVENTS || 900);

fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({
  headless: true,
  args: process.env.SOFTWARE_GL === '1'
      ? ['--no-sandbox', '--use-gl=swiftshader', '--enable-unsafe-swiftshader']
      : ['--no-sandbox', '--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const consoleLines = [];
page.on('console', (m) => consoleLines.push(`[${m.type()}] ${m.text()}`));

await page.addInitScript(() => {
  // Every byte from the game arrives on a WebRTC data channel. Tag each message
  // by its 2-byte magic so pictures can be told apart from frame data.
  window.__W = { msgs: [], armed: false, t0: 0 };

  const tag = (buf) => {
    const u = new Uint8Array(buf);
    if (u.length >= 2 && u[0] === 0x44 && u[1] === 0x46) return 'frame';   // 'DF'
    if (u.length >= 2 && u[0] === 0x44 && u[1] === 0x54) {              // 'DT'
      // texId sits at offset 2 of the texture header, so each message can be
      // attributed to a specific picture rather than just counted as bytes.
      const id = u.length >= 4 ? (u[2] | (u[3] << 8)) : -1;
      return 'picture:' + id;
    }
    return 'other';
  };

  // The client assigns `onmessage` as a property, so intercepting the property
  // setter is the only place that sees every message.
  const record = (ev) => {
    if (window.__W.armed && ev && ev.data && ev.data.byteLength !== undefined) {
      window.__W.msgs.push([Math.round(performance.now() - window.__W.t0), ev.data.byteLength, tag(ev.data)]);
    }
  };
  const hook = (proto, label) => {
    if (!proto) return;
    const d = Object.getOwnPropertyDescriptor(proto, 'onmessage');
    if (!d || !d.set) return;
    Object.defineProperty(proto, 'onmessage', {
      configurable: true,
      get() { return d.get.call(this); },
      set(fn) {
        const wrapped = function (ev) { record(ev); return fn.apply(this, arguments); };
        wrapped.__wrapped = label;
        return d.set.call(this, wrapped);
      },
    });
  };
  if (typeof RTCDataChannel !== 'undefined') hook(RTCDataChannel.prototype, 'dc');
  if (typeof WebSocket !== 'undefined') hook(WebSocket.prototype, 'ws');

  // An atlas wipe reallocates the whole sheet. That is the event suspected of
  // making every picture go missing at once and triggering the re-send flood.
  window.__W.wipes = [];
  window.__W.reqIds = [];
  if (typeof WebGL2RenderingContext !== 'undefined') {
    const TI = WebGL2RenderingContext.prototype.texImage2D;
    WebGL2RenderingContext.prototype.texImage2D = function (...a) {
      const wipe = a.length === 9 && a[8] === null && a[3] === 4096 && a[4] === 4096;
      const r = TI.apply(this, a);
      if (wipe && window.__W.armed) window.__W.wipes.push(Math.round(performance.now() - window.__W.t0));
      return r;
    };
  }
  // Outgoing asset requests name the ids the client is missing.
  if (typeof RTCDataChannel !== 'undefined') {
    const S = RTCDataChannel.prototype.send;
    RTCDataChannel.prototype.send = function (d) {
      try {
        if (window.__W.armed && d && d.byteLength >= 7 && d.byteLength <= 8192) {
          const v = new DataView(d.buffer || d, d.byteOffset || 0, d.byteLength);
          if (v.getUint8(0) === 8) {                    // asset-bridge opcode
            const n = v.getUint16(5, true);
            const ids = [];
            for (let i = 0; i < n; i++) ids.push(v.getUint16(7 + i * 2, true));
            window.__W.reqIds.push([Math.round(performance.now() - window.__W.t0), ids]);
          }
        }
      } catch {}
      return S.apply(this, arguments);
    };
  }

  window.__lt = [];
  try {
    new PerformanceObserver((l) => { for (const e of l.getEntries()) window.__lt.push(Math.round(e.duration)); })
      .observe({ entryTypes: ['longtask'] });
  } catch {}
});

await page.goto(URL, { waitUntil: 'domcontentloaded' });
const launch = page.locator('text=Launch Game');
try { await launch.waitFor({ state: 'visible', timeout: 8000 }); await launch.click(); }
catch { console.log('attaching to running session'); }
await page.waitForSelector('canvas', { timeout: 120000 });
const box = await page.locator('canvas').first().boundingBox();

await page.waitForTimeout(18000);
const click = async (x, y, settle = 7000) => {
  await page.mouse.move(box.x + x, box.y + y);
  await page.waitForTimeout(400);
  await page.mouse.click(box.x + x, box.y + y);
  await page.waitForTimeout(settle);
};
console.log('-> arena');
await click(631, 472);
await click(180, 137, 3000);
await click(991, 678, 26000);

await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
await page.evaluate(() => {
  window.__W.msgs.length = 0; window.__W.t0 = performance.now();
  window.__W.armed = true; window.__lt.length = 0;
});

console.log(`rapid input: ${EVENTS} wheel events at ${GAP}ms gaps`);
for (let i = 0; i < EVENTS; i++) {
  await page.mouse.wheel(0, i % 2 === 0 ? 400 : -400);
  await page.waitForTimeout(GAP);
}
await page.waitForTimeout(2500);

const R = await page.evaluate(() => { window.__W.armed = false; return { msgs: window.__W.msgs, lt: window.__lt, wipes: window.__W.wipes, reqIds: window.__W.reqIds }; });
fs.writeFileSync(`${OUT}/wire.json`, JSON.stringify(R.msgs));
fs.writeFileSync(`${OUT}/console.log`, consoleLines.join('\n'));

const frames = R.msgs.filter((m) => m[2] === 'frame');
const pics = R.msgs.filter((m) => m[2].startsWith('picture'));
const other = R.msgs.filter((m) => m[2] === 'other');
const sum = (a) => a.reduce((s, m) => s + m[1], 0);

console.log('\n=== WIRE TRAFFIC DURING THE BURST ===');
console.log('frame messages  :', String(frames.length).padStart(6), (sum(frames) / 1024).toFixed(0).padStart(9), 'KB');
console.log('picture messages:', String(pics.length).padStart(6), (sum(pics) / 1024).toFixed(0).padStart(9), 'KB');
console.log('other messages  :', String(other.length).padStart(6), (sum(other) / 1024).toFixed(0).padStart(9), 'KB');
const allKb = (sum(R.msgs) / 1024).toFixed(0);
console.log('TOTAL           :', String(R.msgs.length).padStart(6), allKb.padStart(9), 'KB');
if (sum(R.msgs)) {
  console.log('=> pictures are', (100 * sum(pics) / sum(R.msgs)).toFixed(0) + '% of all bytes received');
}

// Gaps between consecutive frame deliveries: a frozen frame is a long gap.
const gaps = [];
for (let i = 1; i < frames.length; i++) gaps.push(frames[i][0] - frames[i - 1][0]);
const sorted = [...gaps].sort((a, b) => a - b);
console.log('\n=== FRAME DELIVERY (a frozen frame is a long gap) ===');
if (gaps.length) {
  const p = (q) => sorted[Math.floor(sorted.length * q)];
  console.log('frames delivered :', frames.length, 'over', ((frames[frames.length - 1][0]) / 1000).toFixed(1), 's');
  console.log('gap median       :', p(0.5), 'ms    p90:', p(0.9), 'ms    p99:', p(0.99), 'ms    worst:', sorted[sorted.length - 1], 'ms');
  console.log('gaps over 250ms  :', gaps.filter((g) => g > 250).length);
  console.log('gaps over 500ms  :', gaps.filter((g) => g > 500).length);
  console.log('gaps over 1000ms :', gaps.filter((g) => g > 1000).length);
  console.log('worst 10 gaps    :', sorted.slice(-10).join(', '), 'ms');
} else {
  console.log('no frames delivered');
}

// Do the stalls coincide with picture floods?
console.log('\n=== CORRELATION: picture bytes in the 1s before each long gap ===');
const big = gaps.map((g, i) => ({ g, at: frames[i + 1][0] })).filter((x) => x.g > 250).slice(0, 8);
if (!big.length) console.log('  no long gaps to correlate');
for (const { g, at } of big) {
  const from = at - 1000;
  const bytes = pics.filter((m) => m[0] >= from && m[0] <= at).reduce((s, m) => s + m[1], 0);
  const nFrames = frames.filter((m) => m[0] >= from && m[0] <= at).length;
  console.log(`  gap ${String(g).padStart(5)}ms ending at ${(at / 1000).toFixed(1)}s : ${(bytes / 1024).toFixed(0).padStart(6)} KB of pictures, ${nFrames} frames, in the preceding second`);
}

console.log('\n=== SHEET WIPES (each one makes every picture go missing) ===');
console.log('wipes during burst:', R.wipes.length);
if (R.wipes.length) console.log('  at (ms):', R.wipes.slice(0, 20).join(', '));

// Was the flood pictures the client asked for, or pictures pushed unasked?
const picIds = new Map();
for (const m of pics) {
  const id = Number(m[2].split(':')[1]);
  const e = picIds.get(id) || { bytes: 0, msgs: 0 };
  e.bytes += m[1]; e.msgs++; picIds.set(id, e);
}
const askedIds = new Set(R.reqIds.flatMap((r) => r[1]));
let askedBytes = 0, unaskedBytes = 0, askedN = 0, unaskedN = 0;
for (const [id, e] of picIds) {
  if (askedIds.has(id)) { askedBytes += e.bytes; askedN++; } else { unaskedBytes += e.bytes; unaskedN++; }
}
console.log('\n=== WAS THE FLOOD ASKED FOR? ===');
console.log('distinct pictures received :', picIds.size);
console.log('  asked for by the client  :', askedN, '=', (askedBytes / 1024).toFixed(0), 'KB');
console.log('  pushed unasked           :', unaskedN, '=', (unaskedBytes / 1024).toFixed(0), 'KB');
const tot = askedBytes + unaskedBytes;
if (tot) console.log('  => ' + (100 * unaskedBytes / tot).toFixed(0) + '% of picture bytes were sent without the client asking');
const biggestPics = [...picIds.entries()].sort((a, b) => b[1].bytes - a[1].bytes).slice(0, 6);
console.log('  biggest pictures received:');
for (const [id, e] of biggestPics) {
  console.log(`     id ${String(id).padStart(5)}  ${(e.bytes / 1024).toFixed(0).padStart(7)} KB  ${e.msgs} chunks  ${askedIds.has(id) ? 'ASKED' : 'unasked'}`);
}

console.log('\n=== ASSET REQUESTS THE CLIENT SENT ===');
const allIds = R.reqIds.flatMap((r) => r[1]);
const uniq = new Set(allIds);
console.log('requests:', R.reqIds.length, ' ids asked for:', allIds.length, ' distinct:', uniq.size);
const counts = new Map();
for (const id of allIds) counts.set(id, (counts.get(id) || 0) + 1);
const repeated = [...counts.entries()].filter(([, n]) => n > 1).sort((a, b) => b[1] - a[1]);
console.log('ids asked for MORE THAN ONCE:', repeated.length, '(re-sends, not new pictures)');
if (repeated.length) console.log('  worst:', repeated.slice(0, 10).map(([id, n]) => id + 'x' + n).join(', '));
if (R.reqIds.length) console.log('  first request at', (R.reqIds[0][0] / 1000).toFixed(2) + 's, last at', (R.reqIds[R.reqIds.length - 1][0] / 1000).toFixed(2) + 's');

console.log('\nlong tasks:', R.lt.length, ' blocked:', R.lt.reduce((a, b) => a + b, 0), 'ms');
await browser.close();
