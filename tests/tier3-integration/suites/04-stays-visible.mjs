// The picture does not fall back to black once it is up.
//
// The first bug had two halves and this guards the second: pictures arriving late
// or the screen going dark again after it had been correct. A stream that shows
// a picture and then loses it is worse than one that never showed it.
import { connect, that, DEADLINE_MS } from '../lib/harness.mjs';

export const name = 'the picture stays on screen while the game sits still';

export async function run() {
  const c = await connect();
  try {
    const up = await c.waitForPicture({ deadlineMs: DEADLINE_MS });
    that('the picture comes up before the persistence check', up.ok,
      { litFraction: up.lit, ...up.state });

    // Still no input. If the stream needs a redraw to keep the canvas alive,
    // this is where it shows.
    for (let i = 0; i < 4; i++) {
      await c.page.waitForTimeout(3000);
      const lit = await c.lit();
      that(`the picture is still on screen ${(i + 1) * 3}s later`, lit > 0.05,
        { litFraction: lit, atSecond: (i + 1) * 3 });
    }
  } finally {
    await c.close();
  }
}
