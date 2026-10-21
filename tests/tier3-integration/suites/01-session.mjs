// The stack is up and says so.
//
// Everything else in this tier depends on this, so it fails first and alone
// rather than letting four suites report the same outage as four bugs.
import { session, stats, gamePid, that } from '../lib/harness.mjs';

export const name = 'session is running and the game process exists';

export async function run() {
  const s = await session();
  that('the server reports a running session', s.state === 'running', { session: s });
  that('the session names its stream port', Number(s.streamPort) > 0, { streamPort: s.streamPort });

  // A session that reports running while the game process is gone is the failure
  // mode that makes every later suite meaningless, so check the process too.
  const pid = gamePid();
  that('the game process is alive', /^\d+/.test(pid), { pid });
  that('the reported pid is the pid actually running', String(s.pid) === pid.split('\n')[0],
    { reported: s.pid, actual: pid });

  // Counters must be readable: a streamer that cannot answer /df-stats cannot be
  // diagnosed, and that is itself a defect worth failing on.
  const st = await stats();
  that('the streamer answers with stats', !st.error, { stats: st });
}
