/**
 * df_build_report.mjs — turn a capture run into every artefact the report needs.
 *
 * This is the analysis half of a two-step pipeline:
 *   1. df_capture_screens.mjs  walks DF and records the framebuffer + trace
 *   2. this script              summarises, compares, and renders the images
 *
 * Inputs (produced by step 1, pulled from the game container):
 *   $SCREENS/<name>.png        framebuffer grab of each screen
 *   $SCREENS/<name>.gfx.log    the trace for that screen
 *   $SCREENS/FULL.gfx.log      the whole session, for timing analysis
 *   $PULL/sprites/*.ppm        every sprite DF uploaded, as raw pixels
 *
 * Outputs (written to $OUT, referenced directly by the report):
 *   <name>.png                 framebuffer cropped to the game's render area
 *   <name>_sprites.png         the sprites that screen actually drew
 *   screen_summary.json        per-screen counts
 *
 * Run:  node scripts/df_build_report.mjs [outDir]
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const SCREENS = process.env.SCREENS || '/tmp/screens';
const PULL = process.env.PULL || '/tmp/dfgfx_pull';
const OUT = process.argv[2] || '/Users/mac/repos/remote-df/evidence/graphics';

fs.mkdirSync(OUT, { recursive: true });

/* ===================== image helpers ===================== */

function crc32(b) {
  let c, crc = 0xffffffff;
  for (let n = 0; n < b.length; n++) {
    c = (crc ^ b[n]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = c ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
const chunk = (t, d) => {
  const l = Buffer.alloc(4); l.writeUInt32BE(d.length);
  const td = Buffer.concat([Buffer.from(t, 'ascii'), d]);
  const c = Buffer.alloc(4); c.writeUInt32BE(crc32(td));
  return Buffer.concat([l, td, c]);
};
function writePNG(file, w, h, rgba) {
  const st = w * 4, raw = Buffer.alloc((st + 1) * h);
  for (let y = 0; y < h; y++) rgba.copy(raw, y * (st + 1) + 1, y * st, (y + 1) * st);
  const ih = Buffer.alloc(13);
  ih.writeUInt32BE(w, 0); ih.writeUInt32BE(h, 4); ih[8] = 8; ih[9] = 6;
  fs.writeFileSync(file, Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ih), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]));
}
function readPNG(file) {
  const png = fs.readFileSync(file);
  let off = 8, idat = [], w = 0, h = 0, ctype = 6;
  while (off < png.length) {
    const len = png.readUInt32BE(off);
    const type = png.toString('ascii', off + 4, off + 8);
    const data = png.subarray(off + 8, off + 8 + len);
    if (type === 'IHDR') { w = data.readUInt32BE(0); h = data.readUInt32BE(4); ctype = data[9]; }
    if (type === 'IDAT') idat.push(data);
    off += 12 + len;
  }
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const bpp = ctype === 6 ? 4 : 3, stride = w * bpp;
  const out = Buffer.alloc(w * h * 4, 255);
  let prev = Buffer.alloc(stride);
  for (let y = 0; y < h; y++) {
    const ft = raw[y * (stride + 1)];
    const line = Buffer.from(raw.subarray(y * (stride + 1) + 1, y * (stride + 1) + 1 + stride));
    for (let i = 0; i < stride; i++) {
      const a = i >= bpp ? line[i - bpp] : 0, b = prev[i], c = i >= bpp ? prev[i - bpp] : 0;
      let v = line[i];
      if (ft === 1) v += a; else if (ft === 2) v += b; else if (ft === 3) v += (a + b) >> 1;
      else if (ft === 4) {
        const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
        v += (pa <= pb && pa <= pc) ? a : (pb <= pc ? b : c);
      }
      line[i] = v & 0xff;
    }
    prev = line;
    for (let x = 0; x < w; x++) {
      const s = x * bpp, d = (y * w + x) * 4;
      out[d] = line[s]; out[d + 1] = line[s + 1]; out[d + 2] = line[s + 2];
      out[d + 3] = bpp === 4 ? line[s + 3] : 255;
    }
  }
  return { w, h, rgba: out };
}
function readPPM(file) {
  const b = fs.readFileSync(file);
  let p = 0; const f = [];
  while (f.length < 4) {
    while (b[p] === 32 || b[p] === 10 || b[p] === 13 || b[p] === 9) p++;
    if (b[p] === 35) { while (b[p] !== 10) p++; continue; }
    const s = p;
    while (p < b.length && ![32, 10, 13, 9].includes(b[p])) p++;
    f.push(b.toString('ascii', s, p));
  }
  const w = +f[1], h = +f[2];
  return { w, h, px: b.subarray(p + 1, p + 1 + w * h * 3) };
}

/* ===================== trace parsing ===================== */

/** Only the block after the LAST capture marker belongs to this screen; the
 *  trace accumulates for the whole session. */
function scopedLines(name) {
  const all = fs.readFileSync(path.join(SCREENS, `${name}.gfx.log`), 'utf8').split('\n');
  let start = 0;
  for (let i = all.length - 1; i >= 0; i--) if (all[i].startsWith('CAPTURE_ARMED')) { start = i; break; }
  const before = all.slice(0, start).filter((l) => l.startsWith('PRESENT')).length;
  return { seg: all.slice(start), frameBase: before };
}

/** What a screen drew: the sprites referenced, and where each was placed. */
function screenDraws(name) {
  const { seg, frameBase } = scopedLines(name);
  const tex = new Set(), pos = new Set();
  let draws = 0, frames = 0;
  for (const ln of seg) {
    if (ln.startsWith('PRESENT')) { frames++; continue; }
    const m = ln.match(/^DRAW frame=\d+ tex=(\S+) src=\S+ dst=(-?\d+),(-?\d+),/);
    if (m) { tex.add(m[1]); pos.add(`${m[1]}@${m[2]},${m[3]}`); draws++; }
  }
  return { tex, pos, draws, frames, frameBase };
}

const inter = (a, b) => [...a].filter((v) => b.has(v)).length;

/* ===================== 1. per-screen summary + viewport test ===================== */

const NAMES = ['A_title', 'B_arena_menu', 'C_arena_map', 'D_arena_scrolled'];
const info = {};
console.log('=== PER-SCREEN SUMMARY ===');
console.log('screen              draws  distinct sprites');
for (const n of NAMES) {
  const d = screenDraws(n);
  info[n] = d;
  console.log(`${n.padEnd(20)}${String(d.draws).padStart(5)}${String(d.tex.size).padStart(18)}`);
}

const A = info.A_title, C = info.C_arena_map, D = info.D_arena_scrolled;
console.log('\n=== TITLE vs ARENA (different content => different sprites) ===');
const ac = inter(A.tex, C.tex);
console.log(`title ${A.tex.size}, arena ${C.tex.size}, shared ${ac}`);
console.log(`title-only ${A.tex.size - ac}, arena-only ${C.tex.size - ac}`);

console.log('\n=== ARENA vs ARENA SCROLLED (the viewport test) ===');
const cd = inter(C.tex, D.tex);
console.log(`shared ${cd} (${((100 * cd) / C.tex.size).toFixed(1)}% of C)`);
console.log(`left the view ${C.tex.size - cd}, entered the view ${D.tex.size - cd}`);
console.log(`same spot ${inter(C.pos, D.pos)} of ${C.pos.size}`);
const moved = [...C.tex].filter((t) => {
  const a = [...C.pos].filter((p) => p.startsWith(t + '@'));
  const b = [...D.pos].filter((p) => p.startsWith(t + '@'));
  return a.length && b.length && !a.some((x) => b.includes(x));
}).length;
console.log(`same sprite, new position ${moved}`);

/* ===================== 2. when does the building happen ===================== */

if (fs.existsSync(path.join(SCREENS, 'FULL.gfx.log'))) {
  const lines = fs.readFileSync(path.join(SCREENS, 'FULL.gfx.log'), 'utf8').split('\n');
  let frame = 0, sprites = 0;
  const per = new Map(), tints = new Map();
  for (const ln of lines) {
    if (ln.startsWith('PRESENT')) { frame++; continue; }
    if (ln.startsWith('SPRITE')) sprites++;
    if (/^(NEWSURFACE|BLIT|TINT|ALPHA|CONVERT|IMG_LOAD|COLORKEY) /.test(ln))
      per.set(frame, (per.get(frame) || 0) + 1);
    const t = ln.match(/^TINT \S+ rgb=(\S+)/);
    if (t) tints.set(t[1], (tints.get(t[1]) || 0) + 1);
  }
  const total = [...per.values()].reduce((s, v) => s + v, 0);
  console.log('\n=== WHEN DF BUILDS SPRITES ===');
  console.log(`frames ${frame}, frames with any building ${per.size} (${((100 * per.size) / frame).toFixed(1)}%)`);
  console.log(`building operations ${total.toLocaleString()}, sprites uploaded ${sprites.toLocaleString()}`);
  console.log('busiest frames:', [...per.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6));
  console.log('recolours:', [...tints.entries()].sort((a, b) => b[1] - a[1]));
}

/* ===================== 3. sprites each screen drew ===================== */

// Every sprite DF uploaded, with the frame it happened on.
const uploaded = [];
if (fs.existsSync(path.join(SCREENS, 'FULL.gfx.log'))) {
  let f = 0;
  for (const ln of fs.readFileSync(path.join(SCREENS, 'FULL.gfx.log'), 'utf8').split('\n')) {
    if (ln.startsWith('PRESENT')) { f++; continue; }
    const m = ln.match(/^SPRITE tex=(\S+) seq=(\d+) (\d+)x(\d+) file=(\S+)/);
    if (m) uploaded.push({ tex: m[1], w: +m[3], h: +m[4], file: m[5], frame: f });
  }
}
/** pixels for a texture as of a frame: the latest upload at or before it */
function spriteFor(tex, atFrame) {
  let best = null;
  for (const u of uploaded) {
    if (u.frame > atFrame) break;
    if (u.tex === tex) best = u;
  }
  return best;
}

function buildSheet(name, list, outName, cols, cell) {
  if (!list.length) { console.log(`${name}: no sprites`); return 0; }
  const rows = Math.ceil(list.length / cols);
  const W = cols * cell, H = rows * cell;
  const buf = Buffer.alloc(W * H * 4, 0);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = (y * W + x) * 4, on = ((x % cell) === 0 || (y % cell) === 0);
    buf[i] = on ? 48 : 16; buf[i + 1] = on ? 48 : 16; buf[i + 2] = on ? 56 : 20; buf[i + 3] = 255;
  }
  list.forEach((s, i) => {
    const cx = (i % cols) * cell, cy = Math.floor(i / cols) * cell;
    const { w, h, px } = readPPM(path.join(PULL, 'sprites', s.file));
    const ox = cx + Math.max(0, Math.floor((cell - w) / 2));
    const oy = cy + Math.max(0, Math.floor((cell - h) / 2));
    for (let y = 0; y < Math.min(h, cell); y++) for (let x = 0; x < Math.min(w, cell); x++) {
      if (ox + x >= W || oy + y >= H) continue;
      const si = (y * w + x) * 3, di = ((oy + y) * W + (ox + x)) * 4;
      buf[di] = px[si]; buf[di + 1] = px[si + 1]; buf[di + 2] = px[si + 2]; buf[di + 3] = 255;
    }
  });
  writePNG(path.join(OUT, outName), W, H, buf);
  console.log(`${outName}: ${list.length} sprites (${W}x${H})`);
  return list.length;
}

console.log('\n=== SPRITE SHEETS PER SCREEN ===');
const summary = {};
for (const n of NAMES) {
  const d = info[n];
  const at = d.frameBase + 2;
  const sprites = [];
  for (const t of d.tex) { const s = spriteFor(t, at); if (s) sprites.push(s); }
  sprites.sort((a, b) => b.w * b.h - a.w * a.h);   // biggest first
  const seen = new Set(), uniq = [];
  for (const s of sprites) if (!seen.has(s.file)) { seen.add(s.file); uniq.push(s); }
  const shown = buildSheet(n, uniq, `${n}_sprites.png`, 10, 56);
  summary[n] = { draws: d.draws, distinctSprites: d.tex.size, spritesShown: shown };
}
fs.writeFileSync(path.join(OUT, 'screen_summary.json'), JSON.stringify(summary, null, 1));

/* ===================== 4. crop framebuffers to the render area ===================== */

// DF renders into a centred 1280x720 area inside a larger window; the rest is
// black letterbox that adds nothing to the report.
console.log('\n=== FRAMEBUFFER CROPS ===');
for (const n of NAMES) {
  const f = path.join(SCREENS, `${n}.png`);
  if (!fs.existsSync(f)) { console.log(`skip ${n}`); continue; }
  const { w, h, rgba } = readPNG(f);
  const cw = Math.min(1280, w), ch = Math.min(720, h);
  const ox = Math.floor((w - cw) / 2), oy = Math.floor((h - ch) / 2);
  const out = Buffer.alloc(cw * ch * 4);
  for (let y = 0; y < ch; y++)
    rgba.copy(out, y * cw * 4, ((y + oy) * w + ox) * 4, ((y + oy) * w + ox + cw) * 4);
  writePNG(path.join(OUT, `${n}.png`), cw, ch, out);
  console.log(`${n}.png  ${w}x${h} -> ${cw}x${ch}`);
}

console.log('\nwrote ->', OUT);
