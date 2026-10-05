#!/usr/bin/env node
/**
 * qa_parity_walk.mjs — replay the manual QA walk and emit paired parity images.
 *
 * WHAT THIS IS
 *   A checkpoint harness. For each step it captures the browser canvas, captures a
 *   burst of native DF frames from the streaming host, and writes the images plus
 *   localised difference maps so a human can compare them side by side.
 *
 * WHAT THIS IS NOT
 *   It does NOT decide whether the build is correct. DF animates lava and water, so
 *   a naive per-pixel diff manufactures defects that are not there. This script
 *   only answers "which pixels does the client show that NO native frame ever
 *   showed?" — the answer is then judged by eye against the images it writes.
 *   A green-looking number here is a place to LOOK, not a verdict.
 *
 * CONFIG COMES FROM THE ENVIRONMENT — nothing sensitive is stored in this file.
 * It is safe to commit. Do NOT add hostnames, IPs, tokens or credentials here.
 *
 *   DF_SSH_HOST      ssh destination for the streaming host   (required)
 *   DF_CONTAINER     podman container running DF               (default: remote-df)
 *   DF_WINDOW        X window id of the DF window              (default: 0x200008)
 *   DF_DISPLAY       X display inside the container            (default: :99)
 *   QA_URL           client URL to drive                      (required)
 *   QA_OUT           output directory (git-ignored)          (default: qa/walk)
 *   QA_BURST         native frames per step                    (default: 6)
 *   QA_SETTLE_MS     wait after each action before capture     (default: 6000)
 *   QA_ONLY          comma-separated step ids to run           (default: all)
 *   QA_SOAK_FRAMES   frames in the soak step                   (default: 12)
 *   QA_SOAK_GAP_MS   gap between soak frames                   (default: 5000)
 *   QA_KEEP_BURST    keep every native frame, not just best    (default: 1)
 *   QA_HEADFUL       run with a visible browser                (default: 0)
 *
 * USAGE
 *   DF_SSH_HOST=user@host QA_URL=http://host:8484/ node scripts/qa_parity_walk.mjs
 *   ... QA_ONLY=arena_created,pan node scripts/qa_parity_walk.mjs
 *
 * NOTE ON COORDINATES
 *   Click targets below are the canvas coordinates used during the original manual
 *   walk. They are valid while DF's menus have their original layout. If a step
 *   appears to do nothing, the menu layout has changed and the constant for that
 *   step needs updating — the script will still capture, so the images show you
 *   what the screen actually was.
 */

import { chromium } from 'playwright';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const env = process.env;

function req(name) {
  const v = env[name];
  if (!v) {
    console.error(`\nERROR: ${name} is required.\n  e.g. ${name}=user@host   (see header comment)\n`);
    process.exit(2);
  }
  return v;
}

const SSH_HOST = req('DF_SSH_HOST');
const QA_URL = req('QA_URL');
const CONTAINER = env.DF_CONTAINER || 'remote-df';
const XWIN = env.DF_WINDOW || '0x200008';
const XDISP = env.DF_DISPLAY || ':99';
const OUT = env.QA_OUT || 'qa/walk';
const BURST = parseInt(env.QA_BURST || '6', 10);
const SETTLE = parseInt(env.QA_SETTLE_MS || '6000', 10);
const ONLY = env.QA_ONLY ? env.QA_ONLY.split(',').map((s) => s.trim()) : null;
const SOAK_FRAMES = parseInt(env.QA_SOAK_FRAMES || '12', 10);
const SOAK_GAP = parseInt(env.QA_SOAK_GAP_MS || '5000', 10);
const KEEP_BURST = (env.QA_KEEP_BURST || '1') !== '0';
const HEADFUL = (env.QA_HEADFUL || '0') !== '0';
const VIEWPORT = { width: 1280, height: 720 }; // must match the native DF window

/* ------------------------------------------------------------------ *
 * Click targets, in canvas coordinates. Update if DF's layout moves.
 * ------------------------------------------------------------------ */
const C = {
  returnToTitle: [635, 353],
  fortress: [631, 257],
  objectTestingArena: [631, 472],
  classicArena: [180, 137],
  createArena: [991, 678],
  spawnCreature: [451, 701],
  spawnCreate: [993, 77],
  placeTile: [640, 350],
  minimapArrow: [1110, 77],
};

/* ------------------------------------------------------------------ *
 * The walk. Each step: one action, then capture.
 * `soak` steps emit several client frames and compare them all.
 * ------------------------------------------------------------------ */
const STEPS = [
  { id: 'reset_to_title', title: 'Return to the title screen',
    note: 'Escape opens "Return to title menu"; click it. Needed because every later step assumes the title screen.',
    act: async (h) => { await h.press('Escape'); await h.wait(1400); await h.press('Escape'); await h.wait(1400);
                        await h.click(C.returnToTitle); await h.wait(9000); } },

  { id: 'title', title: 'Title screen',
    note: 'Known defect D-1 reference: full-screen artwork and the DWARF FORTRESS wordmark drop out in the client.',
    act: async () => {} },

  { id: 'world_list', title: 'World list',
    note: 'Known defect D-2 reference: glyphs dropped mid-word in long strings; a button can vanish.',
    act: async (h) => { await h.press('ArrowDown'); await h.wait(SETTLE); } },

  { id: 'game_type', title: 'Game type selection',
    note: 'Known defect D-3 reference: the entire text layer can vanish from a frame.',
    act: async (h) => { await h.press('Enter'); await h.wait(SETTLE); } },

  { id: 'world_map', title: 'World map / embark selection',
    note: 'Known defect D-4 reference: an individual site sprite can be dropped from the map.',
    act: async (h) => { await h.click(C.fortress); await h.wait(SETTLE + 6000); } },

  { id: 'embark_view', title: 'Embark placement view',
    note: 'Known defect D-5 reference: the right-hand info panel renders too narrow and clips its text.',
    act: async (h) => { await h.click(C.minimapArrow); await h.wait(SETTLE); } },

  { id: 'back_to_title_2', title: 'Back to title (second)',
    act: async (h) => { await h.press('Escape'); await h.wait(1400); await h.press('Escape'); await h.wait(1400);
                        await h.click(C.returnToTitle); await h.wait(9000); } },

  { id: 'arena_menu', title: 'Object testing arena menu',
    act: async (h) => { await h.click(C.objectTestingArena); await h.wait(SETTLE + 4000); } },

  { id: 'arena_classic', title: 'Select "Classic Arena"',
    act: async (h) => { await h.click(C.classicArena); await h.wait(SETTLE); } },

  { id: 'arena_created', title: 'Arena created — gameplay map',
    note: 'First look at the pure tiled workload. Historically this matched native exactly.',
    act: async (h) => { await h.click(C.createArena); await h.wait(SETTLE + 14000); } },

  { id: 'pan', title: 'Pan the map (ArrowRight)',
    act: async (h) => { await h.press('ArrowRight'); await h.wait(SETTLE); } },

  { id: 'scroll', title: 'Scroll a z-level (mouse wheel)',
    note: 'The wheel drives z-level, not tile-size zoom. Elevation changes in the minimap caption.',
    act: async (h) => { await h.move(640, 360); await h.wait(500); await h.wheel(0, -240); await h.wait(SETTLE); } },

  { id: 'spawn_menu', title: 'Open the spawn menu',
    note: 'Dense text list — the hardest test for glyph defects.',
    act: async (h) => { await h.click(C.spawnCreature); await h.wait(SETTLE); } },

  { id: 'spawn_create', title: 'Create creature — placing mode',
    act: async (h) => { await h.click(C.spawnCreate); await h.wait(SETTLE); } },

  { id: 'spawn_place', title: 'Place the creature',
    note: 'New sprite must appear in the client exactly as it does natively.',
    act: async (h) => { await h.click(C.placeTile); await h.wait(SETTLE); } },

  { id: 'minimap_zoom', title: 'Recentre via the minimap',
    note: 'Arena exposes no +/- tile-size zoom control; this is the only view control.',
    act: async (h) => { await h.click(C.minimapArrow); await h.wait(SETTLE); } },

  { id: 'soak', title: 'Soak — repeated frames, no input',
    note: 'The defects found so far are intermittent and self-recovering, so one clean frame proves little.',
    soak: SOAK_FRAMES, gap: SOAK_GAP,
    act: async () => {} },
];

/* ------------------------------------------------------------------ *
 * Native capture over ssh. No shell, so nothing is word-split or expanded.
 * ------------------------------------------------------------------ */
function sshCapture(dest, { maxBuffer = 256 * 1024 * 1024 } = {}) {
  return execFileSync('ssh', ['-o', 'ConnectTimeout=15', '-o', 'BatchMode=yes', SSH_HOST, dest],
    { maxBuffer, stdio: ['ignore', 'pipe', 'pipe'] });
}

function nativeGrab(outFile) {
  const remote = '/tmp/qa_parity_walk_native.png';
  sshCapture(`podman exec ${CONTAINER} sh -c 'export DISPLAY=${XDISP}; rm -f ${remote}; import -window ${XWIN} ${remote}'`);
  const b64 = sshCapture(`podman exec ${CONTAINER} base64 -w0 ${remote}`).toString('utf8').trim();
  fs.writeFileSync(outFile, Buffer.from(b64, 'base64'));
  return outFile;
}

/* ------------------------------------------------------------------ *
 * Difference analysis. A pixel "counts" only if it appears in NO native
 * frame — that separates "different animation phase" from "content the
 * client never received".
 *
 * The lava/water split is INDICATIVE ONLY: DF's darker lava and water cells
 * fail a naive colour test, so check mask_other.png by eye before believing it.
 * ------------------------------------------------------------------ */
const PY = `
import sys, json
import numpy as np
from PIL import Image

client, burst, outdir = sys.argv[1], json.loads(sys.argv[2]), sys.argv[3]
c = np.asarray(Image.open(client).convert('RGB')).astype(np.int32)
H, W = c.shape[:2]
matched = np.zeros((H, W), bool)
for f in burst:
    n = np.asarray(Image.open(f).convert('RGB')).astype(np.int32)
    matched |= (np.abs(c - n).sum(axis=2) <= 12)
un = ~matched
R, G, B = c[..., 0], c[..., 1], c[..., 2]
lava  = un & (R > 110) & (R - B > 55)
water = un & (B >= G - 25) & (G > R + 5) & (B > 85)
other = un & ~lava & ~water

Image.fromarray(np.where(un[..., None], np.array([255, 0, 0], np.int32), c).astype(np.uint8)).save(outdir + '/mask_all.png')
Image.fromarray(np.where(other[..., None], np.array([255, 0, 255], np.int32), c).astype(np.uint8)).save(outdir + '/mask_other.png')

# closest native frame, for a conventional side-by-side diff count
best, bestn = burst[0], None
for f in burst:
    n = np.asarray(Image.open(f).convert('RGB')).astype(np.int32)
    d = int((np.abs(c - n).sum(axis=2) > 12).sum())
    if bestn is None or d < bestn:
        bestn, best = d, f

print(json.dumps({
    'unmatched': int(un.sum()),
    'lava': int(lava.sum()),
    'water': int(water.sum()),
    'other': int(other.sum()),
    'pct_other': round(100.0 * float(other.sum()) / (H * W), 4),
    'best_native': best,
    'best_diff_px': bestn,
    'best_diff_pct': round(100.0 * bestn / (H * W), 4),
}))
`;

function analyse(clientFile, burstFiles, dir) {
  const out = execFileSync('python3', ['-c', PY, clientFile, JSON.stringify(burstFiles), dir],
    { maxBuffer: 64 * 1024 * 1024 }).toString('utf8');
  return JSON.parse(out);
}

/* ------------------------------------------------------------------ *
 * Capture + analyse one client frame against a fresh native burst.
 * ------------------------------------------------------------------ */
async function captureStep(page, canvas, step, index, label) {
  const dir = path.join(OUT, `${String(index).padStart(2, '0')}_${step.id}${label ? '_' + label : ''}`);
  fs.mkdirSync(dir, { recursive: true });

  const clientFile = path.join(dir, 'client.png');
  await canvas.screenshot({ path: clientFile });
  // Lesson from this session: a screenshot that silently failed once produced a
  // vacuous "0 px" result. Refuse to analyse anything that is not on disk.
  if (!fs.existsSync(clientFile) || fs.statSync(clientFile).size < 1024) {
    throw new Error(`client capture missing or truncated at ${clientFile}`);
  }

  const burstFiles = [];
  for (let i = 1; i <= BURST; i++) {
    const f = path.join(dir, `native_${String(i).padStart(2, '0')}.png`);
    nativeGrab(f);
    if (!fs.existsSync(f) || fs.statSync(f).size < 1024) {
      throw new Error(`native capture missing or truncated at ${f}`);
    }
    burstFiles.push(f);
  }

  const stats = analyse(clientFile, burstFiles, dir);

  // Keep the best-matching native frame as the named pair partner.
  fs.copyFileSync(stats.best_native, path.join(dir, 'native.png'));
  if (!KEEP_BURST) for (const f of burstFiles) fs.unlinkSync(f);

  return { dir, clientFile, native: path.join(dir, 'native.png'), ...stats };
}

/* ------------------------------------------------------------------ *
 * Playwright helpers
 * ------------------------------------------------------------------ */
async function makeHelpers(page, canvas) {
  const box = await canvas.boundingBox();
  // Accepts either click([x, y]) or click(x, y): step definitions pass the
// coordinate tuples as a single array, and concatenating an array onto a
// number silently produces a string, which Playwright then rejects.
const at = (...args) => {
    const [x, y] = Array.isArray(args[0]) ? args[0] : args;
    return [box.x + x, box.y + y];
};
  return {
    wait: (ms) => page.waitForTimeout(ms),
    press: async (key) => {
      // E-1: with no window manager, X focus is PointerRoot. If the pointer has
      // drifted off the DF window, SDL treats it as unfocused and DF ignores
      // every key. Warp into the window before sending input, or nothing lands.
      await canvas.hover({ position: { x: 5, y: 5 } });
      await page.waitForTimeout(150);
      await canvas.press(key);
    },
    move: async (x, y) => { const [px, py] = at(x, y); await page.mouse.move(px, py); },
    click: async (x, y) => { const [px, py] = at(x, y); await page.mouse.move(px, py);
                             await page.waitForTimeout(350); await page.mouse.click(px, py); },
    wheel: async (dx, dy) => { const [px, py] = at(640, 360); await page.mouse.wheel(dx, dy); },
  };
}

/* ------------------------------------------------------------------ */
function pct(n) { return (n * 100 / (VIEWPORT.width * VIEWPORT.height)).toFixed(3) + '%'; }

async function main() {
  const selected = ONLY ? STEPS.filter((s) => ONLY.includes(s.id)) : STEPS;
  if (!selected.length) { console.error('QA_ONLY matched no steps.'); process.exit(2); }

  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(OUT, { recursive: true });

  console.log(`qa_parity_walk`);
  console.log(`  url      ${QA_URL}`);
  console.log(`  ssh      ${SSH_HOST.replace(/^[^@]*@/, '<user>@')} via ${CONTAINER} ${XWIN}`);
  console.log(`  out      ${OUT}/   burst=${BURST}  steps=${selected.length}\n`);

  const browser = await chromium.launch({
    headless: !HEADFUL,
    args: ['--no-sandbox', '--use-gl=swiftshader', '--enable-unsafe-swiftshader'],
  });
  const page = await browser.newPage({ viewport: VIEWPORT });

  const results = [];
  try {
    await page.goto(QA_URL, { waitUntil: 'networkidle' });
    await page.waitForTimeout(2500);

    const resume = page.getByText('Resume Game').first();
    if (await resume.count()) await resume.click();

    const canvas = page.locator('canvas').first();
    await canvas.waitFor({ state: 'visible' });
    await page.waitForTimeout(8000);
    const h = await makeHelpers(page, canvas);

    let n = 0;
    for (const step of selected) {
      n++;
      const label = String(n).padStart(2, '0');
      process.stdout.write(`[${label}] ${step.id.padEnd(18)} `);
      await step.act(h);

      if (step.soak) {
        const rows = [];
        for (let i = 1; i <= step.soak; i++) {
          const r = await captureStep(page, canvas, step, n, `s${String(i).padStart(2, '0')}`);
          rows.push(r);
          process.stdout.write('.');
        }
        const worst = rows.reduce((a, b) => (b.other > a.other ? b : a));
        console.log(` soak x${rows.length}  worst non-animated = ${worst.other} px (${pct(worst.other)})`);
        results.push({ ...step, rows, worst });
      } else {
        const r = await captureStep(page, canvas, step, n);
        const flag = r.other > 1500 ? '  <-- LOOK AT mask_other.png' : '';
        console.log(`unmatched=${String(r.unmatched).padStart(6)}  lava=${String(r.lava).padStart(6)} water=${String(r.water).padStart(6)} other=${String(r.other).padStart(5)}${flag}`);
        results.push({ ...step, rows: [r] });
      }
    }
  } finally {
    await browser.close();
  }

  writeSummary(results);
  console.log(`\nWrote ${OUT}/ — open ${OUT}/index.html and judge each pair BY EYE.`);
  console.log('Counts here only locate differences. They are not verdicts.');
}

function writeSummary(results) {
  const rows = results.flatMap((s) => (s.rows || []).map((r, i) =>
    `<tr><td>${path.basename(r.dir)}</td><td><a href="${r.dir}/client.png">client</a></td>` +
    `<td><a href="${r.dir}/native.png">native</a></td>` +
    `<td><a href="${r.dir}/mask_all.png">all</a></td>` +
    `<td><a href="${r.dir}/mask_other.png">other</a></td>` +
    `<td class="n">${r.unmatched}</td><td class="n">${r.lava}</td><td class="n">${r.water}</td>` +
    `<td class="n ${r.other > 1500 ? 'hot' : ''}">${r.other}</td>` +
    `<td class="n">${r.best_diff_pct}%</td></tr>`));

  const html = `<!doctype html><meta charset="utf-8"><title>remote-df parity walk</title>
<style>
 body{font:13px ui-monospace,Menlo,monospace;margin:24px;background:#111;color:#ddd}
 h1{font-size:16px} table{border-collapse:collapse;margin-top:12px}
 td,th{border:1px solid #333;padding:4px 9px;text-align:left}
 th{background:#222} .n{text-align:right;font-variant-numeric:tabular-nums}
 .hot{background:#5a1020;color:#ffb0c0;font-weight:700}
 a{color:#7cc7ff} .warn{background:#3a2a00;border-left:3px solid #dca300;padding:8px 12px;margin:12px 0}
</style>
<h1>remote-df — parity walk</h1>
<p class="warn"><b>These numbers are not verdicts.</b> "other" counts pixels the client shows that no native
frame ever showed, excluding colours that look like lava or water. DF's darker lava and water cells fail that
colour test, so <b>always open mask_other.png and look</b> before concluding anything.</p>
<table><tr><th>step</th><th>client</th><th>native</th><th>mask all</th><th>mask other</th>
<th>unmatched</th><th>lava</th><th>water</th><th>other</th><th>best diff</th></tr>
${rows.join('\n')}</table>`;

  fs.writeFileSync(path.join(OUT, 'index.html'), html);

  const md = [`# parity walk results`, '',
    `url: ${QA_URL}`, `native: podman container window via ssh (host omitted)`, '',
    '| step | unmatched | lava | water | other | best diff |', '|---|---|---|---|---|---|',
    ...results.flatMap((s) => (s.rows || []).map((r) =>
      `| ${path.basename(r.dir)} | ${r.unmatched} | ${r.lava} | ${r.water} | ${r.other} | ${r.best_diff_pct}% |`)),
    '', 'Counts localise differences; they do not decide correctness. Review the image pairs.'].join('\n');
  fs.writeFileSync(path.join(OUT, 'summary.md'), md);
}

main().catch((e) => { console.error('\nERROR:', e.message); process.exit(1); });