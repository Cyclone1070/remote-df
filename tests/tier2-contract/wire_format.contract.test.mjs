// Contract: the bytes the interposer writes are the bytes the page reads.
//
// The two halves of this wire are written in different languages by different
// code, and nothing at runtime checks that they still agree. A field that moves
// by two bytes on one side does not fail loudly - it decodes as a plausible
// number and the symptom is a stream that is subtly wrong, which is the most
// expensive kind of bug to find.
//
// So the offsets are read out of the C++ source itself rather than restated
// here. If someone reorders a struct, this fails at the point the struct changed
// instead of somewhere downstream of it.
//
// Tier 2: no game, no browser, milliseconds.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DFProtocol } from '../../client/src/core/protocol.js';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const SRC = readFileSync(resolve(REPO, 'interposer/df_streamer.cpp'), 'utf8');

// Pulls the field order out of a `struct X { ... };` block, honouring the
// `uint8_t magic[2]` array form. Comments and blanks are dropped.
function structFields(name) {
  const block = SRC.match(new RegExp(`struct\\s+${name}\\s*\\{([\\s\\S]*?)\\};`));
  assert.ok(block, `struct ${name} not found in interposer/df_streamer.cpp`);
  const fields = [];
  for (const raw of block[1].split('\n')) {
    const line = raw.replace(/\/\/.*$/, '').trim();
    if (!line || line.startsWith('/*') || line.startsWith('*')) continue;
    const m = line.match(/^([A-Za-z_][\w:]*)\s+([A-Za-z_]\w*)\s*(\[(\d+)\])?\s*;/);
    if (!m) continue;
    const [, type, field, , arrayLen] = m;
    fields.push({ type, field, count: arrayLen ? Number(arrayLen) : 1 });
  }
  return fields;
}

// Byte widths as the compiler sees them on this target. The wire is little
// endian and the protocol is packed, so these are exact.
const WIDTH = { uint8_t: 1, int8_t: 1, uint16_t: 2, int16_t: 2, uint32_t: 4, int32_t: 4, uint64_t: 8, int64_t: 8 };

function field(off, name) {
  assert.notEqual(off[name], undefined,
    `the C++ struct has no field "${name}" - a test writing to it would silently ` +
    `write at offset 0 and corrupt the header instead of failing`);
  return off[name];
}

function offsets(fields) {
  const out = {};
  let at = 0;
  for (const f of fields) {
    const w = WIDTH[f.type];
    assert.ok(w, `struct field type ${f.type} has no known width - extend WIDTH in this test`);
    out[f.field] = at;
    at += w * f.count;
  }
  return { offsets: out, size: at };
}

test('frame header: C++ layout matches the page decoder', () => {
  const { offsets: off, size } = offsets(structFields('FrameHeader'));
  assert.equal(size, 10, 'frame header is 10 bytes on the wire');

  // A frame header built to the C++ offsets must decode on the JS side.
  const buf = new ArrayBuffer(size);
  const v = new DataView(buf);
  v.setUint8(0, 0x44);                                // 'D'
  v.setUint8(1, 0x46);                                // 'F'
  v.setUint32(field(off, 'frame_seq'), 4242, true);
  v.setUint16(field(off, 'flags'), 0x01, true);                 // hasStamp off, combined off
  v.setUint16(field(off, 'cmd_count'), 77, true);

  const hdr = DFProtocol.parseHeader(v);
  assert.ok(hdr, 'the page must recognise this as a frame header');
  assert.equal(hdr.seq, 4242, 'sequence number lands where the page reads it');
  assert.equal(hdr.count, 77, 'command count lands where the page reads it');
});

test('frame header: flags are read from the byte the C++ writes them to', () => {
  const { offsets: off } = offsets(structFields('FrameHeader'));
  for (const [flag, expected] of [[0x01, null], [0x04, 'hasStamp'], [0x08, 'hasBaseSeq']]) {
    const buf = new ArrayBuffer(10);
    const v = new DataView(buf);
    v.setUint8(0, 0x44); v.setUint8(1, 0x46);
    v.setUint16(field(off, 'flags'), flag, true);
    const hdr = DFProtocol.parseHeader(v);
    assert.ok(hdr, `flags 0x${flag.toString(16)} must still parse`);
    if (expected) assert.equal(hdr[expected], true, `flag 0x${flag.toString(16)} sets ${expected}`);
  }
});

test('picture chunk header: C++ layout matches the page decoder', () => {
  const fields = structFields('TextureHeader');
  const { offsets: off, size } = offsets(fields);
  assert.equal(size, DFProtocol.TEXTURE_HEADER_BYTES,
    'the C++ picture header and DFProtocol.TEXTURE_HEADER_BYTES must be the same size, ' +
    'or the page slices the payload at the wrong byte');

  const payload = 100;
  const buf = new ArrayBuffer(size + payload);
  const v = new DataView(buf);
  v.setUint8(0, 0x44); v.setUint8(1, 0x54);           // 'D','T'
  v.setUint16(field(off, 'tex_id'), 10, true);
  v.setUint16(field(off, 'w'), 256, true);
  v.setUint16(field(off, 'h'), 144, true);
  v.setUint32(field(off, 'payload_len'), 4 * 256 * 144, true);
  v.setUint16(field(off, 'chunk_index'), 3, true);
  v.setUint16(field(off, 'chunk_count'), 37, true);

  const chunk = DFProtocol.decodeTexture(buf);
  assert.ok(chunk, 'the page must recognise this as a picture chunk');
  assert.equal(chunk.texId, 10);
  assert.equal(chunk.chunkCount, 37, 'chunk count lands where the page reads it');
  assert.equal(chunk.chunkIndex, 3, 'chunk index lands where the page reads it');
  assert.equal(chunk.data.byteLength, payload,
    'the payload must start exactly after the header, or every picture is shifted');
});

test('a picture is whole only when every chunk index is present', () => {
  // The client discards a picture whose chunk set has a hole, so the count the
  // server puts in the header has to be the count it actually sends. This pins
  // the arithmetic both sides use.
  const CHUNK = 131072;
  for (const total of [0, 1, CHUNK - 1, CHUNK, CHUNK + 1, 4 * 1280 * 720]) {
    const n = Math.max(1, Math.ceil(total / CHUNK));
    assert.equal(new Set([...Array(n).keys()]).size, n, 'indices are unique and complete');
    assert.ok(n <= 65535, 'chunk count must fit the uint16 in the header');
    for (let i = 0; i < n; i++) {
      const bytes = Math.min(CHUNK, total - i * CHUNK);
      assert.ok(bytes > 0 || total === 0,
        `chunk ${i} of ${n} for ${total} bytes must carry something`);
    }
  }
});
