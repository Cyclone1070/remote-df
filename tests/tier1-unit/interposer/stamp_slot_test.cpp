// Tests the client-input stamp slot in isolation, without the interposer's
// dependencies - it is a plain header with no includes beyond <cstdint>, so the
// rule that decides whether an input was answered can be checked on its own.
//
// Build and run:
//   clang++ -std=c++17 -Wall -Wextra -Iinterposer -o /tmp/stamp_slot_test tests/stamp_slot_test.cpp && /tmp/stamp_slot_test
#include "stamp_slot.hpp"   // -Iinterposer

#include <cstdio>

static int failures = 0;

#define CHECK(cond, ...)                                                     \
    do {                                                                     \
        if (!(cond)) {                                                       \
            failures++;                                                      \
            std::printf("FAIL %s:%d: ", __FILE__, __LINE__);                  \
            std::printf(__VA_ARGS__);                                        \
            std::printf("\n");                                               \
        }                                                                    \
    } while (0)

using stamp_slot::Packet;
using stamp_slot::State;

// Every input is accounted for: received = answered + overwritten + expired +
// still waiting. A count that cannot be closed is a count that cannot be
// defended, and the bench reports all four.
static void test_every_input_is_accounted_for() {
    State s;
    s.receive(1, 0);
    s.receive(2, 10);            // waits behind the first, not an overwrite
    CHECK(s.overwritten == 0, "a second input waits its turn instead of replacing the first");
    CHECK(s.waiting_count == 2, "both inputs are waiting (got %d)", s.waiting_count);

    uint8_t claimed = 0;
    CHECK(s.claim(20, 1000, claimed) && claimed == 1, "the oldest waiting input is claimed first");
    int64_t age = -1;
    CHECK(s.settle(Packet::Frame, 30, claimed, &age), "the frame answers it");
    CHECK(age == 30, "its age runs from its own arrival (got %lld)", (long long)age);

    // A stamp that has waited past the limit can be dropped without claiming it,
    // and one inside the limit survives the same check.
    CHECK(!s.expire_if_stale(1000, 1000), "a stamp inside the age limit must survive the check");
    CHECK(s.has && s.stamp == 2, "a stamp inside the age limit stays in the queue");
    CHECK(s.expire_if_stale(1100, 1000), "a stamp older than the age limit must be droppable without claiming it");
    CHECK(s.expired == 1, "an aged-out stamp must be counted as expired");

    // A fresh input after that is claimable again, and a claim whose present
    // sends nothing returns to the queue rather than being spent.
    s.receive(4, 1201);
    CHECK(s.claim(1201, 1000, claimed) && claimed == 4, "a fresh input is claimable after an expiry");
    CHECK(!s.settle(Packet::Nothing, 1210, claimed, &age), "a present that sent nothing answered nothing");
    CHECK(s.has && s.stamp == 4, "an unsettled claim returns to the queue");

    CHECK(s.received == 3, "three inputs arrived (got %llu)", (unsigned long long)s.received);
    CHECK(s.received == s.answered + s.overwritten + s.expired + (s.has ? 1 : 0),
          "received (%llu) must equal answered (%llu) + overwritten (%llu) + expired (%llu) + waiting",
          (unsigned long long)s.received, (unsigned long long)s.answered,
          (unsigned long long)s.overwritten, (unsigned long long)s.expired);
}

// A present with nothing to send at all: the input is still waiting, and it is
// not an answer.
static void test_nothing_sent_hands_the_stamp_back_silently() {
    State s;
    s.receive(9, 500);
    uint8_t claimed = 0;
    CHECK(s.claim(500, 1000, claimed), "claim");
    int64_t age = -1;
    s.settle(Packet::Nothing, 510, claimed, &age);
    CHECK(s.answered == 0, "a present that sent nothing cannot have answered an input");
    CHECK(s.has && s.stamp == 9, "the stamp waits for a frame");
    CHECK(s.claimed_pending() == false, "the pending flag must be cleared, or a later frame reports this age");
}

// A claim empties the slot, so an input arriving while that claim is in flight
// is not an overwrite: the claimed stamp is already on the wire, and this new
// input simply waits its turn behind it.
static void test_input_during_a_claim_is_not_an_overwrite() {
    State s;
    s.receive(1, 0);
    uint8_t claimed = 0;
    CHECK(s.claim(0, 1000, claimed), "claim");
    s.receive(2, 5);
    CHECK(s.overwritten == 0, "the claimed stamp is not overwritten - it is in flight");
    CHECK(s.has && s.stamp == 2, "the new input waits in the slot");

    int64_t age = -1;
    s.settle(Packet::Frame, 20, claimed, &age);
    CHECK(s.answered == 1, "the frame that carried the claim answers it");
    CHECK(age == 20, "its age is measured from its own arrival (got %lld)", (long long)age);
    CHECK(s.received == 2 && s.answered + s.overwritten + (s.has ? 1 : 0) == s.received,
          "the counts still close with an input waiting behind a settled claim");
}

// A stamp handed back into an occupied slot must be recorded as replaced, not
// dropped. The live runs are what found this: with the counters closing
// (received = answered + overwritten + expired + waiting) the sum was one short,
// because a claim settled while a newer input was already waiting overwrote that
// newer stamp and said nothing about it.
static void test_handback_keeps_the_older_input_ahead() {
    State s;
    s.receive(1, 0);
    uint8_t claimed = 0;
    CHECK(s.claim(0, 1000, claimed), "claim the first input");

    s.receive(2, 5);                       // arrives while the claim is in flight
    CHECK(s.has && s.stamp == 2, "the newer input waits in the queue");

    int64_t age = -1;
    CHECK(!s.settle(Packet::Nothing, 10, claimed, &age), "a present that sent nothing answered nothing");
    CHECK(s.waiting_count == 2, "both inputs are waiting (got %d)", s.waiting_count);
    CHECK(s.stamp == 1, "the older input is answered first, because it has waited longer");
    CHECK(s.overwritten == 0, "nothing was lost: both inputs are queued");
    CHECK(s.received == s.answered + s.overwritten + s.expired + s.waiting_count,
          "the counts still close: received %llu = answered %llu + overwritten %llu + expired %llu + waiting %d",
          (unsigned long long)s.received, (unsigned long long)s.answered,
          (unsigned long long)s.overwritten, (unsigned long long)s.expired, s.waiting_count);
}


// A zero stamp is not a stamp. This never reaches the slot from the wire (the
// input handler ignores byte 16 == 0), and the slot refuses it too: a signal that
// cannot be answered must not occupy the queue and block real inputs behind it.
static void test_zero_stamp_is_not_claimable() {
    State s;
    s.receive(0, 0);
    uint8_t claimed = 0;
    CHECK(!s.claim(0, 1000, claimed), "a zero stamp is not claimable");
    CHECK(s.received == 0, "a zero stamp is not an input and is not counted (got %llu)",
          (unsigned long long)s.received);
}

// Inputs arrive faster than frames. A player holding a key produces several
// inputs between two frames, and the single slot threw all but the newest away -
// which is why a live session measured 2,824 inputs received and 1,282 of them
// overwritten, with most of the rest never attributable to a picture.
//
// A frame answers the OLDEST waiting input - it was drawn with that input already
// applied - and the next frame answers the next one, until the queue drains. The
// counts still close, because every input ends answered, expired, or waiting.
static void test_inputs_faster_than_frames_are_all_answerable() {
    State s;
    s.receive(1, 0);
    s.receive(2, 10);
    s.receive(3, 20);
    CHECK(s.overwritten == 0, "inputs waiting behind each other are not overwrites (got %llu)",
          (unsigned long long)s.overwritten);

    uint8_t claimed = 0;
    int64_t age = -1;
    CHECK(s.claim(30, 1000, claimed) && claimed == 1, "the oldest waiting input is claimed first");
    CHECK(s.settle(Packet::Frame, 40, claimed, &age), "the frame answers it");
    CHECK(age == 40, "its age runs from its own arrival (got %lld)", (long long)age);

    CHECK(s.claim(50, 1000, claimed) && claimed == 2, "the next frame answers the next input");
    CHECK(s.settle(Packet::Frame, 60, claimed, &age), "answered");
    CHECK(age == 50, "its age runs from its own arrival (got %lld)", (long long)age);

    CHECK(s.claim(70, 1000, claimed) && claimed == 3, "and the third");
    CHECK(s.settle(Packet::Frame, 80, claimed, &age), "answered");

    CHECK(s.answered == 3, "three inputs, three answers (got %llu)", (unsigned long long)s.answered);
    CHECK(s.received == s.answered + s.overwritten + s.expired + (s.has ? 1 : 0),
          "the counts still close: received %llu = answered %llu + overwritten %llu + expired %llu + waiting",
          (unsigned long long)s.received, (unsigned long long)s.answered,
          (unsigned long long)s.overwritten, (unsigned long long)s.expired);
}

// The queue is bounded, so a stalled host cannot grow it without limit. Overflow
// is the only way an input is now lost, and it is counted: the counts must close,
// or the bench reports a rate it cannot defend.
static void test_overflow_drops_the_oldest_and_counts_it() {
    State s;
    for (int i = 1; i <= State::kCapacity; i++) s.receive((uint8_t)i, i);
    CHECK(s.waiting_count == State::kCapacity, "the queue fills to its bound (got %d)", s.waiting_count);
    CHECK(s.overwritten == 0, "filling exactly to the bound loses nothing");

    s.receive(99, 100);
    CHECK(s.waiting_count == State::kCapacity, "the queue never exceeds its bound");
    CHECK(s.overwritten == 1, "the dropped input is counted as overwritten (got %llu)",
          (unsigned long long)s.overwritten);
    CHECK(s.stamp == 2, "the OLDEST input is the one dropped, so the head moves on (got %u)", (unsigned)s.stamp);

    CHECK(s.received == (uint64_t)State::kCapacity + 1, "every input was received (got %llu)",
          (unsigned long long)s.received);
    CHECK(s.received == s.answered + s.overwritten + s.expired + s.waiting_count,
          "the counts close: received %llu = answered %llu + overwritten %llu + expired %llu + %d waiting",
          (unsigned long long)s.received, (unsigned long long)s.answered,
          (unsigned long long)s.overwritten, (unsigned long long)s.expired, s.waiting_count);
}

int main() {
    test_every_input_is_accounted_for();
    test_nothing_sent_hands_the_stamp_back_silently();
    test_input_during_a_claim_is_not_an_overwrite();
    test_zero_stamp_is_not_claimable();
    test_handback_keeps_the_older_input_ahead();
    test_inputs_faster_than_frames_are_all_answerable();
    test_overflow_drops_the_oldest_and_counts_it();

    if (failures) {
        std::printf("%d assertion(s) failed\n", failures);
        return 1;
    }
    std::printf("stamp_slot: all assertions passed\n");
    return 0;
}
