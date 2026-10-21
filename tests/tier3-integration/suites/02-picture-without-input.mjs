// THE regression this tier exists for.
//
// A client that connects while the game's picture is not changing must still be
// sent that picture. The stream sends on change, and the send path used to live
// only inside the game's draw hook, so a game parked on a still menu sent nothing
// and the newcomer watched a black canvas until it happened to press something.
//
// No input of any kind is sent by this suite. That is the whole assertion.
import { connect, that, DEADLINE_MS } from '../lib/harness.mjs';

export const name = 'connecting to a still picture delivers it, with no input';

export async function run() {
  const c = await connect();
  try {
    const r = await c.waitForPicture({ deadlineMs: DEADLINE_MS });
    that('the picture arrives without the user touching anything', r.ok, {
      waitedMs: r.ms,
      litFraction: r.lit,
      ...r.state,
    });
    that('the picture is the whole screen, not a fragment', r.lit > 0.5,
      { litFraction: r.lit });
  } finally {
    await c.close();
  }
}
