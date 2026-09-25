const test = require('node:test');
const assert = require('node:assert/strict');
const { execSync } = require('node:child_process');
const fzstd = require('../client/js/fzstd.js');
const DFProtocol = require('../client/js/protocol.js');

function compressPayload(bytes) {
    return execSync('zstd -1 -q', { input: Buffer.from(bytes) });
}

test('DFProtocol.encodeInput: 16 bytes when debugStamp is omitted or 0', () => {
    const b1 = DFProtocol.encodeInput(1, 10, 20, 0, 0, 0, 0);
    assert.equal(b1.byteLength, 16);

    const b2 = DFProtocol.encodeInput(1, 10, 20, 0, 0, 0, 0, 0);
    assert.equal(b2.byteLength, 16);
});

test('DFProtocol.encodeInput: 17 bytes when debugStamp > 0', () => {
    const b = DFProtocol.encodeInput(1, 10, 20, 0, 0, 0, 0, 42);
    assert.equal(b.byteLength, 17);
    const view = new DataView(b);
    assert.equal(view.getUint8(16), 42);
});

test('DFProtocol.decodeFrame: decodes frame without stamp (10B header)', () => {
    const payload = new Uint8Array([0, 0]); // num_updates = 0
    const compressed = compressPayload(payload);
    const buf = new ArrayBuffer(10 + compressed.byteLength);
    const view = new DataView(buf);
    view.setUint8(0, 0x44); // 'D'
    view.setUint8(1, 0x46); // 'F'
    view.setUint32(2, 100, true);
    view.setUint16(6, 0x02, true); // delta, no stamp
    view.setUint16(8, 50, true);
    new Uint8Array(buf, 10).set(compressed);

    const frame = DFProtocol.decodeFrame(buf, fzstd);
    assert.ok(frame);
    assert.equal(frame.seq, 100);
    assert.equal(frame.stamp || 0, 0);
    assert.equal(frame.totalCmdCount, 50);
});

test('DFProtocol.decodeFrame: decodes frame with stamp (11B header with FLAG_HAS_STAMP)', () => {
    const payload = new Uint8Array([0, 0]); // num_updates = 0
    const compressed = compressPayload(payload);
    const buf = new ArrayBuffer(11 + compressed.byteLength);
    const view = new DataView(buf);
    view.setUint8(0, 0x44); // 'D'
    view.setUint8(1, 0x46); // 'F'
    view.setUint32(2, 101, true);
    view.setUint16(6, 0x02 | 0x04, true); // delta | FLAG_HAS_STAMP
    view.setUint16(8, 50, true);
    view.setUint8(10, 77); // stamp = 77
    new Uint8Array(buf, 11).set(compressed);

    const frame = DFProtocol.decodeFrame(buf, fzstd);
    assert.ok(frame);
    assert.equal(frame.seq, 101);
    assert.equal(frame.stamp, 77);
});
