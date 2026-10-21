import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { DFProtocol } from '../src/core/protocol.js';

// Mirrors interposer/df_streamer.cpp's FrameHeader flags.
const FLAG_FULL = 0x01;
const FLAG_DELTA = 0x02;
const FLAG_STAMP = 0x04;
const FLAG_BASE_SEQ = 0x08;

function header({ seq = 1, flags = FLAG_FULL, cmdCount = 0 } = {}) {
    const buf = new ArrayBuffer(16);
    const view = new DataView(buf);
    view.setUint8(0, 0x44);      // 'D'
    view.setUint8(1, 0x46);      // 'F'
    view.setUint32(2, seq, true);
    view.setUint16(6, flags, true);
    view.setUint16(8, cmdCount, true);
    return view;
}

// Four flag bits, and no fifth. 0x10 used to mark a keepalive - a packet with no
// commands whose only job was to touch the link. The streamer measured it as
// doing nothing (evidence/bench/loopback/KEEPALIVE_MATRIX.md) and it was
// removed, so the client must not carve out a packet kind for it: a header
// carrying that bit is not a keepalive, because nothing can send one.
describe('frame header flags', () => {
    it('has no keepalive packet kind', () => {
        const hdr = DFProtocol.parseHeader(header({ flags: 0x10 }));
        assert.equal(hdr.type, undefined);
    });

    it('still reads the four flags that remain', () => {
        const hdr = DFProtocol.parseHeader(header({ flags: FLAG_DELTA | FLAG_STAMP | FLAG_BASE_SEQ }));
        assert.equal(hdr.hasStamp, true);
        assert.equal(hdr.hasBaseSeq, true);
        assert.equal(hdr.count, 0);
    });
});
