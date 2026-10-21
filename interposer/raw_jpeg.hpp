#pragma once
// JPEG encoding for the opt-in raw pixel mode (DF_RAW_STREAM=1).
//
// This lives in its own header, with no SDL and no libdatachannel dependency, so
// the encoder can be compiled and run on a development machine that has neither.
// Everywhere else in the interposer a mistake is caught by starting a stream and
// watching it; here the alternative would be an unexplained silence from a remote
// host, so the encoder is deliberately kept testable on its own
// (tests/raw_jpeg_test.cpp).

// The standard headers come first on purpose: jpeglib.h uses size_t and FILE
// without including anything that defines them, so it only compiles when they are
// already in scope. Including it first fails with "unknown type name 'size_t'".
#include <csetjmp>
#include <cstddef>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <vector>

#include <jpeglib.h>

// libjpeg's default fatal error handler calls exit(). In a preloaded library that
// means a bad frame - an allocation that fails while the game is running - kills
// Dwarf Fortress mid-session. The documented alternative is to longjmp back to the
// caller and report the failure, which is what this manager does. The mode is a
// sanity-check baseline; it must never be the reason the game dies.
struct RawJpegErrorMgr {
    jpeg_error_mgr pub;
    std::jmp_buf jump;
};

static void raw_jpeg_error_exit(j_common_ptr cinfo) {
    RawJpegErrorMgr* mgr = (RawJpegErrorMgr*)cinfo->err;
    std::longjmp(mgr->jump, 1);
}

// Encode one RGBA framebuffer as a JPEG.
//
// The input is what SDL_RenderReadPixels gives back for SDL_PIXELFORMAT_ABGR8888,
// which on a little-endian machine is the byte order R,G,B,A. JPEG carries no
// alpha, so the alpha byte is dropped. The rows are repacked into three bytes per
// pixel and handed to libjpeg as plain JCS_RGB: libjpeg-turbo can read RGBA input
// directly through JCS_EXT_RGBA, but that is a turbo-only extension and the deploy
// image is not guaranteed to have turbo, so the portable path is used. The repack
// is one row of memcpy-sized work against a full-frame DCT, so it costs nothing
// measurable.
//
// Returns false and leaves `out` empty if the frame is unusable or the encoder
// fails. Callers drop the frame; there is nothing to repair.
static bool raw_jpeg_encode(const uint8_t* rgba, int w, int h, int quality,
                            std::vector<uint8_t>& out) {
    out.clear();
    if (!rgba || w <= 0 || h <= 0) return false;
    if (quality < 1) quality = 1;
    if (quality > 100) quality = 100;

    // Set by the longjmp path so the cleanup knows whether libjpeg handed out a
    // buffer that still has to be released. volatile because its value is read
    // after a longjmp, where an ordinary local would be indeterminate.
    volatile bool created = false;
    unsigned char* mem = nullptr;
    unsigned long mem_size = 0;

    jpeg_compress_struct cinfo;
    RawJpegErrorMgr err;
    memset(&cinfo, 0, sizeof(cinfo));
    memset(&err, 0, sizeof(err));
    cinfo.err = jpeg_std_error(&err.pub);
    err.pub.error_exit = raw_jpeg_error_exit;

    if (setjmp(err.jump)) {
        if (created) jpeg_destroy_compress(&cinfo);
        if (mem) free(mem);
        out.clear();
        fprintf(stderr, "[RAW] JPEG encode failed for %dx%d frame, dropping it\n", w, h);
        fflush(stderr);
        return false;
    }

    jpeg_create_compress(&cinfo);
    created = true;

    // Writing into memory rather than a file: the three bytes of protocol framing
    // are prepended by the caller, and a file in /tmp would be one more thing to
    // clean up on a host that has to keep running unattended.
    jpeg_mem_dest(&cinfo, &mem, &mem_size);
    cinfo.image_width = (JDIMENSION)w;
    cinfo.image_height = (JDIMENSION)h;
    cinfo.input_components = 3;
    cinfo.in_color_space = JCS_RGB;
    jpeg_set_defaults(&cinfo);
    jpeg_set_quality(&cinfo, quality, TRUE);
    jpeg_start_compress(&cinfo, TRUE);

    std::vector<uint8_t> row((size_t)w * 3);
    while (cinfo.next_scanline < cinfo.image_height) {
        const uint8_t* src = rgba + (size_t)cinfo.next_scanline * (size_t)w * 4;
        for (int x = 0; x < w; x++) {
            row[(size_t)x * 3 + 0] = src[(size_t)x * 4 + 0];
            row[(size_t)x * 3 + 1] = src[(size_t)x * 4 + 1];
            row[(size_t)x * 3 + 2] = src[(size_t)x * 4 + 2];
        }
        JSAMPROW row_ptr = row.data();
        jpeg_write_scanlines(&cinfo, &row_ptr, 1);
    }

    jpeg_finish_compress(&cinfo);
    jpeg_destroy_compress(&cinfo);
    created = false;

    if (!mem || mem_size == 0) {
        if (mem) free(mem);
        return false;
    }
    out.assign(mem, mem + mem_size);
    free(mem);
    return true;
}
