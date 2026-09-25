#pragma once
#include <string>
#include <cstdint>
#include <cstring>

class SHA1 {
public:
    uint32_t state[5];
    uint32_t count[2];
    uint8_t buffer[64];

    void transform(const uint8_t buf[64]) {
        uint32_t a = state[0], b = state[1], c = state[2], d = state[3], e = state[4], w[80];
        for (int i = 0; i < 16; i++) {
            w[i] = ((uint32_t)buf[i * 4] << 24) |
                   ((uint32_t)buf[i * 4 + 1] << 16) |
                   ((uint32_t)buf[i * 4 + 2] << 8) |
                   ((uint32_t)buf[i * 4 + 3]);
        }
        for (int i = 16; i < 80; i++) {
            uint32_t val = w[i - 3] ^ w[i - 8] ^ w[i - 14] ^ w[i - 16];
            w[i] = (val << 1) | (val >> 31);
        }
        for (int i = 0; i < 80; i++) {
            uint32_t f, k;
            if (i < 20) { f = (b & c) | ((~b) & d); k = 0x5A827999; }
            else if (i < 40) { f = b ^ c ^ d; k = 0x6ED9EBA1; }
            else if (i < 60) { f = (b & c) | (b & d) | (c & d); k = 0x8F1BBCDC; }
            else { f = b ^ c ^ d; k = 0xCA62C1D6; }
            uint32_t temp = ((a << 5) | (a >> 27)) + f + e + k + w[i];
            e = d; d = c; c = (b << 30) | (b >> 2); b = a; a = temp;
        }
        state[0] += a; state[1] += b; state[2] += c; state[3] += d; state[4] += e;
    }

    void init() {
        state[0] = 0x67452301; state[1] = 0xEFCDAB89; state[2] = 0x98BADCFE;
        state[3] = 0x10325476; state[4] = 0xC3D2E1F0;
        count[0] = count[1] = 0;
    }

    void update(const uint8_t* data, size_t len) {
        size_t i = 0, j = (count[0] >> 3) & 63;
        if ((count[0] += (uint32_t)(len << 3)) < (len << 3)) count[1]++;
        count[1] += (uint32_t)(len >> 29);
        if ((j + len) > 63) {
            memcpy(&buffer[j], data, (i = 64 - j));
            transform(buffer);
            for (; i + 63 < len; i += 64) transform(&data[i]);
            j = 0;
        }
        memcpy(&buffer[j], &data[i], len - i);
    }

    void final(uint8_t digest[20]) {
        uint8_t finalcount[8];
        for (int i = 0; i < 8; i++) {
            finalcount[i] = (uint8_t)((count[(i >= 4 ? 0 : 1)] >> ((3 - (i & 3)) * 8)) & 255);
        }
        uint8_t c = 0200;
        update(&c, 1);
        while ((count[0] & 504) != 448) {
            c = 0000;
            update(&c, 1);
        }
        update(finalcount, 8);
        for (int i = 0; i < 20; i++) {
            digest[i] = (uint8_t)((state[i >> 2] >> ((3 - (i & 3)) * 8)) & 255);
        }
    }
};

inline std::string base64_encode(const uint8_t* data, size_t len) {
    static const char b64_table[] = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    std::string out;
    out.reserve(((len + 2) / 3) * 4);
    for (size_t i = 0; i < len; i += 3) {
        uint32_t val = (data[i] << 16) | (i + 1 < len ? data[i + 1] << 8 : 0) | (i + 2 < len ? data[i + 2] : 0);
        out.push_back(b64_table[(val >> 18) & 0x3F]);
        out.push_back(b64_table[(val >> 12) & 0x3F]);
        out.push_back(i + 1 < len ? b64_table[(val >> 6) & 0x3F] : '=');
        out.push_back(i + 2 < len ? b64_table[val & 0x3F] : '=');
    }
    return out;
}

inline std::string compute_ws_accept(const std::string& key) {
    std::string combined = key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
    SHA1 sha;
    sha.init();
    sha.update((const uint8_t*)combined.data(), combined.size());
    uint8_t digest[20];
    sha.final(digest);
    return base64_encode(digest, 20);
}
