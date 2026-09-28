import test from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import * as fzstd from '../client/node_modules/fzstd/esm/index.mjs';
import { DFProtocol } from '../client/src/core/protocol.js';

test('DFProtocol.encodeGapAck: encodes opcode 0x07 and uint32 lastAckedSeq', () => {
    const buf = DFProtocol.encodeGapAck(100);
    assert.equal(buf.byteLength, 5);
    const view = new DataView(buf);
    assert.equal(view.getUint8(0), 7);
    assert.equal(view.getUint32(1, true), 100);
});

test('DFProtocol.decodeFrame: decodes combined delta frame with flag 0x08 and baseSeq', () => {
    // Construct dummy combined delta frame:
    // Header (10 bytes): 'DF', seq: 103, flags: 0x02 | 0x08 (delta + combined), count: 1
    // Extra header (4 bytes): baseSeq: 100
    // Payload (zstd compressed): uint16 numUpdates (1), uint16 index (5), 18 bytes DrawCommand
    const headerBuf = new ArrayBuffer(14);
    const hView = new DataView(headerBuf);
    hView.setUint8(0, 0x44); // 'D'
    hView.setUint8(1, 0x46); // 'F'
    hView.setUint32(2, 103, true); // seq: 103
    hView.setUint16(6, 0x02 | 0x08, true); // delta + combined
    hView.setUint16(8, 1, true); // totalCmdCount: 1
    hView.setUint32(10, 100, true); // baseSeq: 100

    const rawPayload = new Uint8Array(2 + 2 + 18);
    const pView = new DataView(rawPayload.buffer);
    pView.setUint16(0, 1, true); // 1 update
    pView.setUint16(2, 5, true); // index: 5
    pView.setUint16(4, 42, true); // texId: 42

    const compressed = execSync('zstd -1 -q', { input: rawPayload });
    const packet = new Uint8Array(14 + compressed.byteLength);
    packet.set(new Uint8Array(headerBuf), 0);
    packet.set(compressed, 14);

    const decoded = DFProtocol.decodeFrame(packet.buffer, fzstd);
    assert.notEqual(decoded, null);
    assert.equal(decoded.type, 'delta');
    assert.equal(decoded.seq, 103);
    assert.equal(decoded.baseSeq, 100);
    assert.equal(decoded.totalCmdCount, 1);
    assert.equal(decoded.updates.length, 1);
    assert.equal(decoded.updates[0].index, 5);
    assert.equal(decoded.updates[0].cmd.texId, 42);
});
