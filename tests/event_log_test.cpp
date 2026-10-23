// Tests for the event log: the per-event record of everything the host does.
//
// The log exists because counters cannot answer "which picture delayed which
// frame". Counters say a stream was slow; only per-event records with a
// timestamp and a correlation id can say where the time went.
#include "../interposer/event_log.hpp"

#include <cstdio>
#include <cstdlib>
#include <vector>

static int failures = 0;

static void check(bool ok, const char* what) {
    if (!ok) {
        std::printf("FAIL: %s\n", what);
        failures++;
    } else {
        std::printf("ok: %s\n", what);
    }
}

// 1. Records come back in the order they were written, with their fields intact.
static void test_records_round_trip() {
    event_log::Ring ring(16);
    ring.note(event_log::DrawCaptured, 7, 11, 100, 200, 1);
    ring.note(event_log::PicSent, 8, 12, 300, 400, 0);
    ring.note(event_log::Present, 9, 0, 500, 0, 2);

    std::vector<event_log::Rec> out;
    const size_t n = ring.drain(out);

    check(n == 3, "three records drained");
    check(out.size() == 3, "drain filled the vector");
    check(out[0].kind == event_log::DrawCaptured && out[0].seq == 7 && out[0].id == 11 &&
              out[0].a == 100 && out[0].b == 200 && out[0].flags == 1,
          "first record keeps every field");
    check(out[1].kind == event_log::PicSent && out[1].id == 12 && out[1].a == 300, "second record intact");
    check(out[2].kind == event_log::Present && out[2].seq == 9 && out[2].b == 0, "third record intact");

    std::vector<event_log::Rec> again;
    check(ring.drain(again) == 0, "draining twice yields nothing the second time");
}

// 2. A full ring drops the OLDEST records and counts the loss. Dropping quietly
//    would make a burst look like an idle period, which is the exact failure this
//    whole logging effort is meant to end.
static void test_overflow_is_counted() {
    event_log::Ring ring(4);
    for (int i = 0; i < 10; i++) ring.note(event_log::DrawCaptured, (uint32_t)i, 1, i, 0, 0);

    check(ring.dropped() == 6, "six records counted as dropped");

    std::vector<event_log::Rec> out;
    ring.drain(out);
    check(out.size() == 4, "the newest four survive");
    check(out[0].seq == 6 && out[3].seq == 9, "survivors are the newest, in order");
    check(ring.dropped() == 0, "the drop count resets once the log has been drained");
}

// 3. A bounded drain takes only what was asked for and leaves the rest, so a
//    caller can pull a burst in chunks instead of building one enormous response.
//    The oldest records go first, because a log that returns the newest first
//    cannot be replayed.
static void test_partial_drain_keeps_the_rest() {
    event_log::Ring ring(16);
    for (int i = 0; i < 6; i++) ring.note(event_log::Present, (uint32_t)i, 0, 0, 0, 0);

    std::vector<event_log::Rec> first;
    check(ring.drain(first, 4) == 4, "a bounded drain returns only what fits");
    check(first[0].seq == 0 && first[3].seq == 3, "the oldest go first");

    std::vector<event_log::Rec> second;
    check(ring.drain(second, 4) == 2, "the remainder is still there");
    check(second[0].seq == 4 && second[1].seq == 5, "and it is the newer records");
}

int main() {
    test_records_round_trip();
    test_overflow_is_counted();
    test_partial_drain_keeps_the_rest();
    if (failures) {
        std::printf("%d FAILED\n", failures);
        return 1;
    }
    std::printf("all event_log tests passed\n");
    return 0;
}
