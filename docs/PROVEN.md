# Proven properties

Every claim below was measured, not reasoned. Each names the run or the log it
comes from. Anything not in this file is a hypothesis, an inference from the code,
or was retracted — those are listed at the end so they cannot be quoted again by
accident.

Measurement conditions unless stated otherwise: Dwarf Fortress 53.16 in the game
container, both clients attached **simultaneously** to one game process, headful
Chromium with a real compositor, wired Ethernet, pan interaction, startup excluded
from percentiles where noted.

---

## Payload

1. **A frame costs less than the pixel path's frame.** Pairing each instruction
   frame with the pixel frame nearest in time, including the artwork attributable to
   that frame's interval: **0 of 364 frames** exceeded their paired pixel frame.
   Largest instruction frame 13 847 B; smallest pixel frame in the same run
   94 225 B; p50 ratio 0.001, p95 0.082.
   *Caveat: artwork is attributed by interval since the previous frame, not by an
   exact per-frame id list.*

2. **Whole-run payload differs by ~700×.** Latest steady-state run: instruction
   **0.07 MB**, pixel **52.66 MB**.

3. **Pictures are compressed with the pixel path's own encoder.** q80 JPEG brings
   artwork to **5.8%** of raw (4.56 MB → 0.26 MB across 45 pictures), at a total
   encode cost of **7.8 ms**, worst single picture **1.68 ms**. Pictures with any
   alpha are sent raw, deliberately, to avoid black fringing.

4. **Bridge traffic names ids and sizes.** Requests and resends are recorded per id
   with the byte size of the picture the client was waiting for, e.g.
   `28 3 1 8294400` = frame 3, picture 1, 7.9 MB.

---

## Latency

5. **Painting on arrival beats painting on the tick.** Same scenario, headful, both
   clients live: paints **164 → 453**, display gap p50 **40 → 36 ms**, p95
   **309 → 61 ms**, worst **9 583 → 1 204 ms**. The client applies a frame on
   arrival; it used to wait for the next animation frame to draw it.

6. **Steady-state display cadence matches the pixel path.** 409 gaps with the
   stream running: p50 **36 ms**, p90 **53 ms**, p95 **58 ms**, p99 **76 ms**,
   worst **93 ms**. The pixel path in the same run: 37 / 52 / 57 / 90 ms.

7. **Every remaining gap ≥100 ms is outside the stream.** Five in the run: four
   before the stream starts (233, 310, 353, 835, 1 204 ms — page load, zero frames
   and zero pictures in flight) and one 591 ms catch-up with a 570 ms hold at the
   instant the stream begins.

8. **The repair round trip is real, measured end to end.** Client held a frame with
   8 pictures missing at 3 059 ms, asked immediately, first chunk of those pictures
   arrived at 4 545 ms, frame painted at 4 587 ms — **1 486 ms** of dead time for
   pictures the client had explicitly requested. The host's reply had been queued
   behind a full send budget.

9. **Repairs can overtake the budget.** After letting an urgent picture past the
   send gate (bounded reserve 256 KiB), holds in that run fell from 1 528 ms worst
   to **29 ms** (n=30).

---

## Transport

10. **The network is clean.** 200 ICMP packets to the game host: **0.0% loss**,
    RTT 2.77 / 3.69 / 5.69 ms (min/avg/max), stddev 0.47 ms, wired Ethernet on
    both ends.

11. **The host's per-channel send queue is not the cause of frame delay.** Frames
    recorded `bufferedAmount = 0` at handover still arrived up to **1 934 ms**
    later.

12. **The same frames over TCP do not queue.** With every frame mirrored over a
    TCP socket in the same instants: the TCP copy was **197 ms ahead at the
    median** (it pays a relay hop), while **103 of 671** frames on the data channel
    arrived more than 500 ms later, worst **3.98 s**.

13. **Artwork was crossing while frames waited.** In the worst 3.98 s lag: **753
    picture chunks, 1 862 KB** arrived at the client. All 60 latest frames had
    picture chunks arriving while they were in flight; none of them sat in silence.

14. **Artwork delivery rate under load: ~330 KB/s.** One hold: 109 pictures,
    1 097 KB, last chunk at +3 327 ms (337 chunks/s), while the pixel path moves
    ~5 MB/s in the same run.

15. **Frame loss is not a factor.** Frames the host hands over reach the client:
    in the audited 836 ms window, all **29 of 29** frames arrived — late, in a
    batch of nine within 0.6 ms, not lost.

---

## Client

16. **The client's own work is negligible.** Loop body **1 ms** per turn (worst
   4 ms); data-channel message handling 0–2 ms per second (worst 35 ms);
    re-asset-sync total ~0 ms.

17. **The "24 Hz client ceiling" was the harness.** Headless Chromium
    software-rasterises WebGL and presents the canvas at **20 Hz**; the same page
    with GPU flags, and in a real window, runs at **60 Hz**. The pixel page uses
    `<img>` and never touches WebGL, which is why it never showed the effect.

18. **The client paints nearly every frame it receives.** Latest run: 472 frames
    in, 466 applied, **453 painted**.

---

## Logging

19. **The log must be readable for a whole run.** Logging one record per draw wrote
    **22 GB / 650 million lines** in a single session, which made a full run
    impossible to drain: spikes could only be traced in the last few seconds. The
    draw count now rides on the frame record.

20. **A gate that cannot fail is not a gate; a counter with no consumer is not
    instrumentation.** Coverage audit result: 0 never-fired-unexplained kinds, 0
    fired-but-unread kinds, 1 conditional, 8 expected-zero with stated reasons.

---

## Retracted — do not quote these

- **"Bandwidth saturation explains the stall."** Disproven: during the stall the
  pixel path's cadence was normal (p50 45 ms, max 75 ms). It was never contended.
- **"The client loop is the bottleneck."** Artifact of software GL in headless
  (see 17). Real-window cadence is 60 Hz.
- **"The repair stall is fixed."** It returned: holds of 6 283 ms and 9 463 ms in
  the two runs after the one that showed zero. It is mitigated, not eliminated.
- **"Instruction path is faster than the pixel path"** from the period before
  simultaneous-client measurement. Sequential runs made it look better than it was;
  the comparison is only valid with both clients attached to one game.
- **"Frames are being lost."** No run has ever shown a frame that left the host and
  never arrived (see 15).

## Open — measured, not explained

- Why a 221-byte frame handed over with an empty per-channel queue sometimes arrives
  ~1–2 s later, while its TCP copy does not.
- Whether ~330 KB/s of artwork is a ceiling of the data channel or simply the demand
  at that moment. The channel's throughput has never been measured directly.
- Cold start cost — 7 920 ms and 2 309 ms in one run, 1 204 ms and 835 ms of page
  load in another. Dominates total time; never optimized.
