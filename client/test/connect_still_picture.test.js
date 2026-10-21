// A client that connects while the game's picture is NOT changing must still
// receive that picture.
//
// The stream sends a frame when the game draws something different, and the
// whole send path lives inside the draw hook. A game parked on a still menu
// never draws again, so a client that arrives after the last draw gets nothing
// and sits on a black screen until the user happens to press something.
//
// This test drives that exact case: connect, send no input of any kind, and
// require the picture to appear on its own.
//
// It needs a live server with a session running, so it is skipped unless
// DF_QA_URL is set. Run it with:
//   DF_QA_URL=http://192.168.1.111:8484 node --test test/connect_still_picture.test.js

import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';

const BASE = process.env.DF_QA_URL || '';
const DEADLINE_MS = Number(process.env.DF_QA_DEADLINE_MS || 60000);

// Fraction of the canvas that is not near-black. A black screen reads 0.
async function litFraction(page) {
  return page.evaluate(() => {
    const canvas = document.querySelector('canvas');
    if (!canvas) return -1;
    const probe = document.createElement('canvas');
    probe.width = 80;
    probe.height = 50;
    const ctx = probe.getContext('2d');
    ctx.drawImage(canvas, 0, 0, 80, 50);
    const { data } = ctx.getImageData(0, 0, 80, 50);
    let lit = 0;
    for (let i = 0; i < data.length; i += 4) {
      if (data[i] + data[i + 1] + data[i + 2] > 24) lit += 1;
    }
    return lit / (80 * 50);
  });
}

test('connecting to a still picture delivers that picture without any input', { skip: !BASE }, async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    await page.goto(`${BASE}/df`, { waitUntil: 'domcontentloaded', timeout: 30000 });

    // No clicks, no keys, no mouse movement from here on - that is the point.
    const started = Date.now();
    let lit = 0;
    while (Date.now() - started < DEADLINE_MS) {
      await page.waitForTimeout(2000);
      lit = await litFraction(page);
      if (lit > 0.05) break;
    }

    assert.ok(
      lit > 0.05,
      `the picture never arrived: canvas was ${(lit * 100).toFixed(1)}% lit after ` +
        `${DEADLINE_MS / 1000}s of waiting with no input. A client joining a still ` +
        `picture must be sent that picture.`,
    );
  } finally {
    await browser.close();
  }
});
