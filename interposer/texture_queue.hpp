// Picture-queue policy for the streamer.
//
// Frames and pictures share one SCTP send queue. They are not comparable in
// size: a delta frame is ~114 B and a full frame ~4 KB, while a picture is up
// to 8,294,400 B (1920x1080 RGBA). A single large picture can therefore bury
// the queue, and anything measured against that queue -- including the frame
// path's backpressure guard -- then refuses to send the thing the user is
// actually looking at.
//
// The rule this encodes: the queue budget belongs to frames, and pictures wait
// their turn. A picture that cannot be sent now is remembered along with the
// first chunk it still owes, so a picture interrupted half way resumes rather
// than restarting. The client assembles chunks by index and only uploads once
// every index has arrived, so a paused picture is simply not visible yet --
// never half-drawn.
//
// Two kinds of waiting picture, and the difference matters:
//   speculative - sent because the game just created it; nobody is blocked
//   urgent      - the client explicitly asked for it, so a frame it already
//                 holds commands for cannot be drawn until it arrives
// Urgent pictures go to the front and stay urgent if they are put back part
// sent, because otherwise a picture larger than the budget loses its priority
// half way through and the client gives up on it before it finishes.
#ifndef DF_TEXTURE_QUEUE_HPP
#define DF_TEXTURE_QUEUE_HPP

#include <cstddef>
#include <cstdint>
#include <deque>

class TextureQueue {
public:
    explicit TextureQueue(size_t budget_bytes) : budget_(budget_bytes) {}

    // True while the link has room for more picture bytes. Frames deliberately
    // do not consult this: they are three orders of magnitude smaller and are
    // what the user sees.
    bool has_room(int64_t queue_bytes) const {
        return queue_bytes < (int64_t)budget_;
    }

    // Remembers that `id` still owes chunks from `next_chunk` onwards. Deferring
    // the same picture again keeps the earliest owed chunk, so an interruption
    // never skips a chunk and never queues the picture twice. Urgency is sticky:
    // once a picture has been asked for, it stays ahead of speculative ones.
    //
    // Urgent pictures are kept as a prefix of the queue, in the order they were
    // asked for, so "urgent" is a real ordering and not just a label.
    void defer(uint16_t id, uint32_t next_chunk, bool urgent = false) {
        auto it = find_pending(id);
        if (it != pending_.end()) {
            if (next_chunk < it->next_chunk) it->next_chunk = next_chunk;
            if (urgent && !it->urgent) {
                Pending p = *it;
                p.urgent = true;
                pending_.erase(it);
                insert_urgent(p);
            }
            return;
        }
        Pending p{id, next_chunk, urgent};
        if (urgent) {
            insert_urgent(p);
        } else {
            pending_.push_back(p);
        }
    }

    // Same, but the picture goes to the front. The client asks for a picture
    // only when a frame it already holds commands for cannot be drawn without
    // it, so that picture is blocking something visible, while the pictures
    // behind it are speculative. Serving strictly oldest-first made a requested
    // picture wait behind a whole session's worth of speculative ones, which is
    // long enough for the client to give up on it (it tries three times, 1.5s
    // apart) and leave a permanent hole in the display.
    void defer_front(uint16_t id, uint32_t next_chunk) {
        auto it = find_pending(id);
        if (it != pending_.end()) {
            // Keep whatever progress the transfer has already made.
            //
            // This used to take the earlier chunk, so a fresh request rewound a
            // part-sent picture to chunk 0. The client re-asks for anything it is
            // still missing roughly every 1.5s, so a picture too large to send
            // inside that window was rewound before it could finish, every time,
            // and never completed at all. That is the missing full-screen
            // backdrop: named in every frame, requested thousands of times,
            // never delivered. Chunks the client already holds are deduplicated
            // on its side, so continuing where the transfer left off is correct
            // and restarting is merely wasteful - except that here it was fatal.
            if (next_chunk < it->next_chunk) next_chunk = it->next_chunk;
            pending_.erase(it);
        }
        pending_.push_front(Pending{id, next_chunk, true});
    }

    // Takes the oldest waiting picture and reports whether it was urgent, so a
    // caller putting back a part-sent picture can keep its priority.
    bool take(uint16_t& id, uint32_t& next_chunk, bool& urgent) {
        if (pending_.empty()) return false;
        id = pending_.front().id;
        next_chunk = pending_.front().next_chunk;
        urgent = pending_.front().urgent;
        pending_.pop_front();
        return true;
    }

    size_t size() const { return pending_.size(); }
    bool empty() const { return pending_.empty(); }
    size_t budget() const { return budget_; }

private:
    struct Pending {
        uint16_t id;
        uint32_t next_chunk;
        bool urgent;
    };

    std::deque<Pending>::iterator find_pending(uint16_t id) {
        for (auto it = pending_.begin(); it != pending_.end(); ++it) {
            if (it->id == id) return it;
        }
        return pending_.end();
    }

    // Appends to the urgent prefix, after any urgent pictures already waiting.
    void insert_urgent(const Pending& p) {
        auto it = pending_.begin();
        while (it != pending_.end() && it->urgent) ++it;
        pending_.insert(it, p);
    }

    size_t budget_;
    std::deque<Pending> pending_;
};

#endif  // DF_TEXTURE_QUEUE_HPP
