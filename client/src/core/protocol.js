import * as fzstd from 'fzstd';

export class DFProtocol {
    static DRAW_COMMAND_SIZE = 18;
    static INPUT_EVENT_SIZE = 16;
    
    static parseHeader(view) {
        const magic0 = view.getUint8(0);
        const magic1 = view.getUint8(1);
        if (magic0 !== 0x44 || magic1 !== 0x46) { // 'D', 'F'
            return null;
        }
        const flags = view.getUint16(6, true);
        return {
            seq: view.getUint32(2, true),
            flags: flags,
            hasStamp: (flags & 0x04) !== 0,
            count: view.getUint16(8, true)
        };
    }

    static decodeTexture(buffer) {
        const view = new DataView(buffer);
        const magic0 = view.getUint8(0);
        const magic1 = view.getUint8(1);
        if (magic0 !== 0x44 || magic1 !== 0x54) { // 'D', 'T'
            return null;
        }
        const texId = view.getUint16(2, true);
        const w = view.getUint16(4, true);
        const h = view.getUint16(6, true);
        const rgba = new Uint8ClampedArray(buffer, 12, w * h * 4);
        return { texId, w, h, rgba };
    }

    static decodeFrame(buffer, zstdLib = fzstd) {
        const zstd = zstdLib;
        const view = new DataView(buffer);
        const hdr = this.parseHeader(view);
        if (!hdr || !zstd) return null;

        let payloadOffset = 10;
        let stamp = 0;
        if (hdr.hasStamp) {
            stamp = view.getUint8(10);
            payloadOffset = 11;
        }

        const compressedPayload = new Uint8Array(buffer, payloadOffset);
        const decompressed = zstd.decompress(compressedPayload);
        const dView = new DataView(decompressed.buffer, decompressed.byteOffset, decompressed.byteLength);

        const isFull = (hdr.flags & 0x01) !== 0;
        const isDelta = (hdr.flags & 0x02) !== 0;

        if (isFull) {
            const cmds = [];
            const count = hdr.count;
            for (let i = 0; i < count; i++) {
                const off = i * this.DRAW_COMMAND_SIZE;
                cmds.push({
                    texId: dView.getUint16(off, true),
                    srcX: dView.getInt16(off + 2, true),
                    srcY: dView.getInt16(off + 4, true),
                    srcW: dView.getInt16(off + 6, true),
                    srcH: dView.getInt16(off + 8, true),
                    dstX: dView.getInt16(off + 10, true),
                    dstY: dView.getInt16(off + 12, true),
                    dstW: dView.getInt16(off + 14, true),
                    dstH: dView.getInt16(off + 16, true)
                });
            }
            return { type: 'full', seq: hdr.seq, stamp, cmds };
        } else if (isDelta) {
            const updates = [];
            const numUpdates = dView.byteLength >= 2 ? dView.getUint16(0, true) : 0;
            const entrySize = 2 + this.DRAW_COMMAND_SIZE; // uint16 idx + DrawCommand
            for (let i = 0; i < numUpdates; i++) {
                const off = 2 + i * entrySize;
                const idx = dView.getUint16(off, true);
                const cmdOff = off + 2;
                updates.push({
                    index: idx,
                    cmd: {
                        texId: dView.getUint16(cmdOff, true),
                        srcX: dView.getInt16(cmdOff + 2, true),
                        srcY: dView.getInt16(cmdOff + 4, true),
                        srcW: dView.getInt16(cmdOff + 6, true),
                        srcH: dView.getInt16(cmdOff + 8, true),
                        dstX: dView.getInt16(cmdOff + 10, true),
                        dstY: dView.getInt16(cmdOff + 12, true),
                        dstW: dView.getInt16(cmdOff + 14, true),
                        dstH: dView.getInt16(cmdOff + 16, true)
                    }
                });
            }
            return { type: 'delta', seq: hdr.seq, stamp, totalCmdCount: hdr.count, updates };
        }
        return null;
    }

    static encodeInput(type, x, y, button, keycode, scancode, mod, debugStamp = 0) {
        const size = (debugStamp > 0) ? 17 : 16;
        const buf = new ArrayBuffer(size);
        const view = new DataView(buf);
        view.setUint8(0, type);
        view.setInt16(1, x, true);
        view.setInt16(3, y, true);
        view.setUint8(5, button);
        view.setUint32(6, (keycode || 0) >>> 0, true);
        view.setUint32(10, (scancode || 0) >>> 0, true);
        view.setUint16(14, (mod || 0) >>> 0, true);
        if (debugStamp > 0) {
            view.setUint8(16, debugStamp & 0xFF);
        }
        return buf;
    }

    static encodeResize(width, height) {
        return this.encodeInput(5, width, height, 0, 0, 0, 0);
    }

    static encodeKeyframeRequest() {
        return this.encodeInput(6, 0, 0, 0, 0, 0, 0);
    }
}
