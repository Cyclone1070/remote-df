// Standalone test for the opt-in raw pixel encoder used by DF_RAW_STREAM mode.
//
// It exists because the interposer itself cannot be compiled anywhere except the
// deploy host: it includes libdatachannel, which the development machine does not
// have. The encoder is therefore kept in a header with no libdatachannel and no
// SDL dependency, and this file compiles it against libjpeg alone. Without this,
// a mistake in the encoder would only show up as a remote stream that never
// appears, with no error message anywhere near the cause.
//
//   g++ -std=c++17 -O1 -Wall -Wextra -I/usr/local/include \
//       tests/raw_jpeg_test.cpp -o /tmp/raw_jpeg_test -L/usr/local/lib -ljpeg
//   /tmp/raw_jpeg_test

#include <cstdio>
#include <cstdlib>
#include <vector>

#include "../interposer/raw_jpeg.hpp"

#include <jpeglib.h>

static int g_failures = 0;

static void check(bool ok, const char* what) {
    printf("%s %s\n", ok ? "ok  " : "FAIL", what);
    if (!ok) g_failures++;
}

// Decode a JPEG back to RGB so the test can look at what the encoder produced
// rather than only at how many bytes came out.
static bool decode_jpeg(const std::vector<uint8_t>& jpg, int* w, int* h,
                        std::vector<uint8_t>* rgb, int* channels) {
    jpeg_decompress_struct cinfo;
    jpeg_error_mgr jerr;
    cinfo.err = jpeg_std_error(&jerr);
    jpeg_create_decompress(&cinfo);
    jpeg_mem_src(&cinfo, jpg.data(), (unsigned long)jpg.size());
    if (jpeg_read_header(&cinfo, TRUE) != JPEG_HEADER_OK) {
        jpeg_destroy_decompress(&cinfo);
        return false;
    }
    jpeg_start_decompress(&cinfo);
    *w = (int)cinfo.output_width;
    *h = (int)cinfo.output_height;
    *channels = (int)cinfo.output_components;
    rgb->assign((size_t)cinfo.output_width * cinfo.output_height * cinfo.output_components, 0);
    while (cinfo.output_scanline < cinfo.output_height) {
        uint8_t* row = rgb->data() + (size_t)cinfo.output_scanline * cinfo.output_width * cinfo.output_components;
        jpeg_read_scanlines(&cinfo, &row, 1);
    }
    jpeg_finish_decompress(&cinfo);
    jpeg_destroy_decompress(&cinfo);
    return true;
}

int main() {
    const int W = 64, H = 48;

    // A smooth gradient with a partially transparent alpha byte: the alpha must be
    // dropped (JPEG has no alpha channel) and must not leak into the colour.
    std::vector<uint8_t> rgba((size_t)W * H * 4);
    for (int y = 0; y < H; y++) {
        for (int x = 0; x < W; x++) {
            uint8_t* p = &rgba[((size_t)y * W + x) * 4];
            p[0] = (uint8_t)(x * 4);      // R
            p[1] = (uint8_t)(y * 5);      // G
            p[2] = 128;                   // B
            p[3] = 0x7F;                  // A, must be ignored
        }
    }

    std::vector<uint8_t> jpg;
    check(raw_jpeg_encode(rgba.data(), W, H, 80, jpg), "encode returns true for a valid RGBA frame");
    check(jpg.size() > 0x100, "encoded frame is not empty");
    check(jpg.size() >= 2 && jpg[0] == 0xFF && jpg[1] == 0xD8, "encoded frame starts with the JPEG SOI marker");
    check(jpg.size() >= 2 && jpg[jpg.size() - 2] == 0xFF && jpg[jpg.size() - 1] == 0xD9,
          "encoded frame ends with the JPEG EOI marker");

    int dw = 0, dh = 0, ch = 0;
    std::vector<uint8_t> decoded;
    check(decode_jpeg(jpg, &dw, &dh, &decoded, &ch), "encoded frame decodes again");
    check(dw == W && dh == H, "decoded size matches the captured size");
    check(ch == 3, "decoded frame has no alpha channel");

    if (ch == 3 && dw == W && dh == H) {
        // JPEG is lossy, so exact equality is the wrong test. What matters is that
        // the colour survived and that the ignored alpha byte did not bleed in.
        int worst = 0;
        for (int y = 0; y < H; y++) {
            for (int x = 0; x < W; x++) {
                const uint8_t* want = &rgba[((size_t)y * W + x) * 4];
                const uint8_t* got = &decoded[((size_t)y * W + x) * 3];
                for (int c = 0; c < 3; c++) {
                    int d = (int)want[c] - (int)got[c];
                    if (d < 0) d = -d;
                    if (d > worst) worst = d;
                }
            }
        }
        printf("     worst channel error after round trip: %d\n", worst);
        check(worst <= 12, "round-tripped colours are close to the captured ones");
    }

    // A broken capture must be refused rather than crash the game.
    std::vector<uint8_t> none;
    check(!raw_jpeg_encode(nullptr, W, H, 80, none), "encode refuses a null framebuffer");
    check(!raw_jpeg_encode(rgba.data(), 0, H, 80, none), "encode refuses a zero-width frame");
    check(!raw_jpeg_encode(rgba.data(), W, 0, 80, none), "encode refuses a zero-height frame");
    check(none.empty(), "a refused frame leaves the output buffer empty");

    // The quality setting has to reach libjpeg: at quality 80 the whole point of
    // this mode is a frame small enough to send every few milliseconds, and a
    // silently ignored parameter would look like a working encoder.
    std::vector<uint8_t> low, high;
    check(raw_jpeg_encode(rgba.data(), W, H, 20, low), "encode at quality 20 succeeds");
    check(raw_jpeg_encode(rgba.data(), W, H, 95, high), "encode at quality 95 succeeds");
    check(low.size() < high.size(), "lower quality produces a smaller frame");

    if (g_failures == 0) printf("\nPASS\n");
    else printf("\n%d CHECK(S) FAILED\n", g_failures);
    return g_failures == 0 ? 0 : 1;
}
