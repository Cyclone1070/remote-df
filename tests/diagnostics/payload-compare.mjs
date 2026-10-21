// Payload per frame and in total, for both paths, over the same camera pan.
//
// The two paths cannot be compared on frame rate alone: the command path sends
// instructions plus pictures and the pixel path sends finished images, so the
// only honest comparison is bytes on the wire against pictures delivered, with
// both measured over the same movement and the same duration.
import { chromium } from 'playwright';

const CMD = 'http://192.168.1.111:8484';
const RAW = 'http://192.168.1.111:8000/';
const stats = async () => (await fetch(`${CMD}/df-stats`)).json();
const settle = (ms) => new Promise((r) => setTimeout(r, ms));

async function pan(page, seconds) {
  const keys = ['a', 'd', 'w', 's'];
  const t0 = Date.now();
  let i = 0;
  while (Date.now() - t0 < seconds * 1000) {
    const k = keys[i % keys.length];
    await page.keyboard.down(k);
    await page.waitForTimeout(700);
    await page.keyboard.up(k);
    i++;
  }
}

const browser = await chromium.launch({
  headless: true,
  args: ['--disable-frame-rate-limit', '--disable-gpu-vsync', '--run-all-compositor-stages-before-draw',
         '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows'],
});

const out = {};

// ---------- command path ----------
{
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  await page.goto(`${CMD}/df`, { waitUntil: 'domcontentloaded' });
  await settle(22000);
  const b = page.viewportSize();
  await page.mouse.click(b.width * 0.5, b.height * (479 / 800));
  await settle(4000);
  await page.mouse.click(b.width * (180 / 1280), b.height * (144 / 800));
  await settle(1500);
  await page.mouse.click(b.width * (1000 / 1280), b.height * (755 / 800));
  await settle(60000);
  await page.mouse.move(1240, 700);
  await settle(1500);

  const s0 = await stats();
  await pan(page, 12);
  const s1 = await stats();
  const secs = (s1.now - s0.now) / 1000;
  const d = (k) => s1[k] - s0[k];
  const pics = d('textureBytes');
  const total = d('wireBytes');
  const frames = d('frames');
  out.command = {
    seconds: +secs.toFixed(1),
    picturesDelivered: frames,
    picturesPerSec: +(frames / secs).toFixed(1),
    totalBytes: total,
    bytesPerSec: Math.round(total / secs),
    pictureBytes: pics,
    pictureBytesPerSec: Math.round(pics / secs),
    bytesPerPicture: frames > 0 ? Math.round(total / frames) : null,
    pictureShare: total > 0 ? +(100 * pics / total).toFixed(1) : 0,
  };
  await page.close();
}

// ---------- pixel codec path ----------
{
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  await page.goto(RAW, { waitUntil: 'domcontentloaded' });
  await settle(12000);
  const s0 = await stats();
  await pan(page, 12);
  const s1 = await stats();
  const secs = (s1.now - s0.now) / 1000;
  const bytes = s1.raw.bytes - s0.raw.bytes;
  const frames = s1.raw.sent - s0.raw.sent;
  out.pixel = {
    seconds: +secs.toFixed(1),
    picturesDelivered: frames,
    picturesPerSec: +(frames / secs).toFixed(1),
    totalBytes: bytes,
    bytesPerSec: Math.round(bytes / secs),
    bytesPerPicture: frames > 0 ? Math.round(bytes / frames) : null,
  };
  await page.close();
}

console.log(JSON.stringify(out, null, 2));
await browser.close();
