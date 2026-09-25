#include <iostream>
#include <vector>
#include <deque>
#include <string>
#include <mutex>
#include <thread>
#include <atomic>
#include <cstdint>
#include <cstring>
#include <cstdlib>
#include <dlfcn.h>
#include <unistd.h>
#include <sys/stat.h>
#include <zstd.h>
#include <execinfo.h>
#include <unordered_map>
#include <algorithm>
#include <memory>
#include <variant>
#include <rtc/rtc.hpp>

#include "ws_server.hpp"

#define MAX_DRAW_COMMANDS 32768
#define MAX_TEXTURES 4096

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
    uint8_t magic[2];      // 'D', 'T'
    uint16_t tex_id;
    uint16_t w;
    uint16_t h;
    uint32_t payload_len;  // w * h * 4
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
static uint32_t (*real_SDL_GetMouseState)(int*, int*) = nullptr;
static void (*real_SDL_DestroyTexture)(void*) = nullptr;
static int (*real_SDL_RenderReadPixels)(void*, const SDL_Rect*, uint32_t, void*, int) = nullptr;
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
class DeltaEncoder {
public:
    DrawCommand prev_cmds[MAX_DRAW_COMMANDS];
    uint16_t prev_count = 0;
    DeltaUpdate delta_updates[MAX_DRAW_COMMANDS];

    bool encode_frame(uint32_t seq, const DrawCommand* curr_cmds, uint16_t curr_count,
                      bool force_keyframe, uint8_t stamp, std::vector<uint8_t>& out_packet) {
        bool send_full = force_keyframe || (prev_count == 0) || (curr_count != prev_count);

        uint16_t num_updates = 0;
        if (!send_full) {
            uint16_t min_count = std::min(curr_count, prev_count);
            for (uint16_t i = 0; i < min_count; ++i) {
                if (memcmp(&curr_cmds[i], &prev_cmds[i], sizeof(DrawCommand)) != 0) {
                    delta_updates[num_updates].index = i;
                    delta_updates[num_updates].cmd = curr_cmds[i];
                    num_updates++;
                }
            }

            // If more than 50% changed, send full frame
            if (num_updates > (curr_count / 2)) {
                send_full = true;
            }
        }

        FrameHeader hdr;
        hdr.magic[0] = 'D';
        hdr.magic[1] = 'F';
        hdr.frame_seq = seq;
        hdr.cmd_count = curr_count;

        bool include_stamp = (stamp != 0);

        if (send_full) {
            hdr.flags = 0x01; // Full frame
            if (include_stamp) hdr.flags |= 0x04;

            size_t raw_len = curr_count * sizeof(DrawCommand);
            size_t max_comp = ZSTD_compressBound(raw_len);
            size_t header_size = sizeof(hdr) + (include_stamp ? 1 : 0);

            out_packet.resize(header_size + max_comp);
            memcpy(out_packet.data(), &hdr, sizeof(hdr));
            if (include_stamp) {
                out_packet[sizeof(hdr)] = stamp;
            }

            size_t c_size = ZSTD_compress(out_packet.data() + header_size, max_comp, curr_cmds, raw_len, 1);
            if (ZSTD_isError(c_size)) return false;
            out_packet.resize(header_size + c_size);
        } else {
            hdr.flags = 0x02; // Delta frame
            if (include_stamp) hdr.flags |= 0x04;

            size_t payload_len = 2 + num_updates * sizeof(DeltaUpdate);
            std::vector<uint8_t> raw_payload(payload_len);
            memcpy(raw_payload.data(), &num_updates, 2);
            if (num_updates > 0) {
                memcpy(raw_payload.data() + 2, delta_updates, num_updates * sizeof(DeltaUpdate));
            }

            size_t max_comp = ZSTD_compressBound(payload_len);
            size_t header_size = sizeof(hdr) + (include_stamp ? 1 : 0);

            out_packet.resize(header_size + max_comp);
            memcpy(out_packet.data(), &hdr, sizeof(hdr));
            if (include_stamp) {
                out_packet[sizeof(hdr)] = stamp;
            }

            size_t c_size = ZSTD_compress(out_packet.data() + header_size, max_comp, raw_payload.data(), payload_len, 1);
            if (ZSTD_isError(c_size)) return false;
            out_packet.resize(header_size + c_size);
        }

        memcpy(prev_cmds, curr_cmds, curr_count * sizeof(DrawCommand));
        prev_count = curr_count;
        return send_full;
    }
};

static DeltaEncoder g_delta_encoder;
static uint32_t g_frame_seq = 0;
static std::atomic<bool> g_need_keyframe{true};

static void resolve_symbols() {
    if (!real_SDL_RenderCopy) real_SDL_RenderCopy = (int(*)(void*,void*,const SDL_Rect*,const SDL_Rect*))dlsym(RTLD_NEXT, "SDL_RenderCopy");
    if (!real_SDL_RenderCopyEx) real_SDL_RenderCopyEx = (int(*)(void*,void*,const SDL_Rect*,const SDL_Rect*,double,const void*,int))dlsym(RTLD_NEXT, "SDL_RenderCopyEx");
    if (!real_SDL_RenderClear) real_SDL_RenderClear = (int(*)(void*))dlsym(RTLD_NEXT, "SDL_RenderClear");
    if (!real_SDL_RenderPresent) real_SDL_RenderPresent = (void(*)(void*))dlsym(RTLD_NEXT, "SDL_RenderPresent");
    if (!real_SDL_PushEvent) real_SDL_PushEvent = (int(*)(void*))dlsym(RTLD_NEXT, "SDL_PushEvent");
    if (!real_SDL_CreateTextureFromSurface) real_SDL_CreateTextureFromSurface = (void*(*)(void*,void*))dlsym(RTLD_NEXT, "SDL_CreateTextureFromSurface");
    if (!real_SDL_GetMouseState) real_SDL_GetMouseState = (uint32_t(*)(int*,int*))dlsym(RTLD_NEXT, "SDL_GetMouseState");
    if (!real_SDL_DestroyTexture) real_SDL_DestroyTexture = (void(*)(void*))dlsym(RTLD_NEXT, "SDL_DestroyTexture");
    if (!real_SDL_RenderReadPixels) real_SDL_RenderReadPixels = (int(*)(void*,const SDL_Rect*,uint32_t,void*,int))dlsym(RTLD_NEXT, "SDL_RenderReadPixels");
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

static uint8_t g_current_client_stamp = 0;
static bool g_has_client_stamp = false;
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

// Hook SDL_PollEvent: guarantees DF mainloop() always sees mouse clicks before mouse release
extern "C" int SDL_PollEvent(void* event) {
    if (!real_SDL_PollEvent) resolve_symbols();

    int target_w = g_pending_resize_w.exchange(0);
    int target_h = g_pending_resize_h.exchange(0);
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

    // 2. Poll real SDL
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
void handle_client_input_event(const uint8_t* data, size_t len) {
    if (len < sizeof(InputEvent)) return;
    const InputEvent* ev = (const InputEvent*)data;
    if (len >= 17 && data[16] != 0) {
        g_current_client_stamp = data[16];
        g_has_client_stamp = true;
    }

    ensure_mouse_focus();

    if (ev->event_type == 1) { // MOUSEMOTION
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

static uint16_t get_texture_id(void* texture) {
    if (!texture) return 0;
    std::lock_guard<std::mutex> lock(g_tex_lock);
    for (uint16_t i = 0; i < g_texture_count; i++) {
        if (g_textures[i] == texture) return i + 1;
    }
    // Monotonically allocate new IDs so destroyed texture slots are never recycled across frame transitions
    if (g_texture_count < MAX_TEXTURES) {
        uint16_t id = ++g_texture_count;
        g_textures[id - 1] = texture;
        return id;
    }
    // Fallback: recycle null slots only if MAX_TEXTURES is completely saturated
    for (uint16_t i = 0; i < MAX_TEXTURES; i++) {
        if (g_textures[i] == nullptr) {
            g_textures[i] = texture;
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
                fprintf(stderr, "[WebRTC] onDataChannel callback triggered for label='%s' fd=%d\n", dc->label().c_str(), fd);
                fflush(stderr);

                dc->onOpen([fd, dc]() {
                    fprintf(stderr, "[WebRTC] True UDP DataChannel '%s' OPEN for fd=%d\n", dc->label().c_str(), fd);
                    fflush(stderr);
                    g_need_keyframe.store(true);
                    std::lock_guard<std::mutex> lock(g_rtc_lock);
                    g_active_dcs.push_back(dc);
                });

                dc->onClosed([fd, dc]() {
                    fprintf(stderr, "[WebRTC] DataChannel '%s' CLOSED for fd=%d\n", dc->label().c_str(), fd);
                    fflush(stderr);
                    std::lock_guard<std::mutex> lock(g_rtc_lock);
                    g_active_dcs.erase(std::remove(g_active_dcs.begin(), g_active_dcs.end(), dc), g_active_dcs.end());
                });

                dc->onMessage([](auto data) {
                    if (std::holds_alternative<rtc::binary>(data)) {
                        auto& b = std::get<rtc::binary>(data);
                        handle_client_input_event((const uint8_t*)b.data(), b.size());
                    }
                });

                std::lock_guard<std::mutex> lock(g_rtc_lock);
                g_rtc_sessions[fd].dc = dc;
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

void SDL_DestroyTexture(void* texture) {
    if (!real_SDL_DestroyTexture) resolve_symbols();
    if (texture) {
        std::lock_guard<std::mutex> lock(g_tex_lock);
        for (uint16_t i = 0; i < g_texture_count; i++) {
            if (g_textures[i] == texture) {
                g_textures[i] = nullptr;
                g_cached_textures[i].rgba.clear();
                break;
            }
        }
    }
    if (real_SDL_DestroyTexture && texture) real_SDL_DestroyTexture(texture);
}

void* SDL_CreateTextureFromSurface(void* renderer, void* surface) {
    if (!real_SDL_CreateTextureFromSurface) resolve_symbols();
    void* tex = real_SDL_CreateTextureFromSurface ? real_SDL_CreateTextureFromSurface(renderer, surface) : nullptr;
    if (!tex || !surface) return tex;

    SDL_Surface_Internal* s = (SDL_Surface_Internal*)surface;
    if (s->w <= 0 || s->h <= 0 || !s->pixels) return tex;

    uint16_t id = get_texture_id(tex);
    if (id > 0 && id <= MAX_TEXTURES) {
        std::lock_guard<std::mutex> lock(g_tex_lock);
        CachedTexture& ct = g_cached_textures[id - 1];
        ct.id = id;
        ct.w = (uint16_t)s->w;
        ct.h = (uint16_t)s->h;
        ct.rgba.resize((size_t)ct.w * ct.h * 4);

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
        send_texture_packet(-1, ct);
    }
    return tex;
}

int SDL_RenderClear(void* renderer) {
    if (!real_SDL_RenderClear) resolve_symbols();
    g_frame_cmd_count = 0;
    return real_SDL_RenderClear ? real_SDL_RenderClear(renderer) : 0;
}

int SDL_RenderCopy(void* renderer, void* texture, const SDL_Rect* srcrect, const SDL_Rect* dstrect) {
    if (!real_SDL_RenderCopy) resolve_symbols();
    int res = real_SDL_RenderCopy ? real_SDL_RenderCopy(renderer, texture, srcrect, dstrect) : 0;
    if (res != 0) return res;

    if (g_frame_cmd_count < MAX_DRAW_COMMANDS) {
        DrawCommand& cmd = g_frame_cmds[g_frame_cmd_count++];
        cmd.tex_id = get_texture_id(texture);
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
    SDL_RenderCopy(renderer, texture, srcrect, dstrect);
    return real_SDL_RenderCopyEx(renderer, texture, srcrect, dstrect, angle, center, flip);
}

void SDL_RenderPresent(void* renderer) {
    if (!real_SDL_RenderPresent) resolve_symbols();
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

    // On-demand snapshot trigger for QA parity suite
    if (access("/tmp/df_snap_trigger", F_OK) == 0 && real_SDL_RenderReadPixels) {
        unlink("/tmp/df_snap_trigger");
        std::vector<uint8_t> snap_pixel_buf(g_current_w * g_current_h * 4);
        if (real_SDL_RenderReadPixels(renderer, nullptr, 376840196 /* SDL_PIXELFORMAT_ABGR8888 -> RGBA */, snap_pixel_buf.data(), g_current_w * 4) == 0) {
            FILE* fp = fopen("/tmp/df_snap_host.raw", "wb");
            if (fp) {
                fwrite(snap_pixel_buf.data(), 1, snap_pixel_buf.size(), fp);
                fclose(fp);
            }
        }
    }

    bool has_receivers = (g_server && g_server->active_ws_clients() > 0);
    if (!has_receivers) {
        std::lock_guard<std::mutex> lock(g_rtc_lock);
        has_receivers = !g_active_dcs.empty();
    }

    if (g_frame_cmd_count > 0 && has_receivers) {
        uint8_t stamp = 0;
        if (g_has_client_stamp && g_current_client_stamp != 0) {
            stamp = g_current_client_stamp;
            g_has_client_stamp = false;
            g_current_client_stamp = 0;
        }

        std::vector<uint8_t> frame_packet;
        bool is_full = g_delta_encoder.encode_frame(g_frame_seq, g_frame_cmds, g_frame_cmd_count, g_need_keyframe.load(), stamp, frame_packet);
        if (is_full) {
            g_need_keyframe.store(false);
        }

        if (!frame_packet.empty()) {
            bool sent_webrtc = false;
            {
                std::lock_guard<std::mutex> lock(g_rtc_lock);
                for (auto& dc : g_active_dcs) {
                    if (dc && dc->isOpen()) {
                        // Drop frame if UDP buffer is backed up (>64KB) to eliminate bufferbloat
                        if (dc->bufferedAmount() < 65536) {
                            dc->send((const std::byte*)frame_packet.data(), frame_packet.size());
                            sent_webrtc = true;
                        }
                    }
                }
            }

            if (!sent_webrtc && g_server && g_server->active_ws_clients() > 0) {
                g_server->broadcast_ws_binary(frame_packet.data(), frame_packet.size());
            }
        }
    }

    g_frame_cmd_count = 0;
    real_SDL_RenderPresent(renderer);
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
}

__attribute__((destructor))
static void cleanup_interposer() {
    if (g_server) { g_server->stop(); delete g_server; g_server = nullptr; }
}

} // extern "C"
