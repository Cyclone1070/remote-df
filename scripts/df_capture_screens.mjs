/**
 * df_screens.mjs — walk DF through distinct screens, capturing at each one:
 *   - DF's own framebuffer (xwd on the container's X display)
 *   - the graphics-layer trace for the matching frames (dfgfx probe)
 *
 * This is about DF's internal rendering, not the browser stream: the browser
 * is used only as a way to deliver input to the game.
 */
import { chromium } from 'playwright';
import { execSync } from 'node:child_process';
import fs from 'node:fs';

const URL = process.env.QA_URL || 'http://192.168.1.111:8484/';
const SSH = process.env.DF_SSH_HOST || 'cyc@192.168.1.111';
const OUT = '/tmp/screens';
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });

const sh = (cmd) => execSync(`ssh -o BatchMode=yes -o ConnectTimeout=20 ${SSH} ${JSON.stringify(cmd)}`,
  { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });

/** Arm the probe, grab DF's framebuffer, and pull the trace for that screen. */
function capture(name) {
  sh([
    'podman exec remote-df sh -c "rm -f /tmp/dfgfx/capture"',
    'podman exec remote-df sh -c "touch /tmp/dfgfx/capture"',
    'sleep 2',
    `podman exec remote-df sh -c "DISPLAY=:99 /tmp/xwd -root -silent > /tmp/s_${name}.xwd"`,
    `podman cp remote-df:/tmp/s_${name}.xwd /tmp/s_${name}.xwd`,
    `podman exec remote-df sh -c "cp /tmp/dfgfx/gfx.log /tmp/g_${name}.log"`,
    `podman cp remote-df:/tmp/g_${name}.log /tmp/g_${name}.log`,
    `python3 /tmp/xwdc.py /tmp/s_${name}.xwd /tmp/s_${name}.png 2>/dev/null || echo "convert failed"`,
  ].join('; '));
  try {
    execSync(`scp -o BatchMode=yes ${SSH}:/tmp/s_${name}.png ${OUT}/${name}.png`, { stdio: 'ignore' });
    execSync(`scp -o BatchMode=yes ${SSH}:/tmp/g_${name}.log ${OUT}/${name}.gfx.log`, { stdio: 'ignore' });
    const g = fs.readFileSync(`${OUT}/${name}.gfx.log`, 'utf8');
    const details = (g.match(/END_DETAIL/g) || []).length;
    console.log(`  captured ${name}: ${details} detailed frame(s), log ${g.length}B`);
  } catch (e) {
    console.log(`  capture ${name} failed:`, String(e).slice(0, 160));
  }
}

const browser = await chromium.launch({
  headless: true,
  args: ['--no-sandbox', '--use-gl=swiftshader', '--enable-unsafe-swiftshader'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const log = (...a) => console.log(...a);

await page.goto(URL, { waitUntil: 'domcontentloaded' });
const launch = page.locator('text=Launch Game');
try {
  await launch.waitFor({ state: 'visible', timeout: 8000 });
  log('lobby - launching session');
  await launch.click();
} catch { log('attaching to running session'); }
await page.waitForSelector('canvas', { timeout: 120000 });
log('canvas present');
const canvas = await page.locator('canvas').first();
const box = await canvas.boundingBox();

await page.waitForTimeout(22000);           // let DF finish its startup work

log('screen A: title screen');
capture('A_title');

const click = async (x, y, settle = 7000) => {
  await page.mouse.move(box.x + x, box.y + y);
  await page.waitForTimeout(400);
  await page.mouse.click(box.x + x, box.y + y);
  await page.waitForTimeout(settle);
};

log('-> Object testing arena');
await click(631, 472);
log('screen B: arena menu');
capture('B_arena_menu');

log('-> Classic Arena, then Create arena');
await click(180, 137, 3000);
await click(991, 678, 26000);

log('screen C: arena map');
capture('C_arena_map');

// Move the view so a second arena screen shows different tiles. The key must
// be HELD across many frames: a press+release inside one frame nets to no
// movement, which is why the earlier attempt did not scroll.
log('-> scrolling the map (key held across frames)');
await page.mouse.move(box.x + 620, box.y + 300);
await page.waitForTimeout(800);
await page.keyboard.down('Numpad6');
await page.waitForTimeout(12000);
await page.keyboard.up('Numpad6');
await page.waitForTimeout(4000);
log('screen D: arena map, scrolled east');
capture('D_arena_scrolled');

log('-> scrolling south as well');
await page.keyboard.down('Numpad2');
await page.waitForTimeout(10000);
await page.keyboard.up('Numpad2');
await page.waitForTimeout(4000);
log('screen E: arena map, scrolled further');
capture('E_arena_scrolled2');

fs.writeFileSync(`${OUT}/done.txt`, 'ok');
await browser.close();
log('done');
