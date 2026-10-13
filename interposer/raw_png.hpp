#pragma once
// raw_png.hpp — lossless counterpart to raw_jpeg.hpp.
//
// The whole-picture baseline has been sending JPEG at quality 80, which is
// lossy, while the draw-command path sends its pictures bit-exact. Comparing
// the two sizes therefore compares two different things. This gives the
// baseline the same footing: the same pixels the game produced, compressed
// losslessly, so the only difference left is how the two designs choose to
// represent what they send.
//
// A minimal encoder on purpose: one IDAT, filter 0 on every row, zlib at a low
// level. No libpng dependency, no colour management, no interlacing - just the
// smallest thing that is a valid, byte-exact PNG.

#include <cstdint>
#include <cstring>
#include <vector>
#include <zlib.h>

namespace raw_png_detail {

inline void put_u32(std::vector<uint8_t>& v, uint32_t x) {
    v.push_back((uint8_t)(x >> 24));
    v.push_back((uint8_t)(x >> 16));
    v.push_back((uint8_t)(x >> 8));
    v.push_back((uint8_t)x);
}

inline void put_chunk(std::vector<uint8_t>& out, const char type[4],
                      const uint8_t* data, size_t len) {
    put_u32(out, (uint32_t)len);
    size_t at = out.size();
    out.insert(out.end(), type, type + 4);
    if (len) out.insert(out.end(), data, data + len);
    // CRC covers the type and the payload, not the length.
    uLong crc = crc32(0L, Z_NULL, 0);
    crc = crc32(crc, out.data() + at, (uInt)(4 + len));
    put_u32(out, (uint32_t)crc);
}

} // namespace raw_png_detail

// Encodes straight RGBA into a PNG. `level` is the zlib level: 1 keeps the cost
// comparable to the JPEG encoder it replaces, which also mattered for the
// measurement being fair.
// Appends to `out` rather than replacing it: the caller writes the codec tag
// first, and a tag written after the fact would mean moving several megabytes
// down by one byte on every frame.
inline bool raw_png_encode(const uint8_t* rgba, int w, int h, int level,
                           std::vector<uint8_t>& out) {
    using namespace raw_png_detail;
    if (!rgba || w <= 0 || h <= 0) return false;

    const uint8_t sig[8] = {0x89, 'P', 'N', 'G', 0x0d, 0x0a, 0x1a, 0x0a};
    out.insert(out.end(), sig, sig + 8);

    uint8_t ihdr[13];
    ihdr[0] = (uint8_t)(w >> 24); ihdr[1] = (uint8_t)(w >> 16);
    ihdr[2] = (uint8_t)(w >> 8);  ihdr[3] = (uint8_t)w;
    ihdr[4] = (uint8_t)(h >> 24); ihdr[5] = (uint8_t)(h >> 16);
    ihdr[6] = (uint8_t)(h >> 8);  ihdr[7] = (uint8_t)h;
    ihdr[8] = 8;   // bit depth
    ihdr[9] = 6;   // colour type: truecolour with alpha
    ihdr[10] = 0;  // deflate
    ihdr[11] = 0;  // adaptive filtering
    ihdr[12] = 0;  // no interlace
    put_chunk(out, "IHDR", ihdr, sizeof(ihdr));

    // Filter byte 0 in front of every row, then one zlib stream over all of it.
    const size_t row = (size_t)w * 4;
    std::vector<uint8_t> raw;
    raw.reserve(((size_t)h) * (row + 1));
    for (int y = 0; y < h; y++) {
        raw.push_back(0);
        raw.insert(raw.end(), rgba + (size_t)y * row, rgba + (size_t)y * row + row);
    }

    uLongf bound = compressBound((uLong)raw.size());
    std::vector<uint8_t> z(bound);
    if (compress2(z.data(), &bound, raw.data(), (uLong)raw.size(), level) != Z_OK) return false;

    put_chunk(out, "IDAT", z.data(), (size_t)bound);
    put_chunk(out, "IEND", nullptr, 0);
    return true;
}
