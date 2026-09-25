#include <iostream>
#include <vector>
#include <cassert>
#include <cstring>
#include <zstd.h>

#define MAX_DRAW_COMMANDS 32768

#pragma pack(push, 1)
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
#pragma pack(pop)

class DeltaEncoder {
public:
    DrawCommand prev_cmds[MAX_DRAW_COMMANDS];
    uint16_t prev_count = 0;
    uint32_t frames_since_keyframe = 0;
    DeltaUpdate delta_updates[MAX_DRAW_COMMANDS];

    bool encode_frame(uint32_t seq, const DrawCommand* curr_cmds, uint16_t curr_count,
                      bool force_keyframe, std::vector<uint8_t>& out_packet) {
        bool send_full = force_keyframe || (prev_count == 0) || (frames_since_keyframe >= 60);

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
            for (uint16_t i = min_count; i < curr_count; ++i) {
                delta_updates[num_updates].index = i;
                delta_updates[num_updates].cmd = curr_cmds[i];
                num_updates++;
            }

            // If more than 50% changed, send full frame instead
            if (num_updates > (curr_count / 2)) {
                send_full = true;
            }
        }

        FrameHeader hdr;
        hdr.magic[0] = 'D';
        hdr.magic[1] = 'F';
        hdr.frame_seq = seq;
        hdr.cmd_count = curr_count;

        if (send_full) {
            hdr.flags = 0x01; // Full
            size_t raw_len = curr_count * sizeof(DrawCommand);
            size_t max_comp = ZSTD_compressBound(raw_len);
            out_packet.resize(sizeof(hdr) + max_comp);
            memcpy(out_packet.data(), &hdr, sizeof(hdr));

            size_t c_size = ZSTD_compress(out_packet.data() + sizeof(hdr), max_comp, curr_cmds, raw_len, 1);
            assert(!ZSTD_isError(c_size));
            out_packet.resize(sizeof(hdr) + c_size);

            frames_since_keyframe = 0;
        } else {
            hdr.flags = 0x02; // Delta
            size_t payload_len = 2 + num_updates * sizeof(DeltaUpdate);
            std::vector<uint8_t> raw_payload(payload_len);
            memcpy(raw_payload.data(), &num_updates, 2);
            if (num_updates > 0) {
                memcpy(raw_payload.data() + 2, delta_updates, num_updates * sizeof(DeltaUpdate));
            }

            size_t max_comp = ZSTD_compressBound(payload_len);
            out_packet.resize(sizeof(hdr) + max_comp);
            memcpy(out_packet.data(), &hdr, sizeof(hdr));

            size_t c_size = ZSTD_compress(out_packet.data() + sizeof(hdr), max_comp, raw_payload.data(), payload_len, 1);
            assert(!ZSTD_isError(c_size));
            out_packet.resize(sizeof(hdr) + c_size);

            frames_since_keyframe++;
        }

        memcpy(prev_cmds, curr_cmds, curr_count * sizeof(DrawCommand));
        prev_count = curr_count;
        return (hdr.flags == 0x01);
    }
};

int main() {
    DeltaEncoder enc;
    std::vector<DrawCommand> cmds(640);
    for (int i = 0; i < 640; ++i) {
        cmds[i] = { (uint16_t)(i % 5), 0, 0, 8, 12, (int16_t)(i * 2), 0, 8, 12 };
    }

    std::vector<uint8_t> packet;

    // Frame 0: Must be full frame
    bool is_full = enc.encode_frame(0, cmds.data(), cmds.size(), false, packet);
    assert(is_full == true);
    assert(packet[6] == 0x01);
    size_t full_size = packet.size();
    std::cout << "Frame 0 (Full): " << full_size << " bytes\n";

    // Frame 1: Identical -> Delta with 0 updates
    is_full = enc.encode_frame(1, cmds.data(), cmds.size(), false, packet);
    assert(is_full == false);
    assert(packet[6] == 0x02);
    size_t idle_delta_size = packet.size();
    std::cout << "Frame 1 (Idle Delta): " << idle_delta_size << " bytes\n";
    assert(idle_delta_size < 30); // Must be tiny!

    // Frame 2: 2 commands changed -> Delta with 2 updates
    cmds[10].dst_x = 999;
    cmds[20].dst_y = 888;
    is_full = enc.encode_frame(2, cmds.data(), cmds.size(), false, packet);
    assert(is_full == false);
    assert(packet[6] == 0x02);
    size_t sparse_delta_size = packet.size();
    std::cout << "Frame 2 (Sparse Delta): " << sparse_delta_size << " bytes\n";
    assert(sparse_delta_size < 80);

    // Frame 3: >50% changed -> Fallback to full frame
    for (int i = 0; i < 400; ++i) {
        cmds[i].dst_x += 1;
    }
    is_full = enc.encode_frame(3, cmds.data(), cmds.size(), false, packet);
    assert(is_full == true);
    assert(packet[6] == 0x01);
    std::cout << "Frame 3 (>50% Changed -> Full): " << packet.size() << " bytes\n";

    std::cout << ">>> ALL C++ DELTA ENCODER TESTS PASSED <<<\n";
    return 0;
}
