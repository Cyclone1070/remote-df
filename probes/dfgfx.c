/*
 * dfgfx.c — observe the boundary between Dwarf Fortress and its graphics layer.
 *
 * This is NOT about the browser or the network. This sits between DF's own
 * rendering code (libg_src_lib.so) and SDL2, and records the exact primitives
 * DF hands to its graphics layer:
 *
 *   - which textures DF creates, and where each one came from
 *     (a PNG file on disk, a font glyph, or pixels DF synthesised itself)
 *   - every SDL_RenderCopy: which texture, which source rect, which dest rect
 *   - frame boundaries at SDL_RenderPresent
 *
 * Detail capture is triggered by creating /tmp/dfgfx/capture, so a specific
 * screen can be recorded on demand. Without the marker only per-frame totals
 * are written, which keeps the log small during normal running.
 *
 * SAFETY: this runs inside an LD_PRELOAD constructor in the game process.
 * It must never fork, exec, or shell out - a child would inherit LD_PRELOAD
 * and re-enter this library. RLIMIT_NPROC is clamped as a hard backstop.
 */
#define _GNU_SOURCE
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <dlfcn.h>
#include <time.h>
#include <sys/resource.h>
#include <sys/stat.h>

typedef struct { short x, y; unsigned short w, h; } Rect;

static FILE *g_log;
static int g_frame;
static int g_detail_frames;          /* frames left to record in full */
static long g_frame_draws;           /* draws seen so far this frame */
static long g_frame_newtex;          /* textures created this frame */
static unsigned long g_total_draws;
static char g_last_caller[128];

static void *(*real_CreateTexture)(void *, unsigned, int, int, int);
static void *(*real_CreateTextureFromSurface)(void *, void *);
static int   (*real_RenderCopy)(void *, void *, const Rect *, const Rect *);
static int   (*real_RenderPresent)(void *);
static void *(*real_IMG_Load)(const char *);
static int   (*real_UpperBlit)(void *, const Rect *, void *, Rect *);
static int   (*real_RenderFillRect)(void *, const Rect *);
static int   (*real_RenderClear)(void *);
static int   (*real_SetSurfaceColorMod)(void *, unsigned char, unsigned char, unsigned char);
static int   (*real_SetSurfaceAlphaMod)(void *, unsigned char);
static int   (*real_SetColorKey)(void *, int, unsigned);
static int   (*real_SetTextureColorMod)(void *, unsigned char, unsigned char, unsigned char);
static int   (*real_SetTextureAlphaMod)(void *, unsigned char);
static void *(*real_ConvertSurfaceFormat)(void *, unsigned, unsigned);
static void *(*real_CreateRGBSurface)(unsigned, int, int, int, unsigned, unsigned, unsigned, unsigned);
static int   (*real_LockSurface)(void *);
static int   (*real_UnlockSurface)(void *);

/* Which shared object called us - proves the caller is DF's renderer.
 * The return address MUST be read inside the hook itself, not in a helper,
 * or it resolves to this library instead of the real caller. */
static const char *caller(void *ra)
{
    Dl_info info;
    if (ra && dladdr(ra, &info) && info.dli_fname) {
        const char *p = strrchr(info.dli_fname, '/');
        snprintf(g_last_caller, sizeof(g_last_caller), "%s", p ? p + 1 : info.dli_fname);
    } else {
        snprintf(g_last_caller, sizeof(g_last_caller), "?");
    }
    return g_last_caller;
}

static int marker_present(void)
{
    struct stat st;
    return stat("/tmp/dfgfx/capture", &st) == 0;
}

/* Loaded via /etc/ld.so.preload, so this constructor runs in EVERY process in
 * the container (server, Xvfb, shells). Only the game itself should log. */
static int g_active;

static int is_game_process(void)
{
    FILE *f = fopen("/proc/self/comm", "r");
    if (!f) return 0;
    char buf[64] = { 0 };
    if (!fgets(buf, sizeof(buf) - 1, f)) { fclose(f); return 0; }
    fclose(f);
    size_t n = strlen(buf);
    while (n && (buf[n - 1] == '\n' || buf[n - 1] == '\r')) buf[--n] = 0;
    return strcmp(buf, "dwarfort") == 0;
}

__attribute__((constructor)) static void dfgfx_init(void)
{
    /* Always resolve the real symbols, even when we are not logging, or the
     * hooks below would swallow SDL calls in another process. */
    real_IMG_Load                = dlsym(RTLD_NEXT, "IMG_Load");
    real_CreateTexture           = dlsym(RTLD_NEXT, "SDL_CreateTexture");
    real_CreateTextureFromSurface = dlsym(RTLD_NEXT, "SDL_CreateTextureFromSurface");
    real_RenderCopy              = dlsym(RTLD_NEXT, "SDL_RenderCopy");
    real_RenderPresent           = dlsym(RTLD_NEXT, "SDL_RenderPresent");
    real_UpperBlit               = dlsym(RTLD_NEXT, "SDL_UpperBlit");
    real_RenderFillRect          = dlsym(RTLD_NEXT, "SDL_RenderFillRect");
    real_RenderClear             = dlsym(RTLD_NEXT, "SDL_RenderClear");
    real_SetSurfaceColorMod      = dlsym(RTLD_NEXT, "SDL_SetSurfaceColorMod");
    real_SetSurfaceAlphaMod      = dlsym(RTLD_NEXT, "SDL_SetSurfaceAlphaMod");
    real_SetColorKey             = dlsym(RTLD_NEXT, "SDL_SetColorKey");
    real_SetTextureColorMod      = dlsym(RTLD_NEXT, "SDL_SetTextureColorMod");
    real_SetTextureAlphaMod      = dlsym(RTLD_NEXT, "SDL_SetTextureAlphaMod");
    real_ConvertSurfaceFormat    = dlsym(RTLD_NEXT, "SDL_ConvertSurfaceFormat");
    real_CreateRGBSurface        = dlsym(RTLD_NEXT, "SDL_CreateRGBSurface");

    if (!is_game_process()) return;         /* leave every other process alone */
    g_active = 1;

    struct rlimit rl = { 1024, 1024 };
    setrlimit(RLIMIT_NPROC, &rl);            /* backstop against runaway children */

    mkdir("/tmp/dfgfx", 0777);
    mkdir("/tmp/dfgfx/sprites", 0777);
    real_LockSurface = dlsym(RTLD_NEXT, "SDL_LockSurface");
    real_UnlockSurface = dlsym(RTLD_NEXT, "SDL_UnlockSurface");

    g_log = fopen("/tmp/dfgfx/gfx.log", "w");
    if (!g_log) return;
    setvbuf(g_log, NULL, _IOLBF, 0);
    fprintf(g_log, "# dfgfx: DF <-> graphics-layer boundary trace\n");
    fprintf(g_log, "# hooks: CreateTexture=%p FromSurface=%p RenderCopy=%p Present=%p IMG_Load=%p UpperBlit=%p\n",
            (void *)real_CreateTexture, (void *)real_CreateTextureFromSurface,
            (void *)real_RenderCopy, (void *)real_RenderPresent,
            (void *)real_IMG_Load, (void *)real_UpperBlit);
}

void *IMG_Load(const char *file)
{
    void *surf = real_IMG_Load ? real_IMG_Load(file) : NULL;
    if (g_log) fprintf(g_log, "IMG_LOAD file=%s surface=%p\n", file ? file : "(null)", surf);
    return surf;
}

void *SDL_CreateTexture(void *r, unsigned fmt, int access, int w, int h)
{
    void *tex = real_CreateTexture ? real_CreateTexture(r, fmt, access, w, h) : NULL;
    g_frame_newtex++;
    if (g_log)
        fprintf(g_log, "TEX_NEW tex=%p %dx%d format=0x%08x access=%d source=blank caller=%s\n",
                tex, w, h, fmt, access, caller(__builtin_return_address(0)));
    return tex;
}


/* ---- capture the pixels DF uploads -------------------------------------
 * SDL_Surface's layout is stable and these three fields are all we need to
 * read the image back out. Written as PPM, converted to PNG later. */
typedef struct {
    unsigned flags;
    void *format;
    int w, h;
    int pitch;
    void *pixels;
} SurfHdr;

typedef struct {
    unsigned format;
    void *palette;
    unsigned char BitsPerPixel, BytesPerPixel;
    unsigned char _pad[2];
    unsigned Rmask, Gmask, Bmask, Amask;
} FmtHdr;

static unsigned long g_sprite_seq;

static void dump_surface(void *tex, void *surface)
{
    if (!surface || !tex) return;
    SurfHdr *s = (SurfHdr *)surface;
    FmtHdr *f = (FmtHdr *)s->format;
    if (!s->pixels || !f || s->w <= 0 || s->h <= 0 || s->w > 4096 || s->h > 4096) return;
    if (f->BytesPerPixel != 4) return;

    if (real_LockSurface) real_LockSurface(surface);
    unsigned long seq = ++g_sprite_seq;
    char path[256];
    snprintf(path, sizeof(path), "/tmp/dfgfx/sprites/s_%06lu.ppm", seq);
    FILE *out = fopen(path, "wb");
    if (out) {
        fprintf(out, "P6\n%d %d\n255\n", s->w, s->h);
        unsigned rsh = 0, gsh = 0, bsh = 0;
        while (!((f->Rmask >> rsh) & 1)) rsh++;
        while (!((f->Gmask >> gsh) & 1)) gsh++;
        while (!((f->Bmask >> bsh) & 1)) bsh++;
        unsigned char *row = (unsigned char *)s->pixels;
        for (int y = 0; y < s->h; y++) {
            unsigned *px = (unsigned *)row;
            for (int x = 0; x < s->w; x++) {
                unsigned v = px[x];
                unsigned char rgb[3];
                rgb[0] = (unsigned char)((v & f->Rmask) >> rsh);
                rgb[1] = (unsigned char)((v & f->Gmask) >> gsh);
                rgb[2] = (unsigned char)((v & f->Bmask) >> bsh);
                fwrite(rgb, 1, 3, out);
            }
            row += s->pitch;
        }
        fclose(out);
        fprintf(g_log, "SPRITE tex=%p seq=%lu %dx%d file=s_%06lu.ppm\n",
                tex, seq, s->w, s->h, seq);
    }
    if (real_UnlockSurface) real_UnlockSurface(surface);
}

void *SDL_CreateTextureFromSurface(void *r, void *surface)
{
    void *tex = real_CreateTextureFromSurface ? real_CreateTextureFromSurface(r, surface) : NULL;
    g_frame_newtex++;
    if (g_log) {
        fprintf(g_log, "TEX_NEW tex=%p source=surface(%p) caller=%s\n", tex, surface, caller(__builtin_return_address(0)));
        dump_surface(tex, surface);       /* record the pixels DF is uploading */
    }
    return tex;
}

int SDL_RenderCopy(void *r, void *tex, const Rect *src, const Rect *dst)
{
    g_frame_draws++;
    g_total_draws++;
    if (g_detail_frames > 0 && g_log) {
        fprintf(g_log, "DRAW frame=%d tex=%p src=%d,%d,%d,%d dst=%d,%d,%d,%d caller=%s\n",
                g_frame, tex,
                src ? src->x : -1, src ? src->y : -1, src ? src->w : -1, src ? src->h : -1,
                dst ? dst->x : -1, dst ? dst->y : -1, dst ? dst->w : -1, dst ? dst->h : -1,
                caller(__builtin_return_address(0)));
    }
    return real_RenderCopy ? real_RenderCopy(r, tex, src, dst) : 0;
}

int SDL_RenderFillRect(void *r, const Rect *rect)
{
    g_frame_draws++;
    if (g_detail_frames > 0 && g_log)
        fprintf(g_log, "FILL frame=%d rect=%d,%d,%d,%d\n", g_frame,
                rect ? rect->x : -1, rect ? rect->y : -1, rect ? rect->w : -1, rect ? rect->h : -1);
    return real_RenderFillRect ? real_RenderFillRect(r, rect) : 0;
}

int SDL_RenderClear(void *r)
{
    if (g_detail_frames > 0 && g_log) fprintf(g_log, "CLEAR frame=%d\n", g_frame);
    return real_RenderClear ? real_RenderClear(r) : 0;
}

int SDL_UpperBlit(void *src, const Rect *sr, void *dst, Rect *dr)
{
    if (g_log)
        fprintf(g_log, "BLIT src=%p srcrect=%d,%d,%d,%d dst=%p dstrect=%d,%d,%d,%d\n",
                src, sr ? sr->x : -1, sr ? sr->y : -1, sr ? sr->w : -1, sr ? sr->h : -1,
                dst, dr ? dr->x : -1, dr ? dr->y : -1, dr ? dr->w : -1, dr ? dr->h : -1);
    return real_UpperBlit ? real_UpperBlit(src, sr, dst, dr) : 0;
}

/* --- derivation of sprites: the same surface becomes many textures --------
 * DF tints and colour-keys a surface before turning it into a texture, which
 * is how one loaded sheet yields hundreds of distinct sprites. */

int SDL_SetSurfaceColorMod(void *s, unsigned char r, unsigned char g, unsigned char b)
{
    if (g_log) fprintf(g_log, "TINT surface=%p rgb=%d,%d,%d\n", s, r, g, b);
    return real_SetSurfaceColorMod ? real_SetSurfaceColorMod(s, r, g, b) : 0;
}

int SDL_SetSurfaceAlphaMod(void *s, unsigned char a)
{
    if (g_log) fprintf(g_log, "ALPHA surface=%p a=%d\n", s, a);
    return real_SetSurfaceAlphaMod ? real_SetSurfaceAlphaMod(s, a) : 0;
}

int SDL_SetColorKey(void *s, int flag, unsigned key)
{
    if (g_log) fprintf(g_log, "COLORKEY surface=%p flag=%d key=0x%08x\n", s, flag, key);
    return real_SetColorKey ? real_SetColorKey(s, flag, key) : 0;
}

int SDL_SetTextureColorMod(void *t, unsigned char r, unsigned char g, unsigned char b)
{
    if (g_log) fprintf(g_log, "TEXTINT tex=%p rgb=%d,%d,%d\n", t, r, g, b);
    return real_SetTextureColorMod ? real_SetTextureColorMod(t, r, g, b) : 0;
}

int SDL_SetTextureAlphaMod(void *t, unsigned char a)
{
    if (g_log) fprintf(g_log, "TEXALPHA tex=%p a=%d\n", t, a);
    return real_SetTextureAlphaMod ? real_SetTextureAlphaMod(t, a) : 0;
}

void *SDL_ConvertSurfaceFormat(void *s, unsigned fmt, unsigned flags)
{
    void *out = real_ConvertSurfaceFormat ? real_ConvertSurfaceFormat(s, fmt, flags) : NULL;
    if (g_log) fprintf(g_log, "CONVERT src=%p -> dst=%p format=0x%08x\n", s, out, fmt);
    return out;
}

void *SDL_CreateRGBSurface(unsigned flags, int w, int h, int depth,
                           unsigned rm, unsigned gm, unsigned bm, unsigned am)
{
    void *s = real_CreateRGBSurface ? real_CreateRGBSurface(flags, w, h, depth, rm, gm, bm, am) : NULL;
    if (g_log) fprintf(g_log, "NEWSURFACE surface=%p %dx%d depth=%d caller=%s\n",
                       s, w, h, depth, caller(__builtin_return_address(0)));
    return s;
}

int SDL_RenderPresent(void *r)
{
    if (g_log) {
        /* A frame is complete here: this is the point where DF's accumulated
         * draw list is handed to the GPU. Record its shape, and on a triggered
         * capture record it in full (the DRAW lines above). */
        fprintf(g_log, "PRESENT frame=%d draws_this_frame=%ld new_textures=%ld detail=%s\n",
                g_frame, g_frame_draws, g_frame_newtex, g_detail_frames > 0 ? "yes" : "no");
        if (g_detail_frames > 0) {
            fprintf(g_log, "END_DETAIL frame=%d\n", g_frame);
            g_detail_frames--;
        }
    }
    g_frame++;
    g_frame_draws = 0;
    g_frame_newtex = 0;

    /* Arm a detailed capture on request (checked once per frame). */
    if (g_detail_frames == 0 && marker_present()) {
        unlink("/tmp/dfgfx/capture");
        g_detail_frames = 2;
        if (g_log) fprintf(g_log, "CAPTURE_ARMED next_frame=%d\n", g_frame);
    }

    return real_RenderPresent ? real_RenderPresent(r) : 0;
}
