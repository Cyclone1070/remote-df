// Moving the camera does not freeze the stream.
//
// Every other suite asks whether a picture appears. None of them asks whether it
// keeps up, so a stream that delivers a correct picture and then stalls for a
// third of a second every second passed everything while being unusable to hold a
// mouse and look around with.
//
// The measurement is the gap between consecutive draws, taken while the camera is
// actually moving. A still screen draws nothing, so an average over a quiet scene
// says nothing about whether the display can follow a drag - which is why an
// average frame rate reported for a static scene is not evidence about smoothness.
//
// The camera is moved with WASD, which is what the game binds it to (v53.16
// controls: "wasd ... to move the camera around on the same elevation"). This test
// previously dragged the mouse, which does not move the camera at all - the only
// thing that moved was the tile tooltip - so it measured a still picture, passed
// every threshold, and reported smoothness while the display was freezing.
import { connect, stats, that, DEADLINE_MS, enterArena, cameraCanMove } from '../lib/harness.mjs';

export const name = 'panning the camera does not stall the display';

// A stutter is only tolerable if it is short. These are drawn from the frame rate
// the game itself runs at (50/s): a p95 much above one frame interval means the
// display, not the game, is what is holding things up.
const MAX_P95_MS = 120;
const MAX_GAP_MS = 500;
const MAX_LONG_GAPS = 3;   // gaps over MAX_GAP_MS in a 12 second drag

const gapStats = (times) => {
  const gaps = [];
  for (let i = 1; i < times.length; i++) gaps.push(times[i] - times[i - 1]);
  if (gaps.length === 0) return null;
  const sorted = [...gaps].sort((a, b) => a - b);
  const at = (p) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
  return {
    n: gaps.length,
    p50: Math.round(at(0.5)),
    p95: Math.round(at(0.95)),
    max: Math.round(sorted[sorted.length - 1]),
    over: gaps.filter((g) => g > MAX_GAP_MS).length,
  };
};

export async function run() {
  const c = await connect();
  try {
    const up = await c.waitForPicture({ deadlineMs: DEADLINE_MS });
    that('the picture is up before measuring motion', up.ok, { litFraction: up.lit, ...up.state });

    // The arena is the only view here with a map worth moving across.
    await enterArena(c.page);
    const moved = await cameraCanMove(c.page);
    that('the camera actually moves before smoothness is measured', moved, {
      note: 'a still picture makes every gap short and every threshold pass, which '
        + 'is how this suite previously reported success on a display that never moved',
    });

    // Let the transfer settle, so a gap caused by the opening backlog is not
    // reported as a stutter caused by moving.
    await c.page.waitForTimeout(2000);
    const before = (await c.timings()).drawTimes.length;

    // Both ends, measured over the same window: a low draw rate on its own does
    // not say which side is behind, and "the display is slow" and "the server
    // stopped sending" need opposite fixes.
    const srvBefore = (await stats()).frames;
    const dragStart = Date.now();

    // Pan by holding a direction, cycling so the camera keeps moving without
    // sliding off the map. Each key is held rather than tapped: a tapped key moves
    // the camera only while it is down, so tapping measures the gaps between taps.
    const PAN_KEYS = ['a', 'd', 'w', 's'];
    const t0 = Date.now();
    let step = 0;
    while (Date.now() - t0 < 12000) {
      const key = PAN_KEYS[step % PAN_KEYS.length];
      await c.page.keyboard.down(key);
      await c.page.waitForTimeout(700);
      await c.page.keyboard.up(key);
      step++;
    }

    const dragMs = Date.now() - dragStart;
    const srvAfter = (await stats()).frames;
    const { drawTimes, frameTimes, picTimes } = await c.timings();
    const drawn = drawTimes.slice(before);
    const draws = gapStats(drawn);
    const frames = gapStats(frameTimes);
    const seconds = dragMs / 1000;
    const srvRate = Math.round((srvAfter - srvBefore) / seconds);
    const drawRate = Math.round(drawn.length / seconds);
    const evidence = {
      dragSeconds: Math.round(seconds * 10) / 10,
      drawnDuringDrag: drawn.length,
      draws: draws && { ...draws, perSecond: drawRate },
      framesArrived: frames && { ...frames, perSecond: Math.round(frames.n / seconds) },
      serverFramesSent: { count: srvAfter - srvBefore, perSecond: srvRate },
      // Pictures are the other half: a frame is held until its pictures arrive,
      // so a low draw rate with no pictures arriving is a picture problem, and a
      // low draw rate with pictures arriving is a holding problem.
      picturesArrived: {
        count: picTimes.length,
        perSecond: Math.round(picTimes.length / seconds),
      },
      missingNow: (await c.state()).missing,
      whichSideIsTheStall: {
        serverSendingAtLeast20fps: srvRate >= 20 ? 'yes' : 'NO - the server stopped sending',
        clientDrawingAtLeast20fps: drawRate >= 20 ? 'yes' : 'NO - the client stopped drawing',
      },
    };

    that('the display kept drawing while the camera moved', drawn.length > 50, {
      ...evidence,
      note: 'a handful of draws over 12s of dragging is the freeze itself',
    });

    that(`the display keeps up while panning (p95 under ${MAX_P95_MS}ms)`,
      draws.p95 <= MAX_P95_MS, evidence);
    that(`no long freeze while panning (worst gap under ${MAX_GAP_MS}ms)`,
      draws.max <= MAX_GAP_MS, evidence);
    that(`at most ${MAX_LONG_GAPS} long freezes in the drag`,
      draws.over <= MAX_LONG_GAPS, evidence);
  } finally {
    await c.close();
  }
}
