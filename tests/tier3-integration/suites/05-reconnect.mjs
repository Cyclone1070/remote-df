// A second client joining a game that is already running gets the picture too.
//
// This is the case that fails when the picture a new client needs is only sent
// as a side effect of the game drawing something new: the game has already drawn,
// so there is nothing new to send, and the newcomer waits forever.
import { connect, that, DEADLINE_MS } from '../lib/harness.mjs';

export const name = 'reconnecting to a warm game delivers the picture';

export async function run() {
  const first = await connect();
  try {
    const a = await first.waitForPicture({ deadlineMs: DEADLINE_MS });
    that('the first client gets the picture', a.ok, { litFraction: a.lit, ...a.state });
  } finally {
    await first.close();
  }

  // The game is now warm: it has drawn, and is sitting still.
  const second = await connect();
  try {
    const b = await second.waitForPicture({ deadlineMs: DEADLINE_MS });
    that('a client joining afterwards gets it too', b.ok, {
      waitedMs: b.ms, litFraction: b.lit, ...b.state,
    });
  } finally {
    await second.close();
  }
}
