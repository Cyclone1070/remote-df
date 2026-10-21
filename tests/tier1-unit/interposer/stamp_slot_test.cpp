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
    s.receive(2, 10);            // overwrites 1 before any frame claimed it
    CHECK(s.overwritten == 1, "an input replaced before being claimed must be counted as overwritten");

    uint8_t claimed = 0;
    CHECK(s.claim(20, 1000, claimed) && claimed == 2, "the surviving stamp must be the newest input");
    int64_t age = -1;
    s.settle(Packet::Frame, 30, claimed, &age);
    CHECK(s.answered == 1, "the frame answers one input");

    // A stamp that has waited past the limit can be dropped without claiming it,
    // and one inside the limit survives the same check.
    s.receive(3, 100);
    CHECK(!s.expire_if_stale(1100, 1000), "a stamp inside the age limit must survive the check");
    CHECK(s.has && s.stamp == 3, "a stamp inside the age limit stays in the slot");
    CHECK(s.expire_if_stale(1200, 1000), "a stamp older than the age limit must be droppable without claiming it");
    CHECK(s.expired == 1, "an aged-out stamp must be counted as expired");

    // A fresh input after that is claimable again, and a claim whose present
    // sends nothing returns to the slot rather than being spent.
    s.receive(4, 1201);
    CHECK(s.claim(1201, 1000, claimed) && claimed == 4, "a fresh input is claimable after an expiry");
    CHECK(!s.settle(Packet::Nothing, 1210, claimed, &age), "a present that sent nothing answered nothing");
    CHECK(s.has && s.stamp == 4, "an unsettled claim returns to the slot");

    CHECK(s.received == 4, "four inputs arrived (got %llu)", (unsigned long long)s.received);
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
static void test_handback_into_an_occupied_slot_is_counted() {
    State s;
    s.receive(1, 0);
    uint8_t claimed = 0;
    CHECK(s.claim(0, 1000, claimed), "claim the first input");

    s.receive(2, 5);                       // arrives while the claim is in flight
    CHECK(s.has && s.stamp == 2, "the newer input waits in the slot");

    int64_t age = -1;
    CHECK(!s.settle(Packet::Nothing, 10, claimed, &age), "a present that sent nothing answered nothing");
    CHECK(s.has && s.stamp == 2, "the newer input must not be displaced by the older stamp");
    CHECK(s.overwritten == 1, "the older input, superseded while in flight, is recorded as replaced");
    CHECK(s.received == s.answered + s.overwritten + s.expired + (s.has ? 1 : 0),
          "the counts must still close: received %llu = answered %llu + overwritten %llu + waiting",
          (unsigned long long)s.received, (unsigned long long)s.answered,
          (unsigned long long)s.overwritten);
}

// A zero stamp is not a stamp. This never reaches the slot from the wire (the
// input handler ignores byte 16 == 0), but the rule is stated where it is
// enforced rather than only where it is checked.
static void test_zero_stamp_is_not_claimable() {
    State s;
    s.receive(0, 0);
    uint8_t claimed = 0;
    CHECK(!s.claim(0, 1000, claimed), "a zero stamp is not claimable");
}

int main() {
    test_every_input_is_accounted_for();
    test_nothing_sent_hands_the_stamp_back_silently();
    test_input_during_a_claim_is_not_an_overwrite();
    test_zero_stamp_is_not_claimable();
    test_handback_into_an_occupied_slot_is_counted();

    if (failures) {
        std::printf("%d assertion(s) failed\n", failures);
        return 1;
    }
    std::printf("stamp_slot: all assertions passed\n");
    return 0;
}
