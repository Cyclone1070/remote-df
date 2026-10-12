/**
 * The game rebuilds pictures it has already sent and hands each one over under a
 * fresh id. Storing every arrival on its own is what filled the atlas with
 * copies, which in turn caused both the corruption and the freezes: a wipe makes
 * every picture missing, the client asks for all of them again, and the re-send
 * flood starves frames for seconds at a time.
 *
 * These tests pin the behaviour that prevents that: identical pixels are stored
 * once, and every id that resolves to them points at that one copy.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { DFRenderer } from '../src/core/renderer.js';

globalThis.ImageData = class ImageData {};

describe('atlas duplicate handling', () => {
    const fakeGL = () => ({
        TEXTURE_2D: 1, RGBA: 2, UNSIGNED_BYTE: 3, UNPACK_ALIGNMENT: 4,
        bindTexture() {}, texSubImage2D() {}, texImage2D() {}, pixelStorei() {}
    });

    const mk = () => {
        const r = Object.create(DFRenderer.prototype);
        r.textures = new Map();
        r.fingerprints = new Map();
        r.atlasWidth = 4096; r.atlasHeight = 4096;
        r.atlasX = 1; r.atlasY = 1; r.atlasRowHeight = 0;
        r.atlasGeneration = 0; r.dirty = false;
        r.gl = fakeGL(); r.atlasTexture = {};
        return r;
    };

    const pixels = (seed, n = 16) => {
        const a = new Uint8Array(n);
        for (let i = 0; i < n; i++) a[i] = (seed * 31 + i * 7) & 255;
        return a;
    };

    test('the same picture arriving twice is stored once', () => {
        const r = mk();

        r.setTexture(10, { w: 2, h: 2, rgba: pixels(1) });
        const afterFirst = r.atlasX + r.atlasY;   // how far packing advanced

        r.setTexture(11, { w: 2, h: 2, rgba: pixels(1) });

        assert.equal(r.atlasX + r.atlasY, afterFirst,
            'the second arrival advanced the atlas, so a copy was stored');
    });

    test('every id for the same picture points at the one stored copy', () => {
        const r = mk();

        r.setTexture(10, { w: 2, h: 2, rgba: pixels(1) });
        r.setTexture(11, { w: 2, h: 2, rgba: pixels(1) });

        const a = r.textures.get(10);
        const b = r.textures.get(11);
        assert.ok(a && b, 'both ids must resolve to something');
        assert.equal(b.ax, a.ax, 'second id points at a different column');
        assert.equal(b.ay, a.ay, 'second id points at a different row');
        assert.equal(b.w, a.w);
        assert.equal(b.h, a.h);
    });

    test('a genuinely different picture is still stored separately', () => {
        const r = mk();

        r.setTexture(10, { w: 2, h: 2, rgba: pixels(1) });
        r.setTexture(11, { w: 2, h: 2, rgba: pixels(2) });

        const a = r.textures.get(10);
        const b = r.textures.get(11);
        assert.ok(a && b);
        assert.notEqual(b.ax + ':' + b.ay, a.ax + ':' + a.ay,
            'different pixels were treated as the same picture');
    });

    test('an id already held does not stop a new picture being stored', () => {
        const r = mk();

        r.setTexture(10, { w: 2, h: 2, rgba: pixels(1) });
        r.setTexture(10, { w: 2, h: 2, rgba: pixels(1) });
        r.setTexture(11, { w: 2, h: 2, rgba: pixels(3) });

        assert.ok(r.textures.get(11), 'the new id must be stored');
        assert.equal(r.fingerprints.size, 2,
            'exactly two distinct pictures should be known');
    });
});
