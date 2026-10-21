// The host-side wire log, in isolation.
//
// This exists because the first version of the spike instrumentation recorded
// frames and keepalives and dropped textures, and textures are ~99% of the bytes on
// this link - so every explained spike read as "nothing was being sent". The
// rule the log has to keep is therefore not "it records something" but "it can
// record a message of any kind, including the kinds nobody thought about".
//
// Build and run:
//   clang++ -std=c++17 -Wall -Wextra -Iinterposer -o /tmp/wire_log_test tests/wire_log_test.cpp && /tmp/wire_log_test
#include "wire_log.hpp"

#include <cstdio>
#include <string>

static int failures = 0;

#define CHECK(cond, ...)                                                          \
    do {                                                                          \
        if (!(cond)) {                                                            \
            failures++;                                                           \
            std::printf("FAIL %s:%d: ", __FILE__, __LINE__);                      \
            std::printf(__VA_ARGS__);                                             \
            std::printf("\n");                                                    \
        }                                                                         \
    } while (0)

// The defect this log exists to prevent: a log that only knows about frames and
// keepalives. An artwork chunk must land in the log with its own size, and it must
// survive into the JSON a bench reads.
static void test_artwork_chunks_are_logged_not_dropped() {
    wire_log::Log log;
    log.note(1000, wire_log::Kind::Frame, 114, 0, 0, 7);
    log.note(1001, wire_log::Kind::Artwork, 131088, 4096, 0, 0);
    // 3 is a number this header deliberately does not name: it was the downlink
    // keepalive until the keepalive was removed. The log takes any number, so a
    // kind that exists on the wire but not in this enum is still recorded.
    log.note(1002, 3, 18, 0, 0, 0);

    CHECK(log.events() == 3, "three messages must be three events, got %zu", log.events());

    const std::string json = log.json(2000);
    CHECK(json.find("\"events\":[[1000,0,114,0,0,7],[1001,2,131088,4096,0,0],[1002,3,18,0,0,0]]") != std::string::npos,
          "every message, artwork included, must appear in the JSON: %s", json.c_str());
}

// The log is capped, and it drops the OLDEST events: a bench reads it at the end
// of a run, and the events describing the measured window are the newest.
static void test_the_cap_drops_the_oldest() {
    wire_log::Log log(3);
    for (int i = 0; i < 5; i++) log.note(1000 + i, wire_log::Kind::Frame, 100, 0, 0, 0);

    CHECK(log.events() == 3, "the cap must hold, got %zu", log.events());
    const std::string json = log.json(0);
    CHECK(json.find("[1000,") == std::string::npos, "the oldest event must be the one dropped");
    CHECK(json.find("[1004,") != std::string::npos, "the newest event must survive");
}

// The host's own share of a latency sample is per sample, not per session: a
// median cannot describe the one sample that was slow.
static void test_stamp_ages_are_kept_per_sample() {
    wire_log::Log log;
    log.note_stamp(7, 12, 5000, wire_log::Path::Smart);
    log.note_stamp(8, 141, 5100, wire_log::Path::Raw);

    const std::string json = log.json(0);
    CHECK(json.find("\"stamps\":[[7,12,5000,0],[8,141,5100,1]]") != std::string::npos,
          "per-sample host shares must be addressable by stamp: %s", json.c_str());
}

// A queue reading is a level. The bench needs the level as it was, so each entry
// carries the queue depth observed when that message was handed to the link.
static void test_queue_depth_rides_with_each_message() {
    wire_log::Log log;
    log.note(1000, wire_log::Kind::Artwork, 131088, 393216, 0, 0);
    CHECK(log.json(0).find("[1000,2,131088,393216,0,0]") != std::string::npos,
          "the queue depth at that moment must be in the event");
}

// The raw path's own cost per frame: encode microseconds and whether the pixels
// changed. Without it, "raw is slow sometimes" cannot be split into "the encoder
// was slow" and "the link was slow".
static void test_raw_capture_cost_is_recorded_per_frame() {
    wire_log::Log log;
    log.note(1000, wire_log::Kind::RawFrame, 90000, -1, 4100, 3);
    CHECK(log.json(0).find("[1000,4,90000,-1,4100,3]") != std::string::npos,
          "encode microseconds must ride with the raw frame event");
}

// The uplink. Without it, a downlink stall cannot be told from a stall that took
// both directions, and those are different faults.
static void test_arriving_inputs_are_logged_with_their_stamp() {
    wire_log::Log log;
    log.note(1000, wire_log::Kind::Input, 17, -1, 0, 42);
    CHECK(log.json(0).find("[1000,5,17,-1,0,42]") != std::string::npos,
          "an arriving input must be in the log with the stamp it carries: %s", log.json(0).c_str());
}

// An empty log is an empty list, not a missing field and not a null.
static void test_empty_log_is_an_empty_list() {
    wire_log::Log log;
    const std::string json = log.json(1234);
    CHECK(json.find("\"events\":[]") != std::string::npos, "empty events must serialise as []: %s", json.c_str());
    CHECK(json.find("\"now\":1234") != std::string::npos, "the host clock must be reported: %s", json.c_str());
}

int main() {
    test_artwork_chunks_are_logged_not_dropped();
    test_the_cap_drops_the_oldest();
    test_stamp_ages_are_kept_per_sample();
    test_queue_depth_rides_with_each_message();
    test_raw_capture_cost_is_recorded_per_frame();
    test_arriving_inputs_are_logged_with_their_stamp();
    test_empty_log_is_an_empty_list();
    if (failures) {
        std::printf("%d failure(s)\n", failures);
        return 1;
    }
    std::printf("wire_log: all checks passed\n");
    return 0;
}
