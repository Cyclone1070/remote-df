// The rule that decides where a re-requested picture resumes.
//
// A client asks for a picture because it does not have all of it. That is a
// statement about what the CLIENT holds. The server's queue, however, only knows
// what the SERVER sent - and on an unreliable channel those are not the same
// thing: a chunk can be sent perfectly and still never arrive.
//
// Resuming from the server's own position therefore skips the very chunk that
// was lost, for ever. The client re-asks, the server resumes past the hole, and
// the picture stays one chunk short of complete - which the client treats as
// "cannot draw this frame", so the whole screen stays black.
//
// What a request must do is start the picture again from the first chunk. The
// client already holds the chunks it kept and ignores duplicates, so resending
// costs bandwidth only, while resuming from the wrong place costs the screen.

#include <cstdio>
#include <cstdint>
#include <vector>

#include "texture_queue.hpp"

static int failures = 0;
#define CHECK(cond, what)                                                    \
    do {                                                                     \
        if (!(cond)) {                                                       \
            std::printf("  FAIL: %s\n", what);                               \
            failures++;                                                      \
        }                                                                    \
    } while (0)

int main() {
    // A picture is part-sent: the server got as far as chunk 30 of 37.
    {
        TextureQueue q(1u << 20);
        q.defer_front(10, 30);

        // The client says it is still missing picture 10. The server must send it
        // from the beginning, because it has no idea which chunks actually landed.
        q.defer_front_restart(10);

        uint16_t id = 0;
        uint32_t next = 0;
        bool urgent = false;
        CHECK(q.take(id, next, urgent), "the re-requested picture is queued");
        CHECK(id == 10, "the picture taken is the one that was re-requested");
        CHECK(next == 0,
              "a re-requested picture restarts at chunk 0, so a chunk lost in "
              "flight is sent again instead of being skipped for ever");
        CHECK(urgent, "a requested picture stays ahead of speculative ones");
    }

    // Repeated requests must not stack duplicates: the client asks every time its
    // screen is still blocked, and the queue must hold one entry, not fifty.
    {
        TextureQueue q(1u << 20);
        for (int i = 0; i < 50; i++) q.defer_front_restart(10);
        CHECK(q.size() == 1, "fifty requests for one picture leave one queued entry");
    }

    // A request that names the exact chunk it is missing must be served from
    // that chunk and no other.
    //
    // This is what makes recovery cheap. Restarting a 37-chunk picture to repair
    // one lost chunk re-floods the transport, and the chunk that gets dropped is
    // the last one queued - the same one - so the picture never completes. Asking
    // for the one chunk that is missing sends one chunk and finishes.
    {
        TextureQueue q(1u << 20);
        q.defer_front(10, 30);
        q.defer_front_at(10, 36);
        uint16_t id = 0;
        uint32_t next = 99;
        bool urgent = false;
        CHECK(q.take(id, next, urgent), "the precisely-requested picture is queued");
        CHECK(id == 10, "the picture is the one asked for");
        CHECK(next == 36, "a request naming a chunk is served from that chunk");
        CHECK(q.empty(), "one request leaves exactly one entry, not the old position as well");
    }

    // A picture that has never been sent starts at zero either way - the restart
    // rule must not disturb the ordinary path.
    {
        TextureQueue q(1u << 20);
        q.defer_front_restart(7);
        uint16_t id = 0;
        uint32_t next = 99;
        bool urgent = false;
        CHECK(q.take(id, next, urgent), "a fresh picture is queued");
        CHECK(id == 7 && next == 0, "a fresh picture starts at chunk 0");
    }

    // Speculative deferral is unchanged: it still keeps the earliest owed chunk,
    // so an interrupted background transfer is not rewound by ordinary traffic.
    {
        TextureQueue q(1u << 20);
        q.defer(4, 10, false);
        q.defer(4, 2, false);
        uint16_t id = 0;
        uint32_t next = 99;
        bool urgent = true;
        CHECK(q.take(id, next, urgent), "the speculative picture is queued");
        CHECK(next == 2, "speculative deferral keeps the earliest owed chunk");
        CHECK(!urgent, "a speculative picture is not marked urgent");
    }

    if (failures == 0) {
        std::printf("texture_queue_restart_test: all checks passed\n");
        return 0;
    }
    std::printf("texture_queue_restart_test: %d check(s) failed\n", failures);
    return 1;
}
