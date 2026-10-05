# remote-df — QA issues (manual, paired evidence)

Every finding below is backed by a native capture and a client capture of the **same screen**,
saved side by side in this repository. Differences are reported from looking at the two images,
not from an aggregate metric. A number is only ever quoted alongside what the image shows.

Build under test: the current reverted tree, deployed and hash-verified
(`libdf_streamer.so` built `ac3ea3ee…`, deployed `ac3ea3ee…`; served bundle `index-lqespIk5.js`
matches the local build).

> **No hosts, usernames, addresses or machine identifiers appear in this file.** The streaming
> host and the container are referred to only by role. Earlier revisions of this document named
> them; that has been removed, and it must stay removed.

---

## Method note that governs every number below

Screens differ between native and client for two entirely different reasons, and telling them
apart is the whole job:

1. **A real defect** — the client renders something the native screen does not have.
2. **Animation phase** — parts of DF's output animate continuously (lava, flowing water), and
   the native capture is taken seconds after the client capture, so the two are at different
   points in the cycle.

Without a control measurement these are indistinguishable, and the animated surface is large
enough to manufacture fake defects. So on every screen a **noise floor is measured first**: two
native captures are taken with no input at all and compared. On the arena screen this is
**11,597 px (1.2584%)** of self-difference.

Only then is a client capture compared — and on animated screens the client frame is compared
against a **burst of native frames**, with the *best*-matching frame used, so that animation
phase cannot be mistaken for a defect.

Two concrete cases where this changed the verdict:

- Arena entry initially measured **5.83%**. Its best-matching native frame was **0.88%, below
  the noise floor** → the client was correct and the 5.83% was animation.
- A later screen measured **6.09%**; two regions were **0.000%** identical and the remainder was
  lava, confirmed by magnification → also animation, not a defect.

A difference is only called a defect when it survives both the noise floor and the phase match
and is then **visible in the magnified image**.

---

## D-1 — Large full-screen background artwork intermittently absent in the client

**Severity:** high — this is the first thing a player sees.

**Native** (container DF window, 1280×720):

![native title screen](./qa/qa22_native.png)

**Client** (same screen, same moment):

![client title screen](./qa/qa22_client_title.png)

### What the images show

Native renders the complete title screen: the giant stone-textured **DWARF FORTRESS** wordmark
across the top and the full-colour cave artwork filling the window. The client renders the same
screen with **both the artwork and the wordmark entirely absent** — pure black behind the UI.

Everything else on that screen is correct and in the right place:

| Element | Native | Client |
|---|---|---|
| "DWARF FORTRESS" wordmark | present | **missing** |
| Background artwork | present | **missing (black)** |
| "Histories of Greed and Determination" | present | correct |
| All 6 menu buttons incl. "Object testing arena" | correct | correct |
| Yellow dwarf logo, fmod logo, orange icon | present | correct |
| "v53.16 / Copyright (C) 2002-2026 by Tarn Adams, Bay 12 Games" | present | correct |

### Status: INTERMITTENT, not constant

This is the most important correction to an earlier claim in this document. D-1 was originally
written as a permanent defect. It is **not**: on the arena and world-map screens the artwork
renders perfectly and the client is pixel-identical to native. It is the **large full-screen
background layer on menu screens** that drops out, and it recovers on its own.

### Related lead

The container log contains **4,597+** occurrences of:

```
[TEXTURE_DC_ERROR] Message size exceeds limit
```

The origin of that log line **is now established**. It is the catch block of
`send_texture_packet_dc()` in [`interposer/df_streamer.cpp`](./interposer/df_streamer.cpp), which
builds one `dc->send()` containing a texture's **entire** RGBA buffer and, on failure, logs the
exception and moves on. There was no retry, no re-request path and no chunking.

Because the stream channel is `maxRetransmits: 0`, a texture that fails was **permanently** lost
for the life of that connection, and nothing in the client could ask for it again. The renderer
then drew the frame anyway, silently skipping absent sprites — which is the missing artwork and
the black tiles.

Three changes close the loss path:

1. **The frame channel is now ordered** (`ordered: true`, still `maxRetransmits: 0`). Frames arrive
   in send order and a loss is repaired by bridging rather than by a retransmit that would
   head-of-line block every later frame.
2. **Assets gate the frame.** The renderer collects every texture the command buffer references
   and refuses to draw while any are absent, holding the last good frame instead of displaying one
   with holes in it.
3. **Opcode `0x08` asset bridge.** The client reports the frame it is stuck on together with the
   texture ids it *already holds*, and the host responds with **only** the missing ones
   ([`df_streamer.cpp`](./interposer/df_streamer.cpp) `resend_missing_textures`, resolved against
   the encoder's history ring). Requests are keyed on the missing set with a 1.5 s backoff, so an
   absent asset is not re-requested on every arriving frame.

### RESOLVED — 0 px parity with native

The title screen now compares **0 px different against all six native frames**, background
artwork included. The arena measures **0 px across nine steps** with a **0.000%** soak worst case,
down from 0.526%.

Two independent causes had to be closed, and neither was the one originally suspected.

**1. The size cap.** DataChannels refuse any message above the peer's advertised
`a=max-message-size`, which Chrome sets to **262,144**. A 1280×720 RGBA surface is ~3.6 MB, so
those textures were refused at the API boundary every time — `Message size exceeds limit`, logged
and forgotten, with no retry and no way for the client to ask again. Textures are now **chunked to
128 KB** and reassembled client-side (`ingestTextureChunk`). A full-screen background becomes 29
chunks; a small texture still costs exactly one message. Measured after the change: 2,182 chunks /
42 MB delivered with **zero** `TEXTURE_DC_ERROR`.

**2. Recovery was a no-op.** The first bridge asked *"resend what frame N needs"* and the host
diffed that against **its own copy of frame N**. The client's accumulated command buffer and that
single frame disagree, so the diff came out empty and the host replied *"Client already holds every
asset for frame N"* — **zero resends in the entire log**. A lost chunk was therefore permanent and
the gate waited on it forever. Opcode `0x08` now carries the **missing ids directly**, so the host
resends exactly those with no frame to agree about. Observed working: `Frame 8 asked for 2
asset(s); sent 2, 0 not held here`.

The gate itself was nearly a third defect. On first deploy it held the very first frame forever and
the screen came up **blank white**, because `syncAssets` only ran when a frame or texture *arrived*
and an idle DF sends nothing. Fixed with a per-asset retry budget; the cap is deliberately **not**
raised via `setMaxMessageSize`, chunking handles it.

---

## D-2 — Glyphs dropped mid-word on the world-list screen

**Severity:** high — text is the primary content of the game.

**Native** (world list):

![native world list](./qa/qa03_native.png)

**Client** (after the same single `ArrowDown`):

![client world list](./qa/qa03_client_key_arrowdown.png)

### What the images show

| Text / element | Native | Client |
|---|---|---|
| World title | `Histories of Jealousy and Resourcefulness` | `istori s o    a o sy and   so r    n ss` — **glyphs dropped mid-word** |
| World row | `World: Xestusstrasp, "The Enchanted Planets"` | `W   - X    p 'Th E h    P   "` — **mostly missing** |
| Date line (green) | `1st Granite, early spring, 250` | correct |
| Column headers | `▼ World name ▼` `▼ Folder ▼` `▼ Last played` | present, truncated/misaligned |
| **"Files" button** | present | **missing entirely** |
| Copyright | `…Bay 12 Games` | `…Bay 12 Gam s` |

### Diagnosis — status: still UNPROVEN, but much better constrained

This does **not** reproduce anywhere else that was tested. On the game-type screen every string
renders identically (help panel measured **0.000% differing**), and in the arena the spawn menu's
long creature list renders every name and every `♀`/`♂` glyph correctly.

So the defect is **not** "text is broken in general", and not a scaling, colour or positioning
fault. It is confined to long, dense strings on a list screen that redraws. The distinguishing
test — logging which texture IDs the glyphs use and checking each is present in the client atlas
at draw time — has **not** been run, so no cause is claimed.

---

## D-3 — The entire text layer can vanish from a frame, then recover by itself

**Severity:** high — a whole frame is wrong.

**Native** (game-type screen, unchanged):

![native game type screen](./qa/qa05_native.png)

**Client** (same screen, same moment, one `ArrowUp` earlier):

![client with all text missing](./qa/qa10_client_arrowup.png)

### What the images show

Native shows the header "Select a game type to begin!" and the four labelled buttons
`Fortress` / `Adventurer` / `Legends` / `Back to title menu`.

The client at that moment shows **the button rectangles correctly drawn** — correct fills,
correct lavender borders, correct red highlight bar — and **not one character of text anywhere
on the screen**. The header is gone, every button label is gone, the help panel is gone.

### It recovers

Captures taken immediately afterwards, at t=5 s, t=10 s and t=20 s, are **byte-identical to each
other** and show the text fully restored:

![client text recovered](./qa/qa11_client_t20.png)

So this is a **transient whole-layer loss**, not a permanent one. It is the severe end of the same
family as D-2: rendered content that should be present is intermittently absent, and the
difference between D-2 and D-3 is how much of the screen is affected — a few characters versus
every character.

---

## D-4 — Individual map sprites dropped from the world map

**Severity:** medium — content silently missing from a screen.

**Native** and **Client**, world map, magnified 8× from each:

![missing map sprite compared](./qa/qa16_cmp_cluster.png)

### What the images show

The magnified crops cover the same map region. Native contains **four** orange tent/site icons;
the client contains **three** — the right-most one is simply absent. The terrain, rivers, rock
and tree tiles around it are identical.

This was confirmed not to be animation: **two native captures taken 3 s apart with no input
differed by 0 pixels** on this screen, so the map is static and the missing sprite is a real
loss.

---

## D-6 — Side panel background is not opaque; the map renders through it

**Severity:** high — UI chrome is transparent, text sits on unreadable background.

**Found by the checkpoint harness, not by the manual walk.** It is recorded here because the
manual pass over the same screen missed it entirely, which is itself worth noting.

**Native:**

![native arena screen](./qa/qa35_native.png)

**Client**, same screen:

![client arena screen](./qa/qa35_client.png)

The `Conflict Level` / `No Quarter` / `Morale/Fear Off` panel, magnified 5× from each:

![panel compared](./qa/qa35_panel_check.png)

### What the images show

Native fills the panel with **solid opaque dark grey**. The client fills it with nothing — the
**lava map texture shows straight through** behind `Conflict Level`, behind `No Quarter`, and in
the band above `Morale/Fear Off`. The glyphs themselves render correctly; it is the panel's
background fill that is missing, leaving text sitting directly on animated lava.

### Measurement

Over the panel region (x 1085–1258, y 208–290):

| | lava-coloured pixels in the panel |
|---|---|
| Client | **2,698** |
| Each of the six native frames | 1,038 – 1,094 |

Native does show *some* lava there — the crop extends past the panel's edges — so the client is
carrying roughly **1,650 extra** lava pixels that no native frame ever shows. Every native frame
differs from the client by 3,840–4,033 px across that region.

![difference map](./qa/qa35_mask_other.png)

This is a **static** element — the panel fill does not animate — so the difference cannot be
explained by phase, and it is not the same defect as D-5: there the panel was the wrong width,
here it is the right width with no background behind it.

### Why the manual pass missed it

The earlier arena region breakdown sampled the stone pool, the right-hand wall and the toolbar.
The panel sits at y 208–290, **above** every one of those windows, so no sampled region covered
it. The whole-screen figures on that step were dismissed as lava because most of the screen was
lava. This is the failure mode the harness exists to remove: a step that is "all lava" hides a
static defect sitting in a small window at the edge.

---

## Checkpoint harness — `scripts/qa_parity_walk.mjs`

Added so this walk can be re-run as a regression checkpoint rather than re-typed by hand.

```
DF_SSH_HOST=user@host QA_URL=http://host:8484/ node scripts/qa_parity_walk.mjs
DF_SSH_HOST=user@host QA_URL=http://host:8484/ QA_ONLY=arena_created,pan node scripts/qa_parity_walk.mjs
```

It walks all 17 steps (title → menus → world map → return to title → arena → pan/scroll/spawn →
soak), and for each one writes:

| File | What it is |
|---|---|
| `client.png` | the browser canvas at that step |
| `native_01..NN.png` | a burst of native frames, `NN = QA_BURST` (default 6) |
| `native.png` | the best-matching native frame — the pair partner |
| `mask_all.png` | every pixel the client shows that **no** native frame shows |
| `mask_other.png` | the same, minus colours that look like lava or water |

plus `index.html` (side-by-side links per step) and `summary.md`.

**It deliberately reports no pass/fail.** DF animates lava and water, so a plain pixel diff
manufactures defects; the script only locates the difference and hands it to you. The colour
split into lava/water is indicative only — DF's darker lava and water cells fail a naive colour
test, which is why `mask_other.png` must be looked at.

Two failures from this session are defended against in the script:

- **A capture that silently fails** is refused rather than analysed. Writing frames from a
  temporary directory produced a vacuous "0 px" result once; the script now checks that every
  file exists and is over 1 KB before comparing anything.
- **Keyboard focus (E-1)** — the pointer is warped into the DF window before every keypress,
  because with no window manager X focus is `PointerRoot` and DF silently ignores keys otherwise.

Configuration is entirely environment-driven (`DF_SSH_HOST`, `QA_URL`, `QA_BURST`, `QA_ONLY`,
`QA_SOAK_FRAMES`, …); no host, address or credential appears in the file.

---

## D-5 — Right-hand info panel rendered too narrow, clipping its text

**Severity:** medium-high — content is cut off and unreadable.

**Native** (embark placement view):

![native full-width panel](./qa/qa17_native.png)

**Client** (same screen):

![client narrow clipped panel](./qa/qa17_client_title.png)

### What the images show

The right-hand information panel is drawn **~140 px too narrow** in the client, and everything
inside it is clipped at the new, incorrect edge:

| Panel content | Native | Client |
|---|---|---|
| Panel width | extends to the window edge | **ends ~140 px early** |
| `Broek: The Hatred of Sizzling` | full | `Broek: The Hatred of` — **truncated** |
| `Iron Gold Silver Copper Nickel Zinc` | full | `Iron Gold Silver Copp` — **truncated** |
| `Goblins Hostile, twenty thousand` | full | `Goblins Hostile, t` — **truncated** |
| `Nearest site: 1/2 day's travel east` | full | `Nearest site: 1/2 d` — **truncated** |
| Bottom buttons | `Embark`, `Show elevation`, `Show cliffs/grade` | `Embark`, `Show elevation`, `S` — **third button cut off** |

### Reproducible

The same defect and the same ~7.36% difference reappeared on a later attempt at the same screen
([`qa20_native.png`](./qa/qa20_native.png) / [`qa20_client_title.png`](./qa/qa20_client_title.png)),
where native was **byte-identical** across both attempts (`eb31e100…`) — i.e. DF was not changing
state, the client was consistently mis-rendering it.

Note that on the *map* view of the same screen the panel renders at the correct width. The defect
appears on this particular layout, which suggests a grid or column-width computation that is
wrong for that screen's layout rather than a constant misconfiguration.

---

## Environment findings (not product defects)

### E-1 — Keyboard input silently stops until the pointer is moved into the window

This cost real time to diagnose and is worth recording because it looks exactly like a broken
input pipeline.

Symptoms: arrow keys and `Enter` are delivered to the server and pushed into SDL — the container
log shows `[INPUT] key=1073741906 scancode=82 … DOWN` and `[HOOK_RAW] ev: [0]=0x300 …` — yet DF
does not react, and the screen does not change. The client's capture is byte-identical before and
after, which looks like a product defect.

Cause: the container runs Xvfb with **no window manager**. With no WM, the X input focus
defaults to `PointerRoot`, so keyboard input goes to whichever window is under the pointer. When
the pointer drifts away from the DF window, SDL considers the window unfocused and DF ignores
key events.

Resolution: **moving the pointer over the DF window restores input immediately**, and it stays
restored. Every capture run in this document warps the pointer into the window before sending
keys. This is a property of the headless test setup, not of remote-df.

### E-2 — The streaming host and the container are the same machine

One host runs both the container under test and a second, unrelated DF process used as a native
reference. Native captures are taken from the container's own DF window, which is the same
process the stream renders and is therefore the correct pairing partner.

### E-3 — Native captures come from the container window, not the host DF

The host's X display has no listening socket, so its DF process cannot be screenshotted without
restarting the display, which would kill that instance. All native captures therefore come from
the container window.

---

## Action QA performed in the Object Testing Arena

Per the workflow, the Object Testing Arena was used for interaction testing (reached from the
title screen → "Object testing arena" → "Classic Arena" → "Create arena"). Each action was
performed as a single input, then captured and compared. **All actions matched.**

| Step | Action | Result | Evidence |
|---|---|---|---|
| qa23 | Enter the arena | **0.000% differing — pixel-identical** | [`qa23_native.png`](./qa/qa23_native.png) / [`qa23_client_arena.png`](./qa/qa23_client_arena.png) |
| qa24 | Select "Classic Arena" | **0.000% differing** | [`qa24_native.png`](./qa/qa24_native.png) / [`qa24_client_classic_sel.png`](./qa/qa24_client_classic_sel.png) |
| qa26 | Arena gameplay map, first render | **0.88%, below the 1.26% noise floor** | [`qa26_native.png`](./qa/qa26_native.png) / [`qa26_client.png`](./qa/qa26_client.png) |
| qa27 | Pan map — `ArrowRight` | matches; tile tooltip changes identically under the cursor | [`qa27_native.png`](./qa/qa27_native.png) / [`qa27_client_arrowright.png`](./qa/qa27_client_arrowright.png) |
| qa28 | Scroll — mouse wheel up | matches; both moved **Elevation 5 → 6** with identical tiles | [`qa28_native.png`](./qa/qa28_native.png) / [`qa28_client_wheelup.png`](./qa/qa28_client_wheelup.png) |
| qa29 | Open spawn menu (`+ creature`) | **0.47%, below noise floor**; full creature list and `♀`/`♂` glyphs correct | [`qa29_native.png`](./qa/qa29_native.png) / [`qa29_client_spawnbtn.png`](./qa/qa29_client_spawnbtn.png) |
| qa30 | Click `Create` | matches; "Placing creatures / Right click when done" in both | [`qa30_native.png`](./qa/qa30_native.png) / [`qa30_client_created.png`](./qa/qa30_client_created.png) |
| qa31 | Place creature on the map | matches; sprite and `Indep 1` header identical | [`qa31_native.png`](./qa/qa31_native.png) / [`qa31_client_placed.png`](./qa/qa31_client_placed.png) |
| qa32 | Zoom/recentre via the minimap | matches; pool interior and toolbar **0.000%**, remainder is lava animation | [`qa32_native.png`](./qa/qa32_native.png) / [`qa32_client_minimap.png`](./qa/qa32_client_minimap.png) |

### How "no defects in the arena" was actually established

The first pass at the table above was **not rigorous**: four of the nine steps measured above the
noise floor and were dismissed by eye. That is the same shortcut that produced the phantom button
defect, so it was redone.

The stronger test does not ask "which native frame is closest" but **"does the client's pixel
appear in *any* native frame?"**. A pixel matching no frame in a burst is either content the
client invented or content it never received — neither is legitimate.

Applying it to every arena capture:

| Capture | Pixels matching no native frame |
|---|---|
| qa26 arena first render | 5,199 |
| qa27 pan | 10,792 |
| qa28 scroll | 13,236 |
| qa29 spawn menu | 2,639 |
| qa30 create | 18,259 |
| qa31 place creature | 13,546 |
| qa32 zoom/recentre | 23,385 |

**The control matters here.** Running the identical method with a *native* frame as the subject
returns **0 px** for every burst — the native frames within a burst are pixel-identical to each
other. So on its own that result pointed *against* the client, and it was not dismissed.

Mapping every one of those pixels onto the client image shows they are confined to two animated
surfaces, **lava and water**, and nothing else:

![qa32 all unmatched pixels](./qa/qa32_mask.png)

![qa32 unmatched pixels that are neither lava nor water by colour test](./qa/qa32_other.png)

The second image is the decisive one. A colour test split those pixels into "lava", "water" and
"other"; the "other" pixels were then isolated and shown to be **DF's darker maroon lava cells**,
which failed the hot-orange threshold. The same holds for the water in qa27:

![qa27 unmatched non-lava non-water pixels](./qa/qa27_other.png)

**Result: across all seven arena captures, zero unmatched pixels fall on stone, walls, text, the
minimap, the toolbar or any sprite.** Every one is an animated lava or water cell. This agrees
with the direct region measurement on qa32, where the pool interior and the toolbar strip were
both exactly **0.000%**.

So the arena result stands — but it now rests on locating the difference rather than on not
noticing it.

### Coverage limits of the arena QA — stated so this is not overread

Nine actions were exercised. **Not** covered: right-click, drag-pan, the other three spawn
categories (blood, tree, weather), placing multiple entities, and rapid input sequences. The
arena is also the only area where the client has been clean; every confirmed defect below is on
menu and navigation screens.

---

**Zoom note.** The arena's map view exposes no `+`/`−` zoom pair. All on-screen controls were
enumerated by magnifying them ([`qa28_ui_zoom.png`](./qa/qa28_ui_zoom.png) for the bottom spawn
toolbar, [`qa31_minimap.png`](./qa/qa31_minimap.png) for the minimap, which has only the `→` arrow).
The mouse wheel drives z-level (Elevation 5 → 6, verified), and the minimap `→` recentres the
view. No tile-size zoom control exists on this screen in DF itself, so there is nothing further
to compare.

---

## Evidence index

| File | What it is |
|---|---|
| [`qa02_native.png`](./qa/qa02_native.png) / [`qa02_client_entered.png`](./qa/qa02_client_entered.png) | Title screen, artwork missing in client (D-1, first sighting) |
| [`qa03_native.png`](./qa/qa03_native.png) / [`qa03_client_key_arrowdown.png`](./qa/qa03_client_key_arrowdown.png) | World list, glyphs dropped (D-2) |
| [`qa04_client_key_enter.png`](./qa/qa04_client_key_enter.png) | **Partial frame** — the image behind a withdrawn finding; see method notes |
| [`qa05_native.png`](./qa/qa05_native.png) / [`qa05b_client_t35.png`](./qa/qa05b_client_t35.png) | Settled game-type screen at 1280×720 |
| [`qa05_cmp_header_buttons.png`](./qa/qa05_cmp_header_buttons.png) | Header + buttons, 3× from each |
| [`qa05_cmp_buttonedge.png`](./qa/qa05_cmp_buttonedge.png) | Button bevel, 8× — disproved a phantom defect |
| [`qa08_native.png`](./qa/qa08_native.png) / [`qa08_client_warp_then_down.png`](./qa/qa08_client_warp_then_down.png) | Game-type screen with help panel; help panel **0.000%** differing |
| [`qa10_client_arrowup.png`](./qa/qa10_client_arrowup.png) | **Entire text layer missing** (D-3) |
| [`qa11_client_t20.png`](./qa/qa11_client_t20.png) | Text recovered on its own (D-3) |
| [`qa16_native.png`](./qa/qa16_native.png) / [`qa16_client_escape.png`](./qa/qa16_client_escape.png) | World map; [`qa16_cmp_cluster.png`](./qa/qa16_cmp_cluster.png) = dropped sprite, 8× (D-4) |
| [`qa17_native.png`](./qa/qa17_native.png) / [`qa17_client_title.png`](./qa/qa17_client_title.png) | Panel too narrow, text clipped (D-5) |
| [`qa20_native.png`](./qa/qa20_native.png) / [`qa20_client_title.png`](./qa/qa20_client_title.png) | D-5 reproduced |
| [`qa22_native.png`](./qa/qa22_native.png) / [`qa22_client_title.png`](./qa/qa22_client_title.png) | Title screen showing "Object testing arena"; artwork missing in client (D-1) |
| [`qa23`…`qa32` pairs](./qa/qa23_native.png) | Arena action QA, see table above |
| [`qa32_cmp_leftborder.png`](./qa/qa32_cmp_leftborder.png) | Left border at 4× — confirms lava animation, not a defect |
| [`qa35_native.png`](./qa/qa35_native.png) / [`qa35_client.png`](./qa/qa35_client.png) | Arena screen with the transparent panel (D-6) |
| [`qa35_panel_check.png`](./qa/qa35_panel_check.png) | The panel at 5× from each — lava shows through in the client |
| [`qa35_mask_other.png`](./qa/qa35_mask_other.png) | D-6 difference map, produced by the checkpoint harness |
| [`qa32_mask.png`](./qa/qa32_mask.png) | Every pixel matching no native frame, overlaid |
| [`qa32_other.png`](./qa/qa32_other.png) / [`qa27_other.png`](./qa/qa27_other.png) | Those pixels minus lava/water by colour — all darker lava/water cells |
| [`qa05_client_current.png`](./qa/qa05_client_current.png) | Captured at 1400×900 viewport; see method notes |

---

## Method notes — instruments that produced wrong answers

These are recorded deliberately. Every one of them would have put a wrong finding in this
document had it not been caught.

- **A screenshot taken before the frame settles is invalid.** `qa04_client_key_enter.png` was
  captured mid-paint — button fills present, borders absent, lower text block not yet drawn — and
  was used to conclude "text renders clean on this screen", which was false. The defence is to
  confirm the image has stopped changing: three captures 5 s apart here were byte-identical.
- **A pixel-class scan is a locator, not a verdict.** A per-pixel classification reported that
  native drew a ~4 px button bevel and the client a ~1 px line. Magnifying 8× disproved it: the
  extra "border" pixels were background artwork, which exists on the native side and is missing on
  the client side, so the sampling window was not comparing like with like.
- **Without a control, animated content manufactures defects.** See the method note at the top.
- **`strings` is not installed in the container**, so its absence reports "0 matches" for a
  string that is present. The same fact was re-established with `grep -a`.
- **A window capture produced a 0-byte file** that looked valid until the file type was checked.
  Every native capture since is validated for PNG magic and dimensions before being trusted.
- **Two captures can be identical in content and differ in bytes.** A client/native pair with
  different SHA-256 and different file sizes was checked and found to differ by at most **3/255**
  per channel — PNG compression noise, not a rendering difference.