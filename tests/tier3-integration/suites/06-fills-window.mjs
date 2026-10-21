// The picture fills the window it is shown in.
//
// The page draws in the game's own coordinate space, so the game has to be the
// size of the canvas. When it is not, every command lands in the top-left corner
// of a larger canvas and the rest of the window is black - which looks like a
// rendering fault and is really a size that never got applied.
//
// This is checked as a number rather than by looking at a screenshot. The title
// screen is dark at its edges by design, so "is the bottom strip black" cannot
// distinguish a correct picture from a letterboxed one.
import { connect, stats, that, DEADLINE_MS } from '../lib/harness.mjs';

export const name = 'the picture fills the window, whatever size the window is';

export async function run() {
  // A size that is neither the default nor the size the game starts at, so a
  // hardcoded or ignored resize cannot pass by coincidence.
  const VIEWPORT = { width: 1500, height: 940 };
  const c = await connect({ viewport: VIEWPORT });
  try {
    const up = await c.waitForPicture({ deadlineMs: DEADLINE_MS });
    that('the picture came up', up.ok, { litFraction: up.lit, ...up.state });

    // The window is applied on the next event pump, so allow a moment for the
    // resize to reach the game before comparing.
    let win = {};
    for (let i = 0; i < 20; i++) {
      win = (await stats()).window || {};
      if (Math.abs(win.w - VIEWPORT.width) <= 2 && Math.abs(win.h - VIEWPORT.height) <= 2) break;
      await c.page.waitForTimeout(250);
    }

    that('the game is rendering at the size of the page showing it',
      Math.abs(win.w - VIEWPORT.width) <= 2 && Math.abs(win.h - VIEWPORT.height) <= 2, {
        askedFor: `${VIEWPORT.width}x${VIEWPORT.height}`,
        gameIsRenderingAt: `${win.w}x${win.h}`,
        consequence: win.w < VIEWPORT.width || win.h < VIEWPORT.height
          ? 'the picture covers only part of the window and the rest is black'
          : 'the game is larger than the window',
      });

    // And the canvas the user is looking at really is that size, so the two
    // numbers being equal means the picture reaches the edges.
    const canvas = await c.page.evaluate(() => {
      const el = document.querySelector('canvas');
      return el ? { w: el.width, h: el.height } : null;
    });
    that('the canvas is the size of the window', canvas && canvas.w > 0, { canvas });
    that('nothing is left over at the edges of the canvas',
      canvas && Math.abs(canvas.w - win.w) <= 2 && Math.abs(canvas.h - win.h) <= 2,
      { canvas, gameIsRenderingAt: `${win.w}x${win.h}` });
  } finally {
    await c.close();
  }
}
