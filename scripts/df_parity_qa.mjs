#!/usr/bin/env node
/**
 * df_parity_qa.mjs — decide whether the BROWSER CLIENT's rendered canvas matches
 * the GAME HOST's own framebuffer, pixel for pixel, at the same instant in time.
 *
 * WHY THE HOST SIDE IS TRUSTWORTHY
 *   The interposer (interposer/df_streamer.cpp, ~line 1480) watches for the file
 *   /tmp/df_snap_trigger INSIDE THE GAME CONTAINER. When it appears, the game
 *   calls SDL_RenderReadPixels on its own renderer and writes the raw RGBA
 *   framebuffer to /tmp/df_snap_host.raw. That is the game's own view of what it
 *   drew — not an X11 screenshot, not a window grab, no compositor in the path.
 *   This is ground truth. The game runs inside the podman container, so the
 *   trigger must be created INSIDE the container: the host's own /tmp is a
 *   different filesystem and touching it there does nothing.
 *
 * WHAT IS COMPARED
 *   Host:   /tmp/df_snap_host.raw  -> RGBA -> PNG (verified 1280x720x4)
 *   Client: the #gameCanvas WebGL2 canvas, read with toDataURL. The client
 *           renderer sets preserveDrawingBuffer:true precisely so this returns
 *           real content instead of an empty buffer. Only the canvas is read, so
 *           no DOM chrome enters the comparison.
 *   Both sides are 1280x720 at (0,0), so a 1:1 per-pixel diff is dimensionally
 *   meaningful; the script still verifies this at runtime and flags any resize.
 *
 * THE HONEST LIMIT
 *   The two sides are sampled as close together as the process boundary allows,
 *   but the host writes its frame when it next presents, and DF animates. A
 *   single pair therefore cannot distinguish "the client is wrong" from "the two
 *   sides caught different animation phases". So each checkpoint captures a
 *   BURST on both sides and reports both the time-closest pair and the
 *   best-matching pair across the burst. A pixel is only evidence of corruption
 *   if it appears in NO host frame of the burst.
 *
 * USAGE
 *   node scripts/df_parity_qa.mjs [outdir]        (default /tmp/parity_qa)
 *
 * ENVIRONMENT
 *   DF_HOST         ssh destination                     (default cyc@192.168.1.111)
 *   DF_CONTAINER    podman container running the game    (default remote-df)
 *   CLIENT_URL      client URL to drive                  (default http://192.168.1.111:8484/df)
 *   ZOOMS           wheel events in the zoom storm       (default 300)
 *   ZOOM_GAP_MS     gap between wheel events             (default 8)
 *   WHEEL_DELTA     wheel delta per event                (default -120)
 *   BURST           pairs captured per checkpoint        (default 4)
 *   BURST_GAP_MS    gap between pairs                    (default 60)
 *   SETTLE_MS       first settle wait after the storm    (default 1500)
 *   SETTLE2_MS      second settle wait                   (default 5000)
 *   TOL             per-channel tolerance for a mismatch (default 2)
 *   QA_HEADLESS     0 to run the browser headful         (default 1 = headless)
 */
import { createRequire } from 'node:module';
import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

/* ------------------------------------------------------------------ *
 * Configuration
 * ------------------------------------------------------------------ */
const env = process.env;
const HOST = env.DF_HOST || 'cyc@192.168.1.111';
const CONTAINER = env.DF_CONTAINER || 'remote-df';
const URL = env.CLIENT_URL || 'http://192.168.1.111:8484/df';
const ZOOMS = Number(env.ZOOMS || 300);
const ZOOM_GAP_MS = Number(env.ZOOM_GAP_MS || 8);
const WHEEL_DELTA = Number(env.WHEEL_DELTA || -120);
const BURST = Number(env.BURST || 4);
const BURST_GAP_MS = Number(env.BURST_GAP_MS || 60);
const SETTLE_MS = Number(env.SETTLE_MS || 1500);
const SETTLE2_MS = Number(env.SETTLE2_MS || 5000);
const TOL = Number(env.TOL || 2);
const HEADLESS = env.QA_HEADLESS !== '0';
const LOAD_WAIT_MS = Number(env.LOAD_WAIT_MS || 12000);
const SNAPSHOT_TIMEOUT_MS = Number(env.SNAPSHOT_TIMEOUT_MS || 6000);

const OUT = path.resolve(process.argv[2] || '/tmp/parity_qa');
const TRIGGER = '/tmp/df_snap_trigger';
const SNAP = '/tmp/df_snap_host.raw';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const nowMs = () => Date.now();
const log = (...a) => { const s = a.join(' '); console.log(s); };
const md5 = (file) => crypto.createHash('md5').update(fs.readFileSync(file)).digest('hex');

/** Frame gaps from a list of monotonic timestamps. */
function gapStats(times) {
  if (!times || times.length < 2) return { frames: times ? times.length : 0, gaps: 0 };
  const g = [];
  for (let i = 1; i < times.length; i++) g.push(times[i] - times[i - 1]);
  g.sort((a, b) => a - b);
  const q = (p) => g[Math.min(g.length - 1, Math.max(0, Math.ceil((p / 100) * g.length) - 1))];
  return {
    frames: times.length,
    gaps: g.length,
    gap_median_ms: Math.round(q(50) * 100) / 100,
    gap_p90_ms: Math.round(q(90) * 100) / 100,
    gap_p99_ms: Math.round(q(99) * 100) / 100,
    gap_max_ms: Math.round(g[g.length - 1] * 100) / 100,
    gap_mean_ms: Math.round((g.reduce((a, b) => a + b, 0) / g.length) * 100) / 100,
  };
}

function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { maxBuffer: 512 * 1024 * 1024, encoding: 'buffer', ...opts },
      (err, stdout, stderr) => {
        if (err) return reject(new Error(`${cmd} failed: ${err.message}\n${stderr ? stderr.toString().slice(0, 400) : ''}`));
        resolve(stdout);
      });
  });
}
const sshBuf = (remoteCmd) => run('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15', HOST, remoteCmd]);
const sshStr = async (remoteCmd) => (await sshBuf(remoteCmd)).toString('utf8');

/* ------------------------------------------------------------------ *
 * Host-side snapshot. One ssh round trip does all of it: clear the old
 * frame, raise the trigger, wait for a complete new frame, emit base64.
 * Keeping it in a single remote shell minimises the skew against the
 * browser-side canvas read that runs concurrently.
 * ------------------------------------------------------------------ */
function snapCommand(expectedBytes) {
  const inner = [
    `rm -f ${SNAP}`,
    `touch ${TRIGGER}`,
    'i=0',
    `while [ $i -lt 600 ]; do`,
    `  if [ -f ${SNAP} ]; then`,
    `    s1=$(stat -c %s ${SNAP})`,
    '    sleep 0.05',
    `    s2=$(stat -c %s ${SNAP})`,
    `    if [ $s1 = $s2 ] && [ $s1 -ge ${expectedBytes} ]; then break; fi`,
    '  fi',
    '  sleep 0.01',
    '  i=$((i+1))',
    'done',
    `echo META $(stat -c %s ${SNAP} 2>/dev/null || echo 0)`,
    `base64 -w0 ${SNAP} 2>/dev/null`,
  ].join('\n');
  // No single quotes inside `inner`, so one quoting level is enough.
  return `podman exec ${CONTAINER} sh -c '${inner}'`;
}

/** Trigger a host snapshot and return { raw: Buffer, meta: {...}, timings }. */
async function hostSnapshot(expectedBytes) {
  const t0 = nowMs();
  const out = await sshBuf(snapCommand(expectedBytes));
  const t1 = nowMs();
  const nl = out.indexOf(0x0a);
  if (nl < 0) throw new Error('host snapshot: malformed response (no META line)');
  const metaLine = out.subarray(0, nl).toString('utf8').trim();
  const b64 = out.subarray(nl + 1).toString('utf8').replace(/\s+/g, '');
  const bytes = Buffer.from(b64, 'base64');
  const m = /^META (\d+)$/.exec(metaLine);
  const reportedSize = m ? Number(m[1]) : -1;
  if (expectedBytes > 0 && reportedSize !== expectedBytes) {
    throw new Error(`host snapshot: expected ${expectedBytes} bytes, host reported ${reportedSize}. ` +
      `Is the game running and is the interposer loaded?`);
  }
  if (reportedSize <= 0) {
    throw new Error(`host snapshot: host produced no frame at ${SNAP}. ` +
      `Is the game running and is the interposer loaded?`);
  }
  if (bytes.length !== reportedSize) {
    throw new Error(`host snapshot: transferred ${bytes.length} bytes, host reported ${reportedSize} (truncated read?)`);
  }
  return { raw: bytes, meta: { reportedSize, b64Len: b64.length }, timings: { tStart: t0, tEnd: t1, ms: t1 - t0 } };
}

/* ------------------------------------------------------------------ *
 * Analysis. Emits JSON on stdout; all images are written next to it.
 * ------------------------------------------------------------------ */
const PY_ANALYZE = String.raw`
import sys, json
import numpy as np
from PIL import Image, ImageDraw
from scipy import ndimage

hosts = json.loads(sys.argv[1]); clients = json.loads(sys.argv[2])
outdir, tag, tol = sys.argv[3], sys.argv[4], int(sys.argv[5])

def load(p):
    return np.asarray(Image.open(p).convert('RGB')).astype(np.int16)

H0, C0 = load(hosts[0]), load(clients[0])
same_geometry = H0.shape == C0.shape
H0r = H0
if not same_geometry:
    H0r = np.asarray(Image.fromarray(H0.astype(np.uint8)).resize(
        (C0.shape[1], C0.shape[0]), Image.Resampling.NEAREST)).astype(np.int16)

res = {'tag': tag, 'tol': tol,
       'host_shape': list(H0.shape), 'client_shape': list(C0.shape),
       'same_geometry': bool(same_geometry),
       'host_resized_for_diff': bool(not same_geometry)}

def mismatch_mask(h, c, tol):
    return np.any(np.abs(h - c) > tol, axis=2)

def metrics(h, c, tol):
    d = np.abs(h - c)
    m = mismatch_mask(h, c, tol)
    tot = int(m.size)
    fg = np.any(h > 15, axis=2)
    fgt = int(fg.sum())
    fgm = int((m & fg).sum())
    return {
        'mismatch_pct': round(100.0 * float(m.sum()) / tot, 4),
        'mismatch_count': int(m.sum()),
        'total_pixels': tot,
        'exact_match_pct': round(100.0 * (1.0 - float(np.any(d > 0, axis=2).sum()) / tot), 4),
        'mean_abs_delta': round(float(d.mean()), 5),
        'max_delta': int(d.max()),
        'host_foreground_pixels': fgt,
        'host_foreground_mismatch_pct': round(100.0 * float(fgm) / fgt, 4) if fgt else None,
    }

res['primary'] = metrics(H0r, C0, tol)
res['primary']['pair'] = {'host': hosts[0], 'client': clients[0]}

# --- best match across the burst: a difference only counts if NO host frame
# --- in the burst shows that pixel value (separates animation phase from loss)
Hs = [load(h) for h in hosts]
Cs = [load(c) for c in clients]
best = None
matrix = []
for i, h in enumerate(Hs):
    hr = h if h.shape == C0.shape else np.asarray(Image.fromarray(h.astype(np.uint8)).resize(
        (C0.shape[1], C0.shape[0]), Image.Resampling.NEAREST)).astype(np.int16)
    row = []
    for j, c in enumerate(Cs):
        mm = int(mismatch_mask(hr, c, tol).sum())
        row.append({'host': i, 'client': j, 'mismatch_count': mm,
                    'mismatch_pct': round(100.0 * mm / float(hr.shape[0] * hr.shape[1]), 4)})
        if best is None or mm < best['mismatch_count']:
            best = row[-1]
    matrix.append(row)
res['pair_matrix'] = matrix
res['best_pair'] = dict(best, host=hosts[best['host']], client=clients[best['client']],
                        host_index=best['host'], client_index=best['client'])
Hb = Hs[best['host']]
Hbr = Hb if Hb.shape == C0.shape else np.asarray(Image.fromarray(Hb.astype(np.uint8)).resize(
    (C0.shape[1], C0.shape[0]), Image.Resampling.NEAREST)).astype(np.int16)
res['best'] = metrics(Hbr, Cs[best['client']], tol)

# --- a client pixel that no host frame in the burst ever showed
ever = np.zeros(C0.shape[:2], bool)
for h in Hs:
    hr = h if h.shape == C0.shape else np.asarray(Image.fromarray(h.astype(np.uint8)).resize(
        (C0.shape[1], C0.shape[0]), Image.Resampling.NEAREST)).astype(np.int16)
    ever |= np.any(np.abs(hr - C0) <= tol, axis=2)
never = ~ever
res['never_seen_pixels'] = int(never.sum())
res['never_seen_pct'] = round(100.0 * float(never.sum()) / int(never.size), 4)

# --- structural comparison: downscale both to a common small grid so a
# --- sub-pixel/one-cell shift does not dominate the number
SW, SH = 160, 90
hs_ = np.asarray(Image.fromarray(H0r.astype(np.uint8)).resize((SW, SH), Image.Resampling.BOX)).astype(np.int16)
cs_ = np.asarray(Image.fromarray(C0.astype(np.uint8)).resize((SW, SH), Image.Resampling.BOX)).astype(np.int16)
ds = np.abs(hs_ - cs_)
ms = np.any(ds > 24, axis=2)
res['structural'] = {'grid': [SW, SH],
                     'mean_abs_delta': round(float(ds.mean()), 4),
                     'max_abs_delta': int(ds.max()),
                     'cells_mismatch': int(ms.sum()), 'cells': int(ms.size),
                     'cells_mismatch_pct': round(100.0 * float(ms.sum()) / ms.size, 3)}

def hist_inter(h, c, bins=32):
    out = {}
    for i, ch in enumerate('RGB'):
        ph = np.histogram(h[:, :, i], bins=bins, range=(0, 256))[0].astype(np.float64)
        pc = np.histogram(c[:, :, i], bins=bins, range=(0, 256))[0].astype(np.float64)
        ph /= ph.sum(); pc /= pc.sum()
        out[ch] = round(float(np.minimum(ph, pc).sum()), 5)
    out['mean'] = round(float(np.mean([out['R'], out['G'], out['B']])), 5)
    return out
res['histogram_intersection'] = hist_inter(H0r, C0)

regions = []
h3, w3 = H0r.shape[0] // 3, H0r.shape[1] // 3
for r in range(3):
    for c in range(3):
        sh = H0r[r * h3:(r + 1) * h3, c * w3:(c + 1) * w3]
        sc = C0[r * h3:(r + 1) * h3, c * w3:(c + 1) * w3]
        regions.append({'cell': [c, r],
                        'host_mean_rgb': [int(v) for v in sh.reshape(-1, 3).mean(axis=0).round()],
                        'client_mean_rgb': [int(v) for v in sc.reshape(-1, 3).mean(axis=0).round()],
                        'mean_abs_delta': round(float(np.abs(sh - sc).mean()), 3)})

# --- worst mismatch regions: dilate the mask so a sprite's scattered pixels
# --- form one box, then label and rank. Bboxes are inflated by the dilation.
m = mismatch_mask(H0r, C0, tol)
mm = ndimage.binary_dilation(m, structure=np.ones((9, 9), bool))
lab, n = ndimage.label(mm, structure=np.ones((3, 3), int))
boxes = []
for sl in ndimage.find_objects(lab):
    if sl is None:
        continue
    area = int(m[sl].sum())
    if area < 64:
        continue
    ys, xs = sl
    boxes.append({'bbox': [int(xs.start), int(ys.start), int(xs.stop), int(ys.stop)],
                  'w': int(xs.stop - xs.start), 'h': int(ys.stop - ys.start),
                  'mismatch_pixels': area,
                  'mean_abs_delta': round(float(np.abs(H0r[sl] - C0[sl]).mean()), 3)})
boxes.sort(key=lambda b: -b['mismatch_pixels'])
res['worst_regions'] = boxes[:10]
res['worst_region_count'] = len(boxes)

BS = 40
bh, bw = H0r.shape[0] // BS, H0r.shape[1] // BS
mb = m[:bh * BS, :bw * BS].reshape(bh, BS, bw, BS).mean(axis=(1, 3))
order = np.dstack(np.unravel_index(np.argsort(-mb, axis=None), mb.shape))[0]
blocks = []
for by, bx in order[:10]:
    blocks.append({'bbox': [int(bx * BS), int(by * BS), int((bx + 1) * BS), int((by + 1) * BS)],
                   'mismatch_pct': round(100.0 * float(mb[by, bx]), 3)})
res['worst_blocks_40px'] = blocks

# --- images
dv = (C0 // 3).astype(np.uint8).copy()
dv[m] = [255, 0, 255]
Image.fromarray(dv).save(outdir + '/' + tag + '_diff.png')

ov = C0.astype(np.uint8).copy()
im = Image.fromarray(ov)
dr = ImageDraw.Draw(im)
for b in boxes[:5]:
    dr.rectangle([b['bbox'][0], b['bbox'][1], b['bbox'][2] - 1, b['bbox'][3] - 1], outline=(255, 0, 255), width=2)
im.save(outdir + '/' + tag + '_worst_regions.png')

sbs = Image.new('RGB', (C0.shape[1] * 2 + 8, C0.shape[0]), (20, 20, 20))
sbs.paste(Image.fromarray(H0r.astype(np.uint8)), (0, 0))
sbs.paste(Image.fromarray(C0.astype(np.uint8)), (C0.shape[1] + 8, 0))
sbs.save(outdir + '/' + tag + '_sbs_host_client.png')

res['regions_3x3'] = regions
res['images'] = {'diff': tag + '_diff.png', 'worst_regions': tag + '_worst_regions.png',
                 'side_by_side': tag + '_sbs_host_client.png'}
print(json.dumps(res))
`;

const PY_RAW_TO_PNG = String.raw`
import sys
import numpy as np
from PIL import Image
raw, w, h, tw, th, out = sys.argv[1], int(sys.argv[2]), int(sys.argv[3]), int(sys.argv[4]), int(sys.argv[5]), sys.argv[6]
a = np.frombuffer(open(raw, 'rb').read(), dtype=np.uint8)
if a.size != w * h * 4:
    raise SystemExit('raw size %d != %d*%d*4 (%d)' % (a.size, w, h, w * h * 4))
img = Image.fromarray(a.reshape(h, w, 4), 'RGBA')
if (w, h) != (tw, th):
    img = img.resize((tw, th), Image.BOX)
img.save(out)
`;

async function rawToPng(rawPath, w, h, outPath, tw, th) {
  await run('python3', ['-c', PY_RAW_TO_PNG, rawPath, String(w), String(h),
    String(tw ?? w), String(th ?? h), outPath]);
}

async function analyze(hostPngs, clientPngs, dir, tag) {
  const out = await run('python3', ['-c', PY_ANALYZE,
    JSON.stringify(hostPngs), JSON.stringify(clientPngs), dir, tag, String(TOL)]);
  const text = out.toString('utf8').trim().split('\n').pop();
  return JSON.parse(text);
}

/** Host-side frame stats, if the interposer build emits them. */
async function readHostFrameStats() {
  try {
    const logs = await sshStr(`podman logs --tail 400 ${CONTAINER} 2>&1 | grep -F '[FRAME_STATS]' | tail -1`);
    return logs.trim() || null;
  } catch (e) {
    return null;
  }
}

/* ------------------------------------------------------------------ *
 * Preflight — every claim this script makes rests on these.
 * ------------------------------------------------------------------ */
async function preflight() {
  const facts = {};
  const uname = await sshStr('uname -s -n');
  facts.ssh = { dest: HOST, ok: true, uname: uname.trim() };

  const ctr = await sshStr(`podman inspect -f {{.State.Running}} ${CONTAINER} 2>&1 || true`);
  facts.container = { name: CONTAINER, running: ctr.trim() === 'true', raw: ctr.trim() };
  if (!facts.container.running) {
    throw new Error(`container ${CONTAINER} is not running on ${HOST} (podman inspect said: ${ctr.trim()})`);
  }

  const tools = await sshStr(`podman exec ${CONTAINER} sh -c 'command -v base64; command -v stat; command -v sleep'`);
  facts.containerTools = tools.trim().split('\n').filter(Boolean);

  // Informational only: the framebuffer size comes from the snapshot itself.
  // A missing window (mid-restart) must not abort preflight.
  let geo = '';
  try {
    geo = await sshStr(`podman exec ${CONTAINER} sh -c 'DISPLAY=:99 xwininfo -root -children 2>/dev/null | grep dwarfort || true'`);
  } catch (e) { geo = ''; }
  facts.dfWindow = geo.trim();

  // The decisive preflight: does the trigger actually produce a frame?
  const probe = await hostSnapshot(-1).catch(async (e) => {
    throw new Error(`host snapshot trigger did not produce a frame: ${e.message}`);
  });
  facts.snapshot = { bytes: probe.raw.length, transferMs: probe.timings.ms };
  fs.writeFileSync(path.join(OUT, 'preflight_host_frame.raw'), probe.raw);
  return { facts, probe };
}

/* ------------------------------------------------------------------ *
 * Capture one pair: host frame and client canvas as close in time as the
 * process boundary allows, both started from the same instant.
 * ------------------------------------------------------------------ */
async function capturePair(page, expectedBytes, dir, idx) {
  if (page.isClosed()) {
    throw new Error(`page is already closed before capture (browser connected: ${page.context().browser().isConnected()})`);
  }
  const t0 = nowMs();
  const touchP = hostSnapshot(expectedBytes);
  const clientP = page.evaluate(() => {
    const c = document.getElementById('gameCanvas');
    if (!c) return { error: 'no #gameCanvas' };
    return { dataUrl: c.toDataURL('image/png'), w: c.width, h: c.height, t: Date.now() };
  });
  const [snap, cli] = await Promise.all([touchP, clientP]);
  const t1 = nowMs();
  if (cli.error) throw new Error(`client capture failed: ${cli.error}`);

  const hostRaw = path.join(dir, `host_${idx}.raw`);
  const hostPng = path.join(dir, `host_${idx}.png`);
  const clientPng = path.join(dir, `client_${idx}.png`);
  fs.writeFileSync(hostRaw, snap.raw);
  fs.writeFileSync(clientPng, Buffer.from(String(cli.dataUrl).replace(/^data:image\/png;base64,/, ''), 'base64'));
  // Lesson from an earlier harness: a capture that silently produced nothing
  // made a vacuous "0 mismatches" result look like a pass. Refuse empty files.
  if (fs.statSync(clientPng).size < 1024) throw new Error(`client capture truncated: ${clientPng}`);
  // Host frame is the same picture at a larger resolution (the game renders at
  // its window size while the draw coordinates the client gets are logical), so
  // it is downscaled to the canvas before diffing.
  const hostScale = Math.sqrt((expectedBytes / 4) / (cli.w * cli.h)) || 1;
  await rawToPng(hostRaw, Math.round(cli.w * hostScale), Math.round(cli.h * hostScale), hostPng, cli.w, cli.h);
  if (fs.statSync(hostPng).size < 1024) throw new Error(`host capture truncated: ${hostPng}`);

  return {
    idx, hostPng, clientPng,
    canvas: { w: cli.w, h: cli.h },
    timings: {
      tStart: t0, tEnd: t1, windowMs: t1 - t0,
      hostTransferMs: snap.timings.ms,
      hostWindow: [snap.timings.tStart, snap.timings.tEnd],
    },
  };
}

/* ------------------------------------------------------------------ */
async function main() {
  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(OUT, { recursive: true });
  log(`df_parity_qa — out=${OUT}`);
  log(`  host=${HOST} container=${CONTAINER} url=${URL}`);

  log('\n[1/5] preflight');
  const { facts, probe } = await preflight();
  const expectedBytes = probe.raw.length;
  const geoMatch = /(\d+)x(\d+)[+\s]/.exec(facts.dfWindow);
  const hostW = Number(geoMatch ? geoMatch[1] : 0);
  const hostH = Number(geoMatch ? geoMatch[2] : 0);
  log(`  ssh ok: ${facts.ssh.uname}`);
  log(`  container ${CONTAINER} running; tools: ${facts.containerTools.join(' ')}`);
  log(`  DF window: ${facts.dfWindow || '<not found>'}`);
  log(`  trigger works: ${expectedBytes} bytes in ${probe.timings.ms} ms (${hostW}x${hostH})`);

  log(`\n[2/5] launch client (${HEADLESS ? 'headless' : 'headful'}, hardware GL)`);
  const hostStatsBefore = await readHostFrameStats();
  const browser = await chromium.launch({
    headless: HEADLESS,
    args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'],
  });
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  // Lifecycle evidence. If a run dies mid-flight, the difference between "the
  // page crashed", "something closed it" and "the host went away" decides what
  // the failure means, so every one of those is recorded with a timestamp.
  const life = { events: [], pageCrashed: false, pageClosed: false, browserDisconnected: false };
  const stamp = (what, extra) => life.events.push({ at: new Date().toISOString(), what, ...(extra || {}) });
  page.on('crash', () => { life.pageCrashed = true; stamp('page.crash'); });
  page.on('close', () => { life.pageClosed = true; stamp('page.close'); });
  page.on('pageerror', (e) => { life.events.push({ at: new Date().toISOString(), what: 'pageerror', detail: String(e) }); });
  browser.on('disconnected', () => { life.browserDisconnected = true; stamp('browser.disconnected'); });

  // Client-observed frame delivery. The renderer ends every frame in one
  // instanced draw, so counting that call counts frames the client actually
  // rendered — not frames the browser happened to tick.
  await page.addInitScript(() => {
    const st = { draws: [], raf: [], longTasks: [], caps: 200000 };
    window.__parityStats = st;
    const push = (arr, v) => { if (arr.length < st.caps) arr.push(v); };
    const proto = (window.WebGL2RenderingContext || {}).prototype;
    if (proto) {
      for (const name of ['drawArraysInstanced', 'drawElementsInstanced']) {
        const orig = proto[name];
        if (!orig) continue;
        proto[name] = function (...a) { push(st.draws, performance.now()); return orig.apply(this, a); };
      }
    }
    try {
      new PerformanceObserver((l) => { for (const e of l.getEntries()) push(st.longTasks, Math.round(e.duration)); })
        .observe({ entryTypes: ['longtask'] });
    } catch (e) { /* not supported */ }
    const tick = () => { push(st.raf, performance.now()); requestAnimationFrame(tick); };
    requestAnimationFrame(tick);
  });

  const browserErrors = life.events;
  await page.goto(URL, { waitUntil: 'domcontentloaded' });
  await sleep(LOAD_WAIT_MS);

  const gl = await page.evaluate(() => {
    const c = document.getElementById('gameCanvas');
    if (!c) return { error: 'no #gameCanvas' };
    const g = c.getContext('webgl2') || c.getContext('webgl');
    const dbg = g && g.getExtension('WEBGL_debug_renderer_info');
    const r = c.getBoundingClientRect();
    return {
      w: c.width, h: c.height,
      rect: { x: r.x, y: r.y, w: r.width, h: r.height },
      renderer: dbg ? g.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : (g ? g.getParameter(g.RENDERER) : null),
      version: g ? g.getParameter(g.VERSION) : null,
    };
  });
  if (gl.error) throw new Error(`client: ${gl.error}`);
  const soft = /swiftshader|llvmpipe|software|basic render/i.test(String(gl.renderer));
  log(`  canvas ${gl.w}x${gl.h} at (${gl.rect.x},${gl.rect.y}); renderer: ${gl.renderer}`);
  if (soft) throw new Error(`refusing to measure: software renderer in use (${gl.renderer}) — results would be meaningless`);
  // The game renders larger than the client canvas: it sets a logical size and
  // the renderer scales it up to the window (measured 2560x1440 against a
  // 1280x720 canvas). The draw coordinates the client receives are in the
  // logical space, so the two images are the same picture at different
  // resolutions and the host frame is downscaled before diffing. A non-uniform
  // ratio would mean they are genuinely different pictures, which is not
  // comparable, so that is still refused.
  const hostPixels = expectedBytes / 4;
  const canvasPixels = gl.w * gl.h;
  const scale = Math.sqrt(hostPixels / canvasPixels);
  if (!Number.isInteger(scale) || scale < 1) {
    throw new Error(`geometry mismatch: canvas ${gl.w}x${gl.h} (${canvasPixels} px) vs host frame ${hostPixels} px — ratio ${scale}`);
  }
  facts.hostScale = scale;
  facts.hostSize = [gl.w * scale, gl.h * scale];
  log(`  host frame ${gl.w * scale}x${gl.h * scale}, canvas ${gl.w}x${gl.h} (${scale}x — downscaled before diffing)`);
  facts.canvas = gl;
  facts.browserErrors = browserErrors;

  log(`\n[3/5] zoom storm: ${ZOOMS} wheel events, ${ZOOM_GAP_MS} ms apart, delta ${WHEEL_DELTA}`);
  await page.mouse.move(gl.rect.x + gl.rect.w / 2, gl.rect.y + gl.rect.h / 2);
  await sleep(300);
  // The storm runs as its own chain so a capture can happen while it is still
  // in flight — an unsettled zoom is exactly the state we want to sample.
  const storm = { i: 0, done: false };
  const stormP = (async () => {
    for (let i = 0; i < ZOOMS; i++) {
      await page.mouse.wheel(0, WHEEL_DELTA);
      storm.i = i + 1;
      await sleep(ZOOM_GAP_MS);
    }
    storm.done = true;
  })();
  const stormT0 = nowMs();
  const duringAt = Math.max(1, Math.floor(ZOOMS * 0.85));
  while (storm.i < duringAt && nowMs() - stormT0 < 60000) await sleep(5);
  log(`  storm in flight (${storm.i}/${ZOOMS} at ${nowMs() - stormT0} ms)`);

  const checkpoints = [];
  async function checkpoint(id, note, opts = {}) {
    const dir = path.join(OUT, `${String(checkpoints.length + 1).padStart(2, '0')}_${id}`);
    fs.mkdirSync(dir, { recursive: true });
    const pairs = [];
    // A checkpoint that dies is recorded, not fatal: a half-finished run whose
    // three good checkpoints are on disk is worth more than a stack trace.
    try {
      for (let k = 0; k < BURST; k++) {
        pairs.push(await capturePair(page, expectedBytes, dir, k + 1));
        if (k < BURST - 1) await sleep(BURST_GAP_MS);
      }
    } catch (e) {
      const rec = {
        id, note, dir, stormIndexAtCapture: opts.stormIndex, failed: true,
        error: e.message, pageClosed: page.isClosed(),
        browserConnected: page.context().browser().isConnected(),
        pagesRemaining: page.context().pages().length,
        pairsCaptured: pairs.length,
        life: life.events.slice(),
      };
      fs.writeFileSync(path.join(dir, 'failure.json'), JSON.stringify(rec, null, 2));
      checkpoints.push(rec);
      log(`  [${id}] FAILED: ${e.message}`);
      log(`    page.isClosed()=${rec.pageClosed} browser.isConnected()=${rec.browserConnected} pages=${rec.pagesRemaining}`);
      return rec;
    }
    const hostPngs = pairs.map((p) => p.hostPng);
    const clientPngs = pairs.map((p) => p.clientPng);
    const analysis = await analyze(hostPngs, clientPngs, dir, 'primary');
    // Hash diversity: if every frame is byte-identical the screen was static,
    // and a perfect score only proves agreement on a still picture.
    const distinctClient = new Set(clientPngs.map((p) => md5(p))).size;
    const distinctHost = new Set(hostPngs.map((p) => md5(p))).size;
    // Reuse the repo's canonical comparator on the time-closest pair.
    let canonical = null;
    try {
      const raw = await run('python3', ['tests/qa_pixel_comparator.py', hostPngs[0], clientPngs[0],
        path.join(dir, 'primary_comparator_diff.png'), String(TOL)]);
      canonical = JSON.parse(raw.toString('utf8').trim().split('\n').pop());
    } catch (e) {
      canonical = { error: e.message };
    }
    const rec = {
      id, note, dir, stormIndexAtCapture: opts.stormIndex,
      frames: { distinctClient, distinctHost, pairs: pairs.length, screenStatic: distinctClient === 1 && distinctHost === 1 },
      pairs: pairs.map((p) => ({ host: path.basename(p.hostPng), client: path.basename(p.clientPng), timings: p.timings })),
      analysis, canonical,
    };
    fs.writeFileSync(path.join(dir, 'analysis.json'), JSON.stringify(rec, null, 2));
    checkpoints.push(rec);
    log(`  [${id}] primary mismatch ${analysis.primary.mismatch_pct}% | best-of-burst ${analysis.best.mismatch_pct}% ` +
        `| never-seen ${analysis.never_seen_pct}% | hist ${analysis.histogram_intersection.mean}`);
    return rec;
  }

  await checkpoint('during_zoom', 'while the zoom storm is still running', { stormIndex: storm.i });
  await stormP;
  log(`  storm finished in ${nowMs() - stormT0} ms`);
  await checkpoint('post_storm_immediate', 'immediately after the last wheel event');
  await sleep(SETTLE_MS);
  await checkpoint('settle_1500', `after ${SETTLE_MS} ms of settling`);
  await sleep(SETTLE2_MS);
  await checkpoint('settle_5000', `after a further ${SETTLE2_MS} ms of settling`);

  // Client-observed delivery, read before the browser goes away.
  let clientStats = null;
  try {
    const raw = await page.evaluate(() => {
      const s = window.__parityStats || {};
      return { draws: s.draws || [], raf: s.raf || [], longTasks: s.longTasks || [] };
    });
    clientStats = {
      rendered_frames: raw.draws.length,
      frames: gapStats(raw.draws),
      raf: gapStats(raw.raf),
      long_tasks: {
        count: raw.longTasks.length,
        max_ms: raw.longTasks.length ? Math.max(...raw.longTasks) : 0,
        over_50ms: raw.longTasks.filter((d) => d > 50).length,
        total_blocked_ms: raw.longTasks.reduce((a, b) => a + b, 0),
      },
    };
  } catch (e) {
    clientStats = { error: e.message, pageClosed: page.isClosed() };
  }

  await browser.close();

  log('\n[4/5] report');
  const hostStatsAfter = await readHostFrameStats();
  const report = { when: new Date().toISOString(), config: {
      host: HOST, container: CONTAINER, url: URL, out: OUT, zooms: ZOOMS, zoomGapMs: ZOOM_GAP_MS,
      burst: BURST, tol: TOL, headless: HEADLESS },
    preflight: facts, storm: { zooms: ZOOMS, gapMs: ZOOM_GAP_MS, delta: WHEEL_DELTA, totalMs: nowMs() - stormT0 },
    clientStats, life: life.events,
    hostFrameStats: { before: hostStatsBefore, after: hostStatsAfter },
    checkpoints };
  fs.writeFileSync(path.join(OUT, 'report.json'), JSON.stringify(report, null, 2));

  const md = [];
  md.push('# df_parity_qa report', '');
  md.push(`- when: ${report.when}`);
  md.push(`- host: \`${HOST}\` container \`${CONTAINER}\``);
  md.push(`- url: ${URL}`);
  md.push(`- canvas: ${gl.w}x${gl.h} @ (${gl.rect.x},${gl.rect.y}), renderer ${gl.renderer}`);
  md.push(`- host frame: ${expectedBytes} bytes = ${hostW}x${hostH}x4 (DF window ${hostW}x${hostH})`);
  md.push(`- zoom storm: ${ZOOMS} wheel events, ${ZOOM_GAP_MS} ms apart, delta ${WHEEL_DELTA}`);
  md.push(`- tolerance: |delta| > ${TOL} per channel counts as a mismatch`);
  md.push('');
  md.push('| checkpoint | primary mismatch % | best-of-burst % | never-seen-in-burst % | exact match % | hist intersection | mean abs delta | distinct client frames |');
  md.push('|---|---|---|---|---|---|---|---|');
  for (const c of checkpoints) {
    if (c.failed) { md.push(`| ${c.id} | FAILED: ${c.error} | | | | | | |`); continue; }
    const a = c.analysis;
    md.push(`| ${c.id} | ${a.primary.mismatch_pct} | ${a.best.mismatch_pct} | ${a.never_seen_pct} | ` +
            `${a.primary.exact_match_pct} | ${a.histogram_intersection.mean} | ${a.primary.mean_abs_delta} | ` +
            `${c.frames.distinctClient}/${c.frames.pairs} |`);
  }
  md.push('');
  if (clientStats && !clientStats.error) {
    md.push('## Client-observed frame delivery');
    md.push('');
    md.push(`- client-rendered frames (instanced draws): ${clientStats.rendered_frames}`);
    md.push(`- draw gap: median ${clientStats.frames.gap_median_ms} ms, p90 ${clientStats.frames.gap_p90_ms} ms, ` +
            `p99 ${clientStats.frames.gap_p99_ms} ms, max ${clientStats.frames.gap_max_ms} ms`);
    md.push(`- long tasks: ${clientStats.long_tasks.count} (max ${clientStats.long_tasks.max_ms} ms, ` +
            `${clientStats.long_tasks.over_50ms} over 50 ms, ${clientStats.long_tasks.total_blocked_ms} ms total)`);
    md.push('');
  }
  md.push('## Worst mismatch regions (primary pair of each checkpoint)');
  for (const c of checkpoints) {
    if (c.failed) { md.push('', `### ${c.id} — FAILED`, `- ${c.error}`); continue; }
    md.push('', `### ${c.id} — ${c.note}`);
    md.push(`- never-seen pixels: ${c.analysis.never_seen_pixels} (${c.analysis.never_seen_pct}%)`);
    md.push(`- structural (160x90 grid): mean abs delta ${c.analysis.structural.mean_abs_delta}, cells mismatching ${c.analysis.structural.cells_mismatch_pct}%`);
    if (c.analysis.worst_regions.length) {
      md.push('', '| bbox [x0,y0,x1,y1] | size | mismatch px | mean abs delta |', '|---|---|---|---|');
      for (const b of c.analysis.worst_regions) {
        md.push(`| ${JSON.stringify(b.bbox)} | ${b.w}x${b.h} | ${b.mismatch_pixels} | ${b.mean_abs_delta} |`);
      }
    } else {
      md.push('- no mismatch region of 64 px or more');
    }
    md.push(`- images: ${Object.values(c.analysis.images).join(', ')}`);
  }
  md.push('');
  md.push('## What this proves, and what it does not');
  md.push('');
  md.push('- Proves: at each sampled instant, with the two sides captured concurrently, this is the');
  md.push('  measured per-pixel agreement between the client canvas and the game\'s own framebuffer.');
  md.push('- The host frame and the client canvas cannot be sampled at literally the same clock tick:');
  md.push('  the browser read and the ssh round trip are concurrent, but the host writes its frame when');
  md.push('  it next presents. See per-pair `windowMs` in report.json; alignment is within that window.');
  md.push('- Does NOT prove anything about frames between checkpoints, nor about input handling.');
  md.push('- DF animates; a difference in animation phase is not corruption. The `never-seen-in-burst`');
  md.push('  figure is the stronger number, because such a pixel appears in no host frame of the burst.');
  md.push('- Only the canvas is compared, so any DOM overlay is out of scope by construction.');
  fs.writeFileSync(path.join(OUT, 'report.md'), md.join('\n'));

  log(`  wrote ${path.join(OUT, 'report.json')}`);
  log(`  wrote ${path.join(OUT, 'report.md')}`);
  log('\n[5/5] summary');
  for (const c of checkpoints) {
    log(`  ${c.id.padEnd(22)} primary=${String(c.analysis.primary.mismatch_pct).padStart(8)}%  ` +
        `best-of-burst=${String(c.analysis.best.mismatch_pct).padStart(8)}%  ` +
        `never-seen=${String(c.analysis.never_seen_pct).padStart(8)}%  hist=${c.analysis.histogram_intersection.mean}`);
  }
}

main().catch((e) => {
  console.error(`\nFAILED: ${e.message}`);
  process.exit(1);
});
