# The bench

Two paths stream the same game to the same browser: **smart** sends draw commands
and replays them on a WebGL canvas, **raw** sends whole JPEG pictures. This is how
they are compared, and what the numbers mean.

Everything here follows one rule: **both paths count the same event at the same
point in the pipeline.** Where that is impossible, the bench says so instead of
substituting a proxy, and every number that is quoted with a limit has the limit
written next to it.

## The event being counted

**The picture the player is looking at changed.**

It is timed once per path, on the page, at the element that shows the picture:

- **smart** — the canvas was repainted with a different set of draw instances.
  The renderer hashes the instance data it is about to draw (plus viewport and
  atlas generation) and compares it with the previous paint. A frame that draws
  the same instances again is *not* the event: an artwork arrival that changes
  nothing on screen produces no sample.
- **raw** — a readback of the visible `<img>` differs from the previous readback.
  The element is sampled at 256x144 on each animation frame and compared by hash.
  That cheap sample is **blind to changes smaller than one sample cell**: measured
  at 1280x720, a one-pixel change is missed at 96% of positions, 2x2 at 84%, 3x3
  at 64%, 4x4 at 36%, and 5x5 and larger at none
  (`evidence/bench/sampler_probe.json`). The bias is one-directional — a missed
  change lengthens an apparent gap, never shortens one — so it can only inflate a
  freeze count. To bound it, the page reads the picture back at **full
  resolution** whenever the cheap sampler has not seen a change for 100 ms, which
  is the only situation where its blindness can affect a reported number, and
  records what it finds. The bench then withdraws any long gap that contained a
  full-resolution change ("withheld") and reports how many of the remaining ones
  had such a check inside them ("verified"). Measured cost of that check: about
  11-14 ms, run at most five times a second and only while a gap is forming, so it
  can delay the observation that *ends* a gap by one check and cannot accumulate.
  What it still cannot see is a change that appears and is reversed between two
  checks; that is what "unverified" means.

Both are quantised by the animation frame (~16.7 ms). That can merge two changes
that happened within a frame into one, but it cannot turn a short gap into a
>= 250 ms one, so the freeze counts below are sound. It does mean short intervals
are aliased, which is why no per-frame interval is reported.

## What the numbers are

| Metric | How it is counted | Why this one, and its limit |
|--------|-------------------|------------------------------|
| **Wire bytes**, per phase | smart: the streamer's `dc->send`, everything it hands the data channel (frames and artwork) via `/df-stats`; raw: the relay's write of each part to the page via `/raw-stats`. Both include the connect phase and the measured window | One count per path at the call that sends the bytes. Nothing sampled, nothing estimated. **Reported separately for connect and steady state**, because they are different things: connect is the artwork dump plus the scene being set up, steady state is the game running. Quoting one ratio for both is what made an earlier version of this document describe a run that took 40 s to load as "cold" and its steady-state ratio as the cost of the session. A third figure, the **session**, is the same counter from before navigation to the close of the measured window, so the control and action windows (about 24 s) are inside it: the ratio that used to be called a whole session summed connect and one 20 s window and divided by those two spans alone, which dropped them and so biased the comparison against the smart path. |
| **Freeze counts** — gaps over 100 ms, over 250 ms, over 500 ms, the longest, how many were withdrawn, and **each bucket split by verdict** (`path` / `quiet` / `unclear`) | The page's own timeline of display changes, nearest-rank, classified against the host's own send log in the same window | Counts of events survive small samples; percentiles do not. 250 ms is the headline bucket: one animation frame of quantisation cannot manufacture a 250 ms gap, so a reported freeze means a real gap of at least 233 ms. The 100 ms bucket is reported too, and is explicitly **not** a freeze count — it is where the sampler's own bias would show up first. A bucket is never a total: delivery failing, the game having nothing to draw and a gap the data cannot settle are three different things, and only a slow sample that the page missed most of is counted separately (as a sample, not a gap). |
| **Tail latency** — p50, p90, p95, max, and n | From the page clock when the input is sent, to the display change it caused, nearest-rank | Not being able to justify a p95 at n=30 was true when the sample count was 30; these runs produce 340-390 samples, where p90 and p95 are supported. p99 is deliberately *not* reported: at these counts it is the maximum wearing a percentile's clothes. |
| **Uplink transit** — p50, p90, worst and n | Each input the page sent, matched to the arrival carrying the **same stamp** inside a tolerance | The two logs do not cover the same span: the page's send log is cleared when the window opens and the host still holds answers delivered inside it to inputs sent before, so pairing them by position put every pair one place out and refused a whole window (369 of 369). Pairing by stamp also survives an input that never arrived, which used to shift every pair after it. The tolerance is what lets the measurement survive the uplink *holding* inputs — one run has 1229 ms in which none arrived, then 21 inside a millisecond, reported as the uplink's own hole (`uplinkArrivalHole`). A pair whose arrival lands before its own send is an answer to a pre-window input: dropped and counted (`inputEarlyPairs`), never quoted. When a large share of pairs do that, the two logs are not on one clock and the window is refused rather than quoted — one run in four here was refused that way (250 of 369 pairs), with the reason printed in place of the number. A median of a shifted pairing once read **-5640 ms**; the bench prints **unpaired** and the reason instead of a number it cannot support. |
| **The host's share** | The streamer's own record: input received -> the frame carrying its stamp sent, looked up **per sample** against the answer that sample's change followed | Separates "the host was slow to answer" from "the answer was slow to arrive". Quoted next to the round trip, never instead of it. The lookup is by the answer, not by the stamp's value: the stamp is one rotating byte, so one value answers many inputs (1738 answers over 255 stamps in a measured window), and a map keyed by value hands every sample carrying that byte the same, usually wrong, share. The session-wide p50 is reported separately and labelled as a session figure. |
| **Coverage** — sent, host answered, client saw, credited | Four counters: inputs the page sent, answers the streamer counted, answers whose stamp reached the page, answers the page could attribute to a change it saw | The number that used to be one number. A stamp the host never sent is not an answer the client missed; an answer for a change the sampler did not see is not a latency sample. All four are printed, so a discrepancy names which side it is on. |
| **Consistency** — median gap, p90 gap, p90/median | The same timeline | "Smooth" is a claim about the shape of the timeline, not its average. A path that delivers 19 changes a second in two bursts with a third of a second of nothing between them is not smooth, and this is the number that says so. |
| **Wire count** | The streamer's own frame counter, delta between the two reads that bracket the window, read as the window closes | The same window as everything else, and written down as such: the spike section counts frames in the host's **send log** whose send time fell inside the window, and the two used to differ (1135 against 1127 in one run) because the counter was read again after the drain, 500 ms later. Both are labelled with their basis. On the raw path the frame-for-frame match is reported as **unavailable** rather than as zero lost: the page cannot see the parts of the stream it displays, so there is no second log to match the relay's against. |
| **Bursts** — peak bytes in a 250 ms interval over the mean, and the send queue's high-water mark | Exact deltas of the same monotonic counters, sampled every 250 ms | A stall is often a burst that filled a queue, and an average hides it. The send queue is only available on the smart path; it is reported as absent rather than as zero there where it does not apply. |
| **Spike forensics** — the worst 5% of latency samples and every freeze over 250 ms, each with the wire make-up of its own window, the send-queue depth at the message that was queued, the host's share for that sample, the gap immediately before it, and whether the client was parked | One line per event, then the signatures they share | A tail number cannot say whether a path is jittery or has a hole in it: a hundred samples that each went wrong for their own reason and a hundred that went wrong for one reason print as the same p95. The wire make-up covers **every** message kind — frame, keyframe, artwork chunk on the smart path, every relayed part on the raw path — because the first version of this recorded frames and keepalives, and textures are ~99% of the bytes here, so it reported artwork bursts as silence. The two sides run on different clocks: the offset is measured from a round trip and its spread printed next to it, and an alignment whose spread is wider than the windows being described is not usable. The host's share is looked up by the sample's own stamp, not reported as the session's median. Each event also carries what the client itself was doing: the longest stretch inside the window in which it sent nothing, whether the page was blocked, and whether the host had anything new to draw at all. That last one matters more than it looks — a display gap in which the host produced nothing is the workload being still, and counting those with the path's own stalls prints a quiet scene as a broken link. The gaps are therefore split three ways, and the host is judged against **its own observed frame rate in the same window** rather than against a fixed count of frames. A gap in which the host sent two frames in 40 ms at a 50/s rate is the host sending, and a gap in which it sent 11 frames (of the 27 its own rate predicts) that the page received 9 of is neither the path dropping pictures nor the game being still — that third answer is reported as **unclassified**, because a classifier that can only ever say "the host had nothing to draw" gives every run a clean bill of health. The first version asked for at least three frames and printed 0 the path's own across every post-fix run; that was a property of the threshold, not of the data. Frames, not messages: the client's own inputs arrive on the same log, so counting every message charged a stall to the path on the strength of the uplink alone. The verdict reads only the gaps the path owns, plus samples at least twice the median. |
| **Cold start** — connect seconds, bytes, artwork bytes, and time to first picture | Counters sampled immediately before navigation and after the load gate | The answer to "how long until I can see anything", which the freeze counts cannot see at all because a picture that has not arrived cannot stutter. |

Each printed gap carries the same reason as its verdict — a gap the host was
merely still in says "the host sent 20 frame(s) where its own rate predicts 20.8 —
the game had nothing new to draw, nothing was missing", a gap the page caused says
"the host sent 38 frame(s) where its own rate predicts 39.9 and the page got 5 —
the frame failed to arrive", and an unsettled one says so. The sentence used to
open every gap with "nothing was missing — the frame failed to arrive or the host
did not send" and then print the verdict after it, so one line asserted a failure
and denied it. The host's frame count and its own predicted count are printed in
every branch: without them the verdict is an assertion, with them it is a
measurement.

The printed gap line is a **partition of the gaps and says so**: `N freeze(s) the
path's own`, `M the host having nothing new to draw`, `K unclassified`, then
`N+M+K gap(s) in all`. A slow sample the page missed most of is a different
observation of a fault, not a gap, and is printed after that total as
`separately, X slow sample(s) whose own window the page missed most of`. The line
used to put both populations in the first number while the other two held freezes
only, so a run with one unclear gap and four path-caused samples printed "4 the
path's own ... 1 unclassified" — five, from a run with one gap. The text is built
by `gapsLine()` in `client/src/core/measure.js` so it can be asserted in a test
rather than read by eye.

Each gap's own cause is also printed on its line (below), and the three answers a
gap can get are counted per run: `path`
(the host was sending at its own rate and the page missed a third or less of it),
`quiet` (the host sent a quarter or less of what its own rate predicts), and
`unclassified` (the host sent frames its rate does not explain and the page
received most of them — they arrived and the display did not change, which is a
sampler or main-thread question neither of the other answers covers). A slow
sample is a window in which the picture *did* change, so it gets no verdict beyond
whether the page missed what was sent.

The **coverage** line is a chain of subtractions, so it has to name every bucket
that closes a gap rather than assert that there is none. It used to end "every
input that was sent was answered and every answer was seen" whenever the host had
*received* everything the page sent, even when it had answered far fewer — the
audit found a run of 366 inputs in which the host answered 307 and the line called
all 366 answered. The stamp slot is one slot deep, so the inputs that close that
gap are the ones a later input displaced before a frame claimed their stamp, and
that bucket is now passed in and printed: "33 of the 374 that reached the host were
never answered: 33 displaced by a later input before a frame claimed their stamp".
Where the answered figure comes from a different counter than the buckets do — on
the raw path the answers are the relay's echoes, not the slot's — the note names the
gap and stops ("4 of the 385 that reached the host were never answered") instead of
attributing it to a counter that does not describe it.

The **session** figure is a counter delta and a span, and both stop at the same
instant — the read after the window and its drain. Measured to the end of the run
instead, the span ran on through the stall control and the forensics serialisation
while the counter did not, and the rate came out 5.4-7.1% below the rate the same
two counters cover (100.5 s of span against a 93.8 s counter on the smart path,
88.1 against 83.6 on the raw).

The measured window opens and closes on the page's own clock, in one call at
each end: the display timeline, the receive log and the host's send log are all
cut at the same two instants. The open is one call because two calls put a display
event 4.7 ms *before* the window that contained it — one call emptied the page's
series and the next read the clock — and an event outside its own window is the
closed-timeline mistake in miniature. The host's counters still come from an HTTP
endpoint rather than from the page, so they start a few milliseconds after the
open; that lag is reported as `window.counterReadLagMs` (11 and 20 ms in the runs
kept here) so the two bases can be compared instead of assumed equal. It used to be closed by whatever the read happened
to see, 500 ms and one large serialisation after the workload stopped — up to
1.3 s of harness tail inside the window, of which one headline run's longest
reported freeze (1266.5 ms) was 82%. `window.seconds` is that span, and the
change rate is over it; the host's byte counters are read over the wall clock
between the two reads that bracket it, and that span is reported next to it as
`wallSeconds`.

Every freeze bucket is printed and stored **split by verdict** — `path`, `quiet`,
`unclear` — and never as a total. They were single numbers, and a reader of one run
saw `>250ms: 4` printed beside `unverified: 4` and asked what the four were: a
delivery failure, a scene that had nothing new to draw, and a gap the data cannot
settle are three different things, and their sum is not a measurement. The verdict
each gap got is in `freezes.detail` with the frames it was based on
(`hostFrames`, `clientFrames`, `expectedHostFrames`). The **withheld** figure is
still a count of distinct gaps, not a sum over the buckets: a 600 ms hole is over
100, over 250 and over 500, and adding the buckets reported one hole three times.

The headline line also carries how many of those gaps a full-resolution look
confirmed (`verified`) and how many it did not (`unverified`): a verdict read off
the timeline is one thing, and a verdict with a second look behind it is another.

Deliberately **not** reported: mean latency (hides the tail it is used to argue
about), p99 (see above), per-frame intervals (aliased by the animation frame), and
any comparison of change *magnitudes* between the two paths (the smart path
measures instance data, the raw path measures pixels; the numbers are not the same
quantity, and the action gate is only ever read within one path).

The spike section reads two extra endpoints, once each, at the end of a run:
`/df-wire` on the streamer (every message it handed to a link, with the
`dc->bufferedAmount()` in front of it and, for a raw capture, what the encode
cost) and `/raw-stats?parts=1` on the relay (every part it wrote, with its size,
the stamp it answered, and how long the write to the browser took). They are
deliberately separate from the counters the bench polls four times a second:
putting tens of kilobytes of log on a poll would be measurement traffic on the
link being measured.

## Gates and controls

A run is thrown away rather than quoted whenever one of these fails. The result
JSON records every gate with the numbers it used, and the run files are kept under
`evidence/bench/`, so a claim that a gate fired can be checked rather than
believed. Every rejection writes that file before it exits, including the three
(sampler liveness, producer cross-check, workload) that used to exit without one.

| Gate | What it checks | How it fails |
|------|----------------|--------------|
| Isolation, before anything is measured | smart: the raw path is **off** (`producer.raw.on == 0`); raw: it is on | The two paths share one client-stamp slot in the streamer. With the raw path live during a smart run, its capture loop is what consumes the stamp, and the smart numbers are then partly the raw path's. Measured live: with raw left on, the raw capture loop sent ~26 frames a second and claimed stamps inside a run labelled "smart". |
| Isolation, kept | During the window: the raw path sent no frames on a smart run; the relay received frames on a raw run (`ingested` > 0); one WebRTC client | A precondition that stops being true mid-run is worse than one that was never checked. The relay's own count of frames *received* is what makes the second case detectable: in the failure it exists for, the streamer keeps counting frames as sent while the relay receives nothing, and every egress counter reads zero. |
| Load | Nothing missing and artwork has stopped arriving, for three consecutive seconds | The bench measures the catch-up instead of the path |
| Window | The encoded picture really is the pinned size | A run at another resolution is not comparable |
| Action | Candidate actions are measured by `magnitudeGate`: an action is live if its largest change is at least `max(1.5 x the largest change while untouched, 20% of the picture)`; the run fails if nothing is live or nothing is dead | An earlier version compared each action with the *untouched window's peak*, so the same action at the same magnitude was live or dead depending on what the idle scene did: the wait key's 7.3% change was dead against a 14.4% idle peak and live against a 0.0% one. The reference is now stable for a given idle scene, the bar is printed with the verdict, and `barSetBy` says whether the floor or the idle scene set it. |
| Input accounting | Every input that arrived was answered, replaced by a later one, aged out, or is still waiting (`answered + overwritten + expired <= received`) | This is the check that found a handed-back stamp silently displacing a newer input: the buckets summed to one more than the inputs received. A coverage number that cannot be closed is not a coverage number. |
| Sampler liveness | At least 30 events, at least 3 distinct pictures, and a rate between 0.5 and 55 changes a second over the window | The display timeline is not being recorded. The rate window is what catches a sampler that is counting paint callbacks instead of changes - 60 a second from an untouched screen. |
| Producer vs sampler | The sampler's change count is at least 30% of the pictures the producer says differed (both paths), with no escape for small samples | The sampler is reading something other than the picture. On the raw path the producer's counter is captures that differed from the one before them; the smart path has no such counter because it sends a frame only when the picture has changed, so the frames it sent are the pictures it says differed, and the row says which of the two it read. |
| Workload | At least 30 changes in the first half of the window *and* the second half has at least a quarter of the first half's | The stimulus stopped moving the picture, so a still screen would be scored as a freeze. Both halves are now written into the result JSON: a cluster of changes at the start and nothing after it used to satisfy a first-half-only check. |
| (removed) Echo before frame (raw) | — | **Deleted, with its counters.** It could not fail: the two numbers it compared were both taken by the relay around its own two write calls, so the echo was always "first" — 908 before and 0 after on every live run. Write order inside one process is not delivery order across two transports, and the page cannot observe the frame's own arrival without a second subscription to the picture stream, so there was nothing here to measure. The ordering the relay does control — the announcement is written before the frame's bytes are released — is pinned by a Go test that counts flushes at the writer (`TestServeMJPEG_AnnouncesTheStampBeforeItFlushesTheFrame`), which can fail. |
| Deliberate stall | The page's main thread is blocked for 1500 ms mid-window and the freeze counter must report it | The counting chain from a still picture to a count is broken |

The mouse wheel was meant to be the must-reject control, on the assumption that it
does nothing in this game. It does not: in the arena it changes the elevation, and
a run caught that (the picture went from Elevation 5 to Elevation 6). So no action
is declared dead in advance. Every candidate is measured by the same rule, the
table is printed, and the run is rejected if the gate rejected nothing at all.

## Running it

```bash
# the toggles live inside the container, not on the host
ssh cyc@192.168.1.111 'podman exec remote-df rm -f /tmp/df_raw_on'   # smart runs: raw off
ssh cyc@192.168.1.111 'podman exec remote-df touch /tmp/df_raw_on'  # raw runs: raw on

# cold restart the game before EVERY run, then run that path twice
./scripts/df_restart.sh 192.168.1.111:8484
HOLD_MS=20000 node scripts/df_bench.mjs http://192.168.1.111:8484/df smart-final-1
./scripts/df_restart.sh 192.168.1.111:8484
HOLD_MS=20000 node scripts/df_bench.mjs http://192.168.1.111:8484/df smart-final-2
./scripts/df_restart.sh 192.168.1.111:8484
HOLD_MS=20000 node scripts/df_bench.mjs http://192.168.1.111:8000/ raw-final-1
```

Five more scripts exist for questions the bench itself cannot ask, all documented
in `evidence/bench/`:

- `scripts/df_load_probe.mjs <url> <label> <rateHz> <bytes> [seconds] [ssh]`
  offers a chosen number of probe messages of a chosen size per second through the
  same data channel and counts arrivals on both ends, in the browser and at the
  kernel. It is how the path's ceiling was measured rather than inferred. It
  drives the page to the arena the same way the bench does, and it refuses to run
  without hardware GL for the same reason.
- `scripts/df_recheck_archives.mjs [glob]` re-reads archived wire dumps and
  recomputes the frame-loss figure with and without the frames the host sent after
  the page's log ended, plus the client's own frame-number gaps. It states the
  covered span it compares over, because "the host sent 30808 and the page received
  30397" is a difference of two different sets, not a loss figure.
- `scripts/df_closed_timeline.mjs [glob]` re-reads archived wire dumps and prints,
  for each run, the freeze counts as they were reported and the counts with the
  window closed at the instant the workload stopped. That is where 6/3/2 and
  1266.5 ms became 5/2/1 and 948.6 ms; the table is in
  `evidence/bench/CLOSED_TIMELINE.md`.
- `scripts/df_idle_probe.mjs <url> <label>` parks a client on the pause menu and
  measures the next change after an idle stretch. It now launches with the bench's
  hardware-GL arguments and refuses to run when the page reports a software
  renderer, because it produces a latency claim.
- `scripts/df_tail_probe.mjs <wire-dump.json> [--run <result.json>] [--top N]
  [--samples] [--gap-ms 250] [--long-ms 100]` re-reads an archived wire dump and
  splits every latency sample into uplink transit, the host's own hold, the
  delivery of the answering frame (matched by sequence number across the two
  logs) and the paint after arrival; it also lists the display gaps with the
  frame that ended each one, and what every input's wait for the next change
  would have been. Its output for every stored run is
  `evidence/bench/TAIL_PROBE.txt`. It prints `REFUSED` and suppresses every
  clock-dependent field when a dump's two clocks disagree by more than the
  alignment's own spread, because a stamp value repeats and a loose lookup then
  returns another input's answer.

The scene is driven to the Classic Arena on both paths before anything is
measured. Each run writes its full result to `/tmp/bench/bench_<label>.json`; copy
the ones being quoted into `evidence/bench/` and commit them, or the run did not
happen.

The cold restart is not optional. The raw link has been seen to stop delivering
after a viewer disconnects while the streamer keeps counting frames as sent; a
fresh session is the only state in which the two paths are comparable, and the
`relay-fed` gate is there to catch the case where it is not.

Environment: `PIN` (default `1280x720`), `CONTROL_MS`, `ACTION_MS`, `HOLD_MS`,
`OUT`, `PRESS_EVERY_MS` (how often the client is driven; default 25, which is what
every run before this was made with — note that this is the uplink's packet rate as
well as the stimulus rate), `BENCH_CHROME_ARGS` (the Chromium arguments, for a host
that needs something other than the default). `DF_STATS` overrides where the
streamer's counters are read from on the raw path.

**Hardware GL is the default and its absence rejects the run.** A headless
Chromium left to its own devices renders through SwiftShader — a software
rasteriser that blocks the page's main thread for one to four seconds at a time.
That is not a noisier version of the same measurement, it is a measurement of the
rasteriser: on the same Mac and the same Wi-Fi, p95 was 84–149 ms through
SwiftShader and 51–52 ms through Metal, and every Wi-Fi latency or freeze number in
this repository taken before the default changed belongs to the rasteriser. The
bench therefore launches with `--use-angle=metal` on macOS and `--use-angle=gl-egl`
on Linux unless `BENCH_CHROME_ARGS` is set, reads the renderer the page reports
back (`WEBGL_debug_renderer_info`), and **refuses the run** — before measuring
anything — unless that string names a GPU. It is an allowlist, not a list of
rasterisers to reject: a denylist accepts every name its author did not think of,
and this one had not been told about `lavapipe`, `softpipe`, a bare `Mesa`, or
arbitrary junk, all of which it accepted while this document said the check was an
allowlist. `Mesa` is deliberately not a rejection token — the hardware renderer on
this project's Linux host reports itself through Mesa
(`ANGLE (Intel, Mesa Intel(R) UHD Graphics 630 (CFL GT2), OpenGL ES 3.2)`) — but a
string that names Mesa and no GPU is rejected, because it names no GPU.

```
  RUN REJECTED: the page is rendering through ANGLE (Google, Vulkan 1.3.0
  (SwiftShader Device (Subzero) (0x0000C0DE)), SwiftShader driver), not a GPU,
  so its latency and freeze numbers would be the rasteriser's
```

The check runs on **both paths**. The raw page used to carry no renderer record
at all (it has no canvas to ask; it displays an `<img>`, so it now reports one from
a throwaway WebGL context) and the smart-only gate meant raw runs were quoted with
nothing to show which renderer took them: of the 42 archived run files under
`evidence/bench/`, 38 carry no renderer record. The raw path's own latency was
measured to be renderer-insensitive — 86.0 ms p50 through SwiftShader against
85.8 ms through Metal, a 0.2 ms difference between two runs of the same build — so
this is record-keeping and future safety rather than a correction of the raw
numbers already quoted; what it changes is that the next raw run carries the
record, and that a raw run through the rasteriser is now refused like a smart one.
That comparison was taken before the answer-crediting fix above, so its absolute
figures are historical; what it shows is the difference between the two renderers
on one build, which is what it was taken for, and it has not been retaken.

Every Wi-Fi number in `evidence/bench/` taken before this gate existed is
inflated; the retaken runs and the comparison are in
`evidence/bench/FRAME_LOSS.md`.

**Comparing two runs.** A run is a measurement of a scene, and the scene moves on
its own: under one fixed stimulus this harness has measured **9.2 to 47.9 display
changes a second** across sessions, and what it reports follows. On the smart path
a session at 16.8 changes a second reports a 934.6 ms longest gap where one at
47.9 reports 166.5 ms — same build, same workload, same actions. On the raw path
the scene moves the p50 too: 19 changes a second reads 85.8 ms and 27 reads 54.0 ms
on one build. So the tail numbers of two runs are only comparable when the two runs
did the same amount of moving, and this document does not print a comparison it
cannot stand behind.

`comparability()` (in `client/src/core/measure.js`) refuses any pair whose change
rates are more than **1.10×** apart, and `scripts/df_compare.mjs` prints that
verdict for a set of runs — the rates first, then either the comparison or the
reason it is refused. The band comes from these runs: pairs within 1% of each other
in activity read p50s within 1%, while a 32% difference in activity moved the p50
by 24%. Fitted across the raw runs it is an exponent of about **1.27** (28.1
changes a second reads 53.9 ms, 19.5 reads 85.8 ms), so a 1.10× band still admits
a **~13% p50 difference from the scene alone** (1.10^1.27 = 1.13). That is the
price of the band, stated rather than hidden: it refuses pairs whose difference is
dominated by a scene the two runs did not share, and it does not claim that a pair
inside it measured the same scene. The choice sits on a plateau, not a knife edge:
the audit swept it, the conclusions are identical for every value from 1.04 to
1.6, and only at 1.9 does the tool start printing comparisons it exists to
prevent. It is a necessary condition, not proof of an identical scene, which is why
the two rates are printed beside every comparison. Every result carries an `activity` block (window change
rate, and each half of the window) precisely so this can be checked later rather
than remembered.

**No cross-path comparison is made in this document.** The smart runs in the
evidence set changed the picture at 15.3 and 43.0 times a second and the raw runs
at 26.9 and 28.0, so `scripts/df_compare.mjs` refuses every cross-path pair (ratios
1.54× to 2.81×) and no smart-against-raw latency or tail comparison is printed here.
The numbers stand as each run's own figure with its rate beside it — and the one
pair that is inside the band is a raw-against-raw pair, which is what makes the
band worth having rather than an excuse: two runs 1.04× apart read p50 53.1 and
53.4 ms.

Two runs of this bench are also a **list of runs, not a distribution**: with the
scene varying 2.8× under one stimulus, no number of runs of one path at one rate
generalises to another, which is why the rates are printed in the headline table
above rather than only in the JSON.

**Known limits.** A cold start can be refused as `actualWindow: unknown` when the
game has not yet reported its window size: the gate cannot confirm the pin, so it
rejects the run (measured, once, with the retry passing; it is the fail-safe
working, not a measurement). The raw wire dumps carry no input events - the raw
page's inputs are logged by the streamer, not by the relay's part log - so the raw
uplink numbers cannot be re-derived from the artefacts and are verified from the
run's own `spikes` section instead. Two runs are separate sessions, so the scene is
not identical in both, and since the scene sets what is reported the runs are not
interchangeable: every result carries an `activity` block (the display's change
rate in the window and in each half of it) and
[`scripts/df_compare.mjs`](../scripts/df_compare.mjs) refuses to compare a pair that
is more than 1.10x apart in it. Measured session-to-session spread on the **same
build** with the **same stimulus** and the same pinned window, from the runs kept in
`evidence/bench/after_audit/`: the raw path moved 54.7-76.8 MB across runs, at
26.9-28.0 display changes a second, with p50 latency of 53.1-53.4 ms; the smart path
at 15.3 and 43.0 changes a second read p50 33.7 and 33.6 ms while its longest gap
went from 1250.7 ms to 820.8 ms. Across the wider set of sessions recorded during
this work the change rate has ranged from 9.2 to 47.9 a second at the same stimulus,
and in one session the mouse wheel - the stimulus the bench *requires* to be live -
changed nothing at all and the run was rejected rather than measured. A single pair
of runs is not evidence for a difference smaller than that spread, which is why the
tail numbers in this document are always printed beside the rate that produced
them.

**The raw latency headline was taken under a credit rule that no longer exists,
and it was pinned.** Every document and archive in this repository carries raw p50
**67.9-86.2 ms**. Three consecutive runs of the build that was deployed before the
fix read **85.6, 85.8 and 85.7 ms** and credited **99-100%** of the answers the
streamer counted: the page credited every announced answer to the *next* paint
whatever that paint showed, so the number sat at the frame interval's ceiling. It
now credits the paint that shows the announced frame, and the runs taken on the
current build read:

| run | display changes/s | p50 | p90 | credited / answered |
| --- | --- | --- | --- | --- |
| `after_audit/bench_raw_r4_1.json` | 28.0 | 53.1 ms | 69.7 | 334 / 381 (88%) |
| `after_audit/bench_raw_r4_2.json` | 26.9 | 53.4 ms | 69.9 | 346 / 372 (93%) |
| a run of this build at 19.3 changes a second | 19.3 | 85.5 ms | 87.3 | 385 / 386 (99.7%) |
| three runs of the pre-fix build | 18.7-19.5 | 85.6-85.8 ms | 87.2-87.4 | 99-100% |

Read the table as a spread rather than as a correction of one number by another:
the raw p50 is set by the paint cadence, so a faster scene (27-28/s) reports a lower
p50 than a slower one (19/s) on the same build - the archived 67.9-86.2 ms sits
inside the same band. What is not a spread is the credit rule: it was 99-100% of
answers credited to whatever paint came next, and it is now 88-99.7% credited to
the paint that shows the answer. The two runs at 26.9 and 28.0 changes a second are
1.04x apart and read p50 **53.1 and 53.4 ms** - the same measurement twice, which is
what the band above is for. The old figures are kept in the table below, labelled
as the old harness's.
