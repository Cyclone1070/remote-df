// A drawn frame is only whole if every picture it names has arrived.
//
// The client will not draw a frame while any of its pictures are outstanding, so
// one stalled picture is a black screen rather than one missing sprite. This
// asserts the transfer actually finishes, and names the picture that did not if
// it doesn't.
import { connect, that, DEADLINE_MS } from '../lib/harness.mjs';

export const name = 'every picture a drawn frame names has arrived';

export async function run() {
  const c = await connect();
  try {
    const r = await c.waitForPicture({ deadlineMs: DEADLINE_MS });
    that('the screen came up at all, so there is a frame to judge', r.ok, {
      litFraction: r.lit, ...r.state,
    });
    that('the client is not still waiting on a picture',
      !r.state.missing || r.state.missing === 0,
      { missing: r.state.missing, incomplete: r.state.incompletePictures });
    that('no picture was abandoned as undeliverable',
      !r.state.unfetchable, { unfetchable: r.state.unfetchable, ...r.state });
    that('every chunk of every picture arrived',
      Object.keys(r.state.incompletePictures).length === 0,
      { incomplete: r.state.incompletePictures });
  } finally {
    await c.close();
  }
}
