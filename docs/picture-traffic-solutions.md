# Solutions considered for the picture flood

## The problem, measured

During a camera pan in the classic arena:

| measurement | value |
|---|---|
| pictures arriving at the browser | 70–374 per second |
| pictures as a share of all traffic | 98% (16.6 MB of 17 MB) |
| frames sent | falls from 46/s to 6–9/s whenever new pictures come due |
| pictures the browser draws | 6–12 per second |
| worst gap with nothing drawn | 1475 ms |
| frames drawn with a missing picture | 0 |

The small messages that move the screen are queued behind large picture
transfers. Nothing is lost and nothing is held; the screen simply does not get a
turn.

## Option A — do not re-send pictures the viewer already has

**Idea.** The sender already keeps every picture it has sent. It currently uses
that store only to send pictures *again* — to a viewer who joined late, or to
replace one that was lost. It never uses it to decide the picture does not need
sending at all. Give each picture a fingerprint, and when a picture arrives whose
fingerprint matches one already on the viewer's side, send a short note pointing
at the copy instead of the pixels.

**Evidence it would help.** In one session, 1457 pictures were new and 916 were
repeats: roughly four in ten picture sends were bytes the browser already had.

**Why it is not the first choice.**

- It adds a new kind of message, so the client needs a new rule for "this picture
  is that other picture", and every place that resolves a picture has to follow it.
- A note points at a picture that must stay available. If the referenced picture
  is ever released, the viewer is left holding a frame it can never complete —
  exactly the failure the no-corruption rule exists to prevent.
- It treats the symptom. If the game genuinely produces new artwork at this rate,
  de-duplication saves nothing and the flood remains.

Kept on record because it is cheap to try and the repeats are real. Not first.

## Option B — send the artwork once, and stop sending tiles at all

**Idea.** Dwarf Fortress draws the map out of a tileset: a small number of images
that get reused for every tile on screen. If the streamer sent that artwork once
and then only ever said "put this piece of it here", the per-tile transfers would
disappear entirely — not because they are de-duplicated, but because they are
never created.

**Why this is more robust.** It removes the whole class of problem rather than
suppressing an instance of it. Picture traffic becomes a fixed cost paid at
start-up instead of a per-frame cost that grows with how much is on screen.

**What it depends on.** Whether the game actually reuses a stable set of images,
or builds a fresh image for each tile it draws. That is the next thing to
measure: count how many distinct images the game creates during a pan, and
whether their contents repeat.

## Option C — let frames go first, always

**Idea.** The messages that move the screen are about 8 KB per second. The
pictures are megabytes. They currently share one queue, so a large transfer can
delay a small one. Give the small messages unconditional priority: they are
always sent immediately, and pictures use only what is left.

**Why this belongs in any solution.** It bounds the damage no matter how much
picture traffic there is, and it is independent of how the pictures are produced.
On its own it does not make panning smooth if the artwork really is arriving that
fast, but without it every other fix is one bad frame away from stalling again.

## Option D — only capture a picture when its pixels change

**Idea.** Capture happens when the game creates an image. When the game creates
an image whose pixels are identical to the previous one, there is nothing new to
send.

**Why it is last.** It overlaps with Option A, it costs a comparison of every
image against the previous one, and it does nothing for the case where the game
really is producing different artwork each time.

## Order of work

1. Measure what the game actually creates during a pan (Option B's premise).
2. Frame priority (Option C), because it is correct regardless of the answer.
3. Whichever of A, B or D the measurement supports.
