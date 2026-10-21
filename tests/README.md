# Tests

Three tiers, ordered by what they cost to run. A defect belongs to the lowest
tier that can see it: a rule that can be checked without a game, a browser or a
network must be checked there, because that is the tier a change is developed
against. The higher tiers confirm; they do not replace.

| tier | cost | needs | answers |
|---|---|---|---|
| 1 · unit | ~10 s | nothing (compiles on the host) | does this rule hold? |
| 2 · contract | ~1 s | nothing | do the two halves of the wire still agree? |
| 3 · integration | ~2 min | a running stack | does a user actually see the game? |

## Run them

```sh
sh tests/tier1-unit/run.sh                    # unit: C++ headers + client JS
node --test tests/tier2-contract/*.mjs        # contract: wire formats
node tests/tier3-integration/run.mjs          # integration: live stack
node tests/tier3-integration/run.mjs 02 05    # named suites only
node tests/tier3-integration/run.mjs --no-restart
```

Tier 3 restarts the session once at the start, deliberately: the suites build on
a warm game, because "a client joins a game that is already running" fails
differently from "a client joins a cold one" and only the warm case reproduces
the bug that started this.

## Tier 1 — unit

`tier1-unit/interposer/` holds the C++ tests. They include the **shipping
headers**, not a copy, so a header that stops being self-contained fails here
instead of at link time somewhere else. They compile on the build host because
they need zstd and jpeglib, which a development machine does not have.

`client/test/` holds the JavaScript tests, colocated with the source they test.

## Tier 2 — contract

The interposer is C++ and the page is JavaScript, and nothing at runtime checks
that they still agree about the wire. A field that moves by two bytes decodes as a
plausible number, so the symptom is a stream that is subtly wrong rather than a
crash.

These tests read the offsets **out of the C++ source** and compare them against
what the page decoder reads. When a struct changes, the test that fails is the one
that names the struct that changed.

## Tier 3 — integration

`lib/harness.mjs` is the only file that knows how to talk to a running stack. A
suite describes what a user should see; it does not open sockets, restart
sessions or scrape logs itself. When the stack changes, one file changes and the
suites still mean what they said.

Each suite asserts one user-visible claim:

| suite | claim |
|---|---|
| `01-session` | the stack is up, the game process exists, the streamer answers |
| `02-picture-without-input` | connecting to a still picture delivers it, with no input |
| `03-pictures-complete` | every picture a drawn frame names has arrived |
| `04-stays-visible` | the picture does not fall back to black |
| `05-reconnect` | a client joining a warm game gets the picture too |

**A failed suite writes evidence.** `evidence/tier3/<run>/failure.md` contains the
claim, the measurements that settled it, the session state, the stream counters,
the server log around the failure, and a screenshot from a fresh connection. A red
line on its own answers nothing; a red line with the numbers attached is already a
diagnosis.

The browser hook in the harness decodes every data-channel message *inside the
page*, before any page script runs. That is what lets a suite tell "the server
never sent it" from "the client never kept it" — different bugs with the same
black screen.

## Note on `tests/legacy/`

The files in `tests/legacy/` predate this structure: one-off probes written to
answer one question each, kept because some are quoted as evidence in
`docs/`. They are not a suite and are not run. When a probe's question becomes a
standing claim, the claim is rewritten as a suite in the tier above and the probe
is left where it is.
