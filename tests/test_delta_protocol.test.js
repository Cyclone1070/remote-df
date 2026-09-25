const test = require('node:test');
const assert = require('node:assert/strict');
const fzstd = require('../client/js/fzstd.js');

// Mock DFProtocol for test
class DFProtocolTest {
    static DRAW_COMMAND_SIZE = 18;

    static encodeDelta(seq, totalCmdCount, updates) {
        // 10 byte header
        const hdr = new ArrayBuffer(10);
        const hView = new DataView(hdr);
        hView.setUint8(0, 0x44); // 'D'
        hView.setUint8(1, 0x46); // 'F'
        hView.setUint32(2, seq, true);
        hView.setUint16(6, 0x02, true); // Delta flag
        hView.setUint16(8, totalCmdCount, true); // Total active command count

        // Payload: uint16 num_updates, followed by (uint16 index, 18 bytes cmd)
        const payloadLen = 2 + updates.length * (2 + this.DRAW_COMMAND_SIZE);
        const payload = new Uint8Array(payloadLen);
        const pView = new DataView(payload.buffer);
        pView.setUint16(0, updates.length, true);

        for (let i = 0; i < updates.length; i++) {
            const off = 2 + i * (2 + this.DRAW_COMMAND_SIZE);
            pView.setUint16(off, updates[i].index, true);
            const cmd = updates[i].cmd;
            pView.setUint16(off + 2, cmd.texId, true);
            pView.setInt16(off + 4, cmd.srcX, true);
            pView.setInt16(off + 6, cmd.srcY, true);
            pView.setInt16(off + 8, cmd.srcW, true);
            pView.setInt16(off + 10, cmd.srcH, true);
            pView.setInt16(off + 12, cmd.dstX, true);
            pView.setInt16(off + 14, cmd.dstY, true);
            pView.setInt16(off + 16, cmd.dstW, true);
            pView.setInt16(off + 18, cmd.dstH, true);
        }

        const { execSync } = require('child_process');
        const compressed = execSync('zstd -1 -q', { input: payload });
        const packet = new Uint8Array(10 + compressed.byteLength);
        packet.set(new Uint8Array(hdr), 0);
        packet.set(compressed, 10);
        return packet.buffer;
    }
}

test('Delta Protocol: decodes delta packet with total command count and sparse updates', async (t) => {
    // Expected decode function from client/js/protocol.js
    const DFProtocol = require('../client/js/protocol.js');
    
    const sampleUpdates = [
        {
            index: 5,
            cmd: { texId: 2, srcX: 0, srcY: 0, srcW: 8, srcH: 12, dstX: 40, dstY: 60, dstW: 8, dstH: 12 }
        },
        {
            index: 42,
            cmd: { texId: 1, srcX: 8, srcY: 0, srcW: 8, srcH: 12, dstX: 336, dstY: 504, dstW: 8, dstH: 12 }
        }
    ];

    const rawBuf = DFProtocolTest.encodeDelta(101, 500, sampleUpdates);
    const decoded = DFProtocol.decodeFrame(rawBuf, fzstd);

    assert.ok(decoded, 'Frame must decode successfully');
    assert.equal(decoded.type, 'delta');
    assert.equal(decoded.seq, 101);
    assert.equal(decoded.totalCmdCount, 500);
    assert.equal(decoded.updates.length, 2);
    assert.deepEqual(decoded.updates[0], sampleUpdates[0]);
    assert.deepEqual(decoded.updates[1], sampleUpdates[1]);
});
