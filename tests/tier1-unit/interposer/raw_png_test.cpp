// Standalone test for the lossless baseline encoder.
//
// The point of raw_png.hpp is to give the whole-picture baseline the same
// footing as the draw-command path, which sends its pictures bit-exact. If the
// encoder is not actually lossless then the comparison it exists to enable is
// meaningless, so this decodes what it produced and compares every byte against
// the input rather than trusting the encoder's word for it.
//
// It also reports the size against the raw RGBA it came from, because that ratio
// is the whole reason the baseline is being re-measured.
//
//   g++ -std=c++17 -O1 -Wall -Wextra -I/usr/local/include \
//       tests/raw_png_test.cpp -o /tmp/raw_png_test -L/usr/local/lib -lz
//   /tmp/raw_png_test

#include <cstdio>
#include <cstdint>
#include <cstring>
#include <string>
#include <vector>

#include "raw_png.hpp"

#include <zlib.h>

static int g_failures = 0;

static void check(bool ok, const char* what) {
    printf("%s %s\n", ok ? "ok  " : "FAIL", what);
    if (!ok) g_failures++;
}

// Walks the chunks. Returns the concatenated IDAT payloads.
static std::vector<uint8_t> idat_of(const std::vector<uint8_t>& png, int* w, int* h) {
    std::vector<uint8_t> idat;
    size_t pos = 8;
    while (pos + 12 <= png.size()) {
        uint32_t len = ((uint32_t)png[pos] << 24) | ((uint32_t)png[pos + 1] << 16) |
                       ((uint32_t)png[pos + 2] << 8) | png[pos + 3];
        const char* type = (const char*)&png[pos + 4];
        const uint8_t* data = &png[pos + 8];
        if (len > png.size() - pos - 12) break;
        if (memcmp(type, "IHDR", 4) == 0 && len >= 8) {
            *w = (data[0] << 24) | (data[1] << 16) | (data[2] << 8) | data[3];
            *h = (data[4] << 24) | (data[5] << 16) | (data[6] << 8) | data[7];
        } else if (memcmp(type, "IDAT", 4) == 0) {
            idat.insert(idat.end(), data, data + len);
        }
        pos += 12 + len;
    }
    return idat;
}

static void round_trip(const char* name, const std::vector<uint8_t>& rgba, int w, int h) {
    std::vector<uint8_t> png;
    bool ok = raw_png_encode(rgba.data(), w, h, 1, png);
    check(ok && !png.empty(), (std::string("encodes ") + name).c_str());
    if (!ok) return;

    const uint8_t sig[8] = {0x89, 'P', 'N', 'G', 0x0d, 0x0a, 0x1a, 0x0a};
    check(png.size() > 8 && memcmp(png.data(), sig, 8) == 0, "has the PNG signature");

    int dw = 0, dh = 0;
    std::vector<uint8_t> idat = idat_of(png, &dw, &dh);
    check(dw == w && dh == h, "header reports the right dimensions");

    // Inflate and strip the per-row filter byte, then compare byte for byte.
    std::vector<uint8_t> back(((size_t)h) * ((size_t)w * 4));
    uLongf out_len = (uLongf)back.size();
    std::vector<uint8_t> filtered(((size_t)h) * ((size_t)w * 4 + 1));
    uLongf filt_len = (uLongf)filtered.size();
    int zr = uncompress(filtered.data(), &filt_len, idat.data(), (uLong)idat.size());
    check(zr == Z_OK, "the image data inflates");
    if (zr != Z_OK) return;
    check(filt_len == filtered.size(), "inflated length matches the expected row count");

    size_t row = (size_t)w * 4;
    bool filters_zero = true, same = true;
    for (int y = 0; y < h; y++) {
        const uint8_t* src = &filtered[(size_t)y * (row + 1)];
        if (src[0] != 0) filters_zero = false;
        memcpy(&back[(size_t)y * row], src + 1, row);
    }
    check(filters_zero, "every row is stored unfiltered");
    same = memcmp(back.data(), rgba.data(), rgba.size()) == 0;
    check(same, (std::string("decodes back to exactly the same pixels: ") + name).c_str());
    (void)out_len;

    double ratio = rgba.empty() ? 0.0 : (double)rgba.size() / (double)png.size();
    printf("     %-22s %8zu raw -> %8zu png  (%.1fx)\n", name, rgba.size(), png.size(), ratio);
}

int main() {
    // A flat block: the cheapest possible content, and the case where a lossy
    // encoder and a lossless one differ most.
    {
        int w = 192, h = 192;
        std::vector<uint8_t> px((size_t)w * h * 4);
        for (int y = 0; y < h; y++)
            for (int x = 0; x < w; x++) {
                uint8_t* p = &px[((size_t)y * w + x) * 4];
                bool sq = (x > 40 && x < 80 && y > 30 && y < 70);
                p[0] = sq ? 200 : 40; p[1] = sq ? 140 : 190; p[2] = sq ? 20 : 210; p[3] = 255;
            }
        round_trip("flat block", px, w, h);
    }

    // Noise: the worst case. If anything is going to break or blow up, it is here.
    {
        int w = 64, h = 64;
        std::vector<uint8_t> px((size_t)w * h * 4);
        uint32_t s = 12345;
        for (size_t i = 0; i < px.size(); i++) { s = s * 1664525u + 1013904223u; px[i] = (uint8_t)(s >> 24); }
        round_trip("noise", px, w, h);
    }

    // Alpha is where a colour-space mistake would quietly show up.
    {
        int w = 33, h = 17;   // deliberately not a multiple of anything
        std::vector<uint8_t> px((size_t)w * h * 4);
        for (int y = 0; y < h; y++)
            for (int x = 0; x < w; x++) {
                uint8_t* p = &px[((size_t)y * w + x) * 4];
                p[0] = (uint8_t)(x * 7); p[1] = (uint8_t)(y * 13);
                p[2] = (uint8_t)(x + y); p[3] = (uint8_t)((x * y) & 0xff);
            }
        round_trip("gradient with alpha", px, w, h);
    }

    // A full screen, so the number below is the one that matters for the bench.
    {
        int w = 1280, h = 720;
        std::vector<uint8_t> px((size_t)w * h * 4);
        for (int y = 0; y < h; y++)
            for (int x = 0; x < w; x++) {
                uint8_t* p = &px[((size_t)y * w + x) * 4];
                p[0] = (uint8_t)(x / 5); p[1] = (uint8_t)(y / 3);
                p[2] = (uint8_t)((x ^ y) & 0x3f); p[3] = 255;
            }
        round_trip("1280x720 screen", px, w, h);
    }

    // Rejects nonsense instead of emitting a broken file.
    {
        std::vector<uint8_t> png;
        check(!raw_png_encode(nullptr, 16, 16, 1, png), "refuses a null buffer");
        std::vector<uint8_t> px(16);
        check(!raw_png_encode(px.data(), 0, 16, 1, png), "refuses a zero width");
        check(!raw_png_encode(px.data(), 16, -1, 1, png), "refuses a negative height");
    }

    printf("\n%s\n", g_failures ? "FAILURES" : "all passed");
    return g_failures ? 1 : 0;
}
