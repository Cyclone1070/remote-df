// Tests for the picture-queue policy in interposer/texture_queue.hpp.
//
// The policy exists because pictures and frames share one SCTP send queue.
// A picture is up to 8 MB (a 1920x1080 RGBA surface is 8,294,400 bytes), a
// frame is ~114 B to ~4 KB. Letting pictures fill the queue is what froze the
// client: the frame path refused to send while the queue was deep, so the
// screen stopped updating for over a second while the queue drained.
//
// Build:  g++ -std=c++17 -O1 -o /tmp/ttb tests/test_texture_budget.cpp
#include <cstdint>
#include <cstdio>
#include <vector>

#include "../interposer/texture_queue.hpp"

static int g_failures = 0;

#define CHECK(cond)                                                          \
    do {                                                                     \
        if (!(cond)) {                                                       \
            std::printf("FAIL %s:%d: %s\n", __FILE__, __LINE__, #cond);      \
            g_failures++;                                                    \
        }                                                                    \
    } while (0)

// Cycle 1: the room test, and the defer/take round trip.
static void test_room_only_below_budget() {
    TextureQueue q(512 * 1024);
    CHECK(q.has_room(0));
    CHECK(q.has_room(511 * 1024));
    CHECK(!q.has_room(512 * 1024));
    CHECK(!q.has_room(9 * 1024 * 1024));
}

static void test_defer_then_take_in_order() {
    TextureQueue q(512 * 1024);
    CHECK(q.size() == 0);

    q.defer(7, 0);
    q.defer(9, 0);
    CHECK(q.size() == 2);

    uint16_t id = 0;
    uint32_t next = 0;
    bool urgent = false;
    CHECK(q.take(id, next, urgent));
    CHECK(id == 7);
    CHECK(next == 0);
    CHECK(q.take(id, next, urgent));
    CHECK(id == 9);
    CHECK(next == 0);
    CHECK(!q.take(id, next, urgent));
    CHECK(q.size() == 0);
}

// Cycle 2: a picture interrupted part way must resume, not restart or duplicate.
static void test_interrupted_picture_resumes_at_earliest_owed_chunk() {
    TextureQueue q(512 * 1024);

    q.defer(4, 9);   // gave up after chunk 8
    q.defer(4, 3);   // a later attempt got further back; keep the earliest owed
    CHECK(q.size() == 1);

    uint16_t id = 0;
    uint32_t next = 0;
    bool urgent = false;
    CHECK(q.take(id, next, urgent));
    CHECK(id == 4);
    CHECK(next == 3);
    CHECK(q.empty());
}

static void test_repeat_defer_does_not_move_the_owed_chunk_forwards() {
    TextureQueue q(512 * 1024);

    q.defer(11, 2);
    q.defer(11, 7);  // must not skip chunks 2..6
    CHECK(q.size() == 1);

    uint16_t id = 0;
    uint32_t next = 0;
    bool urgent = false;
    CHECK(q.take(id, next, urgent));
    CHECK(id == 11);
    CHECK(next == 2);
}

// Cycle 3: a picture the client explicitly asked for is blocking a frame it
// already holds commands for, so it must not queue behind pictures nobody is
// waiting on.
static void test_requested_picture_jumps_ahead_of_speculative_ones() {
    TextureQueue q(512 * 1024);

    q.defer(1, 0);   // speculative dump
    q.defer(2, 0);   // speculative dump
    q.defer_front(3, 0);

    uint16_t id = 0;
    uint32_t next = 0;
    bool urgent = false;
    CHECK(q.take(id, next, urgent));
    CHECK(id == 3);   // the requested one goes first
    CHECK(q.take(id, next, urgent));
    CHECK(id == 1);   // the rest keep their order
    CHECK(q.take(id, next, urgent));
    CHECK(id == 2);
}

// A request for a picture that is already part-sent must NOT rewind it. The
// client re-asks for anything it still needs about every 1.5s, so rewinding
// means a picture too large to send in that window can never finish - which is
// exactly how the full-screen backdrop went missing.
static void test_request_for_a_part_sent_picture_does_not_rewind_it() {
    TextureQueue q(512 * 1024);

    q.defer(1, 0);
    q.defer(5, 40);       // chunks 0..39 already sent
    q.defer_front(5, 0);  // client asks again; must continue, not restart

    uint16_t id = 0;
    uint32_t next = 0;
    bool urgent = false;
    CHECK(q.size() == 2);
    CHECK(q.take(id, next, urgent));
    CHECK(id == 5);
    CHECK(urgent);
    CHECK(next == 40);   // progress kept
    CHECK(q.take(id, next, urgent));
    CHECK(id == 1);
}

// Cycle 4: a picture bigger than the budget is sent across several drains. The
// part-sent picture is put back, and it must not lose the priority it had, or a
// requested picture ends up behind a session's worth of speculative ones again.
static void test_urgency_survives_being_put_back() {
    TextureQueue q(512 * 1024);

    q.defer(1, 0, false);
    q.defer(2, 0, true);   // requested

    uint16_t id = 0;
    uint32_t next = 0;
    bool urgent = false;
    CHECK(q.take(id, next, urgent));
    CHECK(id == 2);
    CHECK(urgent);

    // Only part of it fit, so it goes back - still urgent.
    q.defer(id, next, urgent);
    q.defer(3, 0, false);

    CHECK(q.take(id, next, urgent));
    CHECK(id == 2);
    CHECK(urgent);   // still ahead of the speculative ones
}

static void test_urgency_is_sticky() {
    TextureQueue q(512 * 1024);

    q.defer(9, 0, false);
    q.defer(9, 0, true);   // asked for later; must upgrade, not duplicate
    CHECK(q.size() == 1);

    uint16_t id = 0;
    uint32_t next = 0;
    bool urgent = false;
    CHECK(q.take(id, next, urgent));
    CHECK(id == 9);
    CHECK(urgent);
}

int main() {
    test_room_only_below_budget();
    test_defer_then_take_in_order();
    test_interrupted_picture_resumes_at_earliest_owed_chunk();
    test_repeat_defer_does_not_move_the_owed_chunk_forwards();
    test_requested_picture_jumps_ahead_of_speculative_ones();
    test_request_for_a_part_sent_picture_does_not_rewind_it();
    test_urgency_survives_being_put_back();
    test_urgency_is_sticky();

    if (g_failures) {
        std::printf(">>> %d FAILURE(S) <<<\n", g_failures);
        return 1;
    }
    std::printf(">>> ALL TEXTURE BUDGET TESTS PASSED <<<\n");
    return 0;
}
