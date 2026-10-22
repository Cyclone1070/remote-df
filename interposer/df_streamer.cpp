#include <iostream>
#include <vector>
#include <unordered_set>
#include <deque>
#include <string>
#include <mutex>
#include <thread>
#include <atomic>
#include <chrono>
#include <cstdint>
#include <cstring>
#include <cstdlib>
#include <dlfcn.h>
#include <unistd.h>
#include <sys/stat.h>
#include <zstd.h>
#include <execinfo.h>
#include <algorithm>
#include <memory>
#include <variant>
#include <rtc/rtc.hpp>

// Raw pixel mode (DF_RAW_STREAM=1) encodes its frames with libjpeg, and the raw
// link is a TCP client. Both are included here rather than in raw_jpeg.hpp so the
// dependencies of the interposer stay visible in one place. The standard headers
// come first on purpose: jpeglib.h uses size_t and FILE without including anything
// that defines them.
#include <cstddef>
#include <cstdio>
#include <jpeglib.h>
#include <sys/socket.h>
#include <netinet/in.h>
#include <netinet/tcp.h>
#include <netdb.h>
#include <poll.h>
#include <fcntl.h>
#include <errno.h>

#include "stamp_slot.hpp"
#include "wire_log.hpp"
#include "ws_server.hpp"
#include "texture_queue.hpp"
#include "raw_jpeg.hpp"
#include "raw_png.hpp"

#define MAX_DRAW_COMMANDS 32768
// The whole u16 id space, so an id is never handed to a second picture in any
// realistic session. Each id costs a pointer plus a small struct, and the pixel
// data behind it is only allocated for pictures the game actually made, so
// covering the full range is cheap: the old 4096 limit was what forced ids to be
// recycled, which is the one case the client cannot detect.
#define MAX_TEXTURES 65535

#pragma pack(push, 1)
struct SDL_Rect {
    int32_t x, y, w, h;
};

struct DrawCommand {
    uint16_t tex_id;
    int16_t src_x, src_y, src_w, src_h;
    int16_t dst_x, dst_y, dst_w, dst_h;
};

struct FrameHeader {
    uint8_t magic[2];      // 'D', 'F'
    uint32_t frame_seq;
    uint16_t flags;        // 0x01: Full frame, 0x02: Delta
    uint16_t cmd_count;
};

struct DeltaUpdate {
    uint16_t index;
    DrawCommand cmd;
};

struct TextureHeader {
    // 'D','T' carries RGBA exactly as the game made it. 'D','Z' carries the same
    // RGBA after zstd, in which case payload_len is the compressed length and the
    // receiver gets w*h*4 back out of the decompressor.
    uint8_t magic[2];
    uint16_t tex_id;
    uint16_t w;
    uint16_t h;
    uint32_t payload_len;  // total bytes for the whole texture across chunks, as sent
    uint16_t chunk_index;  // 0-based index of this chunk
    uint16_t chunk_count;  // total chunks this texture is split into (1 = unchunked)
};

struct InputEvent {
    uint8_t event_type;
    int16_t x;
    int16_t y;
    uint8_t button;
    uint32_t keycode;
    uint32_t scancode;
    uint16_t mod;
};
#pragma pack(pop)

// Standard SDL2 Event structures
typedef struct {
    uint32_t scancode;
    int32_t sym;
    uint16_t mod;
    uint32_t unused;
} SDL2_Keysym;

typedef struct {
    uint32_t type;
    uint32_t timestamp;
    uint32_t windowID;
    uint8_t state;
    uint8_t repeat;
    uint8_t padding2;
    uint8_t padding3;
    SDL2_Keysym keysym;
} SDL2_KeyboardEvent;

typedef struct {
    uint32_t type;
    uint32_t timestamp;
    uint32_t windowID;
    uint32_t which;
    uint32_t state;
    int32_t x;
    int32_t y;
    int32_t xrel;
    int32_t yrel;
} SDL2_MouseMotionEvent;

typedef struct {
    uint32_t type;
    uint32_t timestamp;
    uint32_t windowID;
    uint32_t which;
    uint8_t button;
    uint8_t state;
    uint8_t clicks;
    uint8_t padding1;
    int32_t x;
    int32_t y;
} SDL2_MouseButtonEvent;

typedef struct {
    uint32_t type;
    uint32_t timestamp;
    uint32_t windowID;
    uint32_t which;
    int32_t x;
    int32_t y;
    uint32_t direction;
    float preciseX;
    float preciseY;
    int32_t mouseX;
    int32_t mouseY;
} SDL2_MouseWheelEvent;

typedef struct {
    uint32_t type;
    uint32_t timestamp;
    uint32_t windowID;
    uint8_t event;
    uint8_t padding1;
    uint8_t padding2;
    uint8_t padding3;
    int32_t data1;
    int32_t data2;
} SDL2_WindowEvent;

typedef union {
    uint32_t type;
    SDL2_KeyboardEvent key;
    SDL2_MouseMotionEvent motion;
    SDL2_MouseButtonEvent button;
    SDL2_MouseWheelEvent wheel;
    SDL2_WindowEvent window;
    uint8_t padding[56];
} SDL2_Event;

struct CachedTexture {
    uint16_t id = 0;
    uint16_t w = 0;
    uint16_t h = 0;
    std::vector<uint8_t> rgba;
    // mutable: the send path takes these by const ref, but recording that a
    // picture has gone out once is bookkeeping, not a change to the picture.
    mutable bool sent_once = false;
    // Filled the first time this picture is put on the wire. mutable for the same
    // reason as sent_once: building it does not change what the picture is, and
    // the send path only ever holds a const reference.
    mutable std::vector<uint8_t> compressed;
    mutable bool compress_tried = false;
};

struct SDL_PixelFormat_Internal {
    uint32_t format;
    void *palette;
    uint8_t BitsPerPixel;
    uint8_t BytesPerPixel;
    uint8_t padding[2];
    uint32_t Rmask, Gmask, Bmask, Amask;
    uint8_t Rloss, Gloss, Bloss, Aloss;
    uint8_t Rshift, Gshift, Bshift, Ashift;
};

struct SDL_Surface_Internal {
    uint32_t flags;
    SDL_PixelFormat_Internal* format;
    int w, h;
    int pitch;
    void* pixels;
};

// Original SDL2 function pointers
static int (*real_SDL_RenderCopy)(void*, void*, const SDL_Rect*, const SDL_Rect*) = nullptr;
static int (*real_SDL_RenderCopyEx)(void*, void*, const SDL_Rect*, const SDL_Rect*, double, const void*, int) = nullptr;
static int (*real_SDL_RenderClear)(void*) = nullptr;
static void (*real_SDL_RenderPresent)(void*) = nullptr;
static int (*real_SDL_PushEvent)(void*) = nullptr;
static int (*real_SDL_PollEvent)(void*) = nullptr;
static void* (*real_SDL_CreateTextureFromSurface)(void*, void*) = nullptr;
static int (*real_SDL_UpdateTexture)(void*, const void*, const void*, int) = nullptr;
// Which SDL draw calls the game actually uses, beyond RenderCopy. Anything drawn
// with a call that is not captured never enters the command list, so the encoder
// sees an identical frame and stays silent while the screen changes underneath -
// measured at 4,919 changed pixels against zero command updates. Counting only:
// pass-through, no lock, no capture.
static std::atomic<uint64_t> g_rc_copy_calls{0};
static std::atomic<uint64_t> g_rc_copyex_calls{0};
static std::atomic<uint64_t> g_rc_fillrect{0};
static std::atomic<uint64_t> g_rc_fillrects{0};
static std::atomic<uint64_t> g_rc_drawline{0};
static std::atomic<uint64_t> g_rc_drawlines{0};
static std::atomic<uint64_t> g_rc_drawpoint{0};
static std::atomic<uint64_t> g_rc_geometry{0};
static std::atomic<uint64_t> g_rc_setclip{0};
static std::atomic<uint64_t> g_rc_setcolor{0};
static int (*real_SDL_RenderFillRect)(void*, const void*) = nullptr;
static int (*real_SDL_RenderFillRects)(void*, const void*, int) = nullptr;
static int (*real_SDL_RenderDrawLine)(void*, int, int, int, int) = nullptr;
static int (*real_SDL_RenderDrawLines)(void*, const void*, int) = nullptr;
static int (*real_SDL_RenderDrawPoint)(void*, int, int) = nullptr;
static int (*real_SDL_RenderGeometry)(void*, void*, const void*, int, const void*, int) = nullptr;
static int (*real_SDL_RenderSetClipRect)(void*, const void*) = nullptr;
static int (*real_SDL_SetRenderDrawColor)(void*, uint8_t, uint8_t, uint8_t, uint8_t) = nullptr;
static void dump_render_call_counts();
static int (*real_SDL_LockTexture)(void*, const void*, void**, int*) = nullptr;
static void (*real_SDL_UnlockTexture)(void*) = nullptr;
// What SDL_UpdateTexture actually looks like. Capturing its pixels is only worth
// doing if they are small: copying a full-screen buffer on every call would be
// hundreds of gigabytes a second, which is exactly why an earlier version that
// copied unconditionally stopped the game presenting.
static std::atomic<uint64_t> g_upd_calls{0};
static std::atomic<uint64_t> g_upd_lock_calls{0};
static std::atomic<uint64_t> g_upd_unlock_calls{0};
static std::atomic<uint64_t> g_upd_pitch_le256{0};
static std::atomic<uint64_t> g_upd_pitch_le2048{0};
static std::atomic<uint64_t> g_upd_pitch_le8192{0};
static std::atomic<uint64_t> g_upd_pitch_gt8192{0};
static uint32_t (*real_SDL_GetMouseState)(int*, int*) = nullptr;
static void (*real_SDL_DestroyTexture)(void*) = nullptr;
static int (*real_SDL_RenderReadPixels)(void*, const SDL_Rect*, uint32_t, void*, int) = nullptr;
static int (*real_SDL_GetRendererOutputSize)(void*, int*, int*) = nullptr;
static void* (*real_SDL_ConvertSurfaceFormat)(void*, uint32_t, uint32_t) = nullptr;
static void (*real_SDL_FreeSurface)(void*) = nullptr;
static void* g_gps_ptr = nullptr;
static void* g_enabler_ptr = nullptr;
static void (*real_set_force_full_display_count)(void*, short) = nullptr;
static void (*real_SDL_SetModState)(int) = nullptr;
static uint8_t* g_df_modstate_ptr = nullptr;

static void sync_modifiers(uint8_t mod) {
    if (g_df_modstate_ptr) {
        *g_df_modstate_ptr = mod & 7; // Shift=1, Ctrl=2, Alt=4
    }
    if (real_SDL_SetModState) {
        uint16_t sdl_mod = 0;
        if (mod & 1) sdl_mod |= 0x0001; // KMOD_LSHIFT
        if (mod & 2) sdl_mod |= 0x0040; // KMOD_LCTRL
        if (mod & 4) sdl_mod |= 0x0100; // KMOD_LALT
        if (mod & 8) sdl_mod |= 0x0400; // KMOD_LGUI
        real_SDL_SetModState(sdl_mod);
    }
}

static void force_full_display() {
    if (real_set_force_full_display_count && g_gps_ptr) {
        real_set_force_full_display_count(g_gps_ptr, 2);
    } else if (g_gps_ptr) {
        *((int16_t*)((char*)g_gps_ptr + 0xa3c)) = 2;
    }
}

// Global state
static EmbeddedServer* g_server = nullptr;
static int g_mouse_x = 640;
static int g_mouse_y = 360;
static uint32_t g_mouse_buttons = 0;
static bool g_mouse_focused = false;

static void* g_textures[MAX_TEXTURES] = {nullptr};
static CachedTexture g_cached_textures[MAX_TEXTURES];
static uint16_t g_texture_count = 0;
static std::mutex g_tex_lock;

static DrawCommand g_frame_cmds[MAX_DRAW_COMMANDS];
static uint16_t g_frame_cmd_count = 0;

struct FrameSnapshot {
    uint32_t seq = 0;
    uint16_t cmd_count = 0;
    DrawCommand cmds[MAX_DRAW_COMMANDS];
};

enum class EncodeResult { Nothing, Delta, Full };

// Proof or refutation of the "nothing changed" decision.
//
// The encoder decides a frame is a no-op by comparing draw-command lists. That is
// a claim about what is on screen and it can be checked: sample the framebuffer
// at the moment the claim is made and compare it with the last frame actually
// sent. If the pixels differ while the commands do not, the claim is wrong, and
// the display is frozen by a comparison that cannot see the change.
static std::atomic<uint64_t> g_nothing_pixels_same{0};
static std::atomic<uint64_t> g_nothing_pixels_changed{0};
static uint64_t g_last_sent_pixel_hash = 0;
static bool g_last_sent_pixel_hash_valid = false;
// Set by the present hook, which is the only place holding the renderer.
static void* g_probe_renderer = nullptr;

extern "C" { static bool sample_pixel_hash(void* renderer, uint64_t& out); }

class DeltaEncoder {
public:
    DrawCommand prev_cmds[MAX_DRAW_COMMANDS];
    uint16_t prev_count = 0;
    DeltaUpdate delta_updates[MAX_DRAW_COMMANDS];
    FrameSnapshot history[60];

    // Cumulative counters, surfaced in the stats dump so silent frames and
    // encoding choices are observable rather than invisible.
    uint64_t stat_nothing = 0;
    uint64_t stat_full = 0;
    uint64_t stat_delta = 0;
    uint64_t stat_bytes_full = 0;
    uint64_t stat_bytes_delta = 0;
    uint64_t stat_full_wins = 0;
    uint64_t stat_delta_wins = 0;

    // Encode cost in microseconds. Measured so the price of building two
    // candidate packets per frame is a number, not an assumption.
    std::vector<double> enc_us;
    uint64_t stat_enc_calls = 0;

    EncodeResult encode_frame(uint32_t seq, const DrawCommand* curr_cmds, uint16_t curr_count,
                              bool force_keyframe, uint32_t combined_base_seq, uint8_t stamp,
                              std::vector<uint8_t>& out_packet) {
        out_packet.clear();

        // Times every exit path of this function, including the early returns.
        {
            auto t0 = std::chrono::steady_clock::now();
            struct EncScopeTimer {
                std::chrono::steady_clock::time_point t0;
                std::vector<double>* v;
                uint64_t* calls;
                ~EncScopeTimer() {
                    double us = std::chrono::duration<double, std::micro>(
                        std::chrono::steady_clock::now() - t0).count();
                    v->push_back(us);
                    (*calls)++;
                    if (v->size() > 900) v->erase(v->begin(), v->begin() + 300);
                }
            } _est{t0, &enc_us, &stat_enc_calls};
            return encode_frame_inner(seq, curr_cmds, curr_count, force_keyframe,
                                      combined_base_seq, stamp, out_packet);
        }
    }

    EncodeResult encode_frame_inner(uint32_t seq, const DrawCommand* curr_cmds, uint16_t curr_count,
                              bool force_keyframe, uint32_t combined_base_seq, uint8_t stamp,
                              std::vector<uint8_t>& out_packet) {

        bool is_combined = false;
        const DrawCommand* base_cmds = prev_cmds;
        uint16_t base_count = prev_count;

        if (!force_keyframe && combined_base_seq > 0) {
            uint32_t slot = combined_base_seq % 60;
            if (history[slot].seq == combined_base_seq && history[slot].cmd_count > 0) {
                base_cmds = history[slot].cmds;
                base_count = history[slot].cmd_count;
                is_combined = true;
                fprintf(stderr, "[COMBINED_DELTA] Diffing frame %u against history base %u (cmd_count: %u)\n",
                        seq, combined_base_seq, base_count);
                fflush(stderr);
            } else {
                fprintf(stderr, "[COMBINED_DELTA] Base seq %u expired from history -> forcing keyframe\n", combined_base_seq);
                fflush(stderr);
                force_keyframe = true;
            }
        }

        // Diff against the base. Indices the base never had are emitted too, so a
        // delta stays applicable when the command count grew or shrank.
        uint16_t num_updates = 0;
        if (!force_keyframe && base_count > 0) {
            uint16_t min_count = std::min(curr_count, base_count);
            for (uint16_t i = 0; i < min_count; ++i) {
                if (memcmp(&curr_cmds[i], &base_cmds[i], sizeof(DrawCommand)) != 0) {
                    delta_updates[num_updates].index = i;
                    delta_updates[num_updates].cmd = curr_cmds[i];
                    num_updates++;
                }
            }
            for (uint16_t i = min_count; i < curr_count; ++i) {
                delta_updates[num_updates].index = i;
                delta_updates[num_updates].cmd = curr_cmds[i];
                num_updates++;
            }
        }

        // Nothing changed and no bridge is outstanding: stay silent. The caller
        // must not consume a sequence number, otherwise the client reads the hole
        // as packet loss and starts a recovery round trip over a no-op frame.
        // A requested bridge is never suppressed - that packet is what advances
        // a client that is parked on an older sequence.
        if (!force_keyframe && !is_combined && base_count > 0 &&
            curr_count == base_count && num_updates == 0) {
            stat_nothing++;
            // The commands are identical. Did the picture change anyway?
            uint64_t now_hash = 0;
            if (sample_pixel_hash(g_probe_renderer, now_hash)) {
                if (g_last_sent_pixel_hash_valid && now_hash != g_last_sent_pixel_hash) {
                    g_nothing_pixels_changed.fetch_add(1, std::memory_order_relaxed);
                } else {
                    g_nothing_pixels_same.fetch_add(1, std::memory_order_relaxed);
                }
            }
            return EncodeResult::Nothing;
        }

        FrameHeader hdr;
        hdr.magic[0] = 'D';
        hdr.magic[1] = 'F';
        hdr.frame_seq = seq;
        hdr.cmd_count = curr_count;

        bool include_stamp = (stamp != 0);

        // Candidate 1: standalone whole frame.
        std::vector<uint8_t> full_packet;
        {
            size_t raw_len = curr_count * sizeof(DrawCommand);
            size_t max_comp = ZSTD_compressBound(raw_len);
            size_t header_size = sizeof(hdr) + (include_stamp ? 1 : 0);

            hdr.flags = 0x01; // Full frame
            if (include_stamp) hdr.flags |= 0x04;

            full_packet.resize(header_size + max_comp);
            memcpy(full_packet.data(), &hdr, sizeof(hdr));
            if (include_stamp) full_packet[sizeof(hdr)] = stamp;

            size_t c_size = ZSTD_compress(full_packet.data() + header_size, max_comp, curr_cmds, raw_len, 1);
            if (ZSTD_isError(c_size)) return EncodeResult::Nothing;
            full_packet.resize(header_size + c_size);
        }

        // A forced keyframe is the only case where the encoding is not a choice:
        // the client has no baseline to patch, so a delta would be unusable.
        if (force_keyframe) {
            stat_full++;
            stat_bytes_full += full_packet.size();
            out_packet = std::move(full_packet);
            record(curr_cmds, curr_count, seq);
            return EncodeResult::Full;
        }

        // Candidate 2: delta against whichever base we resolved.
        bool include_base = is_combined;
        std::vector<uint8_t> delta_packet;
        {
            size_t payload_len = 2 + num_updates * sizeof(DeltaUpdate);
            std::vector<uint8_t> raw_payload(payload_len);
            memcpy(raw_payload.data(), &num_updates, 2);
            if (num_updates > 0) {
                memcpy(raw_payload.data() + 2, delta_updates, num_updates * sizeof(DeltaUpdate));
            }

            hdr.flags = 0x02; // Delta frame
            if (include_stamp) hdr.flags |= 0x04;
            if (include_base) hdr.flags |= 0x08; // Combined delta flag

            size_t max_comp = ZSTD_compressBound(payload_len);
            size_t header_size = sizeof(hdr) + (include_stamp ? 1 : 0) + (include_base ? sizeof(uint32_t) : 0);

            delta_packet.resize(header_size + max_comp);
            memcpy(delta_packet.data(), &hdr, sizeof(hdr));
            size_t offset = sizeof(hdr);
            if (include_stamp) {
                delta_packet[offset] = stamp;
                offset += 1;
            }
            if (include_base) {
                memcpy(delta_packet.data() + offset, &combined_base_seq, sizeof(uint32_t));
                offset += sizeof(uint32_t);
            }

            size_t c_size = ZSTD_compress(delta_packet.data() + header_size, max_comp, raw_payload.data(), payload_len, 1);
            if (ZSTD_isError(c_size)) {
                out_packet = std::move(full_packet);
                stat_full++;
                stat_bytes_full += out_packet.size();
                record(curr_cmds, curr_count, seq);
                return EncodeResult::Full;
            }
            delta_packet.resize(header_size + c_size);
        }

        // Both encodings are built and measured, so the smaller one always wins.
        // The old rule switched on a command-count ratio, which is only a proxy
        // for size and got it wrong in the band around the break-even point.
        EncodeResult result;
        if (delta_packet.size() < full_packet.size()) {
            stat_delta_wins++;
            stat_delta++;
            stat_bytes_delta += delta_packet.size();
            out_packet = std::move(delta_packet);
            result = EncodeResult::Delta;
        } else {
            stat_full_wins++;
            stat_full++;
            stat_bytes_full += full_packet.size();
            out_packet = std::move(full_packet);
            result = EncodeResult::Full;
        }

        record(curr_cmds, curr_count, seq);
        return result;
    }

    void record(const DrawCommand* curr_cmds, uint16_t curr_count, uint32_t seq) {
        uint32_t hist_slot = seq % 60;
        history[hist_slot].seq = seq;
        history[hist_slot].cmd_count = curr_count;
        memcpy(history[hist_slot].cmds, curr_cmds, curr_count * sizeof(DrawCommand));

        memcpy(prev_cmds, curr_cmds, curr_count * sizeof(DrawCommand));
        prev_count = curr_count;
    }
};


static DeltaEncoder g_delta_encoder;
// Render-tick counter: advances on every present, used to name recorded frames.
static uint32_t g_frame_seq = 0;
// Wire sequence: advances only when a frame packet is actually sent, so silent
// frames leave no gap in the numbering the client sees.
static uint32_t g_sent_seq = 0;

// What the client is modelled as holding, and the only thing that decides what gets
// sent.
//
// Artwork used to be broadcast from SDL_CreateTextureFromSurface, i.e. every picture
// the game created went on the wire whether or not any frame referenced it. Measured
// over 8s of panning: 5,383 pictures sent, 747 referenced by draw commands, 5,381
// never referenced at all. That flood shared the ordered frame channel, so frames
// queued behind it - 12.8 MB crossed the wire during a single 4.6s gap.
//
// The model is an insertion-ordered ring, not LRU, because it has to be reproducible:
// insertion order is exactly the order the host chose, so the client ends up with the
// same set without either side sending a sync message. Recency cannot be mirrored -
// the two sides observe accesses differently - so it is deliberately not used.
static std::deque<uint16_t> g_client_cache_order;
static std::unordered_set<uint16_t> g_client_cache_set;
static std::atomic<size_t> g_client_cache_cap{8192};
static std::atomic<uint64_t> g_pic_sent_referenced{0};
static std::atomic<uint64_t> g_pic_skipped_unreferenced{0};

// Caller holds g_tex_lock (or is single-threaded at connect).
static bool client_cache_has(uint16_t id) {
    return g_client_cache_set.find(id) != g_client_cache_set.end();
}

static void client_cache_push(uint16_t id) {
    if (!g_client_cache_set.insert(id).second) return;
    g_client_cache_order.push_back(id);
    const size_t cap = g_client_cache_cap.load(std::memory_order_relaxed);
    while (g_client_cache_order.size() > cap && !g_client_cache_order.empty()) {
        const uint16_t old = g_client_cache_order.front();
        g_client_cache_order.pop_front();
        g_client_cache_set.erase(old);
    }
}

static void client_cache_reset() {
    g_client_cache_order.clear();
    g_client_cache_set.clear();
}
static std::atomic<bool> g_need_keyframe{true};
static std::atomic<uint32_t> g_pending_combined_base{0};

static void resolve_symbols() {
    if (!real_SDL_RenderCopy) real_SDL_RenderCopy = (int(*)(void*,void*,const SDL_Rect*,const SDL_Rect*))dlsym(RTLD_NEXT, "SDL_RenderCopy");
    if (!real_SDL_RenderCopyEx) real_SDL_RenderCopyEx = (int(*)(void*,void*,const SDL_Rect*,const SDL_Rect*,double,const void*,int))dlsym(RTLD_NEXT, "SDL_RenderCopyEx");
    if (!real_SDL_RenderClear) real_SDL_RenderClear = (int(*)(void*))dlsym(RTLD_NEXT, "SDL_RenderClear");
    if (!real_SDL_RenderPresent) real_SDL_RenderPresent = (void(*)(void*))dlsym(RTLD_NEXT, "SDL_RenderPresent");
    if (!real_SDL_PushEvent) real_SDL_PushEvent = (int(*)(void*))dlsym(RTLD_NEXT, "SDL_PushEvent");
    if (!real_SDL_CreateTextureFromSurface) real_SDL_CreateTextureFromSurface = (void*(*)(void*,void*))dlsym(RTLD_NEXT, "SDL_CreateTextureFromSurface");
    if (!real_SDL_UpdateTexture) real_SDL_UpdateTexture = (int(*)(void*,const void*,const void*,int))dlsym(RTLD_NEXT, "SDL_UpdateTexture");
    if (!real_SDL_RenderFillRect) real_SDL_RenderFillRect = (int(*)(void*,const void*))dlsym(RTLD_NEXT, "SDL_RenderFillRect");
    if (!real_SDL_RenderFillRects) real_SDL_RenderFillRects = (int(*)(void*,const void*,int))dlsym(RTLD_NEXT, "SDL_RenderFillRects");
    if (!real_SDL_RenderDrawLine) real_SDL_RenderDrawLine = (int(*)(void*,int,int,int,int))dlsym(RTLD_NEXT, "SDL_RenderDrawLine");
    if (!real_SDL_RenderDrawLines) real_SDL_RenderDrawLines = (int(*)(void*,const void*,int))dlsym(RTLD_NEXT, "SDL_RenderDrawLines");
    if (!real_SDL_RenderDrawPoint) real_SDL_RenderDrawPoint = (int(*)(void*,int,int))dlsym(RTLD_NEXT, "SDL_RenderDrawPoint");
    if (!real_SDL_RenderGeometry) real_SDL_RenderGeometry = (int(*)(void*,void*,const void*,int,const void*,int))dlsym(RTLD_NEXT, "SDL_RenderGeometry");
    if (!real_SDL_RenderSetClipRect) real_SDL_RenderSetClipRect = (int(*)(void*,const void*))dlsym(RTLD_NEXT, "SDL_RenderSetClipRect");
    if (!real_SDL_SetRenderDrawColor) real_SDL_SetRenderDrawColor = (int(*)(void*,uint8_t,uint8_t,uint8_t,uint8_t))dlsym(RTLD_NEXT, "SDL_SetRenderDrawColor");
    if (!real_SDL_LockTexture) real_SDL_LockTexture = (int(*)(void*,const void*,void**,int*))dlsym(RTLD_NEXT, "SDL_LockTexture");
    if (!real_SDL_UnlockTexture) real_SDL_UnlockTexture = (void(*)(void*))dlsym(RTLD_NEXT, "SDL_UnlockTexture");
    if (!real_SDL_GetMouseState) real_SDL_GetMouseState = (uint32_t(*)(int*,int*))dlsym(RTLD_NEXT, "SDL_GetMouseState");
    if (!real_SDL_DestroyTexture) real_SDL_DestroyTexture = (void(*)(void*))dlsym(RTLD_NEXT, "SDL_DestroyTexture");
    if (!real_SDL_RenderReadPixels) real_SDL_RenderReadPixels = (int(*)(void*,const SDL_Rect*,uint32_t,void*,int))dlsym(RTLD_NEXT, "SDL_RenderReadPixels");
    if (!real_SDL_GetRendererOutputSize) real_SDL_GetRendererOutputSize = (int(*)(void*,int*,int*))dlsym(RTLD_NEXT, "SDL_GetRendererOutputSize");
    if (!real_SDL_ConvertSurfaceFormat) real_SDL_ConvertSurfaceFormat = (void*(*)(void*,uint32_t,uint32_t))dlsym(RTLD_NEXT, "SDL_ConvertSurfaceFormat");
    if (!real_SDL_FreeSurface) real_SDL_FreeSurface = (void(*)(void*))dlsym(RTLD_NEXT, "SDL_FreeSurface");
    if (!g_gps_ptr) g_gps_ptr = dlsym(RTLD_DEFAULT, "gps");
    if (!g_enabler_ptr) g_enabler_ptr = dlsym(RTLD_DEFAULT, "enabler");
    if (!real_set_force_full_display_count) {
        real_set_force_full_display_count = (void(*)(void*, short))dlsym(RTLD_DEFAULT, "_ZN9graphicst28set_force_full_display_countEs");
    }
    if (!real_SDL_PollEvent) real_SDL_PollEvent = (int(*)(void*))dlsym(RTLD_NEXT, "SDL_PollEvent");
    if (!real_SDL_SetModState) real_SDL_SetModState = (void(*)(int))dlsym(RTLD_NEXT, "SDL_SetModState");
    if (!g_df_modstate_ptr) {
        void* fn = dlsym(RTLD_DEFAULT, "_Z11getModStatev");
        if (fn) {
            unsigned char* code = (unsigned char*)fn;
            int offset = 0;
            if (code[0] == 0xf3 && code[1] == 0x0f && code[2] == 0x1e && code[3] == 0xfa) {
                offset = 4; // skip endbr64
            }
            if (code[offset] == 0x0f && code[offset+1] == 0xb6 && code[offset+2] == 0x05) {
                int32_t rip_disp = *(int32_t*)(code + offset + 3);
                g_df_modstate_ptr = (uint8_t*)(code + offset + 7 + rip_disp);
                fprintf(stderr, "[MOD] Resolved DF internal modState at %p\n", g_df_modstate_ptr);
                fflush(stderr);
            }
        }
    }
}

static uint32_t g_df_window_id = 1;
static void* g_df_window = nullptr;
static int g_current_w = 1280;
static int g_current_h = 720;
// The newest pointer position that has not been handed to the game yet.
//
// Mouse movement arrives as absolute positions, one message per movement, and a
// frozen game cannot drain them as fast as they arrive. Queued, they are a
// recording: when the game recovers it walks through every position the pointer
// passed through, which to the player is the camera panning on its own in
// directions they never dragged. Only the newest position is news - the older
// ones describe a pointer that has already moved on - so one is kept and the rest
// are superseded. Coalescing this way cannot lose the current position, which is
// the only one that matters, and it bounds the work to one event per poll however
// long the game was away.
static std::atomic<bool> g_motion_pending{false};
static std::atomic<int>  g_motion_x{0};
static std::atomic<int>  g_motion_y{0};
static std::atomic<int>  g_motion_state{0};
// The longest single blocking send and the longest present, in microseconds.
//
// A stalled display looks the same whether the game stopped drawing or the socket
// stopped accepting, and those two need opposite repairs. These are maxima rather
// than averages on purpose: a stream that is healthy 95% of the time and wedges
// for eight seconds is exactly the case an average hides.
static std::atomic<uint64_t> g_presents{0};
static std::atomic<uint64_t> g_presents_silent{0};
// Why a present produced no frame: no draw commands captured at all, or the
// encoder found nothing changed. They are different faults with the same symptom.
static std::atomic<uint64_t> g_presents_nocmd{0};
// What the game pays for being recorded. The draw hook runs once per sprite per
// present, so a microsecond here is a second per frame at these call counts.
static std::atomic<uint64_t> g_hook_ns{0};
static std::atomic<uint64_t> g_hook_calls{0};
// How many DISTINCT pictures the game produces, against how many pictures it
// creates. If a session builds thousands of images but only a few dozen distinct
// ones, the artwork is a tileset being rebuilt over and over and it only needs to
// be sent once. If the distinct count tracks the total, the game really is
// producing new artwork and de-duplication cannot help.
static std::atomic<uint64_t> g_pic_created{0};
static std::atomic<uint64_t> g_pic_distinct{0};
// Time the game is stuck inside the present hook: delta encoding, the send, and
// any socket wait. This is the number that says whether the interposer is what
// makes the game slow, and it has been declared-but-never-written for a while.
static std::atomic<uint64_t> g_present_us_total{0};
static std::atomic<uint64_t> g_present_us_max{0};
static std::atomic<uint64_t> g_present_count{0};
// Input pipeline, end to end: messages off the wire, motion events handed to the
// game, and motion the game actually drained. A camera that will not move is
// either not being told to, or not asking.
static std::atomic<uint64_t> g_input_msgs{0};
static std::atomic<uint64_t> g_motion_delivered{0};
static std::atomic<uint64_t> g_motion_superseded{0};
static std::atomic<int64_t> g_send_block_max_us{0};
static std::atomic<int64_t> g_present_max_us{0};
static std::atomic<int> g_pending_resize_w{0};
static std::atomic<int> g_pending_resize_h{0};
static void* real_SDL_CreateWindow = nullptr;
static void* real_SDL_GetWindowID = nullptr;
static void (*real_SDL_SetWindowSize)(void*, int, int) = nullptr;

static void ensure_mouse_focus() {
    if (!g_mouse_focused && real_SDL_PushEvent) {
        SDL2_Event ev;
        memset(&ev, 0, sizeof(ev));
        ev.window.type = 0x200; // SDL_WINDOWEVENT
        ev.window.windowID = g_df_window_id;
        ev.window.event = 10;   // SDL_WINDOWEVENT_ENTER
        real_SDL_PushEvent(&ev);

        memset(&ev, 0, sizeof(ev));
        ev.window.type = 0x200;
        ev.window.windowID = g_df_window_id;
        ev.window.event = 12;   // SDL_WINDOWEVENT_FOCUS_GAINED
        real_SDL_PushEvent(&ev);

        g_mouse_focused = true;
    }
}



// Hook enabler_inputst::add_input to prevent mouse wheel events from polluting pressed_keys.
// DF's enabler_inputst re-presses all pressed_keys on modifier changes (Shift, Ctrl, Alt).
// If type_mwheel remains in pressed_keys, pressing '>' (Shift+.) re-triggers mouse wheel forever.
typedef void (*real_add_input_fn)(void* self, void* event, uint32_t now);
static real_add_input_fn real_add_input = nullptr;

typedef void (*real_add_input_refined_fn)(void* self, void* key_event, uint32_t now, int serial);
static real_add_input_refined_fn real_add_input_refined = nullptr;
static uint8_t g_last_wheel_mod = 0;

struct InternalEventMatch {
    int32_t type;
    uint8_t mod;
    uint8_t scancode;
    uint8_t pad[2];
    int32_t y;
};

struct InternalKeyEvent {
    uint8_t release;
    uint8_t pad[3];
    InternalEventMatch match;
};

extern "C" void _ZN15enabler_inputst9add_inputER9SDL_Eventj(void* self, void* event, uint32_t now) {
    uint32_t* p = (uint32_t*)event;
    fprintf(stderr, "[HOOK_RAW] ev: [0]=0x%x [1]=%d [2]=%d [3]=%d [4]=%d [5]=%d [6]=%d [7]=%d [8]=%d [9]=%d [10]=%d\n",
            p[0], (int)p[1], (int)p[2], (int)p[3], (int)p[4], (int)p[5], (int)p[6], (int)p[7], (int)p[8], (int)p[9], (int)p[10]);
    fflush(stderr);
    if (!real_add_input) {
        real_add_input = (real_add_input_fn)dlsym(RTLD_NEXT, "_ZN15enabler_inputst9add_inputER9SDL_Eventj");
    }
    if (!real_add_input_refined) {
        real_add_input_refined = (real_add_input_refined_fn)dlsym(RTLD_DEFAULT, "_ZN15enabler_inputst17add_input_refinedER8KeyEventji");
    }

    uint32_t ev_type = *(uint32_t*)event;
    if (ev_type == 0x403) { // SDL_MOUSEWHEEL
        // In sdl2-compat, offset 20 (integer y) is uninitialized/corrupted with mouseY.
        // Offset 32 (preciseY float) contains the true float scroll delta (+1.0f or -1.0f).
        float precise_y = *(float*)((char*)event + 32);
        int32_t effective_y = (precise_y > 0.0f) ? 1 : -1;
        fprintf(stderr, "[HOOK_ADD_INPUT] WHEEL precise_y=%f effective_y=%d mod=%u\n", precise_y, effective_y, g_last_wheel_mod);
        fflush(stderr);

        InternalKeyEvent ke;
        memset(&ke, 0, sizeof(ke));
        ke.release = 0;
        ke.match.type = 2; // type_mwheel
        ke.match.mod = g_last_wheel_mod;  // Allow modifier keys (e.g. 2 = Ctrl for zoom)
        ke.match.scancode = 0;
        ke.match.y = effective_y;

        static int wheel_serial = 900000;
        if (real_add_input_refined) {
            real_add_input_refined(self, &ke, now, ++wheel_serial);
        }
        return;
    }

    if (real_add_input) {
        real_add_input(self, event, now);
    }
}

// The client-input stamp slot. The rule that decides whether an input was
// answered lives in interposer/stamp_slot.hpp, where it is unit tested without
// the interposer's dependencies (tests/stamp_slot_test.cpp) - a rule this
// central is not allowed to exist only as inline code in a 3000-line file.
static stamp_slot::State g_stamp_slot;
// The raw pixel path needs its OWN slot. Both transports answer inputs, and when
// they shared one slot the raw path - which captures, claims and settles on every
// present - claimed every stamp before the instruction path could reach it. That
// is why instruction-path latency samples were zero for entire runs while the host
// reported hundreds of answers: the answers belonged to the other transport.
static stamp_slot::State g_raw_stamp_slot;

// A stamp only describes latency while the input that produced it is still
// recent. Frames are emitted only when the scene changes, so a stamp from an
// input that changed nothing would otherwise ride along on some unrelated later
// frame and report a latency that never happened.
//
// Long rather than short, deliberately. A cap tight enough to catch that would
// also discard every genuinely slow answer, and a bench that throws away its
// slowest samples reports a latency better than the one the player gets. What it
// has to exclude is a stamp that has outlived its input by so long that no frame
// could still be answering it; a second is well past that, and the count of
// expired stamps is reported so a run where this decides anything is visible.
static const int64_t g_stamp_max_age_ms = 1000;
// Age of an input stamp when the frame carrying it actually went out. This is
// the server-side share of felt latency: input received -> changed frame sent.
static std::vector<int64_t> g_stamp_ages_ms;
// Frames that really carried a stamp and went out on the draw-command path.
// This is the draw-command path's own count of answered inputs; the raw path
// keeps its own (g_raw_stamp_answered), and the input-side totals - received,
// overwritten, expired, deferred - live in the stamp slot itself, where the rule
// that decides them is unit tested.
static uint64_t g_stamp_seen = 0;
// Bytes still queued in the SCTP send buffer at the moment a frame is handed to
// it. Distinguishes "our queue is backed up" from "we handed it over instantly
// and the network took the time" -- different root causes, different fixes.
static std::vector<int64_t> g_queue_at_send;
static uint64_t g_tex_count = 0;
// Splits the picture traffic into first-time sends and repeats. A repeat is
// pure waste: the client already holds that picture, so the only reason to send
// it again is that something threw its copy away.
static uint64_t g_tex_new = 0;
static uint64_t g_tex_repeat = 0;
// The connect-time dump: every cached picture pushed at a client that has just
// arrived and therefore holds nothing yet.
static uint64_t g_tex_dump_count = 0;
static uint64_t g_tex_dump_bytes = 0;
// Ids handed to a second picture, which only happens if the whole id space is
// exhausted. Must stay 0: any other value means a client can be shown a stale
// picture for that id.
static uint64_t g_tex_recycled = 0;
// Everything put on the link toward the client: draw commands plus pictures.
// Counted at the send calls, because this is the number the whole-picture
// baseline has to be compared against and neither side may estimate it.
static uint64_t g_wire_bytes = 0;
static uint64_t g_wire_frames = 0;
// Draws of textures we never saw created, and draws skipped because we hold no
// pixels for them. Either being non-zero means a sprite the game drew is not in
// the stream, which shows up as a correct-looking frame with something missing.
static uint64_t g_draw_unknown = 0;
static uint64_t g_draw_nopixels = 0;
static void dump_render_call_counts() {
    FILE* f = fopen("/tmp/df_render_calls", "w");
    if (!f) return;
    fprintf(f, "renderCopyCalls=%llu drawUnknown=%llu drawNoPixels=%llu capturedCmds=%llu fillRect=%llu fillRects=%llu drawLine=%llu drawLines=%llu drawPoint=%llu geometry=%llu setClipRect=%llu setDrawColor=%llu\n",
            (unsigned long long)g_rc_copy_calls.load(), (unsigned long long)g_draw_unknown, (unsigned long long)g_draw_nopixels,
            (unsigned long long)g_frame_cmd_count,
            (unsigned long long)g_rc_fillrect.load(), (unsigned long long)g_rc_fillrects.load(),
            (unsigned long long)g_rc_drawline.load(), (unsigned long long)g_rc_drawlines.load(),
            (unsigned long long)g_rc_drawpoint.load(), (unsigned long long)g_rc_geometry.load(),
            (unsigned long long)g_rc_setclip.load(), (unsigned long long)g_rc_setcolor.load());
    fclose(f);
}

static uint64_t g_tex_bytes = 0;
static int64_t steady_now_ms() {
    return std::chrono::duration_cast<std::chrono::milliseconds>(
        std::chrono::steady_clock::now().time_since_epoch()).count();
}

// Every message this process handed to a link, with the send-queue depth at that
// moment and, for a raw capture, what the encode cost. Kept here rather than
// derived from the counters because a spike needs the message that caused it,
// not a session total - and because the previous attempt at this recorded only
// frames and pings, which on this link is 1% of the traffic.
static wire_log::Log g_wire_log;

// The host's wall clock, for lining these events up with the page's timeline.
// The page and the host are different machines, so the bench estimates the
// offset from a round trip (see clockAlign in measure.js) rather than assuming
// the two clocks agree.
static int64_t epoch_now_ms() {
    return std::chrono::duration_cast<std::chrono::milliseconds>(
        std::chrono::system_clock::now().time_since_epoch()).count();
}

static std::mutex g_btn_sync_lock;
static bool g_in_poll_pass = false;
static bool g_btn_down_in_pass[8] = {false};
static uint64_t g_down_sim_tick[8] = {0};
static std::deque<SDL2_Event> g_held_events;
static uint64_t g_sim_ticks = 0;

typedef void (*real_update_fps_fn)(void* self);
static real_update_fps_fn real_update_fps = nullptr;

// Hook enablerst::update_fps() which runs immediately after mainloop() consumes frame input
extern "C" void _ZN9enablerst10update_fpsEv(void* self) {
    if (!real_update_fps) {
        real_update_fps = (real_update_fps_fn)dlsym(RTLD_NEXT, "_ZN9enablerst10update_fpsEv");
    }
    if (real_update_fps) real_update_fps(self);

    g_sim_ticks++;
}

// A bench needs a fixed window. The raw baseline captures the whole window, so a
// size that changes whenever a client connects makes two runs measure different
// numbers of pixels and no comparison between them means anything. When
// /tmp/df_window_size holds WxH, that size wins and client resize requests are
// ignored; without the file nothing changes.
#define WINDOW_PIN_FILE "/tmp/df_window_size"

static bool pinned_window_size(int& w, int& h) {
    static std::atomic<int64_t> last_check_ms{0};
    static std::atomic<int> cached_w{0}, cached_h{0};
    static std::atomic<bool> ever_checked{false};
    int64_t now = std::chrono::duration_cast<std::chrono::milliseconds>(
        std::chrono::steady_clock::now().time_since_epoch()).count();
    if (!ever_checked.load() || now - last_check_ms.load() >= 1000) {
        last_check_ms.store(now);
        ever_checked.store(true);
        cached_w.store(0);
        cached_h.store(0);
        FILE* f = fopen(WINDOW_PIN_FILE, "r");
        if (f) {
            int pw = 0, ph = 0;
            if (fscanf(f, "%dx%d", &pw, &ph) == 2 && pw >= 912 && ph >= 552) {
                cached_w.store(pw);
                cached_h.store(ph);
            }
            fclose(f);
        }
    }
    w = cached_w.load();
    h = cached_h.load();
    return w > 0 && h > 0;
}

// Hook SDL_PollEvent: guarantees DF mainloop() always sees mouse clicks before mouse release
extern "C" int SDL_PollEvent(void* event) {
    if (!real_SDL_PollEvent) resolve_symbols();

    int target_w = g_pending_resize_w.exchange(0);
    int target_h = g_pending_resize_h.exchange(0);

    int pin_w = 0, pin_h = 0;
    if (pinned_window_size(pin_w, pin_h)) {
        // Apply the pinned size once so the window matches it, then swallow every
        // client request: the point of the pin is that no client can move it.
        static int applied_w = 0, applied_h = 0;
        if (applied_w != pin_w || applied_h != pin_h) {
            target_w = pin_w;
            target_h = pin_h;
            applied_w = pin_w;
            applied_h = pin_h;
            fprintf(stderr, "[WINDOW] pinned to %dx%d\n", pin_w, pin_h);
            fflush(stderr);
        } else {
            target_w = 0;
            target_h = 0;
        }
    }

    if (target_w >= 912 && target_h >= 552 && g_df_window) {
        g_current_w = target_w;
        g_current_h = target_h;
        if (g_enabler_ptr) {
            *(uint8_t*)((char*)g_enabler_ptr + 8) &= ~1;
            void* renderer_ptr = *(void**)((char*)g_enabler_ptr + 0x60);
            if (renderer_ptr) {
                void** vtable = *(void***)renderer_ptr;
                typedef void (*resize_fn)(void*, int, int);
                resize_fn real_resize = (resize_fn)vtable[16];
                if (real_resize) {
                    real_resize(renderer_ptr, target_w, target_h);
                }
            }
        }
        if (!real_SDL_SetWindowSize) real_SDL_SetWindowSize = (void(*)(void*,int,int))dlsym(RTLD_NEXT, "SDL_SetWindowSize");
        if (real_SDL_SetWindowSize) {
            real_SDL_SetWindowSize(g_df_window, target_w, target_h);
        }
        if (real_SDL_PushEvent) {
            SDL2_Event r_ev;
            memset(&r_ev, 0, sizeof(r_ev));
            r_ev.window.type = 0x200; // SDL_WINDOWEVENT
            r_ev.window.windowID = g_df_window_id;
            r_ev.window.event = 5;    // SDL_WINDOWEVENT_RESIZED
            r_ev.window.data1 = target_w;
            r_ev.window.data2 = target_h;
            real_SDL_PushEvent(&r_ev);

            memset(&r_ev, 0, sizeof(r_ev));
            r_ev.window.type = 0x200; // SDL_WINDOWEVENT
            r_ev.window.windowID = g_df_window_id;
            r_ev.window.event = 6;    // SDL_WINDOWEVENT_SIZE_CHANGED
            r_ev.window.data1 = target_w;
            r_ev.window.data2 = target_h;
            real_SDL_PushEvent(&r_ev);
        }
        force_full_display();
        fprintf(stderr, "[RESIZE_MAIN] Applied resize %dx%d on main thread\n", target_w, target_h);
        fflush(stderr);
    }

    std::lock_guard<std::mutex> lock(g_btn_sync_lock);

    if (!g_in_poll_pass) {
        g_in_poll_pass = true;
        memset(g_btn_down_in_pass, 0, sizeof(g_btn_down_in_pass));
    }

    // 1. Drain held events from earlier pass if ready
    if (!g_held_events.empty()) {
        const SDL2_Event& front = g_held_events.front();
        bool can_return = true;
        if (front.type == 0x402) { // SDL_MOUSEBUTTONUP
            uint8_t btn = front.button.button;
            if (btn < 8 && (g_btn_down_in_pass[btn] || g_sim_ticks <= g_down_sim_tick[btn])) {
                can_return = false;
            }
        }
        if (can_return) {
            if (event) memcpy(event, &front, sizeof(SDL2_Event));
            g_held_events.pop_front();
            return 1;
        }
    }

    // 2. Hand over the newest pointer position, if one is waiting.
    //
    // Before polling SDL, so it is delivered with the same responsiveness as any
    // other event, and after the held button events, so pressing and releasing
    // still take priority over where the pointer has got to.
    if (g_motion_pending.exchange(false, std::memory_order_acquire)) {
        SDL2_Event m_ev;
        memset(&m_ev, 0, sizeof(m_ev));
        m_ev.motion.type = 0x400; // SDL_MOUSEMOTION
        m_ev.motion.windowID = g_df_window_id;
        m_ev.motion.state = g_motion_state.load(std::memory_order_relaxed);
        m_ev.motion.x = g_motion_x.load(std::memory_order_relaxed);
        m_ev.motion.y = g_motion_y.load(std::memory_order_relaxed);
        if (event) memcpy(event, &m_ev, sizeof(SDL2_Event));
        g_motion_delivered.fetch_add(1, std::memory_order_relaxed);
        return 1;
    }

    // 3. Poll real SDL
    SDL2_Event cur;
    while (real_SDL_PollEvent && real_SDL_PollEvent(&cur)) {
        if (cur.type == 0x401) { // SDL_MOUSEBUTTONDOWN
            uint8_t btn = cur.button.button;
            bool has_held = false;
            for (const auto& h : g_held_events) {
                if (h.button.button == btn) { has_held = true; break; }
            }
            if (has_held) {
                g_held_events.push_back(cur);
                continue;
            }
            if (btn < 8) {
                g_btn_down_in_pass[btn] = true;
                g_down_sim_tick[btn] = g_sim_ticks;
            }
            if (event) memcpy(event, &cur, sizeof(SDL2_Event));
            return 1;
        } else if (cur.type == 0x402) { // SDL_MOUSEBUTTONUP
            uint8_t btn = cur.button.button;
            bool hold = (btn < 8 && (g_btn_down_in_pass[btn] || g_sim_ticks <= g_down_sim_tick[btn]));
            if (!hold) {
                for (const auto& h : g_held_events) {
                    if (h.button.button == btn) { hold = true; break; }
                }
            }
            if (hold) {
                fprintf(stderr, "[POLL] Deferring btn=%d UP to next pass (anti-coalesce tick=%lu)\n", btn, (unsigned long)g_sim_ticks);
                fflush(stderr);
                g_held_events.push_back(cur);
                continue;
            }
            if (event) memcpy(event, &cur, sizeof(SDL2_Event));
            return 1;
        } else {
            if (event) memcpy(event, &cur, sizeof(SDL2_Event));
            return 1;
        }
    }

    g_in_poll_pass = false;
    return 0;
}

// Handle client input directly in memory
// Defined below, next to the texture send path it depends on.
static void resend_missing_textures(uint32_t seq, const std::vector<uint16_t>& requested,
                                   const std::vector<uint32_t>& requested_chunks);

void handle_client_input_event(const uint8_t* data, size_t len) {
    if (len >= 5 && data[0] == 7) { // GAP_ACK / COMBINED_DELTA_REQ
        uint32_t acked_seq = 0;
        memcpy(&acked_seq, data + 1, sizeof(uint32_t));
        g_pending_combined_base.store(acked_seq);
        fprintf(stderr, "[COMBINED_DELTA] Received GAP_ACK for seq %u from client\n", acked_seq);
        fflush(stderr);
        return;
    }
    if (len >= 7 && data[0] == 8) { // ASSET_BRIDGE_REQ
        uint32_t seq = 0;
        memcpy(&seq, data + 1, sizeof(uint32_t));
        uint16_t want_count = 0;
        memcpy(&want_count, data + 5, sizeof(uint16_t));

        // Texture ids are u16 on the wire (DrawCommand::tex_id), so parse them
        // as such rather than as bytes.
        std::vector<uint16_t> wanted;
        if (want_count > 0 &&
            len >= static_cast<size_t>(7) + static_cast<size_t>(want_count) * sizeof(uint16_t)) {
            wanted.resize(want_count);
            memcpy(wanted.data(), data + 7, static_cast<size_t>(want_count) * sizeof(uint16_t));
        } else {
            want_count = 0;
        }

        // The client may append one chunk index per picture, naming the chunk it
        // is actually waiting for. Optional: a client that does not send them
        // gets the old behaviour, so the two halves can be deployed separately.
        std::vector<uint32_t> wanted_chunks;
        const size_t chunk_off = static_cast<size_t>(7) + static_cast<size_t>(want_count) * sizeof(uint16_t);
        if (want_count > 0 &&
            len >= chunk_off + static_cast<size_t>(want_count) * sizeof(uint16_t)) {
            wanted_chunks.resize(want_count);
            for (uint16_t i = 0; i < want_count; i++) {
                uint16_t c = 0;
                memcpy(&c, data + chunk_off + static_cast<size_t>(i) * sizeof(uint16_t), sizeof(uint16_t));
                wanted_chunks[i] = c;
            }
        }

        fprintf(stderr, "[ASSET_BRIDGE] Request for seq %u, client wants %u asset(s)%s",
                seq, want_count, wanted_chunks.empty() ? "" : " (with chunk hints)");
        fprintf(stderr, "\n");
        fflush(stderr);
        resend_missing_textures(seq, wanted, wanted_chunks);
        return;
    }
    if (len < sizeof(InputEvent)) return;
    const InputEvent* ev = (const InputEvent*)data;
    if (len >= 17 && data[16] != 0) {
        // One slot, deliberately: the stamp describes the newest input waiting
        // for a frame, and a frame can only answer the input it was drawn for.
        // An input that arrives while an earlier stamp is still unclaimed
        // overwrites it, and that input will never produce a sample - which is
        // counted rather than smoothed over.
        g_wire_log.note(epoch_now_ms(), wire_log::Input, (uint32_t)len, -1, 0, data[16]);
        g_stamp_slot.receive(data[16], steady_now_ms());
        // Same input, offered to both transports: whichever one is on screen gets
        // to answer it, and each one's counters describe only its own answers.
        g_raw_stamp_slot.receive(data[16], steady_now_ms());
    }

    ensure_mouse_focus();

    if (ev->event_type == 1) { // MOUSEMOTION
        g_mouse_x = ev->x;
        g_mouse_y = ev->y;
        // Superseded, not queued: see the note on g_motion_pending.
        g_motion_x.store(ev->x, std::memory_order_relaxed);
        g_motion_y.store(ev->y, std::memory_order_relaxed);
        g_motion_state.store(g_mouse_buttons, std::memory_order_relaxed);
        g_motion_pending.store(true, std::memory_order_release);
        g_motion_superseded.fetch_add(1, std::memory_order_relaxed);
    } else if (ev->event_type == 2 || ev->event_type == 3) { // MOUSEBUTTONDOWN / UP
        g_mouse_x = ev->x;
        g_mouse_y = ev->y;
        uint8_t btn = ev->button;
        sync_modifiers(ev->mod);

        if (ev->event_type == 2) {
            // Sync SDL internal cursor position before button event
            SDL2_Event m_ev;
            memset(&m_ev, 0, sizeof(m_ev));
            m_ev.motion.type = 0x400;
            m_ev.motion.windowID = g_df_window_id;
            m_ev.motion.state = g_mouse_buttons;
            m_ev.motion.x = ev->x;
            m_ev.motion.y = ev->y;
            if (real_SDL_PushEvent) real_SDL_PushEvent(&m_ev);

            if (btn == 1) g_mouse_buttons |= 1;
            else if (btn == 2) g_mouse_buttons |= 2;
            else if (btn == 3) g_mouse_buttons |= 4;

            SDL2_Event b_ev;
            memset(&b_ev, 0, sizeof(b_ev));
            b_ev.button.type = 0x401; // SDL_MOUSEBUTTONDOWN
            b_ev.button.windowID = g_df_window_id;
            b_ev.button.button = btn;
            b_ev.button.state = 1;
            b_ev.button.clicks = 1;
            b_ev.button.x = ev->x;
            b_ev.button.y = ev->y;
            int p_res = real_SDL_PushEvent ? real_SDL_PushEvent(&b_ev) : -1;
            fprintf(stderr, "[INPUT] btn=%d DOWN at (%d, %d) mod=%u winID=%u push=%d\n", btn, ev->x, ev->y, ev->mod, g_df_window_id, p_res);
            fflush(stderr);
        } else {
            if (btn == 1) g_mouse_buttons &= ~1;
            else if (btn == 2) g_mouse_buttons &= ~2;
            else if (btn == 3) g_mouse_buttons &= ~4;

            SDL2_Event b_ev;
            memset(&b_ev, 0, sizeof(b_ev));
            b_ev.button.type = 0x402; // SDL_MOUSEBUTTONUP
            b_ev.button.windowID = g_df_window_id;
            b_ev.button.button = btn;
            b_ev.button.state = 0;
            b_ev.button.clicks = 1;
            b_ev.button.x = ev->x;
            b_ev.button.y = ev->y;
            int p_res = real_SDL_PushEvent ? real_SDL_PushEvent(&b_ev) : -1;
            fprintf(stderr, "[INPUT] btn=%d UP at (%d, %d) mod=%u winID=%u push=%d\n", btn, ev->x, ev->y, ev->mod, g_df_window_id, p_res);
            fflush(stderr);
        }
    } else if (ev->event_type == 4) { // MOUSEWHEEL
        g_mouse_x = ev->x;
        g_mouse_y = ev->y;
        SDL2_Event m_ev;
        memset(&m_ev, 0, sizeof(m_ev));
        m_ev.motion.type = 0x400; // SDL_MOUSEMOTION
        m_ev.motion.windowID = g_df_window_id;
        m_ev.motion.state = g_mouse_buttons;
        m_ev.motion.x = ev->x;
        m_ev.motion.y = ev->y;
        if (real_SDL_PushEvent) real_SDL_PushEvent(&m_ev);

        sync_modifiers(ev->mod);
        g_last_wheel_mod = ev->mod;
        SDL2_Event w_ev;
        memset(&w_ev, 0, sizeof(w_ev));
        w_ev.wheel.type = 0x403; // SDL_MOUSEWHEEL
        w_ev.wheel.windowID = g_df_window_id;
        w_ev.wheel.y = (ev->button == 1) ? 1 : -1;
        w_ev.wheel.direction = 0; // SDL_MOUSEWHEEL_NORMAL
        w_ev.wheel.preciseY = (float)w_ev.wheel.y;
        w_ev.wheel.mouseX = ev->x;
        w_ev.wheel.mouseY = ev->y;
        int p_res = real_SDL_PushEvent ? real_SDL_PushEvent(&w_ev) : -1;
        fprintf(stderr, "[INPUT] wheel pushed btn=%d preciseY=%f mod=%u res=%d\n", ev->button, w_ev.wheel.preciseY, ev->mod, p_res);
        fflush(stderr);
    } else if (ev->event_type == 5) { // RESIZE
        int w = ev->x;
        int h = ev->y;
        if (w >= 912 && h >= 552) {
            g_pending_resize_w = w;
            g_pending_resize_h = h;
            g_need_keyframe.store(true);
            fprintf(stderr, "[RESIZE_QUEUE] Queued resize %dx%d for main thread\n", w, h);
            fflush(stderr);
        }
    } else if (ev->event_type == 6) { // KEYFRAME_REQUEST (loss recovery)
        g_need_keyframe.store(true);
        fprintf(stderr, "[KEYFRAME_REQUEST] Received loss recovery request from client\n");
        fflush(stderr);
    } else if (ev->event_type == 16 || ev->event_type == 17) { // KEYDOWN / KEYUP
        sync_modifiers(ev->mod);
        SDL2_Event k_ev;
        memset(&k_ev, 0, sizeof(k_ev));
        k_ev.key.type = (ev->event_type == 16) ? 0x300 : 0x301;
        k_ev.key.windowID = g_df_window_id;
        k_ev.key.state = (ev->event_type == 16) ? 1 : 0;
        k_ev.key.repeat = 0;
        k_ev.key.keysym.scancode = ev->scancode;
        k_ev.key.keysym.sym = (int32_t)ev->keycode;

        uint16_t sdl_mod = 0;
        if (ev->mod & 1) sdl_mod |= 0x0001; // KMOD_LSHIFT
        if (ev->mod & 2) sdl_mod |= 0x0040; // KMOD_LCTRL
        if (ev->mod & 4) sdl_mod |= 0x0100; // KMOD_LALT
        if (ev->mod & 8) sdl_mod |= 0x0400; // KMOD_LGUI
        k_ev.key.keysym.mod = sdl_mod;

        int p_res = real_SDL_PushEvent ? real_SDL_PushEvent(&k_ev) : -1;
        fprintf(stderr, "[INPUT] key=%u scancode=%u mod=%u %s winID=%u push=%d\n",
                ev->keycode, ev->scancode, ev->mod, (ev->event_type == 16) ? "DOWN" : "UP", g_df_window_id, p_res);
        fflush(stderr);
    }
}

static void send_texture_packet(int fd, const CachedTexture& ct) {
    if (ct.rgba.empty()) return;
    TextureHeader hdr;
    hdr.magic[0] = 'D';
    hdr.magic[1] = 'T';
    hdr.tex_id = ct.id;
    hdr.w = ct.w;
    hdr.h = ct.h;
    hdr.payload_len = (uint32_t)ct.rgba.size();

    std::vector<uint8_t> packet(sizeof(hdr) + ct.rgba.size());
    memcpy(packet.data(), &hdr, sizeof(hdr));
    memcpy(packet.data() + sizeof(hdr), ct.rgba.data(), ct.rgba.size());

    if (fd >= 0) {
        g_server->send_ws_binary(fd, packet.data(), packet.size());
    } else {
        g_server->broadcast_ws_binary(packet.data(), packet.size());
    }
}

void sync_client_textures(int fd) {
    std::lock_guard<std::mutex> lock(g_tex_lock);
    for (uint16_t i = 0; i < g_texture_count; i++) {
        if (!g_cached_textures[i].rgba.empty()) {
            send_texture_packet(fd, g_cached_textures[i]);
        }
    }
    g_need_keyframe = true;
    force_full_display();
}

// Looks up the id a texture was already given. Returns 0 if we never saw it
// created. Draw-time only: it must never allocate, or a texture the game made
// through a path we do not hook would silently adopt an unrelated id.
static uint16_t lookup_texture_id(void* texture) {
    if (!texture) return 0;
    std::lock_guard<std::mutex> lock(g_tex_lock);
    for (uint16_t i = 0; i < g_texture_count; i++) {
        if (g_textures[i] == texture) return i + 1;
    }
    return 0;
}

// Gives a newly created texture an id of its own. Always allocates.
//
// This used to search first and match on the raw pointer. That is unsound: the
// game frees a texture's memory and the allocator hands the same address
// straight to the next texture. Zoom makes it certain rather than unlikely,
// because it destroys and recreates the entire sprite set in one burst. The new
// picture then inherited the old picture's id, and since the client caches
// pictures by id it drew the old sprite wherever the new one belonged - and the
// two stayed fused for the rest of the session, because nothing ever told the
// client the id had changed hands. That is the corruption: stable, whole-sprite,
// shows up after a few zooms, and invisible to the client's missing-picture
// check, which sees the id present and assumes the picture is right.
static uint16_t alloc_texture_id(void* texture) {
    if (!texture) return 0;
    std::lock_guard<std::mutex> lock(g_tex_lock);
    if (g_texture_count < MAX_TEXTURES) {
        uint16_t id = ++g_texture_count;
        g_textures[id - 1] = texture;
        return id;
    }
    // Only reachable once the whole id space is used up. Counted, because an id
    // handed to a second picture is the one case where the client can still be
    // shown a stale picture.
    for (uint16_t i = 0; i < MAX_TEXTURES; i++) {
        if (g_textures[i] == nullptr) {
            g_textures[i] = texture;
            g_tex_recycled++;
            return i + 1;
        }
    }
    return 0;
}

// WebRTC True UDP DataChannel Session Management
struct ClientRtcSession {
    std::shared_ptr<rtc::PeerConnection> pc;
    std::shared_ptr<rtc::DataChannel> dc;
};

static std::mutex g_rtc_lock;
static std::unordered_map<int, ClientRtcSession> g_rtc_sessions;
static std::vector<std::shared_ptr<rtc::DataChannel>> g_active_dcs;

// Serialises encoding and sending between the present path, which runs on the
// game's thread, and any other event with its own reason to send - a client
// connecting, which arrives on the network thread. Without it the two would
// interleave inside g_delta_encoder and corrupt the delta chain.
static std::mutex g_send_lock;

// The picture the game last drew, kept so a client connecting while the game
// sits still can still be sent what is on screen. Every present empties the
// command buffer, so without this copy there is nothing left to send between
// draws - which is exactly why a client joining a still screen got a black
// canvas and stayed there until the user happened to press something.
static std::vector<DrawCommand> g_last_picture;
static bool g_last_picture_valid = false;

// Defined below, next to SDL_RenderPresent. Declared here because the
// data-channel open callback above it is what a client arriving actually
// triggers, and that has to be able to send the current picture.
//
// The extern "C" wrapper is not decoration: the definition lands inside the big
// extern "C" block further down, and a plain declaration here would give it C++
// linkage instead, which the compiler rejects as a conflicting declaration.
extern "C" {
static bool service_picture_send(const DrawCommand* cmds, uint16_t count,
                                 bool force_keyframe, uint32_t combined_base);
}

// --- what the data channel accepted -------------------------------------------
//
// The question these answer: when a frame or a picture does not arrive at the
// client, did it leave this process at all? libdatachannel's DataChannel::send()
// has three distinguishable outcomes, and nothing else in this process can tell
// them apart:
//
//   true    the message went into SCTP's send path
//   false   SCTP could not take it and libdatachannel QUEUED it locally
//           (impl/sctptransport.cpp: trySendMessage returns false on EWOULDBLOCK
//           and send() pushes the message onto its own queue, which is drained
//           when SCTP reports writable - it does not drop)
//   throw   the message is over the peer's advertised limit, or the channel is
//           closed (impl/datachannel.cpp: outgoing())
//
// `buffered` is what libdatachannel is holding for this channel, so a link that
// is being offered more than SCTP will take shows up here before anywhere else.
static std::atomic<uint64_t> g_dc_send_calls{0};
static std::atomic<uint64_t> g_dc_send_queued{0};
static std::atomic<uint64_t> g_dc_send_threw{0};
static std::atomic<uint64_t> g_dc_bytes_offered{0};
static std::atomic<int64_t>  g_dc_buffered_max{0};
static std::atomic<int64_t>  g_dc_buffered_now{0};
// What the channel was actually created as. On this end the peer's DCEP open
// message decides it, so this is the negotiated answer rather than our intent.
// Pictures travel on their own channel, reliable and ordered.
//
// They used to share the unreliable stream channel with the frames, and that
// channel is right for frames: a frame is small, and one that is lost is repaired
// by asking for it again, so paying for retransmission - and head-of-line
// blocking everything queued behind it - would make the display late to fix a
// frame it can already replace. Pictures are the opposite. A lost picture chunk
// cannot be replaced by a later one, it has to be resent, and the client cannot
// draw any frame that names the picture until the last chunk is there. Putting
// both on one channel means choosing between a display that is late and a
// display that is black; putting them on two means each gets what it needs.
static std::shared_ptr<rtc::DataChannel> g_asset_dc;
static std::mutex g_asset_dc_lock;
static std::atomic<int>      g_dc_rel_unordered{-1};
static std::atomic<int>      g_dc_rel_max_retransmits{-1};
static std::atomic<int>      g_dc_rel_max_lifetime{-1};
static std::atomic<int>      g_dc_rel_streams{-1};

// One place where every message to the client's data channel is handed over, so
// the counts are the same count for frames and pictures alike.
static bool dc_send_counted(std::shared_ptr<rtc::DataChannel>& dc, const uint8_t* data, size_t size) {
    g_dc_send_calls.fetch_add(1, std::memory_order_relaxed);
    g_dc_bytes_offered.fetch_add(size, std::memory_order_relaxed);
    try {
        bool ok = dc->send((const std::byte*)data, size);
        if (!ok) g_dc_send_queued.fetch_add(1, std::memory_order_relaxed);
        int64_t b = (int64_t)dc->bufferedAmount();
        g_dc_buffered_now.store(b, std::memory_order_relaxed);
        int64_t prev = g_dc_buffered_max.load(std::memory_order_relaxed);
        while (b > prev && !g_dc_buffered_max.compare_exchange_weak(prev, b)) {}
        return ok;
    } catch (const std::exception& e) {
        g_dc_send_threw.fetch_add(1, std::memory_order_relaxed);
        throw;
    }
}

// Reads the negotiated reliability off a channel, once, when it opens. Reported
// in /df-stats so the answer comes from the running connection rather than from
// the source that asked for it.
static void note_channel_reliability(const std::shared_ptr<rtc::DataChannel>& dc) {
    try {
        rtc::Reliability r = dc->reliability();
        g_dc_rel_unordered.store(r.unordered ? 1 : 0);
        g_dc_rel_max_retransmits.store(r.maxRetransmits ? (int)*r.maxRetransmits : -1);
        g_dc_rel_max_lifetime.store(r.maxPacketLifeTime ? (int)r.maxPacketLifeTime->count() : -1);
    } catch (...) {
        g_dc_rel_unordered.store(-2);
    }
}

// --- a controlled message stream, for the one question the game cannot ask -----
//
// "Does this link lose messages, and if so at what rate" cannot be answered with
// the game driving the traffic: the game decides how much it sends, and a run's
// offered rate is whatever that session's scene happened to produce. This offers
// a chosen number of messages of a chosen size per second instead, so the loss
// curve can be swept and the point where arrivals stop tracking the offer can be
// found rather than inferred.
//
// Controlled by /tmp/df_load_probe, three numbers on one line:
//
//     <messages per second> <message bytes> <total messages, 0 = until stopped>
//
// The messages are marked 'D','P' and carry their own sequence number, so the
// page can count arrivals by sequence and a gap is a specific message rather than
// a difference of two counts. They are NOT written to the wire log: at these
// rates one sweep would evict the whole session's real traffic from it.
#define LOAD_PROBE_FILE "/tmp/df_load_probe"
static std::atomic<bool>     g_probe_stop{false};
static std::atomic<uint64_t> g_probe_sent{0};
static std::atomic<uint64_t> g_probe_bytes{0};
static std::atomic<int>      g_probe_on{0};
static std::atomic<int>      g_probe_rate{0};
static std::atomic<int>      g_probe_size{0};
static std::atomic<uint64_t> g_probe_target{0};
static std::atomic<int>      g_probe_done{0};

static void load_probe_loop() {
    std::string last_spec;
    int rate = 0, size = 0;
    uint64_t target = 0;
    uint64_t sent = 0;
    uint32_t seq = 0;
    while (!g_probe_stop.load()) {
        // Re-read the knob five times a second: a sweep changes it between runs,
        // and removing the file ends the current run and arms the next one.
        FILE* f = fopen(LOAD_PROBE_FILE, "r");
        char spec[128] = {0};
        if (f) {
            if (fgets(spec, sizeof(spec), f) == nullptr) spec[0] = 0;
            fclose(f);
        }
        if (spec[0] == 0) {
            if (g_probe_on.exchange(0)) {
                fprintf(stderr, "[LOADPROBE] off after %llu message(s)\n", (unsigned long long)sent);
                fflush(stderr);
            }
            last_spec.clear();
            sent = 0;
            seq = 0;
            g_probe_sent.store(0);
            g_probe_bytes.store(0);
            g_probe_done.store(0);
            std::this_thread::sleep_for(std::chrono::milliseconds(200));
            continue;
        }
        if (last_spec != spec) {
            int r = 0, sz = 0; unsigned long long n = 0;
            if (sscanf(spec, "%d %d %llu", &r, &sz, &n) >= 2 && r > 0 && sz >= 8 && sz <= 262144) {
                last_spec = spec;
                rate = r; size = sz; target = n;
                sent = 0; seq = 0;
                g_probe_sent.store(0);
                g_probe_bytes.store(0);
                g_probe_done.store(0);
                g_probe_rate.store(rate);
                g_probe_size.store(size);
                g_probe_target.store(target);
                g_probe_on.store(1);
                fprintf(stderr, "[LOADPROBE] %d msg/s of %d B, target %llu\n", rate, size,
                        (unsigned long long)target);
                fflush(stderr);
            } else {
                last_spec = spec;   // do not re-report a malformed file every 200ms
                g_probe_on.store(0);
                continue;
            }
        }
        if (!g_probe_on.load()) {
            std::this_thread::sleep_for(std::chrono::milliseconds(200));
            continue;
        }
        if (target && sent >= target) {
            g_probe_on.store(0);
            g_probe_done.store(1);
            fprintf(stderr, "[LOADPROBE] done, %llu message(s) of %d B\n",
                    (unsigned long long)sent, size);
            fflush(stderr);
            continue;
        }

        // Paced in 10 ms slices: a tight loop would measure how fast send() can
        // be called, which is not the question, and a one-message-per-sleep
        // timer cannot reach the rates a burst needs.
        int per_slice = rate / 100;
        if (per_slice < 1) per_slice = 1;
        std::vector<uint8_t> packet((size_t)size, 0);
        packet[0] = 'D';
        packet[1] = 'P';
        for (int i = 0; i < per_slice && (!target || sent < target); i++) {
            uint32_t n = ++seq;
            memcpy(packet.data() + 2, &n, 4);
            uint32_t sz = (uint32_t)size;
            memcpy(packet.data() + 6, &sz, 4);
            std::lock_guard<std::mutex> lock(g_rtc_lock);
            for (auto& dc : g_active_dcs) {
                if (!dc || !dc->isOpen()) continue;
                try {
                    dc_send_counted(dc, packet.data(), packet.size());
                } catch (...) {
                    // Counted by dc_send_counted; keep the sweep running.
                }
            }
            sent++;
        }
        g_probe_sent.store(sent);
        g_probe_bytes.store(sent * (uint64_t)size);
        std::this_thread::sleep_for(std::chrono::milliseconds(10));
    }
}

static std::thread g_probe_thread;
static std::atomic<bool> g_probe_started{false};
static void load_probe_start() {
    if (g_probe_started.exchange(true)) return;
    try {
        g_probe_thread = std::thread(load_probe_loop);
    } catch (const std::exception& ex) {
        g_probe_started.store(false);
        fprintf(stderr, "[LOADPROBE] worker failed to start: %s\n", ex.what());
        fflush(stderr);
    }
}

// DataChannel messages are refused outright above the peer's advertised
// a=max-message-size (Chrome: 262144). A 1280x720 RGBA surface is ~3.6 MB, so
// anything larger than this is split across several messages and reassembled
// by the client. The budget leaves generous headroom under the advertised cap.
#define TEXTURE_CHUNK_BYTES (128u * 1024u)

// Lossless pictures - opt-in, DF_PIC_LOSSLESS=1 or the file /tmp/df_pic_lossless.
// Pictures have always gone out as plain RGBA, which is lossless but several
// times larger than it needs to be: the tiles the game draws are mostly flat and
// compress hard. Compressing is free in quality terms - zstd gives back exactly
// the bytes that went in - so the only question it raises is how much of the
// traffic it removes, which is what the bench is for.
#define PIC_LOSSLESS_TRIGGER_FILE "/tmp/df_pic_lossless"
// Below this the header and the extra pass cost more than the saving.
#define PIC_LOSSLESS_MIN_BYTES 1024u

static bool g_pic_lossless_env = false;

static bool texture_lossless_on() {
    static std::atomic<int64_t> last_check_ms{0};
    static std::atomic<bool> cached{false};
    static std::atomic<bool> ever_checked{false};
    int64_t now = std::chrono::duration_cast<std::chrono::milliseconds>(
        std::chrono::steady_clock::now().time_since_epoch()).count();
    if (!ever_checked.load() || now - last_check_ms.load() >= 1000) {
        last_check_ms.store(now);
        cached.store(g_pic_lossless_env || (access(PIC_LOSSLESS_TRIGGER_FILE, F_OK) == 0));
        ever_checked.store(true);
    }
    return cached.load();
}

// The bytes this picture will put on the wire. Compresses at most once per
// picture and keeps the result, because a picture is re-sent on every reconnect
// and on every request and re-compressing it each time would burn the game's
// frame time for no reason.
static const std::vector<uint8_t>& texture_wire_bytes(const CachedTexture& ct, bool& is_compressed) {
    is_compressed = false;
    if (!texture_lossless_on() || ct.rgba.size() < PIC_LOSSLESS_MIN_BYTES) return ct.rgba;

    if (!ct.compress_tried) {
        ct.compress_tried = true;
        size_t bound = ZSTD_compressBound(ct.rgba.size());
        ct.compressed.resize(bound);
        size_t got = ZSTD_compress(ct.compressed.data(), bound, ct.rgba.data(), ct.rgba.size(), 1);
        // A picture that did not get smaller is sent as it is: the tag would
        // cost a byte and buy nothing.
        if (ZSTD_isError(got) || got >= ct.rgba.size()) ct.compressed.clear();
        else ct.compressed.resize(got);
    }

    if (ct.compressed.empty()) return ct.rgba;
    is_compressed = true;
    return ct.compressed;
}


// How many bytes of picture the send queue may hold before pictures start
// waiting. Frames are exempt: a delta frame is ~114 B and a full frame ~4 KB,
// so they fit in the noise beside this budget, whereas one 1920x1080 picture is
// 8,294,400 B and can bury the queue on its own.
//
// This replaces the old arrangement, where pictures were sent unconditionally
// and the FRAME path refused to send whenever the queue passed 131,072 B. That
// threshold was smaller than a single chunk (131,088 B), so one picture was
// enough to stop frames going out; measured on the host it dropped 1,224 frames
// in a session with the queue reaching 16.3 MB. Dropping a frame is not a
// saving, it is the freeze the client reports, because the frame is what the
// user is looking at and the picture is not.
// How much may sit in the transport's send queue before pictures stop being
// added to it.
//
// This was 512 KB, which is BELOW this transport's own steady state: measured
// with a client attached, bufferedAmount settles around 609 KB and the queue
// therefore never had room, so the drain sent nothing at all rather than
// throttling. The effect was that a joining client's pictures trickled through
// whenever the buffer happened to dip, and the screen stayed black for 10-15s
// while ~10 MB of pictures arrived. Measured on the same run: 512 KB, lit at
// 15s; 128 MB, lit at 5s, with the peak buffer down from 33 MB to 3.9 MB.
//
// A throttle set below the operating point is not a throttle, it is a stop, so
// this sits well above the steady state while still bounding the queue to about
// a second of link time.
#define TEXTURE_QUEUE_BUDGET (4u * 1024u * 1024u)

// Overridable at runtime so the picture backlog can be turned off in an
// experiment. With the budget at 0 no picture is ever sent, which isolates how
// much of the interactive lag comes from frames queueing behind bulk picture
// traffic on the one shared link rather than from the frame path itself.
//
// DF_TEX_BUDGET in the environment wins; otherwise a file is consulted, which is
// how the raw-pixel toggle already works and needs no restart to flip.
static size_t texture_queue_budget() {
    static size_t env_budget = [] {
        const char* pl = getenv("DF_PIC_LOSSLESS");
        g_pic_lossless_env = (pl && pl[0] == '1');
        const char* s = getenv("DF_TEX_BUDGET");
        if (!s) return (size_t)SIZE_MAX;
        long v = atol(s);
        return v < 0 ? (size_t)SIZE_MAX : (size_t)v;
    }();
    if (env_budget != (size_t)SIZE_MAX) return env_budget;

    static size_t cached = (size_t)TEXTURE_QUEUE_BUDGET;
    static uint64_t next_check_ms = 0;
    struct timespec ts;
    clock_gettime(CLOCK_MONOTONIC, &ts);
    uint64_t now = (uint64_t)ts.tv_sec * 1000u + (uint64_t)(ts.tv_nsec / 1000000);
    if (now >= next_check_ms) {
        next_check_ms = now + 1000;
        FILE* f = fopen("/tmp/df_tex_budget", "r");
        if (f) {
            long v = 0;
            if (fscanf(f, "%ld", &v) == 1 && v >= 0) cached = (size_t)v;
            fclose(f);
        } else {
            cached = (size_t)TEXTURE_QUEUE_BUDGET;
        }
    }
    return cached;
}

// Pictures that could not be sent yet, oldest first, each remembering the first
// chunk it still owes so an interrupted picture resumes instead of restarting.
static TextureQueue g_texture_queue(texture_queue_budget());
// The queue is touched from two threads: pictures are queued from the RTC
// thread (an explicit request) and drained from the render thread (a present or
// a draw call), so it needs its own lock.
static std::mutex g_tex_queue_lock;
// Cheap read-only mirror of the queue depth, so the hot draw path can skip the
// lock entirely when there is nothing waiting. Being a hint, a stale value only
// delays a drain by one draw call.
static std::atomic<uint32_t> g_tex_queue_hint{0};
static uint64_t g_tex_deferred = 0;   // times a speculative picture waited
static uint64_t g_tex_requested = 0;  // times a requested picture jumped ahead
static uint64_t g_tex_resumed = 0;    // pictures taken back off the queue
static int64_t g_queue_at_tex_max = 0;
// No ceiling is needed on the waiting list: defer() keys by picture id and the
// id space is capped at MAX_TEXTURES, so the list cannot grow past that.

static void queue_texture(uint16_t id, uint32_t next_chunk, bool urgent) {
    std::lock_guard<std::mutex> lock(g_tex_queue_lock);
    if (urgent) {
        g_texture_queue.defer_front(id, next_chunk);
        g_tex_requested++;
    } else {
        g_texture_queue.defer(id, next_chunk);
        g_tex_deferred++;
    }
    g_tex_queue_hint.store((uint32_t)g_texture_queue.size(), std::memory_order_relaxed);
}

// Queues a picture the CLIENT asked for, starting again from its first chunk.
//
// Deliberately not queue_texture(id, 0, true): that keeps the transfer's own
// position, which is a record of what was SENT, and the pictures travel on an
// unreliable channel where a chunk can be sent and never arrive. Resuming over
// the lost chunk leaves the picture permanently one chunk short, and the client
// refuses to draw any frame that names an incomplete picture - so one dropped
// chunk is a black screen. Restarting is safe because the client ignores chunks
// it already holds.
static void queue_texture_at(uint16_t id, uint32_t chunk) {
    std::lock_guard<std::mutex> lock(g_tex_queue_lock);
    g_texture_queue.defer_front_at(id, chunk);
    g_tex_requested++;
    g_tex_queue_hint.store((uint32_t)g_texture_queue.size(), std::memory_order_relaxed);
}

static bool take_queued_texture(uint16_t& id, uint32_t& next_chunk, bool& urgent) {
    std::lock_guard<std::mutex> lock(g_tex_queue_lock);
    bool got = g_texture_queue.take(id, next_chunk, urgent);
    g_tex_queue_hint.store((uint32_t)g_texture_queue.size(), std::memory_order_relaxed);
    return got;
}

// Sends one chunk. chunk_index/chunk_count are carried in the header; the
// client uses chunk_count == 1 for the ordinary single-message case so small
// textures keep costing exactly what they cost before.
static void send_texture_chunk_dc(std::shared_ptr<rtc::DataChannel> dc, const CachedTexture& ct,
                                  uint32_t chunk_index, uint32_t chunk_count) {
    if (!dc || !dc->isOpen() || ct.rgba.empty()) return;
    bool compressed = false;
    const std::vector<uint8_t>& bytes = texture_wire_bytes(ct, compressed);
    const size_t total = bytes.size();
    const size_t offset = (size_t)chunk_index * TEXTURE_CHUNK_BYTES;
    if (offset >= total) return;
    size_t len = std::min((size_t)TEXTURE_CHUNK_BYTES, total - offset);

    TextureHeader hdr;
    hdr.magic[0] = 'D';
    hdr.magic[1] = compressed ? 'Z' : 'T';
    hdr.tex_id = ct.id;
    hdr.w = ct.w;
    hdr.h = ct.h;
    hdr.payload_len = (uint32_t)total;
    hdr.chunk_index = (uint16_t)chunk_index;
    hdr.chunk_count = (uint16_t)chunk_count;

    std::vector<uint8_t> packet(sizeof(hdr) + len);
    memcpy(packet.data(), &hdr, sizeof(hdr));
    memcpy(packet.data() + sizeof(hdr), bytes.data() + offset, len);

    g_tex_count++;
    g_tex_bytes += packet.size();
    // Pictures count toward the wire total too: the comparison against whole
    // frames is only honest if both sides count everything they send.
    g_wire_bytes += packet.size();
    // Classify once per picture, on its first chunk, so a chunked picture is
    // counted as one send rather than one per chunk.
    if (chunk_index == 0) {
        if (ct.sent_once) g_tex_repeat++;
        else { g_tex_new++; ct.sent_once = true; }
    }
    // Recorded at the send, with the queue as it was before it: a picture chunk
    // is a message like any other and leaving it out of the log is what made the
    // first version of this instrumentation unable to see 99% of the traffic.
    g_wire_log.note(epoch_now_ms(), wire_log::Artwork, (uint32_t)packet.size(),
                    dc ? (int64_t)dc->bufferedAmount() : -1, 0, 0);
    try {
        const auto send_t0 = std::chrono::steady_clock::now();
        dc_send_counted(dc, packet.data(), packet.size());
        const int64_t us = std::chrono::duration_cast<std::chrono::microseconds>(
            std::chrono::steady_clock::now() - send_t0).count();
        int64_t prev = g_send_block_max_us.load(std::memory_order_relaxed);
        while (us > prev && !g_send_block_max_us.compare_exchange_weak(prev, us)) {}
    } catch (const std::exception& e) {
        // Oversized is the failure this chunking exists to prevent; if it still
        // fires, say so loudly rather than losing the asset silently.
        fprintf(stderr, "[TEXTURE_DC_ERROR] %s (tex %u chunk %u/%u, %zu bytes)\n",
                e.what(), ct.id, chunk_index, chunk_count, len);
        fflush(stderr);
    }

}

static uint32_t texture_chunk_count(const CachedTexture& ct) {
    bool compressed = false;
    const std::vector<uint8_t>& bytes = texture_wire_bytes(ct, compressed);
    return (uint32_t)((bytes.size() + TEXTURE_CHUNK_BYTES - 1) / TEXTURE_CHUNK_BYTES);
}

// Sends every chunk of a texture, stopping the moment the queue holds enough
// picture bytes that a frame would have to queue behind them. Whatever is left
// is remembered, so the next drain carries on from the same chunk rather than
// starting the picture again.
//
// `urgent` marks a picture the client explicitly asked for. That one is blocking
// a frame it already has commands for, so it goes to the front of the queue.
//
// Returns true only if every chunk went out now. A false return means the
// picture was queued instead, which the caller must not report as sent: doing so
// made a request for 193 pictures that had barely started look fully satisfied.
static bool send_texture_all_chunks_dc(std::shared_ptr<rtc::DataChannel> dc, const CachedTexture& ct,
                                       bool urgent = false) {
    if (!dc || !dc->isOpen() || ct.rgba.empty()) return false;
    g_texture_queue.set_budget(texture_queue_budget());
    uint32_t n = texture_chunk_count(ct);
    for (uint32_t i = 0; i < n; i++) {
        int64_t q = (int64_t)dc->bufferedAmount();
        if (q > g_queue_at_tex_max) g_queue_at_tex_max = q;
        if (!g_texture_queue.has_room(q)) {
            queue_texture(ct.id, i, urgent);
            return false;
        }
        send_texture_chunk_dc(dc, ct, i, n);
    }
    return true;
}

// Hands waiting pictures to the link while there is room for them.
static void drain_pending_textures() {
    if (g_tex_queue_hint.load(std::memory_order_relaxed) == 0) return;
    g_texture_queue.set_budget(texture_queue_budget());

    std::lock_guard<std::mutex> rlock(g_rtc_lock);

    // One destination list, never both: a chunk sent down the asset channel and
    // again down the stream channel arrives twice, and while the client would
    // discard the copy, the second send is what fills the unreliable channel and
    // gets dropped - the very behaviour this split exists to avoid.
    std::vector<std::shared_ptr<rtc::DataChannel>> targets;
    {
        std::lock_guard<std::mutex> alk(g_asset_dc_lock);
        if (g_asset_dc && g_asset_dc->isOpen()) targets.push_back(g_asset_dc);
    }
    if (targets.empty()) {
        for (auto& dc : g_active_dcs) if (dc && dc->isOpen()) targets.push_back(dc);
    }

    for (auto& dc : targets) {
        if (!dc || !dc->isOpen()) continue;
        for (;;) {
            int64_t q = (int64_t)dc->bufferedAmount();
            if (q > g_queue_at_tex_max) g_queue_at_tex_max = q;
            if (!g_texture_queue.has_room(q)) break;

            uint16_t id = 0;
            uint32_t next = 0;
            bool urgent = false;
            if (!take_queued_texture(id, next, urgent)) break;
            if (id == 0 || id > g_texture_count) continue;

            std::lock_guard<std::mutex> tlock(g_tex_lock);
            CachedTexture& ct = g_cached_textures[id - 1];
            if (ct.rgba.empty()) continue;  // destroyed since it was queued

            uint32_t n = texture_chunk_count(ct);
            g_tex_resumed++;
            for (uint32_t i = next; i < n; i++) {
                int64_t q2 = (int64_t)dc->bufferedAmount();
                if (!g_texture_queue.has_room(q2)) {
                    // Put back with the same urgency: a picture bigger than the
                    // budget is sent over several drains, and dropping to
                    // speculative half way would send it to the back of the
                    // queue and lose the client's request behind it.
                    queue_texture(id, i, urgent);
                    break;
                }
                send_texture_chunk_dc(dc, ct, i, n);
            }
        }
    }
}

// Called from the draw path, which runs thousands of times per frame, so the
// queue is refilled as soon as the link has room instead of once per present.
// Without this, throughput was capped at one budget per present: on a fast link
// the queue empties in milliseconds and then sits idle for the rest of the
// frame, which is what let a fresh client's requested pictures take longer to
// arrive than its three-attempt patience allowed.
static void maybe_drain_textures() {
    if (g_tex_queue_hint.load(std::memory_order_relaxed) == 0) return;
    drain_pending_textures();
}

// Keeps pushing queued pictures until there are none left, on its own thread.
//
// Wanted when the game is not drawing, because both of the drains that normally
// keep the queue moving - the one in the draw path and the one in the present -
// are driven by the game drawing. A client that asks for a picture while the
// game sits still would otherwise have its request queued and never sent.
//
// One worker at a time, and it exits on its own once the queue is empty, so the
// cost is a thread that lives exactly as long as there is something to send.
static void start_texture_drain_worker() {
    static std::atomic<bool> running{false};
    if (g_tex_queue_hint.load(std::memory_order_relaxed) == 0) return;
    if (running.exchange(true)) return;   // one already pushing
    std::thread([] {
        // Bounded so a client that has stopped reading cannot keep this thread
        // alive forever; it is re-armed by the next request if that happens.
        for (int round = 0; round < 20000; round++) {
            if (g_tex_queue_hint.load(std::memory_order_relaxed) == 0) break;
            drain_pending_textures();
            if (g_tex_queue_hint.load(std::memory_order_relaxed) == 0) break;
            // Waiting on our own socket for room, not polling the game.
            std::this_thread::sleep_for(std::chrono::milliseconds(1));
        }
        running.store(false);
    }).detach();
}

// Resends the textures the client says it is missing.
// The client names the ids directly. An earlier version instead asked "resend
// what frame N needs" and resolved that against this side's copy of frame N.
// The client's accumulated command buffer and that single frame disagree, so
// the diff came out empty and the client was told it already held everything -
// leaving the lost texture permanently incomplete and the frame held forever.
// Naming the missing ids removes the need to agree about frames at all.
static void resend_missing_textures(uint32_t seq, const std::vector<uint16_t>& requested,
                                   const std::vector<uint32_t>& requested_chunks) {
    if (requested.empty()) return;

    // Kept as pairs rather than two parallel arrays: `wanted` collapses repeated
    // ids, so the hint that belonged to the third entry is no longer at index
    // three, and a misaligned hint sends a chunk the client was not waiting for
    // while the one it was waiting for is never sent.
    std::vector<std::pair<uint16_t, uint32_t>> wanted;
    for (size_t i = 0; i < requested.size(); i++) {
        uint16_t id = requested[i];
        if (id == 0) continue;
        bool seen = false;
        for (auto& w : wanted) if (w.first == id) { seen = true; break; }
        if (seen) continue;
        uint32_t chunk = i < requested_chunks.size() ? requested_chunks[i] : 0;
        wanted.emplace_back(id, chunk);
    }

    size_t queued = 0;
    size_t unknown = 0;
    {
        std::lock_guard<std::mutex> rlock(g_rtc_lock);
        for (auto& dc : g_active_dcs) {
            if (!dc || !dc->isOpen()) continue;
            std::lock_guard<std::mutex> tlock(g_tex_lock);
            for (auto& w : wanted) {
                const uint16_t id = w.first;
                const uint32_t hint = w.second;
                if (id > g_texture_count) { unknown++; continue; }
                CachedTexture& ct = g_cached_textures[id - 1];
                if (ct.rgba.empty()) { unknown++; continue; }
                // Urgent: this picture is why a frame the client already holds
                // commands for cannot be drawn. Queueing rather than sending
                // here is deliberate: an eager send always starts at chunk 0,
                // so a repeated request re-sent the opening chunks and spent the
                // whole budget on bytes the client already had, leaving the
                // transfer to advance only through the drain. A picture the
                // client re-asks for every 1.5s could then be starved of
                // progress until it was given up on, which is how the
                // title-screen backdrop stayed missing while the rest of the
                // frame was pixel-perfect.
                // With a chunk hint, send exactly that chunk: a picture is up to
                // 37 chunks and re-sending all of them to repair one floods the
                // transport, which then drops the last chunk queued - the one
                // being repaired. Without a hint, start from the beginning
                // rather than resuming past the gap.
                queue_texture_at(id, hint);
                queued++;
            }
        }
    }

    fprintf(stderr, "[ASSET_BRIDGE] Frame %u asked for %zu asset(s); %zu queued for delivery, %zu not held here\n",
            seq, wanted.size(), queued, unknown);
    fflush(stderr);

    // Push what was just queued, here and now, and keep pushing until it is all
    // gone - but off this thread.
    //
    // The drain otherwise only runs from the draw path and from the present, so
    // a picture asked for while the game is sitting still was queued and then
    // left sitting in the queue: the client waited for it, the client will not
    // draw a frame until every picture it names has arrived, and the game was
    // not drawing, so nothing ever pushed it. The request itself is a reason to
    // send, exactly as a client connecting is - neither needs a draw first.
    //
    // Not done inline. This runs on the thread that serves the data channel, and
    // a client joining a long-running session can be missing hundreds of
    // pictures, which at link speed is seconds of pushing. Blocking here for
    // those seconds stops the same thread answering anything else - signalling
    // and stats included - and the session then looks dead to the server rather
    // than busy. So the pushing happens on its own thread and this returns.
    start_texture_drain_worker();

    // Re-send the picture now the pictures it names have gone out.
    //
    // The client decides whether it can draw a frame at the moment the frame
    // lands, not when the last picture it was waiting for turns up. On a moving
    // screen that is invisible: the next frame arrives almost immediately and
    // re-decides. On a still screen there is no next frame, so the client sat
    // holding a complete frame and a complete set of pictures, having already
    // concluded it could not draw them. Sending the frame again is what makes it
    // look.
    //
    // Not conditional on the whole queue being empty: it rarely is, because the
    // pictures for much later frames are queued behind this request, and waiting
    // for those would be waiting for the whole stream to catch up.
    //
    // It also cannot loop: the client asks only for pictures it is missing, and
    // each round of this resolves the ones it named. That convergence is the
    // 6,5,4,3,2,1 the request log shows, not a retry storm.
    if (queued > 0) {
        std::lock_guard<std::mutex> send_lock(g_send_lock);
        if (g_last_picture_valid && !g_last_picture.empty()) {
            service_picture_send(g_last_picture.data(), (uint16_t)g_last_picture.size(),
                                 /*force_keyframe=*/true, 0);
        }
    }
}

static std::string extract_json_str(const std::string& json, const std::string& key) {
    std::string needle = "\"" + key + "\":\"";
    size_t pos = json.find(needle);
    if (pos == std::string::npos) {
        needle = "\"" + key + "\" : \"";
        pos = json.find(needle);
    }
    if (pos == std::string::npos) return "";
    pos += needle.length();
    std::string res;
    bool escape = false;
    for (size_t i = pos; i < json.length(); i++) {
        char c = json[i];
        if (escape) {
            if (c == 'n') res += '\n';
            else if (c == 'r') res += '\r';
            else if (c == 't') res += '\t';
            else if (c == '"') res += '"';
            else if (c == '\\') res += '\\';
            else res += c;
            escape = false;
        } else if (c == '\\') {
            escape = true;
        } else if (c == '"') {
            break;
        } else {
            res += c;
        }
    }
    return res;
}

static std::string escape_json_str(const std::string& s) {
    std::string res;
    res.reserve(s.size() + 32);
    for (char c : s) {
        if (c == '"') res += "\\\"";
        else if (c == '\\') res += "\\\\";
        else if (c == '\r') res += "\\r";
        else if (c == '\n') res += "\\n";
        else if (c == '\t') res += "\\t";
        else res += c;
    }
    return res;
}

void handle_client_text_message(int fd, const std::string& msg) {
    fprintf(stderr, "[WS_TEXT] fd=%d len=%zu msg=%.80s\n", fd, msg.size(), msg.c_str());
    fflush(stderr);

    if (msg.find("\"type\":\"webrtc_offer\"") != std::string::npos ||
        msg.find("\"type\": \"webrtc_offer\"") != std::string::npos) {
        std::string sdp = extract_json_str(msg, "sdp");
        if (sdp.empty()) {
            fprintf(stderr, "[WebRTC] Error: Empty SDP offer from fd=%d\n", fd);
            fflush(stderr);
            return;
        }

        fprintf(stderr, "[WebRTC] Received offer from fd=%d, sdp len=%zu\n", fd, sdp.size());
        fflush(stderr);

        static bool rtc_inited = false;
        if (!rtc_inited) {
            rtc::InitLogger(rtc::LogLevel::Warning);
            rtc_inited = true;
        }

        try {
            {
                std::lock_guard<std::mutex> lock(g_rtc_lock);
                auto it = g_rtc_sessions.find(fd);
                if (it != g_rtc_sessions.end()) {
                    if (it->second.pc) it->second.pc->close();
                    g_rtc_sessions.erase(it);
                }
            }

            rtc::Configuration config;
            config.portRangeBegin = 8484;
            config.portRangeEnd = 8520;

            const char* env_stun = getenv("STUN_SERVER");
            if (env_stun && strlen(env_stun) > 0) {
                config.iceServers.emplace_back(env_stun);
            } else {
                config.iceServers.emplace_back("stun:stun.l.google.com:19302");
                config.iceServers.emplace_back("stun:stun1.l.google.com:19302");
            }

            auto pc = std::make_shared<rtc::PeerConnection>(config);

            pc->onStateChange([fd](rtc::PeerConnection::State state) {
                fprintf(stderr, "[WebRTC] PeerConnection state fd=%d: %d\n", fd, (int)state);
                fflush(stderr);
            });

            pc->onGatheringStateChange([fd](rtc::PeerConnection::GatheringState state) {
                fprintf(stderr, "[WebRTC] Gathering state fd=%d: %d\n", fd, (int)state);
                fflush(stderr);
            });

            pc->onLocalDescription([fd](rtc::Description desc) {
                std::string sdp_str = std::string(desc);
                fprintf(stderr, "[WebRTC] onLocalDescription fd=%d sdp_len=%zu\n", fd, sdp_str.size());
                fflush(stderr);
                std::string json = "{\"type\":\"webrtc_answer\",\"sdp\":\"" + escape_json_str(sdp_str) + "\"}";
                if (g_server) g_server->send_ws_text(fd, json);
            });

            pc->onLocalCandidate([fd](rtc::Candidate cand) {
                std::string c_str = std::string(cand);
                fprintf(stderr, "[WebRTC] onLocalCandidate fd=%d: %s mid=%s\n", fd, c_str.c_str(), cand.mid().c_str());
                fflush(stderr);
                std::string json = "{\"type\":\"webrtc_ice\",\"candidate\":\"" + escape_json_str(c_str) + "\",\"mid\":\"" + escape_json_str(cand.mid()) + "\"}";
                if (g_server) g_server->send_ws_text(fd, json);
            });

            pc->onDataChannel([fd](std::shared_ptr<rtc::DataChannel> dc) {
                std::string label = dc->label();
                fprintf(stderr, "[WebRTC] onDataChannel callback triggered for label='%s' fd=%d\n", label.c_str(), fd);
                fflush(stderr);

                dc->onOpen([fd, dc, label]() {
                    fprintf(stderr, "[WebRTC] DataChannel '%s' OPEN for fd=%d\n", label.c_str(), fd);
                    fflush(stderr);

                    if (label == "df-assets") {
                        std::lock_guard<std::mutex> lk(g_asset_dc_lock);
                        g_asset_dc = dc;
                        fprintf(stderr, "[WebRTC] df-assets channel registered for pictures\n");
                        fflush(stderr);
                        return;
                    }

                    if (label == "df-stream") {
                        note_channel_reliability(dc);
                        {
                            rtc::Reliability r = dc->reliability();
                            fprintf(stderr, "[WebRTC] df-stream reliability: unordered=%d "
                                            "maxRetransmits=%d maxPacketLifeTime=%d\n",
                                    r.unordered ? 1 : 0,
                                    r.maxRetransmits ? (int)*r.maxRetransmits : -1,
                                    r.maxPacketLifeTime ? (int)r.maxPacketLifeTime->count() : -1);
                            fflush(stderr);
                        }
                        g_need_keyframe.store(true);
                        {
                            std::lock_guard<std::mutex> lock(g_rtc_lock);
                            g_active_dcs.push_back(dc);
                            std::lock_guard<std::mutex> tlock(g_tex_lock);
                            client_cache_reset();
                        }
                        // Send all cached textures directly over df-stream DataChannel!
                        {
                            std::lock_guard<std::mutex> lock(g_tex_lock);
                            for (uint16_t i = 0; i < g_texture_count; i++) {
                                if (!g_cached_textures[i].rgba.empty()) {
                                    g_tex_dump_count++;
                                    g_tex_dump_bytes += g_cached_textures[i].rgba.size();
                                    send_texture_all_chunks_dc(dc, g_cached_textures[i]);
                                }
                            }
                            fprintf(stderr, "[TEXDUMP] client fd=%d: pushed %llu cached pictures (%llu KB)\n",
                                    fd, (unsigned long long)g_tex_dump_count,
                                    (unsigned long long)(g_tex_dump_bytes / 1024));
                            fflush(stderr);
                        }
                        // A client that connects while the game is sitting still
                        // gets nothing from the draw path, because the draw path
                        // is not running: the send used to be reachable only from
                        // SDL_RenderPresent, so a still screen produced no frame
                        // and the newcomer watched a black canvas until the user
                        // happened to press something. Send the picture that is
                        // already on screen, now, instead of waiting for a draw
                        // that may never come.
                        //
                        // This runs AFTER the texture dump on purpose. A frame is
                        // a list of references to pictures, so sending it first
                        // hands the client a picture it cannot draw yet - it was
                        // sent, it arrived, and the canvas stayed black anyway.
                        // Pictures go out first, then the frame that names them.
                        //
                        // Also after g_active_dcs is updated, so this client is
                        // among the receivers, and outside g_rtc_lock because
                        // service_picture_send acquires that lock itself.
                        {
                            std::lock_guard<std::mutex> send_lock(g_send_lock);
                            if (g_last_picture_valid && !g_last_picture.empty()) {
                                service_picture_send(g_last_picture.data(),
                                                     (uint16_t)g_last_picture.size(),
                                                     /*force_keyframe=*/true, 0);
                            }
                        }
                    }
                });

                dc->onClosed([fd, dc, label]() {
                    fprintf(stderr, "[WebRTC] DataChannel '%s' CLOSED for fd=%d\n", label.c_str(), fd);
                    fflush(stderr);
                    if (label == "df-assets") {
                        // Forget the picture channel when it closes. Holding a
                        // reference to a closed channel is not harmless: the
                        // drain asks it whether it is open, gets a stale yes for
                        // a moment, and keeps feeding pictures to a browser that
                        // has already gone. The client on the other end of the
                        // new connection then waits for pictures that are being
                        // posted to its predecessor, re-asks forever, and the
                        // tab sits on "connecting" with the server convinced it
                        // is streaming.
                        std::lock_guard<std::mutex> alk(g_asset_dc_lock);
                        if (g_asset_dc == dc) g_asset_dc.reset();
                        return;
                    }
                    if (label == "df-stream") {
                        std::lock_guard<std::mutex> lock(g_rtc_lock);
                        g_active_dcs.erase(std::remove(g_active_dcs.begin(), g_active_dcs.end(), dc), g_active_dcs.end());
                    }
                });

                dc->onMessage([](auto data) {
                    if (std::holds_alternative<rtc::binary>(data)) {
                        auto& b = std::get<rtc::binary>(data);
                        g_input_msgs.fetch_add(1, std::memory_order_relaxed);
                        handle_client_input_event((const uint8_t*)b.data(), b.size());
                    }
                });

                std::lock_guard<std::mutex> lock(g_rtc_lock);
                if (label == "df-stream") {
                    g_rtc_sessions[fd].dc = dc;
                }
            });

            pc->setRemoteDescription(rtc::Description(sdp, "offer"));

            std::lock_guard<std::mutex> lock(g_rtc_lock);
            g_rtc_sessions[fd].pc = pc;
        } catch (const std::exception& ex) {
            fprintf(stderr, "[WebRTC] Exception during session setup for fd=%d: %s\n", fd, ex.what());
            fflush(stderr);
        }
    } else if (msg.find("\"type\":\"webrtc_ice\"") != std::string::npos ||
               msg.find("\"type\": \"webrtc_ice\"") != std::string::npos) {
        std::string cand = extract_json_str(msg, "candidate");
        std::string mid = extract_json_str(msg, "mid");
        fprintf(stderr, "[WebRTC] Received remote candidate from fd=%d: mid=%s cand=%.50s\n", fd, mid.c_str(), cand.c_str());
        fflush(stderr);
        if (!cand.empty()) {
            try {
                std::lock_guard<std::mutex> lock(g_rtc_lock);
                auto it = g_rtc_sessions.find(fd);
                if (it != g_rtc_sessions.end() && it->second.pc) {
                    it->second.pc->addRemoteCandidate(rtc::Candidate(cand, mid));
                }
            } catch (const std::exception& ex) {
                fprintf(stderr, "[WebRTC] Exception adding candidate for fd=%d: %s\n", fd, ex.what());
                fflush(stderr);
            }
        }
    }
}

void handle_client_disconnected(int fd) {
    std::lock_guard<std::mutex> lock(g_rtc_lock);
    auto it = g_rtc_sessions.find(fd);
    if (it != g_rtc_sessions.end()) {
        if (it->second.dc) {
            g_active_dcs.erase(std::remove(g_active_dcs.begin(), g_active_dcs.end(), it->second.dc), g_active_dcs.end());
        }
        if (it->second.pc) {
            it->second.pc->close();
        }
        g_rtc_sessions.erase(it);
    }
}

// ---------------------------------------------------------------------------
// Framebuffer readback
// ---------------------------------------------------------------------------

// SDL_PIXELFORMAT_ABGR8888, which on a little-endian machine is the byte order
// R,G,B,A. Spelled out as a name because the two readback callers below have to
// agree on it: the QA snapshot compares against the client's canvas and the raw
// mode encodes it as JPEG, and a silent disagreement about channel order would
// look like a rendering bug in the game.
#define RAW_SDL_PIXELFORMAT_ABGR8888 376840196u

// Read the framebuffer the way the QA snapshot does, into memory this time.
//
// The size is asked of the renderer rather than taken from the tracked window
// size: the game resizes its window, and reading with a pitch that does not match
// the target makes SDL refuse the call, which is why snapshotting once produced
// no file at all and left the parity suite with no ground truth. Sharing one copy
// of that rule means the snapshot and the raw stream cannot drift apart on either
// the size or the pixel format.
static bool read_framebuffer_rgba(void* renderer, std::vector<uint8_t>& buf, int* out_w, int* out_h) {
    if (!real_SDL_RenderReadPixels) return false;
    int ow = g_current_w, oh = g_current_h;
    if (real_SDL_GetRendererOutputSize) real_SDL_GetRendererOutputSize(renderer, &ow, &oh);
    if (ow <= 0 || oh <= 0) return false;

    buf.resize((size_t)ow * (size_t)oh * 4);
    if (real_SDL_RenderReadPixels(renderer, nullptr, RAW_SDL_PIXELFORMAT_ABGR8888,
                                  buf.data(), ow * 4) != 0) {
        return false;
    }
    *out_w = ow;
    *out_h = oh;
    return true;
}

// ---------------------------------------------------------------------------
// Raw pixel mode - opt-in, DF_RAW_STREAM=1 or the file /tmp/df_raw_on.
//
// A sanity-check baseline, not a replacement for the command stream: whole frames
// as JPEG, so the screen the client ends up showing can be compared against a path
// that cannot be subtle about what the frame contained. It is off unless it is
// asked for, and when it is off the render thread pays a couple of atomic loads
// and one rate-limited stat per second - no readback, no encoding, no thread, no
// socket. (A clock read comes with the rate limit; that is a handful of
// nanoseconds and is the price of not doing a stat on every frame.)
//
// Transport is a single TCP connection with the interposer as the client, to
// 127.0.0.1:8491 unless DF_RAW_TARGET says host:port:
//   interposer -> server : u32 length, then that many bytes of one JPEG
//   server -> interposer : u32 length, then that many bytes of input, in exactly
//                          the encoding the WebRTC data channel already delivers
// Every integer is big-endian.
// ---------------------------------------------------------------------------

#define RAW_DEFAULT_TARGET "127.0.0.1:8491"
// The runtime switch. Not a nicer DF_RAW_STREAM: changing an environment variable
// means recreating the container, which means restarting the game, and the point of
// this mode is to compare the two paths on the same session. Touching a file is
// something the human can do from outside while the game is running.
#define RAW_TRIGGER_FILE "/tmp/df_raw_on"
#define RAW_TOGGLE_CHECK_MS 1000
#define RAW_JPEG_QUALITY 80
// Lossless picture mode - opt-in, DF_RAW_LOSSLESS=1 or the file
// /tmp/df_raw_lossless. JPEG at any quality is an approximation, so a size
// comparison against pictures that are sent bit-exact compares two different
// claims. This switch lets the baseline send exactly the pixels the game made,
// so the only thing left differing between the two paths is how they represent
// what they send.
#define RAW_LOSSLESS_TRIGGER_FILE "/tmp/df_raw_lossless"
#define RAW_PNG_LEVEL 1
#define RAW_CODEC_JPEG 0
#define RAW_CODEC_PNG 1
#define RAW_RETRY_MS 500
#define RAW_CONNECT_TIMEOUT_MS 500
// Captures closer together than this are skipped. Reading back a 1280x720 frame
// and encoding it costs several milliseconds of the machine the game is running
// on, and a menu screen can present far faster than that; without the cap the raw
// mode would compete with the game for the sake of frames nobody sees.
#define RAW_MIN_CAPTURE_MS 12
// Bounds a length prefix from the peer. The largest input message the WebRTC path
// can produce is an asset-bridge request naming every texture id, so this has to
// be generous; anything past it is a desynchronised stream and the link is dropped.
#define RAW_INPUT_MAX (1u << 20)

static bool g_raw_env_on = false;             // DF_RAW_STREAM was 1 at startup
static bool g_raw_lossless_env = false;       // DF_RAW_LOSSLESS was 1 at startup

// Checked on the same one-second cadence as the mode switch itself, so it costs
// a file test per second rather than one per frame. A static local keeps this
// self-contained; both callers are on the raw worker thread.
static bool raw_lossless_on() {
    static std::atomic<int64_t> last_check_ms{0};
    static std::atomic<bool> cached{false};
    static std::atomic<bool> ever_checked{false};
    int64_t now = std::chrono::duration_cast<std::chrono::milliseconds>(
        std::chrono::steady_clock::now().time_since_epoch()).count();
    if (!ever_checked.load() || now - last_check_ms.load() >= RAW_TOGGLE_CHECK_MS) {
        last_check_ms.store(now);
        bool want = g_raw_lossless_env || (access(RAW_LOSSLESS_TRIGGER_FILE, F_OK) == 0);
        if (want != cached.load()) {
            fprintf(stderr, "[RAW] picture codec -> %s\n", want ? "lossless PNG" : "JPEG q80");
            fflush(stderr);
        }
        cached.store(want);
        ever_checked.store(true);
    }
    return cached.load();
}
static std::atomic<bool> g_raw_on{false};     // effective state, can change at runtime
static std::atomic<bool> g_raw_watcher{false};// a worker thread exists to watch the switch
static std::atomic<int64_t> g_raw_last_check_ms{0};
static std::atomic<bool> g_raw_checked_once{false};
static std::chrono::steady_clock::time_point g_raw_clock_start;
static std::atomic<uint64_t> g_raw_sent{0};
static std::atomic<uint64_t> g_raw_dropped{0};
static std::atomic<uint64_t> g_raw_bytes{0};
// Captures whose pixels differ from the capture before them, and captures that
// repeat it. The raw path sends every captured frame, so an idle game is a
// continuous stream of identical pictures; the count of frames that actually
// changed something is what a display timeline on the client has to match, and
// it is the only way to tell a still screen from a stalled one.
static std::atomic<uint64_t> g_raw_changed{0};
static std::atomic<uint64_t> g_raw_same{0};
// Stamps dropped because the input that produced them was too old to answer.
// The age limit is what stops a stamp riding on a frame that has nothing to do
// with the input, which reports a latency that never happened.
static std::atomic<uint64_t> g_raw_stamp_expired{0};
// Stamps the raw path attached to a frame that went out. This is the raw path's
// own `stampSamples`: without it, coverage on that path could only be described
// from the client's side, which is the number that was already wrong once.
static std::atomic<uint64_t> g_raw_stamp_answered{0};
// Input arrival -> the answering frame leaving here, for the raw path. The same
// interval the draw-command path reports as STAMP_*, so a slow answer can be
// split into "the host took this long" and "the rest was the link and the
// display" on both paths rather than only on one.
static std::vector<int64_t> g_raw_stamp_ages_ms;
static std::mutex g_raw_stamp_lock;
static std::atomic<uint64_t> g_raw_encode_us{0};
static std::atomic<int> g_raw_connected{0};
static std::atomic<bool> g_raw_stop{false};
static std::thread g_raw_thread;
// A plain char buffer, not a std::string, and deliberately so.
//
// raw_init() writes this, and raw_init() is called from init_interposer(), which
// is a constructor attribute. A constructor attribute function runs BEFORE this
// translation unit's own static initializers, so assigning to a std::string here
// is an assignment to an object whose constructor has not run yet: the game
// segfaulted during startup, before it drew a single frame, with no stack for a
// debugger to unwind. A char array is initialised statically, so there is no
// ordering to get wrong.
static char g_raw_host[256] = "127.0.0.1";
static unsigned g_raw_port = 8491;

// One staging buffer, not a queue. The render thread fills it and marks it ready;
// the worker swaps the pixels out and encodes them privately. If the worker has
// not taken the previous frame yet the new one is dropped, which is the right
// answer: a backlog of frames would show the session ageing in lockstep, and the
// stream is only useful if what it shows is now.
static std::mutex g_raw_frame_lock;
static std::vector<uint8_t> g_raw_staging;   // shared: filled by the render thread
static std::vector<uint8_t> g_raw_worker;    // owned by the worker while encoding
static bool g_raw_frame_ready = false;
static int g_raw_frame_w = 0;
static int g_raw_frame_h = 0;
// Whether the staged frame differs from the previous capture, decided where the
// pixels are: the worker uses it to refuse to attach an input's stamp to a frame
// that shows the same picture, and the stats use it to say how much of the
// stream was new.
static bool g_raw_frame_changed = false;
static std::vector<uint8_t> g_raw_previous;  // render thread only

// Reads the switch at most about once a second and updates the effective state.
//
// Called from the present path only while no worker exists, and from the worker
// itself afterwards, so exactly one thread is doing the stat. The rate limit is
// the whole point: a stat per frame would put a filesystem call into the present
// path, and this mode is not allowed to cost anything there when it is off. A
// missing file is a normal state, not an error - it is how the mode is switched
// off - so it is reported only as the one transition line.
static void raw_poll_toggle() {
    // The first call is never rate limited. The clock the limit is measured
    // against starts at load, so a plain comparison would skip the very first
    // check - and that is the one that decides whether the mode was asked for at
    // startup, which left DF_RAW_STREAM=1 doing nothing until the game happened to
    // present a frame.
    bool first_check = !g_raw_checked_once.exchange(true);
    int64_t now = std::chrono::duration_cast<std::chrono::milliseconds>(
        std::chrono::steady_clock::now() - g_raw_clock_start).count();
    if (!first_check && now - g_raw_last_check_ms.load() < RAW_TOGGLE_CHECK_MS) return;
    g_raw_last_check_ms.store(now);

    bool want = g_raw_env_on || (access(RAW_TRIGGER_FILE, F_OK) == 0);
    if (want == g_raw_on.load()) return;

    g_raw_on.store(want);
    if (!want) {
        // Anything already staged is dropped. A frame captured seconds before the
        // switch went off would otherwise be the first thing sent when it comes
        // back on, which is exactly the kind of stale picture this mode is used to
        // rule out.
        std::lock_guard<std::mutex> lock(g_raw_frame_lock);
        g_raw_frame_ready = false;
    }
    fprintf(stderr, "[RAW] raw pixel mode %s (source: %s)\n", want ? "enabled" : "disabled",
            g_raw_env_on ? "DF_RAW_STREAM=1" : RAW_TRIGGER_FILE);
    fflush(stderr);
}

// Render thread. Copies the frame that is about to be presented into the staging
// buffer and returns; the encoding and the sending happen on the worker, because
// a JPEG takes milliseconds and the game must not wait for it.
static void raw_capture_frame(void* renderer) {
    static std::chrono::steady_clock::time_point last_capture;
    auto now = std::chrono::steady_clock::now();
    if (last_capture.time_since_epoch().count() != 0 &&
        std::chrono::duration_cast<std::chrono::milliseconds>(now - last_capture).count() < RAW_MIN_CAPTURE_MS) {
        return;
    }

    {
        std::lock_guard<std::mutex> lock(g_raw_frame_lock);
        if (g_raw_frame_ready) {
            g_raw_dropped++;
            return;
        }
    }

    // Past this point g_raw_frame_ready is false, and only this thread ever sets
    // it, so the worker cannot be looking at the staging buffer: filling it
    // outside the lock is safe and keeps the lock hold time at zero.
    last_capture = now;
    int w = 0, h = 0;
    if (!read_framebuffer_rgba(renderer, g_raw_staging, &w, &h)) return;

    // Compared with the capture before it rather than with the frame last sent:
    // what matters is whether this capture is a different picture, and the
    // previous capture is the last picture the game produced.
    bool changed = g_raw_previous.size() != g_raw_staging.size() ||
                   memcmp(g_raw_previous.data(), g_raw_staging.data(), g_raw_staging.size()) != 0;
    g_raw_previous = g_raw_staging;
    if (changed) g_raw_changed++; else g_raw_same++;

    std::lock_guard<std::mutex> lock(g_raw_frame_lock);
    g_raw_frame_w = w;
    g_raw_frame_h = h;
    g_raw_frame_changed = changed;
    g_raw_frame_ready = true;
}

// Connect to the raw server. Returns -1 and leaves nothing behind when the server
// is not there; the caller retries. The connect is bounded by a poll rather than
// left to the kernel: a blocking connect to a target that neither answers nor
// refuses sits in SYN retries for over a minute, and the destructor joins this
// thread, so an unreachable DF_RAW_TARGET would hold the game's shutdown open for
// that long.
static int raw_connect() {
    char port[16];
    snprintf(port, sizeof(port), "%u", g_raw_port);

    struct addrinfo hints;
    memset(&hints, 0, sizeof(hints));
    hints.ai_family = AF_UNSPEC;
    hints.ai_socktype = SOCK_STREAM;

    struct addrinfo* res = nullptr;
    if (getaddrinfo(g_raw_host, port, &hints, &res) != 0) return -1;

    int fd = -1;
    for (struct addrinfo* ai = res; ai != nullptr; ai = ai->ai_next) {
        int s = socket(ai->ai_family, ai->ai_socktype, ai->ai_protocol);
        if (s < 0) continue;

        int flags = fcntl(s, F_GETFL, 0);
        if (flags < 0) { close(s); continue; }
        fcntl(s, F_SETFL, flags | O_NONBLOCK);
        bool ok = (connect(s, ai->ai_addr, ai->ai_addrlen) == 0);
        if (!ok && errno == EINPROGRESS) {
            struct pollfd pfd;
            pfd.fd = s;
            pfd.events = POLLOUT;
            pfd.revents = 0;
            if (poll(&pfd, 1, RAW_CONNECT_TIMEOUT_MS) > 0) {
                int err = 0;
                socklen_t elen = sizeof(err);
                ok = (getsockopt(s, SOL_SOCKET, SO_ERROR, &err, &elen) == 0 && err == 0);
            }
        }
        if (!ok) { close(s); continue; }
        fcntl(s, F_SETFL, flags);
        fd = s;
        break;
    }
    freeaddrinfo(res);
    if (fd < 0) return -1;

    // A frame is written as a length and then a payload. Waiting for Nagle to
    // coalesce the two would add a round trip of delay to every single frame, so
    // the small header goes out on its own.
    int one = 1;
    setsockopt(fd, IPPROTO_TCP, TCP_NODELAY, &one, sizeof(one));
    // A peer that stops reading must not park this thread forever: a timeout turns
    // that into a send failure, which tears the link down and reconnects.
    struct timeval tv;
    tv.tv_sec = 1;
    tv.tv_usec = 0;
    setsockopt(fd, SOL_SOCKET, SO_SNDTIMEO, &tv, sizeof(tv));
    return fd;
}

// Writing to a socket whose peer has gone away raises SIGPIPE, whose default action
// is to kill the process - that would mean the game dying because the raw server
// was restarted. MSG_NOSIGNAL asks for the error return instead.
static bool raw_send_all(int fd, const uint8_t* p, size_t n) {
    while (n > 0) {
#ifdef MSG_NOSIGNAL
        ssize_t k = send(fd, p, n, MSG_NOSIGNAL);
#else
        ssize_t k = send(fd, p, n, 0);
#endif
        if (k > 0) {
            p += (size_t)k;
            n -= (size_t)k;
            continue;
        }
        if (k < 0 && errno == EINTR) continue;
        return false;
    }
    return true;
}

// Read exactly n bytes, giving up when the connection has been declared finished.
// The poll timeout is why a shutdown is noticed even on a socket that has gone
// completely quiet: a bare recv would sit there until the peer closed.
static bool raw_read_exact(int fd, uint8_t* dst, size_t n, const std::atomic<bool>* alive) {
    size_t got = 0;
    while (got < n) {
        if (!alive->load() || g_raw_stop.load()) return false;
        struct pollfd pfd;
        pfd.fd = fd;
        pfd.events = POLLIN;
        pfd.revents = 0;
        int pr = poll(&pfd, 1, 200);
        if (pr < 0) {
            if (errno == EINTR) continue;
            return false;
        }
        if (pr == 0) continue;
        // Data first: a peer that sent its last message and then closed reports
        // POLLIN together with POLLHUP, and treating the hangup as the answer
        // would throw the final input away.
        if (pfd.revents & POLLIN) {
            ssize_t k = recv(fd, dst + got, n - got, 0);
            if (k > 0) { got += (size_t)k; continue; }
            if (k < 0 && (errno == EINTR || errno == EAGAIN || errno == EWOULDBLOCK)) continue;
            return false;
        }
        if (pfd.revents & (POLLERR | POLLHUP | POLLNVAL)) return false;
    }
    return true;
}

// Input arrives on the same socket as the video. The payloads are byte for byte
// what the WebRTC data channel already delivers, so they go through the same
// handler: a second dispatch path would drift from the first, and an input bug
// that only shows up in raw mode would be the hardest kind to find.
static void raw_reader_loop(int fd, std::atomic<bool>* alive) {
    uint8_t hdr[4];
    while (alive->load() && !g_raw_stop.load()) {
        if (!raw_read_exact(fd, hdr, sizeof(hdr), alive)) break;
        uint32_t len = ((uint32_t)hdr[0] << 24) | ((uint32_t)hdr[1] << 16) |
                       ((uint32_t)hdr[2] << 8) | (uint32_t)hdr[3];
        if (len == 0 || len > RAW_INPUT_MAX) {
            fprintf(stderr, "[RAW] input length %u out of range, dropping raw link\n", len);
            fflush(stderr);
            break;
        }
        std::vector<uint8_t> payload(len);
        if (!raw_read_exact(fd, payload.data(), payload.size(), alive)) break;
        handle_client_input_event(payload.data(), payload.size());
    }

    alive->store(false);
    // Wake the sender: it may be parked in poll() or in a send() that will never
    // finish, and the socket cannot be closed until it has stopped using it.
    shutdown(fd, SHUT_RDWR);
}

enum class RawSendResult { Idle, Sent, Dead };

// Worker side. Takes the staged frame if there is one and writes it as one frame
// message. Returns Dead only when the socket is finished with; a frame that was
// dropped or refused is not an error.
static RawSendResult raw_send_staged(int fd, std::vector<uint8_t>& jpeg) {
    jpeg.clear();

    int w = 0, h = 0;
    {
        std::lock_guard<std::mutex> lock(g_raw_frame_lock);
        if (!g_raw_frame_ready) return RawSendResult::Idle;
        // Swap rather than copy: the render thread gets the previous scratch
        // buffer back and can start on the next frame while this one is encoded.
        g_raw_staging.swap(g_raw_worker);
        w = g_raw_frame_w;
        h = g_raw_frame_h;
        g_raw_frame_ready = false;
    }

    if (w <= 0 || h <= 0 || g_raw_worker.size() < (size_t)w * (size_t)h * 4) return RawSendResult::Idle;

    // The payload carries a one-byte codec tag. The receiving end would
    // otherwise have to sniff the bytes to tell a JPEG from a PNG, and sniffing
    // is exactly the kind of guess that turns into a blank screen with no error.
    // The stamp from the most recent input, if one is waiting. Every captured
    // frame is sent here, so the first capture after an input is by construction
    // the frame the game rendered in response: this is a cleaner causal link than
    // the draw-command path has, where a frame can turn out to be a duplicate and
    // take the stamp down with it. The stamp is spent either way so it can never
    // be attached to a later, unrelated frame.
    bool changed = false;
    {
        std::lock_guard<std::mutex> lock(g_raw_frame_lock);
        changed = g_raw_frame_changed;
    }

    // The stamp goes on the frame that answers the input, and only a frame whose
    // pixels differ from the one before it can answer anything: an identical
    // frame shows the player nothing, so crediting it with a response would
    // manufacture a fast sample out of an input that did nothing. The stamp is
    // held rather than spent while captures repeat, and expires if the answer
    // never comes - a stamp that outlives its input would otherwise ride on some
    // unrelated later frame and report a latency that never happened.
    uint8_t stamp = 0;
    if (g_raw_stamp_slot.expire_if_stale(steady_now_ms(), g_stamp_max_age_ms)) {
        g_raw_stamp_expired++;
    }
    // Only a frame whose pixels changed can answer an input, so the stamp is
    // claimed only when this capture differs from the last one; otherwise it
    // waits in the slot for the capture that does.
    if (changed && g_raw_stamp_slot.claim(steady_now_ms(), g_stamp_max_age_ms, stamp)) {
        int64_t age = -1;
        // The capture path sends every frame it takes, so the claim is answered
        // by this very frame.
        if (g_raw_stamp_slot.settle(stamp_slot::Packet::Frame, steady_now_ms(), stamp, &age)) {
            g_raw_stamp_answered++;
            std::lock_guard<std::mutex> lock(g_raw_stamp_lock);
            g_raw_stamp_ages_ms.push_back(age);
            g_wire_log.note_stamp(stamp, age, epoch_now_ms(), wire_log::Raw);
            if (g_raw_stamp_ages_ms.size() > 900) {
                g_raw_stamp_ages_ms.erase(g_raw_stamp_ages_ms.begin(), g_raw_stamp_ages_ms.begin() + 300);
            }
        }
    }

    bool lossless = raw_lossless_on();
    auto t0 = std::chrono::steady_clock::now();
    bool ok;
    if (lossless) {
        jpeg.clear();
        jpeg.push_back(RAW_CODEC_PNG);
        jpeg.push_back(stamp);
        ok = raw_png_encode(g_raw_worker.data(), w, h, RAW_PNG_LEVEL, jpeg);
    } else {
        ok = raw_jpeg_encode(g_raw_worker.data(), w, h, RAW_JPEG_QUALITY, jpeg);
        if (ok) {
            // The encoder replaces the buffer, so the two header bytes go on after.
            jpeg.insert(jpeg.begin(), stamp);
            jpeg.insert(jpeg.begin(), RAW_CODEC_JPEG);
        }
    }
    g_raw_encode_us += (uint64_t)std::chrono::duration_cast<std::chrono::microseconds>(
        std::chrono::steady_clock::now() - t0).count();
    if (!ok || jpeg.size() <= 2) {
        g_raw_dropped++;
        return RawSendResult::Idle;
    }

    uint32_t len = (uint32_t)jpeg.size();
    uint8_t hdr[4] = {(uint8_t)(len >> 24), (uint8_t)(len >> 16), (uint8_t)(len >> 8), (uint8_t)len};
    if (!raw_send_all(fd, hdr, sizeof(hdr)) || !raw_send_all(fd, jpeg.data(), jpeg.size())) {
        return RawSendResult::Dead;
    }

    g_raw_sent++;
    g_raw_bytes += len;
    // The raw path's own cost, per frame: how long the encode took and whether
    // the pixels changed. Without this the raw tail cannot be split into "the
    // encoder was slow" and "the link was slow", and those have different
    // causes.
    {
        int64_t encode_us = (int64_t)std::chrono::duration_cast<std::chrono::microseconds>(
            std::chrono::steady_clock::now() - t0).count();
        g_wire_log.note(epoch_now_ms(), wire_log::RawFrame, len, -1, encode_us, stamp);
    }
    return RawSendResult::Sent;
}

// One owner for the connection: connect, then run the encoder while a reader
// thread handles input on the same socket. Two threads cannot both be responsible
// for reconnecting, and the socket is only closed after the reader has been joined,
// so neither can end up using a descriptor that has been recycled for something
// else. Nothing here can block the game - every failure is a dropped frame and a
// retry.
static void raw_link_loop() {
    std::vector<uint8_t> jpeg;
    while (!g_raw_stop.load()) {
        // Once this thread exists it owns the switch check, so the present path
        // goes back to a single atomic load. This thread is idle most of the time
        // and the check is rate limited, so it costs nothing here.
        raw_poll_toggle();
        if (!g_raw_on.load()) {
            // Switched off while running. The thread stays alive so the switch can
            // be flipped back without restarting the game, but it stops dialling
            // and stops encoding: an off baseline has to be indistinguishable from
            // the interposer that has no raw mode at all.
            std::this_thread::sleep_for(std::chrono::milliseconds(200));
            continue;
        }

        int fd = raw_connect();
        if (fd < 0) {
            std::this_thread::sleep_for(std::chrono::milliseconds(RAW_RETRY_MS));
            continue;
        }

        g_raw_connected.store(1);
        fprintf(stderr, "[RAW] connected to %s:%u\n", g_raw_host, g_raw_port);
        fflush(stderr);

        std::atomic<bool> alive{true};
        std::thread reader;
        try {
            reader = std::thread(raw_reader_loop, fd, &alive);
        } catch (const std::exception& ex) {
            fprintf(stderr, "[RAW] reader thread failed to start: %s\n", ex.what());
            fflush(stderr);
            close(fd);
            g_raw_connected.store(0);
            std::this_thread::sleep_for(std::chrono::milliseconds(RAW_RETRY_MS));
            continue;
        }

        while (alive.load() && !g_raw_stop.load() && g_raw_on.load()) {
            // Checked here as well as at the top of the outer loop, because the
            // switch has to be noticed while a connection is up - that is the
            // whole point of switching at runtime. Without this the worker sat in
            // its send loop and removing the file only took effect after the link
            // happened to drop. The check rate limits itself, so a loop that runs
            // every couple of milliseconds pays one atomic load per pass.
            raw_poll_toggle();
            RawSendResult r = raw_send_staged(fd, jpeg);
            if (r == RawSendResult::Dead) {
                alive.store(false);
                break;
            }
            if (r == RawSendResult::Idle) {
                // Nothing staged. Sleeping instead of spinning costs at most a
                // couple of milliseconds on the first frame of a fresh capture,
                // and the capture side caps itself at one frame per
                // RAW_MIN_CAPTURE_MS anyway.
                std::this_thread::sleep_for(std::chrono::milliseconds(2));
            }
        }

        alive.store(false);
        shutdown(fd, SHUT_RDWR);
        if (reader.joinable()) reader.join();
        close(fd);
        g_raw_connected.store(0);

        // Only a genuine drop is reported as one. Saying "link down, retrying"
        // when the mode was simply switched off would send the next person
        // looking for a broken connection that never existed.
        if (!g_raw_stop.load() && g_raw_on.load()) {
            fprintf(stderr, "[RAW] link down, retrying in %dms\n", RAW_RETRY_MS);
            fflush(stderr);
            std::this_thread::sleep_for(std::chrono::milliseconds(RAW_RETRY_MS));
        }
    }
}

// The worker only exists once the mode is actually on - started at load when the
// switch is already on, or on the first transition to on afterwards. While the mode
// is off the process has to have exactly the threads it had before this was added,
// so there is nothing to start and nothing to stop.
static void raw_start_worker() {
    g_raw_watcher.store(true);
    try {
        g_raw_thread = std::thread(raw_link_loop);
    } catch (const std::exception& ex) {
        // Leave the mode off rather than half on: a capture that nothing ever
        // encodes would only spend the render thread's time. The next tick tries
        // again, and the message is printed once so a failing start cannot fill
        // the log a line per second.
        g_raw_watcher.store(false);
        g_raw_on.store(false);
        static bool logged = false;
        if (!logged) {
            logged = true;
            fprintf(stderr, "[RAW] worker thread failed to start: %s\n", ex.what());
            fflush(stderr);
        }
        return;
    }
    fprintf(stderr, "[RAW] worker started, target %s:%u, quality %d\n",
            g_raw_host, g_raw_port, RAW_JPEG_QUALITY);
    fflush(stderr);
}

// Render-thread side of the switch. On a disabled interposer this is an atomic
// load plus, at most once a second, one stat - nothing else happens. The stat only
// runs while no worker exists: once there is one, this thread goes back to reading
// a flag, and the frame is only read back when the mode is on.
static void raw_present_tick(void* renderer) {
    if (!g_raw_watcher.load()) {
        raw_poll_toggle();
        if (g_raw_on.load() && !g_raw_watcher.load()) raw_start_worker();
    }
    // Reads the frame that is about to be presented, because that is the one the
    // client would be looking at.
    if (g_raw_on.load()) raw_capture_frame(renderer);
}

// Called once from the interposer constructor. Nothing here starts a thread or
// opens a socket unless the mode is already on at startup; otherwise the present
// path picks the switch up within a second of the file appearing.
static void raw_init() {
    const char* env = getenv("DF_RAW_STREAM");
    { const char* l = getenv("DF_RAW_LOSSLESS"); g_raw_lossless_env = (l && l[0] == '1'); }
    g_raw_env_on = (env && atoi(env) == 1);

    // Parsed even while off, so a target that is going to be used later is already
    // known: reading two environment variables once at load costs nothing.
    const char* target = getenv("DF_RAW_TARGET");
    std::string t = (target && *target) ? target : RAW_DEFAULT_TARGET;
    size_t colon = t.rfind(':');
    if (colon != std::string::npos && colon > 0 && colon + 1 < t.size()) {
        snprintf(g_raw_host, sizeof(g_raw_host), "%s", t.substr(0, colon).c_str());
        g_raw_port = (unsigned)atoi(t.c_str() + colon + 1);
    } else {
        fprintf(stderr, "[RAW] DF_RAW_TARGET '%s' is not host:port, using %s\n", t.c_str(), RAW_DEFAULT_TARGET);
        fflush(stderr);
    }

    g_raw_clock_start = std::chrono::steady_clock::now();
    // Prints the one transition that can happen at load, and nothing at all when
    // there is neither the environment variable nor the file.
    raw_poll_toggle();
    if (g_raw_on.load()) raw_start_worker();
}

extern "C" {

void* SDL_CreateWindow(const char* title, int x, int y, int w, int h, uint32_t flags) {
    if (!real_SDL_CreateWindow) real_SDL_CreateWindow = dlsym(RTLD_NEXT, "SDL_CreateWindow");
    if (!real_SDL_GetWindowID) real_SDL_GetWindowID = dlsym(RTLD_NEXT, "SDL_GetWindowID");
    void* win = real_SDL_CreateWindow ? ((void*(*)(const char*,int,int,int,int,uint32_t))real_SDL_CreateWindow)(title, x, y, w, h, flags) : nullptr;
    if (win) {
        g_df_window = win;
        g_current_w = w;
        g_current_h = h;
        if (real_SDL_GetWindowID) {
            g_df_window_id = ((uint32_t(*)(void*))real_SDL_GetWindowID)(win);
        }
        fprintf(stderr, "[INIT] DF Window created: title='%s', windowID=%u, size=%dx%d\n", title ? title : "", g_df_window_id, w, h);
        fflush(stderr);
    }
    return win;
}

uint32_t SDL_GetMouseState(int* x, int* y) {
    if (!real_SDL_GetMouseState) resolve_symbols();
    if (x) *x = g_mouse_x;
    if (y) *y = g_mouse_y;
    return g_mouse_buttons;
}

// Total picture bytes held. Maintained as pictures are stored and released
// rather than recomputed: the id space now spans the whole u16 range, so a scan
// on every destroy would walk tens of thousands of slots.
static size_t g_cached_bytes = 0;

// Ceiling on retained pictures. A picture whose texture has been destroyed is
// kept because a frame already on the wire may still name its id, and the client
// will ask for it; those requests have to be answerable or the client gives up
// and leaves a permanent hole. Only once this many bytes are held are the
// orphaned ones released, so the retention stays bounded.
#define CACHED_BYTES_MAX (192u * 1024u * 1024u)

// Drops the pixels of every slot whose texture is gone. Live pictures are never
// touched: those are still being drawn.
static void release_orphaned_textures_locked() {
    for (uint16_t i = 0; i < g_texture_count; i++) {
        if (g_textures[i] == nullptr && !g_cached_textures[i].rgba.empty()) {
            g_cached_bytes -= g_cached_textures[i].rgba.size();
            g_cached_textures[i].rgba.clear();
        }
    }
}

void SDL_DestroyTexture(void* texture) {
    if (!real_SDL_DestroyTexture) resolve_symbols();
    if (texture) {
        std::lock_guard<std::mutex> lock(g_tex_lock);
        for (uint16_t i = 0; i < g_texture_count; i++) {
            if (g_textures[i] == texture) {
                // The slot is freed but the pixels are not. Destroying the
                // texture only means the game will not draw it again; it does
                // not mean the client has stopped needing it. A frame that
                // reached the wire just before this destroy still names the id,
                // and the client asks for it - and if the pixels are gone here
                // that request can never be answered, so the client retries
                // three times, calls it unsendable and leaves a hole in the
                // display for the rest of the session.
                g_textures[i] = nullptr;
                break;
            }
        }
        if (g_cached_bytes > CACHED_BYTES_MAX) {
            release_orphaned_textures_locked();
        }
    }
    if (real_SDL_DestroyTexture && texture) real_SDL_DestroyTexture(texture);
}


// Counting only. Whether these pixels can be captured is a measurement, not an
// assumption: at the observed call rate a full-frame copy would be hundreds of
// gigabytes a second, which is why an earlier version that copied unconditionally
// stopped the game presenting at all.

int SDL_RenderFillRect(void* r, const void* rect) { if (!real_SDL_RenderFillRect) resolve_symbols(); g_rc_fillrect.fetch_add(1, std::memory_order_relaxed); dump_render_call_counts(); return real_SDL_RenderFillRect ? real_SDL_RenderFillRect(r, rect) : -1; }
int SDL_RenderFillRects(void* r, const void* rects, int n) { if (!real_SDL_RenderFillRects) resolve_symbols(); g_rc_fillrects.fetch_add(1, std::memory_order_relaxed); dump_render_call_counts(); return real_SDL_RenderFillRects ? real_SDL_RenderFillRects(r, rects, n) : -1; }
int SDL_RenderDrawLine(void* r, int x1, int y1, int x2, int y2) { if (!real_SDL_RenderDrawLine) resolve_symbols(); g_rc_drawline.fetch_add(1, std::memory_order_relaxed); dump_render_call_counts(); return real_SDL_RenderDrawLine ? real_SDL_RenderDrawLine(r, x1, y1, x2, y2) : -1; }
int SDL_RenderDrawLines(void* r, const void* pts, int n) { if (!real_SDL_RenderDrawLines) resolve_symbols(); g_rc_drawlines.fetch_add(1, std::memory_order_relaxed); dump_render_call_counts(); return real_SDL_RenderDrawLines ? real_SDL_RenderDrawLines(r, pts, n) : -1; }
int SDL_RenderDrawPoint(void* r, int x, int y) { if (!real_SDL_RenderDrawPoint) resolve_symbols(); g_rc_drawpoint.fetch_add(1, std::memory_order_relaxed); dump_render_call_counts(); return real_SDL_RenderDrawPoint ? real_SDL_RenderDrawPoint(r, x, y) : -1; }
int SDL_RenderGeometry(void* r, void* tex, const void* v, int nv, const void* i, int ni) { if (!real_SDL_RenderGeometry) resolve_symbols(); g_rc_geometry.fetch_add(1, std::memory_order_relaxed); dump_render_call_counts(); return real_SDL_RenderGeometry ? real_SDL_RenderGeometry(r, tex, v, nv, i, ni) : -1; }
int SDL_RenderSetClipRect(void* r, const void* rect) { if (!real_SDL_RenderSetClipRect) resolve_symbols(); g_rc_setclip.fetch_add(1, std::memory_order_relaxed); dump_render_call_counts(); return real_SDL_RenderSetClipRect ? real_SDL_RenderSetClipRect(r, rect) : -1; }
int SDL_SetRenderDrawColor(void* r, uint8_t a, uint8_t b2, uint8_t c, uint8_t d) { if (!real_SDL_SetRenderDrawColor) resolve_symbols(); g_rc_setcolor.fetch_add(1, std::memory_order_relaxed); dump_render_call_counts(); return real_SDL_SetRenderDrawColor ? real_SDL_SetRenderDrawColor(r, a, b2, c, d) : -1; }

int SDL_UpdateTexture(void* texture, const void* rect, const void* pixels, int pitch) {
    if (!real_SDL_UpdateTexture) resolve_symbols();
    const uint64_t n = g_upd_calls.fetch_add(1, std::memory_order_relaxed) + 1;
    if (pitch <= 256) g_upd_pitch_le256.fetch_add(1, std::memory_order_relaxed);
    else if (pitch <= 2048) g_upd_pitch_le2048.fetch_add(1, std::memory_order_relaxed);
    else if (pitch <= 8192) g_upd_pitch_le8192.fetch_add(1, std::memory_order_relaxed);
    else g_upd_pitch_gt8192.fetch_add(1, std::memory_order_relaxed);
    if ((n & 15) == 0) {
        FILE* f = fopen("/tmp/df_upd_stats", "w");
        if (f) {
            fprintf(f, "calls=%llu lock=%llu unlock=%llu pitch_le256=%llu pitch_le2048=%llu pitch_le8192=%llu pitch_gt8192=%llu\n",
                    (unsigned long long)g_upd_calls.load(),
                    (unsigned long long)g_upd_lock_calls.load(),
                    (unsigned long long)g_upd_unlock_calls.load(),
                    (unsigned long long)g_upd_pitch_le256.load(),
                    (unsigned long long)g_upd_pitch_le2048.load(),
                    (unsigned long long)g_upd_pitch_le8192.load(),
                    (unsigned long long)g_upd_pitch_gt8192.load());
            fclose(f);
        }
    }
    return real_SDL_UpdateTexture ? real_SDL_UpdateTexture(texture, rect, pixels, pitch) : -1;
}

int SDL_LockTexture(void* texture, const void* rect, void** pixels, int* pitch) {
    if (!real_SDL_LockTexture) resolve_symbols();
    g_upd_lock_calls.fetch_add(1, std::memory_order_relaxed);
    return real_SDL_LockTexture ? real_SDL_LockTexture(texture, rect, pixels, pitch) : -1;
}

void SDL_UnlockTexture(void* texture) {
    if (!real_SDL_UnlockTexture) resolve_symbols();
    g_upd_unlock_calls.fetch_add(1, std::memory_order_relaxed);
    if (real_SDL_UnlockTexture) real_SDL_UnlockTexture(texture);
}

void* SDL_CreateTextureFromSurface(void* renderer, void* surface) {
    if (!real_SDL_CreateTextureFromSurface) resolve_symbols();
    void* tex = real_SDL_CreateTextureFromSurface ? real_SDL_CreateTextureFromSurface(renderer, surface) : nullptr;
    if (!tex || !surface) return tex;

    SDL_Surface_Internal* s = (SDL_Surface_Internal*)surface;
    if (s->w <= 0 || s->h <= 0 || !s->pixels) return tex;

    // A texture the game has just created is a picture the client has never
    // seen, so it always gets a fresh id rather than possibly inheriting one.
    uint16_t id = alloc_texture_id(tex);
    if (id > 0 && id <= MAX_TEXTURES) {
        std::lock_guard<std::mutex> lock(g_tex_lock);
        CachedTexture& ct = g_cached_textures[id - 1];
        ct.id = id;
        ct.w = (uint16_t)s->w;
        ct.h = (uint16_t)s->h;
        g_cached_bytes -= ct.rgba.size();
        ct.rgba.resize((size_t)ct.w * ct.h * 4);
        g_cached_bytes += ct.rgba.size();

        if (real_SDL_ConvertSurfaceFormat) {
            void* conv = real_SDL_ConvertSurfaceFormat(surface, 376840196 /* SDL_PIXELFORMAT_ABGR8888 -> RGBA on LE */, 0);
            if (conv) {
                SDL_Surface_Internal* cs = (SDL_Surface_Internal*)conv;
                for (int y = 0; y < s->h; y++) {
                    const uint8_t* src_row = (const uint8_t*)cs->pixels + y * cs->pitch;
                    uint8_t* dst_row = ct.rgba.data() + y * ct.w * 4;
                    memcpy(dst_row, src_row, ct.w * 4);
                }
                if (real_SDL_FreeSurface) real_SDL_FreeSurface(conv);
            } else {
                const uint8_t* src = (const uint8_t*)s->pixels;
                for (int y = 0; y < s->h; y++) {
                    memcpy(ct.rgba.data() + y * ct.w * 4, src + y * s->pitch, std::min((int)(ct.w * 4), s->pitch));
                }
            }
        } else {
            const uint8_t* src = (const uint8_t*)s->pixels;
            for (int y = 0; y < s->h; y++) {
                memcpy(ct.rgba.data() + y * ct.w * 4, src + y * s->pitch, std::min((int)(ct.w * 4), s->pitch));
            }
        }
        g_pic_created.fetch_add(1, std::memory_order_relaxed);
        {
            uint64_t h = 1469598103934665603ull;
            for (size_t i = 0; i < ct.rgba.size(); i += 13) { h ^= ct.rgba[i]; h *= 1099511628211ull; }
            h ^= (uint64_t)ct.w << 32; h *= 1099511628211ull; h ^= ct.h;
            static std::mutex distinct_lock;
            static std::unordered_set<uint64_t> distinct;
            std::lock_guard<std::mutex> dl(distinct_lock);
            if (distinct.size() < 200000 && distinct.insert(h).second) {
                g_pic_distinct.fetch_add(1, std::memory_order_relaxed);
            }
        }
        // Deliberately nothing here.
        //
        // This is where every created picture used to be broadcast. A picture is now
        // sent only when a frame that is actually going out references it and the
        // client does not already hold it - see the send path in the present hook.
        // Sending on creation meant the game's own texture churn (5,383 pictures in
        // 8s of panning) became wire traffic regardless of what was on screen.
        g_pic_skipped_unreferenced.fetch_add(1, std::memory_order_relaxed);
    }
    return tex;
}

int SDL_RenderClear(void* renderer) {
    if (!real_SDL_RenderClear) resolve_symbols();
    g_frame_cmd_count = 0;
    return real_SDL_RenderClear ? real_SDL_RenderClear(renderer) : 0;
}

// True if this id has pixels we could actually put on the wire.
static bool texture_pixels_available(uint16_t id) {
    std::lock_guard<std::mutex> lock(g_tex_lock);
    return id >= 1 && id <= g_texture_count && !g_cached_textures[id - 1].rgba.empty();
}

int SDL_RenderCopy(void* renderer, void* texture, const SDL_Rect* srcrect, const SDL_Rect* dstrect) {
    const auto hook_t0 = std::chrono::steady_clock::now();
    struct HookTime { std::chrono::steady_clock::time_point t0; ~HookTime() {
        g_hook_ns.fetch_add((uint64_t)std::chrono::duration_cast<std::chrono::nanoseconds>(
            std::chrono::steady_clock::now() - t0).count(), std::memory_order_relaxed);
        g_hook_calls.fetch_add(1, std::memory_order_relaxed);
    } } hook_time{hook_t0};
    if (!real_SDL_RenderCopy) resolve_symbols();
    // Refill the picture queue here rather than only once per present: this hook
    // runs thousands of times per frame, so the link is kept busy instead of
    // idling between presents.
    maybe_drain_textures();
    int res = real_SDL_RenderCopy ? real_SDL_RenderCopy(renderer, texture, srcrect, dstrect) : 0;
    if (res != 0) return res;
    g_rc_copy_calls.fetch_add(1, std::memory_order_relaxed);

    // A picture the client can never be sent must not be named in a frame. If it
    // is, the client holds that whole frame waiting for it, spends its retries
    // on a request that cannot be satisfied, then writes the id off and leaves a
    // hole in the display - and the frame sat frozen the whole time for nothing.
    // This is reachable rather than theoretical: a texture the game creates
    // without a surface (plain SDL_CreateTexture, which is not hooked) gets an
    // id here at draw time and never has any pixels cached, which is exactly how
    // ids 10 and 11 stayed permanently missing.
    uint16_t tid = lookup_texture_id(texture);
    if (tid == 0) {
        // Never saw this texture created. Name it anyway: the client then knows
        // the picture exists and holds the frame until it arrives, instead of
        // silently drawing a screen with a large sprite missing. Counted, because
        // a sprite dropped here is invisible corruption - the rest of the frame
        // is correct, so nothing looks obviously broken.
        g_draw_unknown++;
        tid = alloc_texture_id(texture);
    }
    if (tid == 0 || !texture_pixels_available(tid)) {
        g_draw_nopixels++;
        dump_render_call_counts();
        return res;
    }

    if (g_frame_cmd_count < MAX_DRAW_COMMANDS) {
        DrawCommand& cmd = g_frame_cmds[g_frame_cmd_count++];
        cmd.tex_id = tid;
        if (srcrect) {
            cmd.src_x = (int16_t)srcrect->x; cmd.src_y = (int16_t)srcrect->y;
            cmd.src_w = (int16_t)srcrect->w; cmd.src_h = (int16_t)srcrect->h;
        } else {
            cmd.src_x = 0; cmd.src_y = 0; cmd.src_w = 0; cmd.src_h = 0;
        }
        if (dstrect) {
            cmd.dst_x = (int16_t)dstrect->x; cmd.dst_y = (int16_t)dstrect->y;
            cmd.dst_w = (int16_t)dstrect->w; cmd.dst_h = (int16_t)dstrect->h;
        } else {
            cmd.dst_x = 0; cmd.dst_y = 0; cmd.dst_w = (int16_t)g_current_w; cmd.dst_h = (int16_t)g_current_h;
        }
    }
    return res;
}

int SDL_RenderCopyEx(void* renderer, void* texture, const SDL_Rect* srcrect, const SDL_Rect* dstrect, double angle, const void* center, int flip) {
    if (!real_SDL_RenderCopyEx) resolve_symbols();
    g_rc_copyex_calls.fetch_add(1, std::memory_order_relaxed);
    SDL_RenderCopy(renderer, texture, srcrect, dstrect);
    return real_SDL_RenderCopyEx(renderer, texture, srcrect, dstrect, angle, center, flip);
}

// Send the picture in cmds[0..count) when there is a reason to.
//
// This block used to live inline in SDL_RenderPresent, so the only moment the
// interposer could transmit anything was when the game drew. A game parked on a
// still screen never draws again, and a client that connected after the last
// draw was therefore never sent the picture sitting right there - it waited on a
// black screen until the user happened to press something, which changed the
// picture and finally produced a frame. The send is now callable from any event
// that gives a reason to send, including a client arriving.
//
// Callers must hold g_send_lock. It serialises g_delta_encoder, g_sent_seq and
// the delta chain's prev_cmds, which the present path and the connect path both
// touch, and it is what makes an encode from the network thread safe while the
// game keeps drawing on its own.
//
// Returns true when a packet actually went out - which is what consumes a
// sequence number.
static bool service_picture_send(const DrawCommand* cmds, uint16_t count,
                                 bool force_keyframe, uint32_t combined_base) {
    if (count == 0) return false;
    {
        static std::atomic<int> svc_log{0};
        if (svc_log.fetch_add(1) < 30) {
            size_t ndcs = 0, nopen = 0;
            { std::lock_guard<std::mutex> l(g_rtc_lock);
              ndcs = g_active_dcs.size();
              for (auto& d : g_active_dcs) if (d && d->isOpen()) nopen++; }
            fprintf(stderr, "[SVCSEND] count=%u force=%d dcs=%zu open=%zu\n",
                    (unsigned)count, (int)force_keyframe, ndcs, nopen);
            fflush(stderr);
        }
    }
    // NOTE: the age is NOT measured here. Presents happen whether or not
    // anything is transmitted, so measuring here reports the time to the next
    // vsync rather than the time to the client's answer. Claiming carries the
    // arrival time forward; settle() below measures the age when a frame
    // really goes out, which is the number that matters.
    uint8_t stamp = 0;
    g_stamp_slot.claim(steady_now_ms(), g_stamp_max_age_ms, stamp);

    std::vector<uint8_t> frame_packet;
    EncodeResult enc = g_delta_encoder.encode_frame(g_sent_seq, cmds, count,
                                                    force_keyframe, combined_base, stamp, frame_packet);
    if (enc == EncodeResult::Full) {
        g_need_keyframe.store(false);
    }

    // Did the packet that is about to go out actually carry the stamp? The
    // stamp rides only on a frame. A keepalive used to go out here - a packet
    // with no commands and a zeroed header, which the client dropped without
    // ever looking at a stamp - and it used to be counted as an answer, so a
    // run claimed 485 answers for 381 stamps the client could see. The
    // keepalive was then measured as doing nothing at all (its removal
    // changed no metric by more than the run-to-run spread:
    // evidence/bench/loopback/KEEPALIVE_MATRIX.md) and removed, so the only
    // thing that can settle a claim now is a frame.
    bool carried_stamp = !frame_packet.empty();

    // What went out settles it: a frame that carried the stamp answers the
    // input; a present that sent nothing hands the stamp back for the next
    // frame that really goes out, still subject to the age limit.
    int64_t stamp_age_ms = -1;
    if (g_stamp_slot.settle(carried_stamp ? stamp_slot::Packet::Frame : stamp_slot::Packet::Nothing,
                            steady_now_ms(), stamp, &stamp_age_ms)) {
        // Input arrival -> the frame that actually answers it leaving here.
        g_stamp_ages_ms.push_back(stamp_age_ms);
        g_wire_log.note_stamp(stamp, stamp_age_ms, epoch_now_ms(), wire_log::Smart);
        g_stamp_seen++;
        if (g_stamp_ages_ms.size() > 900) g_stamp_ages_ms.erase(g_stamp_ages_ms.begin(), g_stamp_ages_ms.begin() + 300);
    }

    bool report_due = false;
    // The encoder built something, so it goes out. Nothing else is ever sent:
    // a present whose picture did not change produces no packet at all.
    if (!frame_packet.empty()) {
        // Pictures first, then the frame that names them.
        //
        // The client will not draw a frame until every picture it references is in
        // its atlas, so these have to be queued ahead of it. Sending the frame first
        // means the client's completeness gate fires an asset-bridge request, which
        // costs a round trip and a forced keyframe - the stall this is meant to
        // remove.
        //
        // Only pictures this frame references AND this client does not already hold.
        // `g_active_dcs` is stable here: the frame path already holds g_send_lock.
        {
            std::lock_guard<std::mutex> rlock(g_rtc_lock);
            if (!g_active_dcs.empty()) {
                std::lock_guard<std::mutex> tlock(g_tex_lock);
                for (uint16_t i = 0; i < count; i++) {
                    const uint16_t id = cmds[i].tex_id;
                    if (id == 0 || id > g_texture_count) continue;
                    if (client_cache_has(id)) continue;
                    CachedTexture& ct = g_cached_textures[id - 1];
                    if (ct.rgba.empty()) continue;
                    for (auto& dc : g_active_dcs) {
                        if (dc && dc->isOpen()) send_texture_all_chunks_dc(dc, ct);
                    }
                    client_cache_push(id);
                    g_pic_sent_referenced.fetch_add(1, std::memory_order_relaxed);
                }
            }
        }
        {
            std::lock_guard<std::mutex> lock(g_rtc_lock);
            for (auto& dc : g_active_dcs) {
                if (dc && dc->isOpen()) {
                    // No backpressure guard here: it only ever measured bytes
                    // queued locally, which on a healthy link stays near zero,
                    // and dropping a delta breaks the chain for every later
                    // frame. Bulk traffic is the texture path, not this one.
                    g_queue_at_send.push_back((int64_t)dc->bufferedAmount());
                    if (g_queue_at_send.size() > 900) g_queue_at_send.erase(g_queue_at_send.begin(), g_queue_at_send.begin() + 300);
                    // `extra` carries the frame's own sequence number: it is
                    // what lets the page's log be matched against this one
                    // frame by frame, so a frame that never arrived can be
                    // told from one that arrived late.
                    g_wire_log.note(epoch_now_ms(),
                                    enc == EncodeResult::Full ? wire_log::Keyframe : wire_log::Frame,
                                    (uint32_t)frame_packet.size(), (int64_t)dc->bufferedAmount(),
                                    (int64_t)g_sent_seq, carried_stamp ? stamp : 0);
                    dc_send_counted(dc, frame_packet.data(), frame_packet.size());
                    g_wire_bytes += frame_packet.size();
                    g_wire_frames++;
                }
            }
            // Sequence numbers are consumed only by frames that were actually
            // sent, so a silent present leaves no hole for the client to treat
            // as packet loss.
            g_sent_seq++;

            static uint64_t last_report_seq = 0;
            if (g_sent_seq - last_report_seq >= 25) {
                last_report_seq = g_sent_seq;
                report_due = true;
            }
        }

        // Reported after the lock is released: never do blocking I/O while
        // holding g_rtc_lock, which the signalling path also needs.
        if (report_due) {
            const DeltaEncoder& s = g_delta_encoder;
            double e50 = 0, e95 = 0, emax = 0;
            if (!s.enc_us.empty()) {
                std::vector<double> v = s.enc_us;
                std::sort(v.begin(), v.end());
                e50 = v[v.size() / 2];
                e95 = v[(size_t)std::min(v.size() - 1, (size_t)(v.size() * 0.95))];
                emax = v.back();
            }
            int64_t q50 = -1, q95 = -1, qmax = -1;
            if (!g_queue_at_send.empty()) {
                std::vector<int64_t> q = g_queue_at_send;
                std::sort(q.begin(), q.end());
                q50 = q[q.size() / 2];
                q95 = q[(size_t)std::min(q.size() - 1, (size_t)(q.size() * 0.95))];
                qmax = q.back();
            }
            double s50 = -1, s95 = -1, smax = -1;
            if (!g_stamp_ages_ms.empty()) {
                std::vector<int64_t> v = g_stamp_ages_ms;
                std::sort(v.begin(), v.end());
                s50 = (double)v[v.size() / 2];
                s95 = (double)v[(size_t)std::min(v.size() - 1, (size_t)(v.size() * 0.95))];
                smax = (double)v.back();
            }
            // The RAW_ fields are dormant unless DF_RAW_STREAM=1: RAW_on says
            // whether the mode was asked for, RAW_conn whether the raw server
            // is currently connected, and RAW_enc_us is the mean JPEG encode
            // time per sent frame - the number that decides whether the 12ms
            // capture cap is doing anything useful.
            fprintf(stderr, "[FRAME_STATS] sent=%llu silent=%llu full=%llu delta=%llu avg_full=%lluB avg_delta=%lluB enc_calls=%llu enc_p50=%.0fus enc_p95=%.0fus enc_max=%.0fus STAMP_n=%llu STAMP_p50=%.0fms STAMP_p95=%.0fms STAMP_max=%.0fms QUEUE_p50=%lld QUEUE_p95=%lld QUEUE_max=%lld WIRE_kb=%llu WIRE_frames=%llu TEX_n=%llu TEX_kb=%llu TEX_new=%llu TEX_repeat=%llu DUMP_n=%llu DUMP_kb=%llu TEXQ_defer=%llu TEXQ_req=%llu TEXQ_resume=%llu TEXQ_pend=%u TEXQ_qmax=%lld TEX_ids=%u TEX_recycled=%llu TEX_kbheld=%llu DRAW_unknown=%llu DRAW_nopixels=%llu RAW_on=%d RAW_sent=%llu RAW_drop=%llu RAW_kb=%llu RAW_enc_us=%llu RAW_conn=%d RAW_new=%llu RAW_same=%llu RAW_stamp_exp=%llu STAMP_exp=%llu\n",
                    (unsigned long long)g_sent_seq,
                    (unsigned long long)s.stat_nothing,
                    (unsigned long long)s.stat_full,
                    (unsigned long long)s.stat_delta,
                    (unsigned long long)(s.stat_full ? s.stat_bytes_full / s.stat_full : 0),
                    (unsigned long long)(s.stat_delta ? s.stat_bytes_delta / s.stat_delta : 0),
                    (unsigned long long)s.stat_enc_calls,
                    e50, e95, emax,
                    (unsigned long long)g_stamp_seen, s50, s95, smax,
                    (long long)q50, (long long)q95, (long long)qmax,
                    (unsigned long long)(g_wire_bytes / 1024), (unsigned long long)g_wire_frames,
                    (unsigned long long)g_tex_count, (unsigned long long)(g_tex_bytes / 1024),
                    (unsigned long long)g_tex_new, (unsigned long long)g_tex_repeat,
                    (unsigned long long)g_tex_dump_count, (unsigned long long)(g_tex_dump_bytes / 1024),
                    (unsigned long long)g_tex_deferred, (unsigned long long)g_tex_requested,
                    (unsigned long long)g_tex_resumed,
                    (unsigned)g_tex_queue_hint.load(std::memory_order_relaxed),
                    (long long)g_queue_at_tex_max,
                    (unsigned)g_texture_count,
                    (unsigned long long)g_tex_recycled,
                    (unsigned long long)(g_cached_bytes / 1024),
                    (unsigned long long)g_draw_unknown,
                    (unsigned long long)g_draw_nopixels,
                    (int)(g_raw_on.load() ? 1 : 0),
                    (unsigned long long)g_raw_sent.load(),
                    (unsigned long long)g_raw_dropped.load(),
                    (unsigned long long)(g_raw_bytes.load() / 1024),
                    (unsigned long long)(g_raw_sent.load() ? g_raw_encode_us.load() / g_raw_sent.load() : 0),
                    (int)g_raw_connected.load(),
                    (unsigned long long)g_raw_changed.load(),
                    (unsigned long long)g_raw_same.load(),
                    (unsigned long long)g_raw_stamp_expired.load(),
                    (unsigned long long)g_stamp_slot.expired);
            fflush(stderr);
        }
    }
    return true;
}



// A 64x64 sample from the middle of the window: cheap enough to run on a skipped
// present, and large enough that a camera pan cannot move without changing it.
static bool sample_pixel_hash(void* renderer, uint64_t& out) {
    if (!real_SDL_RenderReadPixels || !renderer) return false;
    static uint32_t buf[64 * 64];
    SDL_Rect r;
    r.x = (g_current_w > 64 ? (g_current_w - 64) / 2 : 0);
    r.y = (g_current_h > 64 ? (g_current_h - 64) / 2 : 0);
    r.w = 64; r.h = 64;
    if (real_SDL_RenderReadPixels(renderer, &r, 376840196 /* ABGR8888 */, buf, 64 * 4) != 0) return false;
    uint64_t h = 1469598103934665603ull;
    for (int i = 0; i < 64 * 64; i++) { h ^= buf[i]; h *= 1099511628211ull; }
    out = h;
    return true;
}


void SDL_RenderPresent(void* renderer) {
    const auto present_t0 = std::chrono::steady_clock::now();
    struct PresentTime { std::chrono::steady_clock::time_point t0; ~PresentTime() {
        const uint64_t us = (uint64_t)std::chrono::duration_cast<std::chrono::microseconds>(
            std::chrono::steady_clock::now() - t0).count();
        g_present_us_total.fetch_add(us, std::memory_order_relaxed);
        g_present_count.fetch_add(1, std::memory_order_relaxed);
        uint64_t prev = g_present_us_max.load(std::memory_order_relaxed);
        while (us > prev && !g_present_us_max.compare_exchange_weak(prev, us)) {}
    } } present_time{present_t0};
    if (!real_SDL_RenderPresent) resolve_symbols();
    if ((g_presents.load(std::memory_order_relaxed) & 63) == 0) dump_render_call_counts();
    g_presents.fetch_add(1, std::memory_order_relaxed);
    g_frame_seq++;

    // Force DF to redraw full screen on next frame so all viewport & map tiles stay fresh
    force_full_display();

    // Frame-by-frame interception if enabled (records at most N frames)
    static int g_record_max = -1;
    static int g_recorded_count = 0;
    if (g_record_max == -1) {
        const char* env = getenv("DF_RECORD_FRAMES");
        g_record_max = (env && atoi(env) > 0) ? atoi(env) : 0;
        if (g_record_max > 0) mkdir("/tmp/df_frames", 0777);
    }
    if (g_record_max > 0 && g_recorded_count < g_record_max && real_SDL_RenderReadPixels) {
        std::vector<uint8_t> raw_pixel_buf(g_current_w * g_current_h * 4);
        if (real_SDL_RenderReadPixels(renderer, nullptr, 376840196 /* SDL_PIXELFORMAT_ABGR8888 -> RGBA */, raw_pixel_buf.data(), g_current_w * 4) == 0) {
            char fpath[128];
            snprintf(fpath, sizeof(fpath), "/tmp/df_frames/host_%06u.raw", g_frame_seq);
            FILE* fp = fopen(fpath, "wb");
            if (fp) {
                fwrite(raw_pixel_buf.data(), 1, raw_pixel_buf.size(), fp);
                fclose(fp);
                g_recorded_count++;
            }
        }
    }

    // On-demand snapshot trigger for QA parity suite.
    //
    // The readback itself lives in read_framebuffer_rgba, shared with the raw
    // pixel mode: the size is asked of the renderer rather than taken from the
    // tracked window size, because the game resizes its window and reading with a
    // pitch that does not match the target makes SDL refuse, which is why this
    // produced no file at all and left the parity suite with no ground truth.
    if (access("/tmp/df_snap_trigger", F_OK) == 0) {
        unlink("/tmp/df_snap_trigger");
        std::vector<uint8_t> snap_pixel_buf;
        int ow = 0, oh = 0;
        if (read_framebuffer_rgba(renderer, snap_pixel_buf, &ow, &oh)) {
            FILE* fp = fopen("/tmp/df_snap_host.raw", "wb");
            if (fp) {
                fwrite(snap_pixel_buf.data(), 1, snap_pixel_buf.size(), fp);
                fclose(fp);
                FILE* mp = fopen("/tmp/df_snap_host.meta", "w");
                if (mp) { fprintf(mp, "%d %d\n", ow, oh); fclose(mp); }
            }
        }
    }

    // Raw pixel mode, when it was asked for. Almost always this is an atomic load
    // and a return, so the disabled interposer behaves exactly as it did before.
    raw_present_tick(renderer);

    bool has_receivers = (g_server && g_server->active_ws_clients() > 0);
    if (!has_receivers) {
        std::lock_guard<std::mutex> lock(g_rtc_lock);
        has_receivers = !g_active_dcs.empty();
    }

    // Backpressure: if the SCTP send queue is already deep, skip this frame
    // rather than queueing behind it. Queueing does not lose data, it makes it
    // late -- and every later frame then queues behind it too, which is how a
    // bursty link turns into multi-hundred-millisecond lag. Removing this check
    // measured transport p95 at 259ms against the baseline's 86ms, with zero
    // packet loss, which is the signature of a queue rather than a drop.
    // Skipping is safe because nothing is consumed here: prev_cmds, the sequence
    // number and the client's stamp are all left untouched, so the next present
    // recomputes the same delta with more changes folded in and sends once the
    // queue has drained.
    // Frames are never held back for picture traffic. The queue can only grow
    // from pictures, and pictures are throttled at the source now (see
    // TEXTURE_QUEUE_BUDGET), so there is always room for a frame: a delta frame
    // is ~114 B against a 512 KB picture budget.
    //
    // The guard that used to live here tested 131,072 B, which is smaller than a
    // single 131,088 B chunk -- so one picture was enough to stop frames going
    // out, and the client sat on a stale screen until the queue drained.
    g_probe_renderer = renderer;
    if (g_frame_cmd_count == 0) g_presents_nocmd.fetch_add(1, std::memory_order_relaxed);
    if (g_frame_cmd_count > 0 && has_receivers) {
        std::lock_guard<std::mutex> send_lock(g_send_lock);
        const uint32_t seq_before = g_sent_seq;
        service_picture_send(g_frame_cmds, g_frame_cmd_count,
                             g_need_keyframe.load(), g_pending_combined_base.exchange(0));
        // Only meaningful if a frame actually went out: the hash must describe
        // the screen the client has been told about.
        if (g_sent_seq != seq_before) {
            uint64_t h = 0;
            if (sample_pixel_hash(renderer, h)) {
                g_last_sent_pixel_hash = h;
                g_last_sent_pixel_hash_valid = true;
            }
        }
    }

    // Remember what was just drawn - even when nobody is connected, because the
    // point is to have it ready for whoever connects next, which may be long
    // after this draw and with no further draw in between.
    if (g_frame_cmd_count > 0) {
        std::lock_guard<std::mutex> send_lock(g_send_lock);
        g_last_picture.assign(g_frame_cmds, g_frame_cmds + g_frame_cmd_count);
        g_last_picture_valid = true;
    }

    g_frame_cmd_count = 0;
    real_SDL_RenderPresent(renderer);

    // Pictures wait for frames, never the other way round. Running this after
    // the present also means the chunk copying happens while the renderer would
    // otherwise be idle waiting on vsync, instead of delaying the frame.
    drain_pending_textures();
}

// Everything the producer knows about what it sent, for the bench.
//
// All of it is counted at the send calls themselves. A byte total estimated
// anywhere else - from the log, from the client, from a payload size - would be a
// different number pretending to be the same one, and the whole point of the
// comparison is that both sides count the same thing at the same point.
// C++ linkage on purpose: the whole file is inside an extern "C" block, and a
// std::string return type has no business claiming C linkage.
static double median_of(std::vector<int64_t> v) {
    if (v.empty()) return -1;
    std::sort(v.begin(), v.end());
    return (double)v[v.size() / 2];
}

// Every message this process put on a link, for the spike forensics. Separate
// from /df-stats on purpose: the stats endpoint is polled several times a second
// during a run and this is read once, at the end, so making the poll carry it
// would put the measurement's own traffic on the link being measured.
extern "C++" std::string df_wire_json() {
    return g_wire_log.json(epoch_now_ms());
}

static int64_t max_of(std::vector<int64_t> v) {
    if (v.empty()) return -1;
    return *std::max_element(v.begin(), v.end());
}

extern "C++" std::string df_stats_json() {
    double raw_stamp_p50;
    {
        std::lock_guard<std::mutex> lock(g_raw_stamp_lock);
        raw_stamp_p50 = median_of(g_raw_stamp_ages_ms);
    }
    double stamp_p50;
    {
        std::lock_guard<std::mutex> lock(g_rtc_lock);
        stamp_p50 = median_of(g_stamp_ages_ms);
    }
    // Bytes still sitting in the SCTP send queue when a frame was handed over,
    // and how many clients are attached. The queue maximum is what makes a burst
    // visible: a total and a mean rate can hide a 500 ms stall behind a healthy
    // average. The client count is here so a run can prove it was measuring one
    // client - both paths share one stamp slot, so a second attached client (or
    // the raw path running while the smart path is measured) silently steals
    // answers from the one being measured.
    int64_t queue_max = -1;
    size_t clients = 0;
    {
        std::lock_guard<std::mutex> lock(g_rtc_lock);
        queue_max = max_of(g_queue_at_send);
        for (auto& dc : g_active_dcs) {
            if (dc && dc->isOpen()) clients++;
        }
    }
    char buf[2560];
    snprintf(buf, sizeof(buf),
             "{\"now\":%lld,"
             "\"window\":{\"w\":%d,\"h\":%d},"
             "\"wireBytes\":%llu,\"frames\":%llu,"
             "\"textures\":%llu,\"textureBytes\":%llu,"
             "\"textureNew\":%llu,\"textureRepeat\":%llu,"
             "\"stampSamples\":%llu,\"stampExpired\":%llu,\"stampP50\":%.0f,"
             "\"stampReceived\":%llu,\"stampOverwritten\":%llu,"
             "\"queueMax\":%lld,\"clients\":%zu,\"presents\":%llu,\"presentsSilent\":%llu,\"presentsNoCmd\":%llu,\"encodeNothing\":%llu,\"nothingPixelsSame\":%llu,\"nothingPixelsChanged\":%llu,\"hookUsTotal\":%llu,\"hookCalls\":%llu,\"inputMsgs\":%llu,\"motionIn\":%llu,\"motionOut\":%llu,\"presentUsTotal\":%llu,\"presentUsMax\":%llu,\"presentCount\":%llu,\"picCreated\":%llu,\"picDistinct\":%llu,\"sendBlockMaxUs\":%lld,\"presentMaxUs\":%lld,"
             "\"dc\":{\"sendCalls\":%llu,\"queued\":%llu,\"threw\":%llu,"
             "\"bytesOffered\":%llu,\"bufferedMax\":%lld,\"bufferedNow\":%lld,"
             "\"unordered\":%d,\"maxRetransmits\":%d,\"maxPacketLifeTime\":%d},"
             "\"probe\":{\"on\":%d,\"done\":%d,\"rate\":%d,\"size\":%d,"
             "\"target\":%llu,\"sent\":%llu,\"bytes\":%llu},"
             "\"raw\":{\"on\":%d,\"connected\":%d,\"sent\":%llu,\"changed\":%llu,"
             "\"same\":%llu,\"bytes\":%llu,\"dropped\":%llu,\"stampExpired\":%llu,"
             "\"stampAnswered\":%llu,\"stampP50\":%.0f},"
             "\"rc\":{\"copy\":%llu,\"unknown\":%llu,\"nopix\":%llu,\"cmds\":%llu,\"upd\":%llu,\"copyex\":%llu}}",
             (long long)epoch_now_ms(),
             g_current_w, g_current_h,
             (unsigned long long)g_wire_bytes,
             (unsigned long long)g_wire_frames,
             (unsigned long long)g_tex_count,
             (unsigned long long)g_tex_bytes,
             (unsigned long long)g_tex_new,
             (unsigned long long)g_tex_repeat,
             (unsigned long long)g_stamp_slot.answered,
             (unsigned long long)g_stamp_slot.expired,
             stamp_p50,
             (unsigned long long)g_stamp_slot.received,
             (unsigned long long)g_stamp_slot.overwritten,
             (long long)queue_max,
             clients,
             (unsigned long long)g_presents.load(),
             (unsigned long long)g_presents_silent.load(),
             (unsigned long long)g_presents_nocmd.load(),
             (unsigned long long)g_delta_encoder.stat_nothing,
             (unsigned long long)g_nothing_pixels_same.load(),
             (unsigned long long)g_nothing_pixels_changed.load(),
             (unsigned long long)(g_hook_ns.load() / 1000),
             (unsigned long long)g_hook_calls.load(),
             (unsigned long long)g_input_msgs.load(),
             (unsigned long long)g_motion_superseded.load(),
             (unsigned long long)g_motion_delivered.load(),
             (unsigned long long)g_present_us_total.load(),
             (unsigned long long)g_present_us_max.load(),
             (unsigned long long)g_present_count.load(),
             (unsigned long long)g_pic_created.load(),
             (unsigned long long)g_pic_distinct.load(),
             (long long)g_send_block_max_us.load(),
             (long long)g_present_max_us.load(),
             (unsigned long long)g_dc_send_calls.load(std::memory_order_relaxed),
             (unsigned long long)g_dc_send_queued.load(std::memory_order_relaxed),
             (unsigned long long)g_dc_send_threw.load(std::memory_order_relaxed),
             (unsigned long long)g_dc_bytes_offered.load(std::memory_order_relaxed),
             (long long)g_dc_buffered_max.load(std::memory_order_relaxed),
             (long long)g_dc_buffered_now.load(std::memory_order_relaxed),
             g_dc_rel_unordered.load(std::memory_order_relaxed),
             g_dc_rel_max_retransmits.load(std::memory_order_relaxed),
             g_dc_rel_max_lifetime.load(std::memory_order_relaxed),
             g_probe_on.load(std::memory_order_relaxed),
             g_probe_done.load(std::memory_order_relaxed),
             g_probe_rate.load(std::memory_order_relaxed),
             g_probe_size.load(std::memory_order_relaxed),
             (unsigned long long)g_probe_target.load(std::memory_order_relaxed),
             (unsigned long long)g_probe_sent.load(std::memory_order_relaxed),
             (unsigned long long)g_probe_bytes.load(std::memory_order_relaxed),
             (int)(g_raw_on.load() ? 1 : 0),
             (int)g_raw_connected.load(),
             (unsigned long long)g_raw_sent.load(),
             (unsigned long long)g_raw_changed.load(),
             (unsigned long long)g_raw_same.load(),
             (unsigned long long)g_raw_bytes.load(),
             (unsigned long long)g_raw_dropped.load(),
             (unsigned long long)g_raw_stamp_expired.load(),
             (unsigned long long)g_raw_stamp_answered.load(),
             raw_stamp_p50,
             (unsigned long long)g_rc_copy_calls.load(),
             (unsigned long long)g_draw_unknown,
             (unsigned long long)g_draw_nopixels,
             (unsigned long long)g_frame_cmd_count,
             (unsigned long long)g_upd_calls.load(),
             (unsigned long long)g_rc_copyex_calls.load());
    return std::string(buf);
}

__attribute__((constructor))
static void init_interposer() {
    fprintf(stderr, "[INIT] libdf_streamer constructor started!\n"); fflush(stderr);
    resolve_symbols();
    const char* p_str = getenv("PORT");
    int port = p_str ? atoi(p_str) : 8484;
    const char* r_str = getenv("WEB_ROOT");
    std::string root = r_str ? r_str : "/tmp/remote-df/client";
    g_server = new EmbeddedServer();
    g_server->start(port, root);
    // Started last, so the raw mode is never the reason a stream fails to come up.
    raw_init();
    // The controlled-load probe: idle until /tmp/df_load_probe appears, so it
    // costs one thread that sleeps 200ms at a time when nobody is asking.
    load_probe_start();
}

__attribute__((destructor))
static void cleanup_interposer() {
    // Stop the raw worker and wait for it before the globals it reads go away.
    // Without this the thread could be inside the input handler while the process
    // is tearing down the state that handler uses.
    g_raw_stop.store(true);
    if (g_raw_thread.joinable()) g_raw_thread.join();
    g_probe_stop.store(true);
    if (g_probe_thread.joinable()) g_probe_thread.join();
    if (g_server) { g_server->stop(); delete g_server; g_server = nullptr; }
}

} // extern "C"
