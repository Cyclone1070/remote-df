import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { DFProtocol } from '../src/core/protocol.js';
import { DFRenderer } from '../src/core/renderer.js';

// Mirrors interposer/df_streamer.cpp: TEXTURE_CHUNK_BYTES.
const CHUNK_BYTES = 128 * 1024;

// Builds one texture chunk message exactly as the interposer serialises it.
function makeChunk({ texId, w, h, totalLen, chunkIndex, chunkCount, payload }) {
    const buf = new ArrayBuffer(16 + payload.length);
    const view = new DataView(buf);
    view.setUint8(0, 0x44);      // 'D'
    view.setUint8(1, 0x54);      // 'T'
    view.setUint16(2, texId, true);
    view.setUint16(4, w, true);
    view.setUint16(6, h, true);
    view.setUint32(8, totalLen, true);
    view.setUint16(12, chunkIndex, true);
    view.setUint16(14, chunkCount, true);
    new Uint8Array(buf, 16).set(payload);
    return buf;
}

describe('Texture chunk header', () => {
    it('parses a single-chunk message', () => {
        const payload = Uint8Array.from([1, 2, 3, 4]);
        const buf = makeChunk({ texId: 7, w: 1, h: 1, totalLen: 4, chunkIndex: 0, chunkCount: 1, payload });
        const c = DFProtocol.decodeTexture(buf);

        assert.equal(c.texId, 7);
        assert.equal(c.w, 1);
        assert.equal(c.h, 1);
        assert.equal(c.totalLen, 4);
        assert.equal(c.chunkCount, 1);
        assert.equal(c.chunkIndex, 0);
        assert.deepEqual([...c.data], [1, 2, 3, 4]);
    });

    it('uses THIS message length, not the whole-texture payload_len', () => {
        // The header claims a 10-byte texture but only carries 4 bytes: the
        // naive w*h*4 read would run past the end of the buffer.
        const buf = makeChunk({
            texId: 3, w: 1, h: 1, totalLen: 10,
            chunkIndex: 2, chunkCount: 5, payload: Uint8Array.from([9, 9, 9, 9])
        });
        const c = DFProtocol.decodeTexture(buf);
        assert.equal(c.totalLen, 10, 'header still reports the full size');
        assert.equal(c.data.byteLength, 4, 'but only this chunk is read');
        assert.equal(c.chunkIndex, 2);
        assert.equal(c.chunkCount, 5);
    });

    it('rejects a non-texture message', () => {
        const buf = new ArrayBuffer(20);
        new DataView(buf).setUint8(0, 0x44); // 'D' but not 'T'
        assert.equal(DFProtocol.decodeTexture(buf), null);
    });

    it('treats a zero chunk_count as a single chunk rather than dividing by zero', () => {
        const buf = makeChunk({ texId: 1, w: 1, h: 1, totalLen: 4, chunkIndex: 0, chunkCount: 0, payload: Uint8Array.from([1, 1, 1, 1]) });
        assert.equal(DFProtocol.decodeTexture(buf).chunkCount, 1);
    });
});

describe('Reassembly of a chunked texture', () => {
    // Mirrors ingestTextureChunk in GameCanvas.jsx.
    const reassemble = (chunks, totalLen) => {
        const map = new Map();
        for (const c of chunks) {
            if (!map.has(c.chunkIndex)) map.set(c.chunkIndex, c.data.slice());
        }
        if (map.size < chunks[0].chunkCount) return null;
        const out = new Uint8ClampedArray(totalLen);
        let off = 0;
        for (let i = 0; i < chunks[0].chunkCount; i++) {
            const c = map.get(i);
            if (!c) return null;
            out.set(c, off);
            off += c.length;
        }
        return off === totalLen ? out : null;
    };

    it('rebuilds a multi-chunk texture byte for byte', () => {
        const total = CHUNK_BYTES * 2 + 100;
        const all = Uint8Array.from({ length: total }, (_, i) => i & 0xFF);

        const parts = [];
        for (let i = 0; i * CHUNK_BYTES < total; i++) {
            parts.push(all.subarray(i * CHUNK_BYTES, Math.min((i + 1) * CHUNK_BYTES, total)));
        }

        const chunks = parts.map((p, i) => DFProtocol.decodeTexture(
            makeChunk({ texId: 5, w: 1280, h: 720, totalLen: total, chunkIndex: i, chunkCount: parts.length, payload: p })
        ));

        assert.equal(chunks.length, 3);
        const out = reassemble(chunks, total);
        assert.ok(out, 'should assemble');
        assert.equal(out.length, total);
        assert.deepEqual([...out.subarray(0, 16)], [...all.subarray(0, 16)], 'first bytes match');
        assert.deepEqual([...out.subarray(total - 8)], [...all.subarray(total - 8)], 'trailing bytes match');
    });

    it('assembles correctly even when chunks arrive out of order', () => {
        const total = CHUNK_BYTES + 10;
        const all = Uint8Array.from({ length: total }, (_, i) => (i * 7) & 0xFF);
        const mk = (i, off, len) => DFProtocol.decodeTexture(
            makeChunk({ texId: 2, w: 10, h: 10, totalLen: total, chunkIndex: i, chunkCount: 2, payload: all.subarray(off, off + len) })
        );
        const shuffled = [mk(1, CHUNK_BYTES, 10), mk(0, 0, CHUNK_BYTES)];
        const out = reassemble(shuffled, total);
        assert.ok(out);
        assert.deepEqual([...out.subarray(0, 8)], [...all.subarray(0, 8)]);
        assert.deepEqual([...out.subarray(CHUNK_BYTES)], [...all.subarray(CHUNK_BYTES)]);
    });

    it('stays incomplete while a chunk is still missing', () => {
        const total = CHUNK_BYTES * 3;
        const mk = (i) => DFProtocol.decodeTexture(
            makeChunk({ texId: 9, w: 8, h: 8, totalLen: total, chunkIndex: i, chunkCount: 3, payload: new Uint8Array(CHUNK_BYTES) })
        );
        assert.equal(reassemble([mk(0), mk(2)], total), null, 'a hole means not ready');
    });

    it('every chunk stays under the 262144 byte DataChannel limit', () => {
        // The whole reason chunking exists: a full-screen RGBA surface is ~3.6 MB.
        const fullScreen = 1280 * 720 * 4;
        const chunkCount = Math.ceil(fullScreen / CHUNK_BYTES);
        assert.ok(chunkCount > 1, 'a full-screen texture must actually split');
        for (let i = 0; i < chunkCount; i++) {
            const len = Math.min(CHUNK_BYTES, fullScreen - i * CHUNK_BYTES);
            assert.ok(16 + len <= 262144, `chunk ${i} message must fit the advertised limit`);
        }
    });
});
describe('Atlas reclaim', () => {
    // setTexture does `imageOrData instanceof ImageData`. Browsers always have
    // ImageData; Node does not, and the reference itself throws without it.
    if (typeof globalThis.ImageData === 'undefined') {
        globalThis.ImageData = class ImageData {};
    }

    // A WebGL2 context is required: setTexture short-circuits to a plain Map
    // when there is no GL, so the atlas path would never be exercised.
    const fakeGL = () => ({
        TEXTURE_2D: 1, RGBA: 2, UNSIGNED_BYTE: 3, UNPACK_ALIGNMENT: 4,
        bindTexture() {}, texSubImage2D() {}, texImage2D() {}, pixelStorei() {}
    });

    const mk = () => {
        const r = Object.create(DFRenderer.prototype);
        r.textures = new Map();
        r.atlasWidth = 4096; r.atlasHeight = 4096;
        r.atlasX = 1; r.atlasY = 1; r.atlasRowHeight = 0;
        r.atlasGeneration = 0; r.dirty = false;
        r.gl = fakeGL(); r.atlasTexture = {};
        return r;
    };

    it('resetAtlas empties the texture set and bumps the generation', () => {
        const r = mk();
        r.textures.set(1, { ax: 0, ay: 0 });
        r.atlasY = 4000; r.atlasRowHeight = 50;
        r.resetAtlas();
        assert.equal(r.textures.size, 0);
        assert.equal(r.atlasX, 1);
        assert.equal(r.atlasY, 1);
        assert.equal(r.atlasRowHeight, 0);
        assert.equal(r.atlasGeneration, 1);
    });

    it('an exhausted atlas is reclaimed rather than dropping textures forever', () => {
        const r = mk();
        r.atlasY = r.atlasHeight - 4;   // no room for anything

        r.setTexture(7, { w: 1280, h: 720, rgba: new Uint8ClampedArray(1280 * 720 * 4) });

        assert.equal(r.atlasGeneration, 1, 'a reclaim happened');
        assert.equal(r.textures.has(7), true, 'texture stored after reclaim, not dropped');
    });

    it('refuses rather than looping when a texture cannot fit even an empty atlas', () => {
        const r = mk();
        r.atlasY = r.atlasHeight - 4;
        r.setTexture(9, { w: 16, h: 8192, rgba: new Uint8ClampedArray(4) });
        assert.equal(r.textures.has(9), false);
        assert.equal(r.atlasGeneration, 1, 'reclaims once, then stops cleanly');
    });

    it('a normal texture does not trigger a reclaim', () => {
        const r = mk();
        r.setTexture(3, { w: 16, h: 16, rgba: new Uint8ClampedArray(16 * 16 * 4) });
        assert.equal(r.atlasGeneration, 0, 'no reclaim while there is room');
        assert.equal(r.textures.has(3), true);
    });
});
