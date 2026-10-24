// The host event log: one record per thing that happens, timestamped, drained on
// demand.
//
// Why this exists next to wire_log. The wire log records messages handed to a
// link, which is a handful per frame. This records the events that decide how
// long a frame took: every captured draw, every dropped draw, every picture
// created, sent, skipped or evicted, every encode decision, every input pushed
// into the game. Counters answer "how many"; they cannot answer "which picture
// delayed which frame", and that is the question every latency investigation
// actually asks.
//
// Why a ring and not a file. The draw hooks run about a thousand times per frame
// at fifty frames per second. A write per event would cost more than the thing
// being measured. A fixed-size ring makes note() a bounds check and a struct
// copy, and the records are drained in bulk by whoever asks.
//
// Why overflow is counted. A full ring drops the OLDEST records and increments a
// counter. Dropping silently would turn a burst into an apparent idle period,
// which is the exact class of lie this whole exercise exists to remove: a log
// that cannot report its own losses is worse than no log.
#ifndef DF_EVENT_LOG_HPP
#define DF_EVENT_LOG_HPP

#include <atomic>
#include <chrono>
#include <cstdint>
#include <mutex>
#include <cstddef>
#include <vector>

namespace event_log {

// The kinds that can occur. The numbers are part of the JSON contract with the
// bench, so they are written down once and a retired number is left free rather
// than reused - dumps kept as evidence are read back by number.
enum Kind : uint8_t {
    DrawDroppedNoPixels = 1, // draw skipped: its texture has no pixels stored
    DrawDroppedUnknown = 2,  // draw skipped: texture id could not be resolved
    DrawDroppedOverflow = 3, // draw skipped: command buffer full
    Present = 5,             // SDL_RenderPresent entered
    PresentSent = 6,         // a frame was handed to the link from this present
    PresentNoReceiver = 8,   // nothing sent: no client attached
    Clear = 9,               // SDL_RenderClear entered (this game never calls it)
    PicAlloc = 10,           // a texture id was assigned
    PicCreated = 11,         // a picture was captured from a surface
    PicCompressed = 13,      // a picture was compressed for the wire
    PicSent = 14,            // a whole picture completed sending
    PicChunkSent = 15,       // one chunk of one picture was handed to the link
    PicSkippedCached = 16,   // referenced picture not sent: client already has it
    PicQueued = 17,          // picture deferred by the send budget
    CacheEvict = 19,         // client-holdings cache evicted an id
    CacheReset = 20,         // client-holdings cache cleared (new client)
    EncodeFull = 21,         // a full frame was produced
    EncodeDelta = 22,        // a delta frame was produced
    EncodeKeyframe = 23,     // a keyframe was forced; `a` carries the reason
    EncodeNothing = 24,      // nothing was sent; `a` carries the reason
    EncodeError = 25,        // encoding failed
    GapAck = 26,             // a GAP_ACK arrived from the client
    BridgeRequest = 27,      // an asset-bridge request arrived
    ResendMissing = 28,      // pictures were re-sent because the client asked
    MissingUnknown = 29,     // the client asked for an id the host does not have
    InputRecv = 30,          // an input message arrived from the client
    InputPushed = 31,        // an input event was pushed into the game
    ClientConnect = 33,      // a client attached
    ClientDisconnect = 34,   // a client left
    PicSkippedNoData = 36,   // a frame referenced a picture the host has no pixels for
    LinkBuffered = 37,       // bytes waiting in the channel when a frame was handed over
};

// Why a keyframe was forced. Carried in the `a` field of an EncodeKeyframe
// record, so "we send a keyframe every time the client asks" can be told apart
// from "we send one because a base expired".
enum KeyframeReason : int64_t {
    KfConnect = 1,
    KfClientAsked = 2,
    KfBaseExpired = 3,
    KfResend = 4,
    KfResize = 5,
    KfPixelsMoved = 6,
    KfUnknown = 7,
};

// Why nothing was sent. Carried in `a` of an EncodeNothing record.
enum NothingReason : int64_t {
    NothingUnchanged = 1,
    NothingNoReceiver = 2,
    NothingNoCommands = 3,
    NothingEncodeError = 4,
};

// One record. Deliberately small and trivially copyable: 40 bytes, no
// allocation, no strings, nothing that can throw on the draw path.
struct Rec {
    int64_t t_us;   // monotonic microseconds since the process started
    uint32_t seq;   // frame sequence, or 0 where the event is not frame-scoped
    uint32_t id;    // picture id, or 0
    int64_t a;      // per-kind: bytes, reason - see the kind comments
    int64_t b;      // per-kind: a second number, usually a queue depth or size
    int64_t c;      // per-kind: a third number, usually a duration in microseconds
    uint8_t kind;
    uint8_t flags;
    uint16_t pad;
};

class Ring {
public:
    explicit Ring(size_t capacity)
        : buf_(capacity ? capacity : 1), cap_(buf_.size()) {}

    // Record one event. Cheap: a bounds check and a struct copy. Safe to call
    // from the render thread while the HTTP thread drains.
    void note(uint8_t kind, uint32_t seq = 0, uint32_t id = 0,
              int64_t a = 0, int64_t b = 0, uint8_t flags = 0, int64_t c = 0) {
        if (!enabled_.load(std::memory_order_relaxed)) return;
        Rec r;
        r.t_us = now_us();
        r.seq = seq;
        r.id = id;
        r.a = a;
        r.b = b;
        r.c = c;
        r.kind = kind;
        r.flags = flags;
        r.pad = 0;
        std::lock_guard<std::mutex> lock(mu_);
        buf_[head_] = r;
        head_ = (head_ + 1) % cap_;
        if (count_ < cap_) {
            count_++;
        } else {
            dropped_++;
        }
    }

    // Take records since the last drain, oldest first, at most `max` of them.
    // Anything not taken stays for the next call: a burst arrives at tens of
    // thousands of records a second, and handing the whole ring back in one
    // response built a 73 MB body that no caller could fetch inside its timeout.
    size_t drain(std::vector<Rec>& out, size_t max = SIZE_MAX) {
        std::lock_guard<std::mutex> lock(mu_);
        out.clear();
        const size_t take = count_ < max ? count_ : max;
        out.reserve(take);
        size_t start = (head_ + cap_ - count_) % cap_;
        for (size_t i = 0; i < take; i++) {
            out.push_back(buf_[(start + i) % cap_]);
        }
        count_ -= take;
        // Dropped is only cleared once the log is genuinely empty: a caller that
        // takes part of a burst must still learn that records were lost.
        if (count_ == 0) dropped_ = 0;
        return out.size();
    }

    // Records lost to a full ring since the last drain. Non-zero means the log
    // is not telling the whole story and must say so.
    uint64_t dropped() {
        std::lock_guard<std::mutex> lock(mu_);
        return dropped_;
    }

    // Records waiting to be drained. Non-zero after a bounded drain means the
    // caller should ask again rather than assume it has everything.
    size_t pending() {
        std::lock_guard<std::mutex> lock(mu_);
        return count_;
    }

    size_t capacity() const { return cap_; }

    void set_enabled(bool on) { enabled_.store(on, std::memory_order_relaxed); }
    bool enabled() const { return enabled_.load(std::memory_order_relaxed); }

private:
    static int64_t now_us() {
        using namespace std::chrono;
        static const steady_clock::time_point start = steady_clock::now();
        return duration_cast<microseconds>(steady_clock::now() - start).count();
    }

    std::mutex mu_;
    std::vector<Rec> buf_;
    size_t cap_ = 0;
    size_t head_ = 0;
    size_t count_ = 0;
    uint64_t dropped_ = 0;
    std::atomic<bool> enabled_{true};
};

} // namespace event_log

#endif
