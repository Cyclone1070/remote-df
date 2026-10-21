// There is no moment where the loading indicator is gone and the screen is empty.
//
// The indicator used to come down when the data channel opened, which is not when
// the picture arrives. Between the two the user sat looking at a black canvas with
// nothing on it: the spinner had stopped, so there was no sign anything was still
// happening, and the wait was as long as the pictures took.
//
// The claim is about a duration, not an instant. One frame of overlap between the
// indicator leaving and the first frame painting is not perceptible and is not
// worth contorting the code to remove; two seconds of blank screen is the bug.
import { connect, that, DEADLINE_MS } from '../lib/harness.mjs';

export const name = 'the loading indicator stays up until the picture is on screen';

// Long enough to absorb a couple of repaints and the fade the indicator uses,
// short enough that the gap this test exists for is far outside it.
const TOLERATED_BLANK_MS = 400;

export async function run() {
  const c = await connect();
  try {
    const up = await c.waitForPicture({ deadlineMs: DEADLINE_MS });
    that('the picture came up at all, so there is an end of the wait to measure', up.ok,
      { litFraction: up.lit, ...up.state });

    const trace = await c.loadTrace();
    that('the page recorded what was on screen while it loaded', trace.length > 5,
      { samples: trace.length });

    // A black, uncovered screen is only a defect once the app is on screen at all:
    // before the first paint there is no canvas and no indicator to be missing.
    let started = false;
    let blankFrom = null;
    let worst = 0;
    let worstAt = 0;
    for (const [ms, overlayUp, lit] of trace) {
      if (overlayUp) started = true;
      if (!started) continue;
      const blank = !overlayUp && lit === 0;
      if (blank && blankFrom === null) blankFrom = ms;
      if (!blank && blankFrom !== null) {
        const d = ms - blankFrom;
        if (d > worst) { worst = d; worstAt = blankFrom; }
        blankFrom = null;
      }
    }
    if (blankFrom !== null) {
      const d = trace[trace.length - 1][0] - blankFrom;
      if (d > worst) { worst = d; worstAt = blankFrom; }
    }

    // Without this the test passes on a page that never showed an indicator at
    // all: the loop below would skip every sample and find nothing wrong. A gate
    // that cannot fail is not a gate.
    that('the indicator was actually on screen while it loaded', started, {
      samples: trace.length,
      anyOverlay: trace.some(t => t[1] === 1),
      note: 'if the indicator never rendered, "no gap after it" is vacuously true',
    });

    that(`the screen is never black with the indicator gone for more than ${TOLERATED_BLANK_MS}ms`,
      worst <= TOLERATED_BLANK_MS, {
        longestBlankWithNoIndicatorMs: worst,
        startedAtMs: worstAt,
        samples: trace.length,
        note: 'the indicator must stay up until a frame has actually been drawn',
      });
  } finally {
    await c.close();
  }
}
