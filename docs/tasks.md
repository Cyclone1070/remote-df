# Tasks

Open work, in priority order. Each item states how it is proven done, because
several items below exist only because an earlier measurement was believed
without one.

## A. Benchmark — rebuilt, done

The old bench was invalid and was replaced. What it got wrong, and what
`scripts/df_bench.mjs` does instead, is recorded in `docs/bench.md`. In short:

- The measured event is now **the picture the player is looking at changed**,
  timed once per path on the page, at the element that shows the picture. Smart
  records a sample only when a paint resolves to instances that differ from the
  ones already on screen, so an artwork arrival the client already holds no
  longer counts as a frame. Raw reads the picture back through its own `<img>`;
  the second `fetch('/raw.mjpg')` subscription is gone.
- The metrics are three: wire bytes counted once at the producer's send call,
  freeze counts on the display timeline (>100 ms, >250 ms, >500 ms, and the
  longest), and input-to-visible-change p50 for inputs proven to change the
  picture.
- Every gate can fail: the load gate takes one consistent snapshot, the action
  gate is measured against an untouched window, a sampler that never varies fails
  the run, and a deliberate 1500 ms stall in the page has to show up in the freeze
  count before any count is reported.

- [x] **A1. Count the same event the same way on both paths.**
- [x] **A2. Fill in the frame header timestamp.** Superseded: the stamp the client
      attaches to its own input is what ties a sample to its cause, and it now
      rides only frames that differ from the one before them.
- [x] **A3. Timestamp on the client**, at the element, on one clock.
- [x] **A4. Report the metric set** — three metrics, no percentiles below the
      sample floor.
- [x] **A5. Pre-flight action gate** against an untouched window. The wheel was
      meant to be the must-reject control and turned out to be live - see the
      reference notes. The gate now requires that it rejected *something*, and the
      run is thrown away if it rejected nothing.
- [x] **A6. Sampler self-check** — a series that never varies fails the run.
- [x] **A7. Measure under sustained motion.**
- [x] **A8. Window pin is checked, not assumed** — the encoded size is read from
      the producer and compared with the pin.
- [x] **A9. Retired instruments deleted**: `df_ux_bench.mjs`, `df_latency.mjs`,
      `df_latency_timeline.mjs`, `_zoomcheck.mjs`, `_verify_keepalive.mjs`.
- [ ] **A10. Retire the rest of the old scripts.** `df_wire_compare.mjs`,
      `df_m2p.mjs`, `df_raw_codec_ab.mjs`, `df_bench_suite.sh` and the other
      `df_*.mjs` tools still carry the old methodology - a shadow subscription,
      positional pairing of inputs and answers, percentiles over a handful of
      samples - and `df_bench_suite.sh` still runs them. Nothing they print should
      be quoted. They were left in place because the task was to rebuild the bench,
      not to delete tools that were not named.

## B. Connect-time picture dump

Every client that connects is pushed the entire picture cache before we know
what it needs. This is the most likely source of the send-queue spike
(`QUEUE_max=563797` against `QUEUE_p50=0`).

- [ ] **B1. Send only what the client asks for**, instead of the full cache on
      connect.
      *Done when:* `DUMP_kb` is at or near zero on connect and the client still
      draws correctly.
- [ ] **B2. Confirm the queue spike is gone.**
      *Done when:* `QUEUE_max` after several connects is a small fraction of
      563 KB, measured over a run that includes at least two client connects.

## C. Duplicate picture sends

Pictures are the overwhelming majority of the wire. In the runs taken while
rebuilding the bench: `TEX_repeat=3653` of `22636` picture sends (16%),
`WIRE_kb=43432` frames against `TEX_kb=38857` pictures — the two are the same
order of magnitude, so a repeat is worth real traffic.

- [ ] **C1. Find why the client re-requests pictures it already holds.**
      Candidates: client-side eviction under memory pressure, atlas rebuild,
      texture id recycling (`TEX_recycled` should be 0 and now reads 0), or the
      request being issued before the picture has been applied.
      *Done when:* the cause is identified with evidence, not a guess.
- [ ] **C2. Fix it.**
      *Done when:* `TEX_repeat` stays near zero across a full arena session.

## E. Keep-alive interval — removed

The smart path used to send a bare 10-byte packet at 16 ms whenever the encoder had
nothing to say, on the theory that the quiet link this path produces would let the
Wi-Fi radio fall asleep. The interval was never measured, so it was: a controlled
twelve-run matrix across {loopback, Wi-Fi} x {16 ms, 60000 ms}, three cold runs per
cell, round-robin (`evidence/bench/loopback/KEEPALIVE_MATRIX.md`).

- [x] Ping is a distinct packet, not a frame; encoder no longer knows the link exists.
- [x] Client recognises and drops it without sequencing or drawing it.
- [x] Interval configurable at runtime (`DF_KEEPALIVE_MS`, `/tmp/df_keepalive_ms`).
- [x] **Measure the interval, then remove what it measured.** No metric moved by
      more than the run-to-run spread of the same build on the same stimulus. The
      whole-run ping count (457-3374) turned out to be a property of the *session*,
      not the interval: a ping is only built when the encoder has nothing to
      **send**, so inside a measured window the delivered dose ranged 0.05-24.1 a
      second and was effectively zero in three of the six "on" runs. The one real
      effect is the length of the silence on an idle link - 30 ms with it, 1002 ms
      without - and the thing that would make that matter, a frame that arrives
      late because the link was quiet, does not happen: see the 120 s idle probe
      below. Removed, along with its flag bit, its counters, its file and
      environment knobs and its tests.
- [x] **An idle link recovers promptly without it.** `scripts/df_idle_probe.mjs`
      parks the client on the pause menu (the arena animates at ~40 changes a
      second on its own, so the menu is the only genuinely still picture in this
      game), holds it there with no input for 120 s, and measures the next change
      on the page's own clock. Keepalive off: 0 messages received during the idle
      window, the connection still up, first frame drawn 1.3 ms after it arrived
      and 45.9 ms after the key that caused it, against 13.6 ms and 83.1 ms for
      the same measurement with no idle period in front of it. Run again after the
      removal was deployed, on Wi-Fi: the host sent **0 frames and 0 bytes** in the
      whole 120 s, `clients=1` at every poll, and the next change after the idle
      still arrived in 1.3 ms. Nothing about the silence is visible to the player.

      A ping is not evidence that the host was idle either: pings shared the
      ordered queue with frames, so a ping queued behind a burst of artwork
      arrived after the gap it was supposed to exonerate.

## F. Found by the rebuilt bench (not yet fixed)

- [ ] **F0. The bench launched a software rasteriser by default, and every Wi-Fi
      number it produced was the rasteriser's.** Headless Chromium on macOS falls
      back to SwiftShader unless told which GL implementation to use, and
      SwiftShader blocks the page's main thread for 1-4 s at a time. On the same
      Mac and the same Wi-Fi, p95 was 84-149 ms through SwiftShader against 51-52
      ms through Metal. Fixed: `defaultChromeArgs(platform)` supplies the argument
      (`--use-angle=metal` on macOS, `--use-angle=gl-egl` on Linux), the page
      reports its renderer string, and `isHardwareGL` **rejects the run** before
      anything is measured if it names SwiftShader, llvmpipe or nothing at all.
      Verified both ways: with `BENCH_CHROME_ARGS=""` the run is refused with the
      rasteriser named; with the default it measures on the GPU. The Wi-Fi runs in
      `evidence/bench/` taken before this are inflated and are being retaken.
- [ ] **F0b. Frame loss was a snapshot gap.** The bench read the page's receive log
      at one instant and its display timeline tens of milliseconds later, then
      counted every host frame with no arrival as lost - including the frames sent
      in between. Across the 27 archived runs, 419 of the 424 frames called lost
      were sent after the page's log had ended. Corrected accounting: 5 of 16130
      (0.03%), and the client's own frame numbers agree (3 gaps). Fixed: one page
      call reads the display timeline, the receive log and the clock together, and
      a frame sent after the log ends is reported as `framesBeyondLog`.


These came out of the first accurate cold runs; see `docs/bench.md` for the
numbers. They are listed here rather than fixed, because the measurement had to
be trustworthy first.

- [x] **F1. A keepalive was counted as an answered input, and consumed the stamp.**
      The streamer handed the input's stamp to a packet that carries none: the
      encoder had nothing to say, a keepalive went out instead, the packet was
      non-empty so it was treated as a delivery, and the input was counted as
      answered. Measured before the fix: 485 answers claimed by the host against
      381 stamps the client could see; with pings off, 480 answers for 480 stamps,
      which is what identified the keepalive as the extra 104.

      Fixed, and verified on the live host: the rule now lives in
      `interposer/stamp_slot.hpp` - one slot, a claim that is not an answer, an
      answer only when the frame that goes out carries the stamp, everything else
      handed back under the same age limit - with unit tests in
      `tests/stamp_slot_test.cpp` that fail if a keepalive is allowed to answer.
      In the archived runs the two sides agree exactly, and the stamps
      that were handed back are visible as such: 230 inputs deferred on a
      keepalive with 362 sent, 272 answered and 272 seen; 56 deferred with 397,
      391 and 391; and in the quietest session, where the condition almost never
      arises, 1 deferred with 243 and 243. The counter that says every input
      landed in exactly one bucket is what exposed a second, smaller gap: a stamp
      handed back into a slot a newer input had already taken was displacing it
      silently, so the buckets summed to one more than the inputs received. Both
      are fixed and both are gated now. A keepalive that is built is still sent
      (a bench gate now checks that, because a refactor that suppressed them was
      caught by exactly this counter pair).

      The age limit stays 1000 ms: a cap tight enough to catch a stale stamp also
      throws away the slow samples a bench is supposed to find.
- [ ] **F2. Textures deferred behind the send queue.** `TEXQ_defer` and
      `TEXQ_qmax` grow without bound while a client catches up, and the client
      parks on the last good picture while it waits. Whether that is a cause of
      the remaining freezes or a symptom of them is not settled by the data
      gathered so far.
- [ ] **F3. Raw's relay drops frames a viewer cannot keep up with.** The
      subscriber holds one frame, so a slow browser loses intermediate pictures.
      Visible as the gap between the interposer's `RAW_sent` and the relay's
      `frames` written to the browser. In the matched pair below the relay wrote
      61.10 MB of the 61.39 MB it was handed, so this costs nothing at this speed;
      it is a risk, not a current loss.
- [ ] **F5. The raw link stops delivering after a viewer disconnects.** Seen
      twice on the live host: after the page that was watching the raw stream
      went away, the streamer kept counting frames as sent and the relay's
      counters kept climbing, while the relay received nothing more - the streamer
      was writing into a connection the relay had stopped reading. It did not
      recover on its own within 30 s; restarting the game session did. The bench
      now fails a raw run in that state instead of measuring it (`relay-fed`), but
      the underlying stop is not fixed and is not a measurement problem: a viewer
      closing must not take the path down.
- [ ] **F4. A zoom stops the picture for seconds.** Zooming changes more of the
      picture than anything else the bench can do (82-88% of it, against 44% for
      the wheel), and it is the slowest action by a wide margin: 2.3-6.3 changes
      per second against 15-20 for the wheel, with a 3966 ms gap measured while
      the workload was zooming. The host re-rasterises its whole sprite set on a
      zoom, so the queue fills with artwork and the client has nothing new to
      show. Not fixed here: the bench measures, it does not repair.

## D. Reference

- DF zooms on `[` and `]`, not the mouse wheel. Every "zoom" figure taken before
  this was known measured the response to an input that does nothing, and is
  void.
- **The mouse wheel is not dead.** It was going to be the bench's must-reject
  control, and a run caught it changing the arena's elevation (5 to 6) - 44% of
  the picture, and 15-20 changes a second while turned both ways. No action is
  declared dead in advance any more: the gate measures every candidate by the
  same rule and the run is thrown away if it rejected nothing.
- The arrow keys reach the game and do nothing. The interposer's log shows the
  SDL key event arriving for scancode 79 (`[HOOK_RAW] ev: [0]=0x300 ... [4]=79`)
  and the picture does not change, so the action gate's rejection of them is a
  fact about the game, not about the input path.
- Window pinned to 1280x720 via `/tmp/df_window_size`; without it the client's
  resize requests change the comparison. The bench now checks the pin rather than
  assuming it.
- Only a minority of presents produce a frame: the game draws far more often than
  it sends, which is what makes a redraw a poor proxy for a picture change.
