// The client-input stamp slot: the one place that decides whether an input was
// answered, and by what.
//
// It lives in its own header, with no includes and no state of its own, so the
// rule can be tested without the interposer's dependencies (see
// tests/stamp_slot_test.cpp). The rule it encodes, and why each part of it
// exists:
//
//   * ONE slot. A stamp describes the newest input waiting for a frame, and a
//     frame can only answer the input it was drawn for. A second input arriving
//     before the first was claimed overwrites it; that input produces no sample
//     and is COUNTED as overwritten rather than quietly dropped.
//
//   * A claim is not an answer. Claiming takes the stamp out of the slot so the
//     next frame that really goes out carries it. What settles the question is
//     what actually went out: a frame answers the input, and a present that sent
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
    uint8_t stamp = 0;
    bool has = false;
    bool pending = false;
    int64_t received_at_ms = 0;
    int64_t pending_at_ms = 0;

    uint64_t received = 0;
    uint64_t overwritten = 0;
    uint64_t answered = 0;
    uint64_t expired = 0;

    bool claimed_pending() const { return pending; }

    // An input arrived, carrying this stamp at this time.
    void receive(uint8_t value, int64_t now_ms) {
        if (has && stamp != 0) overwritten++;
        stamp = value;
        has = true;
        received_at_ms = now_ms;
        received++;
    }

    // A present with commands is about to try to encode a frame. Returns true
    // and writes the stamp into `out` if this present may carry it.
    bool claim(int64_t now_ms, int64_t max_age_ms, uint8_t& out) {
        if (!has || stamp == 0) return false;
        if (now_ms - received_at_ms > max_age_ms) {
            has = false;
            stamp = 0;
            expired++;
            return false;
        }
        out = stamp;
        has = false;
        stamp = 0;
        pending = true;
        pending_at_ms = received_at_ms;
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
        // A present that sent nothing cannot carry the stamp, so the input is
        // still waiting and the stamp goes back in the slot - still subject to
        // the age limit, so it cannot wait forever.
        if (pending) {
            pending = false;
            if (has && stamp != 0) {
                // A newer input arrived while this claim was in flight. The newer
                // one keeps the slot - it is the input the player is waiting on
                // now - and the one that was handed back is recorded as replaced
                // rather than quietly dropped, so the counts still close.
                overwritten++;
            } else {
                has = true;
                stamp = claimed;
            }
        }
        return false;
    }

    // Drops a stamp that has waited longer than the limit. Returns true if one
    // was dropped. Used where a path needs to ask "is this still current?"
    // without taking it - the age limit applies whether or not the frame that
    // would have answered it ever showed anything.
    bool expire_if_stale(int64_t now_ms, int64_t max_age_ms) {
        if (!has || stamp == 0) return false;
        if (now_ms - received_at_ms <= max_age_ms) return false;
        has = false;
        stamp = 0;
        expired++;
        return true;
    }
};

} // namespace stamp_slot

#endif // DF_STAMP_SLOT_HPP
