// The client-input stamp slot: the one place that decides whether an input was
// answered, and by what.
//
// It lives in its own header, with no includes and no state of its own, so the
// rule can be tested without the interposer's dependencies (see
// tests/tier1-unit/interposer/stamp_slot_test.cpp). The rule it encodes, and why
// each part of it exists:
//
//   * A QUEUE, oldest first. A player holding a key sends several inputs between
//     two frames. The first version kept only the newest and counted the rest as
//     overwritten, which made them permanently unmeasurable: a live session
//     recorded 2,824 inputs received and 1,282 overwritten, so most of what the
//     player did could never be attributed to a picture. A frame answers the
//     oldest waiting input - it was drawn with that input already applied - and
//     the following frames answer the rest until the queue drains.
//
//   * A claim is not an answer. Claiming takes the oldest stamp out of the queue
//     so the next frame that really goes out carries it. What settles the question
//     is what actually went out: a frame answers the input, and a present that sent
//     nothing at all hands the stamp back. The measured defect was here: a
//     keepalive used to go out in place of a frame, the packet was non-empty, and
//     the input was counted as answered even though a keepalive carries no stamp
//     a client can read. The keepalive has since been removed - it was measured
//     as doing nothing (evidence/bench/loopback/KEEPALIVE_MATRIX.md) - so the
//     only packet that can settle a claim now is a frame.
//
//   * The age limit bounds a wait, not a delivery. A stamp that has outlived its
//     input by longer than the limit is dropped: that is a missing answer, not a
//     slow one, and reporting it as very slow would flatter the path.
//
//   * Overflow is the only way an input is lost, and it is counted. The queue is
//     bounded so a stalled host cannot grow it without limit; when it is full the
//     OLDEST waiting input is dropped, because it is the one already least likely
//     to be answered inside the age limit.
//
//   * Every input lands in exactly one bucket, so the counts close:
//     received = answered + overwritten + expired + still waiting.
#ifndef DF_STAMP_SLOT_HPP
#define DF_STAMP_SLOT_HPP

#include <cstdint>

namespace stamp_slot {

// What actually went out on the wire for one present.
enum class Packet {
    // A frame that carries the stamp. The only thing that can answer an input.
    Frame,
    // Nothing was transmitted at all: the encoder had nothing new to say.
    Nothing,
};

struct State {
    // Eight is enough to cover a key held through a stalled frame without ever
    // being large enough to hold a backlog nobody would be shown.
    static constexpr int kCapacity = 8;

    struct Entry {
        uint8_t stamp = 0;
        int64_t at_ms = 0;
    };

    Entry waiting[kCapacity];
    int waiting_count = 0;

    bool pending = false;
    uint8_t pending_stamp = 0;
    int64_t pending_at_ms = 0;

    uint64_t received = 0;
    uint64_t overwritten = 0;
    uint64_t answered = 0;
    uint64_t expired = 0;

    // A view of the head of the queue: whether anything is waiting, and which
    // input the next frame will answer. Kept as fields because callers and tests
    // read them directly.
    bool has = false;
    uint8_t stamp = 0;
    int64_t received_at_ms = 0;

    bool claimed_pending() const { return pending; }

    void sync_head() {
        has = waiting_count > 0;
        stamp = has ? waiting[0].stamp : 0;
        received_at_ms = has ? waiting[0].at_ms : 0;
    }

    void drop_head() {
        for (int i = 1; i < waiting_count; ++i) waiting[i - 1] = waiting[i];
        waiting_count--;
    }

    void push_front(const Entry& e) {
        if (waiting_count >= kCapacity) {
            // Full: the newest arrival is the one with the least left to live.
            waiting_count--;
            overwritten++;
        }
        for (int i = waiting_count; i > 0; --i) waiting[i] = waiting[i - 1];
        waiting[0] = e;
        waiting_count++;
        sync_head();
    }

    // An input arrived, carrying this stamp at this time.
    void receive(uint8_t value, int64_t now_ms) {
        // Zero is not a stamp. The wire handler also refuses it, but the rule is
        // stated where it is enforced rather than only where it is checked.
        if (value == 0) return;
        if (waiting_count >= kCapacity) {
            drop_head();
            overwritten++;
        }
        waiting[waiting_count].stamp = value;
        waiting[waiting_count].at_ms = now_ms;
        waiting_count++;
        received++;
        sync_head();
    }

    // A present with commands is about to try to encode a frame. Returns true and
    // writes the oldest waiting stamp into `out` if this present may carry it.
    bool claim(int64_t now_ms, int64_t max_age_ms, uint8_t& out) {
        expire_prefix(now_ms, max_age_ms);
        if (waiting_count == 0) return false;
        const Entry e = waiting[0];
        drop_head();
        out = e.stamp;
        pending = true;
        pending_stamp = e.stamp;
        pending_at_ms = e.at_ms;
        sync_head();
        return true;
    }

    // What went out settles the claim. `claimed` is the stamp claim() returned;
    // `answered_age_ms` is filled in with input-arrival -> frame-sent, which is
    // the host's share of the felt latency, or left alone when nothing answered.
    // Returns true when this packet answered the input.
    bool settle(Packet packet, int64_t now_ms, uint8_t claimed, int64_t* answered_age_ms) {
        if (packet == Packet::Frame) {
            if (!pending) return false;
            answered++;
            if (answered_age_ms) *answered_age_ms = now_ms - pending_at_ms;
            pending = false;
            return true;
        }
        // A present that sent nothing cannot carry the stamp. The input is still
        // waiting, so it goes back at the FRONT: it is older than everything that
        // arrived while the claim was in flight, so it must not queue behind them.
        if (pending) {
            pending = false;
            Entry e;
            e.stamp = claimed;
            e.at_ms = pending_at_ms;
            push_front(e);
        }
        return false;
    }

    // Drops every stamp that has waited longer than the limit. Returns true if one
    // was dropped. Used where a path needs to ask "is this still current?" without
    // taking it - the age limit applies whether or not the frame that would have
    // answered it ever showed anything.
    bool expire_if_stale(int64_t now_ms, int64_t max_age_ms) {
        const uint64_t before = expired;
        expire_prefix(now_ms, max_age_ms);
        return expired > before;
    }

    void expire_prefix(int64_t now_ms, int64_t max_age_ms) {
        // Arrival order makes stale entries always a prefix of the queue.
        while (waiting_count > 0 && now_ms - waiting[0].at_ms > max_age_ms) {
            drop_head();
            expired++;
        }
        sync_head();
    }
};

} // namespace stamp_slot

#endif // DF_STAMP_SLOT_HPP
