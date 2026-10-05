import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { DFProtocol } from '../src/core/protocol.js';
import { DFRenderer } from '../src/core/renderer.js';

describe('Asset bridge request (opcode 0x08)', () => {
    it('encodes opcode, seq and the MISSING texture ids', () => {
        const buf = DFProtocol.encodeAssetBridgeRequest(1234, [3, 9, 41]);
        const view = new DataView(buf);

        assert.equal(view.getUint8(0), 8, 'opcode must be 0x08');
        assert.equal(view.getUint32(1, true), 1234, 'frame seq');
        assert.equal(view.getUint16(5, true), 3, 'wanted count');
        assert.equal(view.getUint16(7, true), 3);
        assert.equal(view.getUint16(9, true), 9);
        assert.equal(view.getUint16(11, true), 41);
        assert.equal(buf.byteLength, 13, '7 byte header + 3 ids');
    });

    it('carries the missing set verbatim, so the host never has to diff frames', () => {
        // Guards the regression: an earlier encoding sent the HELD set and let
        // the host work out what was missing by comparing against its own copy
        // of a single frame. The two views disagreed and nothing was ever resent.
        const view = new DataView(DFProtocol.encodeAssetBridgeRequest(9, [1996, 1997]));
        assert.equal(view.getUint16(5, true), 2);
        assert.equal(view.getUint16(7, true), 1996);
        assert.equal(view.getUint16(9, true), 1997);
    });

    it('de-duplicates and drops ids that cannot be put on the wire', () => {
        const view = new DataView(DFProtocol.encodeAssetBridgeRequest(1, [7, 7, 0, -1, 65536, 2.5, 9]));
        assert.equal(view.getUint16(5, true), 2, 'only 7 and 9 survive');
    });

    it('encodes an empty wanted-set', () => {
        const buf = DFProtocol.encodeAssetBridgeRequest(5, []);
        const view = new DataView(buf);
        assert.equal(buf.byteLength, 7);
        assert.equal(view.getUint16(5, true), 0);
        assert.equal(view.getUint32(1, true), 5);
    });
});

describe('Frame is held until every texture it references has arrived', () => {
    // The renderer wants a live canvas, but asset accounting must not depend on
    // WebGL being present, so this exercises the same methods on a bare instance.
    const makeRenderer = () => {
        const r = Object.create(DFRenderer.prototype);
        r.commands = [];
        r.textures = new Map();
        r.dirty = true;
        r.assetsReady = true;
        r.lastDrawCalls = 0;
        r.lastSprites = 0;
        r.gl = null;
        r.ctx = { fillStyle: '', fillRect() {}, drawImage() {} };
        r.canvas = { width: 1280, height: 720 };
        return r;
    };

    it('reports every texture the command buffer draws from', () => {
        const r = makeRenderer();
        r.applyFullFrame([
            { texId: 1 }, { texId: 2 }, { texId: 1 }, { texId: 0 }, { texId: 3 }, null
        ]);
        assert.deepEqual([...r.collectTextureIds()].sort((a, b) => a - b), [1, 2, 3]);
    });

    it('reports as missing only the textures that have not arrived', () => {
        const r = makeRenderer();
        r.applyFullFrame([{ texId: 1 }, { texId: 2 }, { texId: 3 }]);
        r.textures.set(1, {});
        r.textures.set(3, {});

        assert.deepEqual([...r.missingTextureIds()], [2]);
        assert.equal(r.hasTexture(1), true);
        assert.equal(r.hasTexture(2), false);
    });

    it('refuses to draw while assets are missing, and draws once they land', () => {
        const r = makeRenderer();
        r.applyFullFrame([{ texId: 5 }]);
        r.assetsReady = false;

        // Holding is observable: no draw call was produced and the buffer is
        // still dirty, so the frame is not silently lost.
        assert.equal(r.render(), false);
        assert.equal(r.dirty, true);

        r.textures.set(5, { w: 16, h: 16 });
        r.assetsReady = true;
        assert.equal(r.render(), true, 'renders as soon as the asset arrives');
    });

    it('a frame whose assets are all present is displayable immediately', () => {
        const r = makeRenderer();
        r.textures.set(7, { w: 16, h: 16 });
        r.applyFullFrame([{ texId: 7 }]);
        assert.equal(r.missingTextureIds().size, 0);
        assert.equal(r.render(), true);
    });
});