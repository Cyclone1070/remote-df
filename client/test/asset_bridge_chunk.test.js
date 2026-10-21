// The asset-bridge request names pictures, and now also the chunk it lacks.
//
// A client that is one chunk short of a picture used to be able to say only "I
// am missing picture 10". The host answered by sending the whole 37-chunk picture
// again; the transport is fullest when the last chunk is queued, so the last
// chunk was the one dropped, and the next request produced the same picture and
// the same drop. The screen stayed black and neither side was doing anything
// wrong on its own.
//
// Saying which chunk is missing turns a 4.7 MB repair into a 5 KB one.
import test from 'node:test';
import assert from 'node:assert/strict';
import { DFProtocol } from '../src/core/protocol.js';

const decode = (buf) => {
  const v = new DataView(buf);
  assert.equal(v.getUint8(0), 8, 'opcode 0x08 is the asset bridge request');
  const seq = v.getUint32(1, true);
  const count = v.getUint16(5, true);
  const ids = [];
  for (let i = 0; i < count; i++) ids.push(v.getUint16(7 + i * 2, true));
  let chunks = null;
  if (buf.byteLength >= 7 + count * 2 + count * 2) {
    chunks = [];
    for (let i = 0; i < count; i++) chunks.push(v.getUint16(7 + count * 2 + i * 2, true));
  }
  return { seq, ids, chunks };
};

test('an id and its missing chunk travel together', () => {
  const chunks = new Map([[10, 36]]);
  const { seq, ids, chunks: got } = decode(DFProtocol.encodeAssetBridgeRequest(900, [10], chunks));
  assert.equal(seq, 900);
  assert.deepEqual(ids, [10]);
  assert.deepEqual(got, [36], 'the missing chunk index must reach the host, or it resends everything');
});

test('several pictures keep their chunk indices aligned with their ids', () => {
  const chunks = new Map([[4, 0], [10, 36]]);
  const { ids, chunks: got } = decode(DFProtocol.encodeAssetBridgeRequest(1, [4, 10], chunks));
  assert.deepEqual(ids, [4, 10]);
  assert.deepEqual(got, [0, 36], 'chunk i must belong to id i');
});

test('a picture with no known missing chunk asks for the whole picture', () => {
  // Chunk 0 means "start at the beginning", which is the old behaviour and still
  // correct when the client has nothing at all for that picture.
  const { ids, chunks } = decode(DFProtocol.encodeAssetBridgeRequest(1, [10], new Map()));
  assert.deepEqual(ids, [10]);
  assert.deepEqual(chunks, [0]);
});

test('a request without chunk information keeps the old wire length', () => {
  // The host must keep accepting a request from a client that does not send
  // chunks; an old page against a new host must not be a protocol error.
  const buf = DFProtocol.encodeAssetBridgeRequest(1, [10, 11]);
  assert.equal(buf.byteLength, 7 + 2 * 2, 'no chunk array means no extra bytes');
  const { ids, chunks } = decode(buf);
  assert.deepEqual(ids, [10, 11]);
  assert.equal(chunks, null);
});

test('chunks outside the u16 range are refused rather than truncated', () => {
  // Truncating 65536 to 0 would silently turn "the last chunk" into "start over".
  const chunks = new Map([[10, 70000]]);
  const { chunks: got } = decode(DFProtocol.encodeAssetBridgeRequest(1, [10], chunks));
  assert.deepEqual(got, [0], 'an impossible index must fall back to restarting, never wrap');
});
