// The host-side wire log: every message the host handed to a link, with the
// context that tells one kind of spike from another.
//
// Two rules, and both of them are corrections of something that was measured
// wrong before:
//
//   * EVERY message, of any kind. The first version of this instrumentation
//     recorded frames and pings and left textures out; textures are ~99% of the
//     bytes on this link, so every spike it described read as "nothing was
//     sent". `Kind` therefore names the kinds that exist today and the log
//     accepts a number, so a kind added later is recorded by a caller that knows
//     about it rather than silently dropped by this one.
//
//   * The queue depth rides WITH the message. A queue high-water mark for a
//     session cannot say whether one particular frame waited behind 400kB of
//     artwork, and that is the whole question this log is asked. libdatachannel
//     reports it at the moment of the send, so it is recorded at the moment of
//     the send.
//
// It is a header with no dependencies beyond the standard library so it can be
// checked on its own: see tests/wire_log_test.cpp.
#ifndef DF_WIRE_LOG_HPP
#define DF_WIRE_LOG_HPP

#include <cstdint>
#include <cstdio>
#include <mutex>
#include <string>
#include <vector>

namespace wire_log {

// The kinds that go on the wire. The numbers are part of the JSON contract with
// the bench, so they are written down once, here - and a number that is retired
// is left free rather than reused, because the wire dumps kept as evidence are
// read back by number. 3 was the downlink keepalive; the keepalive was measured
// as doing nothing (evidence/bench/loopback/KEEPALIVE_MATRIX.md) and removed, so
// nothing writes 3 any more and renumbering would silently reinterpret every
// dump taken before it.
enum Kind : uint8_t {
    Frame = 0,      // a delta frame on the draw-command path
    Keyframe = 1,   // a full frame on the draw-command path
    Artwork = 2,    // one chunk of one picture
    // 3 retired: the downlink keepalive
    RawFrame = 4,   // one captured picture handed to the raw link
    // An input ARRIVING from the client. Recorded because the uplink is the
    // mirror of the frame log: an input that reaches the host during a downlink
    // stall says the stall was one-directional, and one that arrives in a burst
    // at the end says it was not.
    Input = 5,
};

enum Path : uint8_t {
    Smart = 0,
    Raw = 1,
};

// One message. `queue` is the send-queue depth observed at that moment, or -1
// where the link has no such queue (the raw link's is the relay's, and it is
// measured there). `extra` is a per-kind number: encode microseconds for a raw
// frame, zero elsewhere.
struct Event {
    int64_t epoch_ms;
    uint8_t kind;
    uint32_t bytes;
    int64_t queue;
    int64_t extra;
    uint8_t stamp;
};

// One answered input: which stamp, how long the host held it, and when the
// answering frame left. This is the host's share of the *felt* latency for that
// sample, not a median over the session.
struct StampAge {
    uint8_t stamp;
    int64_t age_ms;
    int64_t epoch_ms;
    uint8_t path;
};

class Log {
public:
    explicit Log(size_t max_events = 40000, size_t max_stamps = 4000)
        : max_events_(max_events ? max_events : 1), max_stamps_(max_stamps ? max_stamps : 1) {}

    void note(int64_t epoch_ms, uint8_t kind, uint32_t bytes, int64_t queue, int64_t extra, uint8_t stamp) {
        std::lock_guard<std::mutex> lock(mu_);
        events_.push_back(Event{epoch_ms, kind, bytes, queue, extra, stamp});
        if (events_.size() > max_events_) {
            events_.erase(events_.begin(), events_.begin() + (events_.size() - max_events_));
        }
    }

    void note_stamp(uint8_t stamp, int64_t age_ms, int64_t epoch_ms, uint8_t path) {
        std::lock_guard<std::mutex> lock(mu_);
        stamps_.push_back(StampAge{stamp, age_ms, epoch_ms, path});
        if (stamps_.size() > max_stamps_) {
            stamps_.erase(stamps_.begin(), stamps_.begin() + (stamps_.size() - max_stamps_));
        }
    }

    size_t events() const {
        std::lock_guard<std::mutex> lock(mu_);
        return events_.size();
    }

    size_t stamps() const {
        std::lock_guard<std::mutex> lock(mu_);
        return stamps_.size();
    }

    // The whole log as JSON, with the host's own clock so a bench can put it on
    // the page's clock. Compact arrays rather than objects: this is read once per
    // run, but it is read over the link being measured.
    std::string json(int64_t now_ms) const {
        std::vector<Event> events;
        std::vector<StampAge> stamps;
        {
            std::lock_guard<std::mutex> lock(mu_);
            events = events_;
            stamps = stamps_;
        }
        std::string out;
        out.reserve(64 + events.size() * 40 + stamps.size() * 24);
        char buf[160];
        std::snprintf(buf, sizeof(buf), "{\"now\":%lld,\"events\":[", (long long)now_ms);
        out += buf;
        for (size_t i = 0; i < events.size(); i++) {
            std::snprintf(buf, sizeof(buf), "%s[%lld,%u,%u,%lld,%lld,%u]",
                          i ? "," : "", (long long)events[i].epoch_ms, (unsigned)events[i].kind,
                          (unsigned)events[i].bytes, (long long)events[i].queue,
                          (long long)events[i].extra, (unsigned)events[i].stamp);
            out += buf;
        }
        out += "],\"stamps\":[";
        for (size_t i = 0; i < stamps.size(); i++) {
            std::snprintf(buf, sizeof(buf), "%s[%u,%lld,%lld,%u]",
                          i ? "," : "", (unsigned)stamps[i].stamp, (long long)stamps[i].age_ms,
                          (long long)stamps[i].epoch_ms, (unsigned)stamps[i].path);
            out += buf;
        }
        out += "]}";
        return out;
    }

private:
    mutable std::mutex mu_;
    std::vector<Event> events_;
    std::vector<StampAge> stamps_;
    size_t max_events_;
    size_t max_stamps_;
};

} // namespace wire_log

#endif // DF_WIRE_LOG_HPP
