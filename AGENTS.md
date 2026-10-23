# Working notes for agents

Things that cost hours to learn and are invisible from the code. Read this before
driving the game, the bench, or the client.

## Driving the game

**Pan keys are `a` `d` and `w` `s`.** Not the arrow keys. A check that presses
`ArrowUp`/`ArrowDown` will conclude the camera is stuck and blame the transport,
when the key simply is not a pan key in this build. This mistake was made for five
consecutive rounds and produced a string of false "the scenario is broken" reports.

- pan: `a` / `d` (horizontal), `w` / `s` (vertical)
- zoom: `]` and `[`
- elevation: `>` and `<`
- unpause / pause: `Space` — it is a **toggle**, so pressing it on a running game
  pauses it. Never press it blind. Detect first, then press only if paused.

**Press spacing must be at least 250 ms.** Measured with per-press attribution:
250 ms gives 6/8 presses landing as distinct camera moves (the misses are map
edges), while 120 ms and 60 ms give **0/8** — every press swallowed. A sweep at
those spacings reports coverage the camera never had.

**The arena loads paused.** A paused game changes nothing, so every interaction
measures a frozen picture. Unpause before measuring, and verify activity by
watching a counter advance rather than assuming.

**The client shows "LOADING PICTURE…" while it is not ready.** `window.renderer.commands`
is already populated during that time, so a command-count check reports "ready"
when the screen is still blank. Gate on `renderer.assetsReady === true` **and**
`missingTextureIds().size === 0`. Clicks sent before that land on a blank canvas
and are lost, which is why automated arena entry kept failing.

**Arena entry clicks:** main menu `(640,478)` → Classic Arena row `(180,144)` →
Create arena `(975,755)`. The menu rows are only ~330 px wide, so an x of 640
misses every one of them. Wait for `assetsReady` before the first click.

## Measuring

- **The log is the report.** The bench's printed lines are an OVERVIEW. Any
  analysis must do its arithmetic and filtering on `steps.ndjson`; if a claim
  cannot be reconstructed from the log, it is not a finding.
- **The pixel path's page is lossy MJPEG.** Never use it as ground truth for
  picture equality or for "did it animate" — JPEG ringing produces visible change
  on a completely static scene. This produced a false "the pixel path animates
  while ours does not" conclusion.
- **`/df-stats` counters must be appended at the end** of both the format string
  and the argument list. Inserting in the middle silently misaligns every field
  after it; that produced a claimed 23.5M `SDL_UpdateTexture` calls against 664
  actual calls.
- **Parity is a picture-equality check, not a latency check.** It must hold the
  game paused for every comparison, otherwise the two paths photograph an
  animating world at different instants.
- **Report tails** — p90/p95/worst. The median hides the stalls a player notices.
- **Payload must be reported next to latency.** Instruction-path cost is a
  per-*motion* cost (new artwork), not a per-frame one: a still camera costs
  ~24 KB/s, panning into unseen terrain costs MB/s. Comparing rows with different
  payloads is comparing different tests.

## Facts worth not rediscovering

- The interposer captures every draw: ~998 `SDL_RenderCopy` per frame, zero
  dropped. `SDL_RenderCopyEx`, `SDL_UpdateTexture`, fills, lines and geometry are
  all called zero times by this game.
- Artwork must be sent when a frame references it, not when a texture is created.
  Sending on creation meant 99.96% of pictures sent were never drawn.
- The client's per-frame picture traffic is almost entirely cache hits: measured
  3,454 sent against 1,119,802 skipped.
- Client paint cost is ~0.5 ms and frame apply ~0 ms. The client is not the
  bottleneck; the wire and the artwork are.
- `/tmp` inside the game container is not the host's `/tmp`. Knobs like
  `/tmp/df_raw_on` must be set with `podman exec remote-df touch ...` over ssh.
- The server often needs `bash scripts/df_restart.sh 192.168.1.111:8484` after a
  deploy before `/df-stats` responds.

## Measurement traps that cost real time

- **Never launch the bench browser with `--disable-frame-rate-limit` or
  `--disable-gpu-vsync`.** They let `requestAnimationFrame` run at **900 Hz**
  (measured: 0.2 ms median gap) against a display's 60. With them, "the client is
  holding 300 pictures" was reported 3,397 times; without them, 28. The client was
  being measured in a browser that cannot exist.
- **A stall logged per loop turn measures the frame rate, not the stall.** Hold a
  frame 300 ms at 900 Hz and it is 270 "held" records; at 60 Hz it is 18. Log
  episodes with durations.
- **Arena detection by command count is impossible on this build:** main menu 976
  commands, world generation 10 912, arena 465. The honest test is that panning
  moves the view — and even that is fooled by a loading screen, which animates by
  itself.
- **`/df-stats` polling shows up in the interposer's own event log** as client
  disconnects, because every one-shot HTTP request ends in the same close path. 175
  phantom "disconnects" in one run were the bench measuring itself. Only sockets
  with a live RTC session count now.
