// A stand-in for the parts of SDL2 the interposer's present path touches.
//
// It is a separate dynamic library on purpose: the interposer is loaded ahead of
// it (DYLD_INSERT_LIBRARIES, the macOS equivalent of LD_PRELOAD), so
// dlsym(RTLD_NEXT, "SDL_RenderPresent") inside the interposer finds these, exactly
// as it finds the real SDL2 in the game.
//
// Build: cc -dynamiclib -O1 -o /tmp/libfakesdl.dylib tests/raw_mode_harness/fakesdl.c
//
// See tests/raw_mode_harness/README.md.

#include <stddef.h>
#include <stdint.h>

static const int FAKE_W = 64;
static const int FAKE_H = 48;

void SDL_RenderPresent(void* renderer) { (void)renderer; }

int SDL_GetRendererOutputSize(void* renderer, int* w, int* h) {
    (void)renderer;
    *w = FAKE_W;
    *h = FAKE_H;
    return 0;
}

// Fills the framebuffer with a known gradient, so the test can tell a JPEG of this
// frame apart from any other bytes that happen to arrive.
int SDL_RenderReadPixels(void* renderer, const void* rect, uint32_t format, void* pixels, int pitch) {
    (void)renderer;
    (void)rect;
    (void)format;
    uint8_t* p = (uint8_t*)pixels;
    for (int y = 0; y < FAKE_H; y++) {
        for (int x = 0; x < FAKE_W; x++) {
            uint8_t* px = p + (size_t)y * (size_t)pitch + (size_t)x * 4;
            px[0] = (uint8_t)(x * 4);
            px[1] = (uint8_t)(y * 5);
            px[2] = 128;
            px[3] = 0x7F;
        }
    }
    return 0;
}

int SDL_PushEvent(void* ev) { (void)ev; return 1; }
void SDL_SetModState(int mod) { (void)mod; }
