/**
 * A frame that is missing a picture is never drawn.
 *
 * This is a correctness rule and it is not negotiable: drawing with a hole shows
 * something the game never drew. When the display stalls because a picture is
 * outstanding, the fix is to make the picture arrive - never to draw anyway,
 * however tempting the stall looks.
 *
 * It is written down because it is exactly the rule that gets relaxed when the
 * display is slow, and relaxing it trades a visible stutter for silent
 * corruption, which is far harder to notice and far worse to explain.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { DFRenderer } from '../src/core/renderer.js';

globalThis.ImageData = class ImageData {};

// A Proxy rather than an object with every method spelled out: the renderer
// touches a lot of GL, and a hand-written stub fails on whichever method was
// added after it was written. Constants read as numbers, creators return objects,
// everything else is a no-op.
const fakeGL = () => new Proxy({}, {
    get(_t, k) {
        if (typeof k !== 'string') return undefined;
        if (/^[A-Z][A-Z0-9_]*$/.test(k)) return 1;
        if (k === 'getExtension') return () => null;
        if (k === 'getParameter' || k === 'getError') return () => 0;
        if (k === 'getShaderParameter' || k === 'getProgramParameter') return () => true;
        if (k === 'getUniformLocation' || k === 'getAttribLocation') return () => 1;
        if (/^create/.test(k)) return () => ({});
        return () => undefined;
    },
});

// The constructor configures a 2D context even on the WebGL path, so it needs
// something with the properties it touches rather than null.
const fakeCtx = () => ({
    imageSmoothingEnabled: false,
    fillRect() {}, clearRect() {}, drawImage() {}, save() {}, restore() {},
    translate() {}, scale() {}, beginPath() {}, closePath() {}, fill() {},
    getImageData: () => ({ data: new Uint8ClampedArray(4) }),
    putImageData() {}, createImageData: () => ({ data: new Uint8ClampedArray(4) }),
});

const makeRenderer = () => {
    const canvas = {
        width: 640, height: 360,
        // The renderer asks for the WebGL context itself, so the stub has to
        // answer that name with the GL one rather than with the 2D one.
        getContext: (kind) => (kind === '2d' ? fakeCtx() : fakeGL()),
    };
    const r = new DFRenderer(canvas, { isWebGL: true, gl: fakeGL() });
    r.gl = fakeGL();
    r.isWebGL = true;
    return r;
};

describe('no frame is drawn while a picture is outstanding', () => {
    test('render refuses while pictures are missing, however long it has been painting', () => {
        const r = makeRenderer();
        r.assetsReady = true;
        r.dirty = true;
        assert.equal(r.render(), true, 'a complete frame is drawn');

        // Plenty of successful frames first: "it has drawn before" must not
        // become a licence to draw an incomplete one.
        for (let i = 0; i < 50; i++) {
            r.assetsReady = true;
            r.dirty = true;
            r.render();
        }

        r.dirty = true;
        r.assetsReady = false;
        assert.equal(r.render(), false,
            'a frame missing a picture must not be drawn - hold the last good frame instead');
    });

    test('nothing is painted while the gate is closed, even when the frame is marked dirty', () => {
        const r = makeRenderer();
        let paints = 0;
        r.renderWebGL = () => { paints++; };
        r.assetsReady = false;
        for (let i = 0; i < 10; i++) {
            r.dirty = true;
            r.render();
        }
        assert.equal(paints, 0, 'a closed gate means no paint at all, not a paint with holes');
    });
});
