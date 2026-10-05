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
            hasBaseSeq: (flags & 0x08) !== 0,
            count: view.getUint16(8, true)
        };
    }

    static TEXTURE_HEADER_BYTES = 16;

    // Returns one texture CHUNK, not necessarily a whole texture. A DataChannel
    // refuses any message above the peer's advertised a=max-message-size
    // (Chrome: 262144), so a full-screen RGBA surface arrives as several
    // messages; the caller reassembles them.
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
        const totalLen = view.getUint32(8, true);
        const chunkIndex = view.getUint16(12, true);
        const chunkCount = Math.max(1, view.getUint16(14, true));

        // This message's own length, not the header's payload_len (which is the
        // whole texture and would overrun a partial message).
        const dataLen = buffer.byteLength - this.TEXTURE_HEADER_BYTES;
        if (dataLen < 0) return null;

        return {
            texId, w, h, totalLen, chunkIndex, chunkCount,
            data: new Uint8Array(buffer, this.TEXTURE_HEADER_BYTES, dataLen)
        };
    }

    static decodeFrame(buffer, zstdLib = fzstd) {
        const zstd = zstdLib;
        const view = new DataView(buffer);
        const hdr = this.parseHeader(view);
        if (!hdr || !zstd) return null;

        let payloadOffset = 10;
        let stamp = 0;
        if (hdr.hasStamp) {
            stamp = view.getUint8(payloadOffset);
            payloadOffset += 1;
        }

        let baseSeq = hdr.seq - 1;
        if (hdr.hasBaseSeq) {
            baseSeq = view.getUint32(payloadOffset, true);
            payloadOffset += 4;
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
            return { type: 'delta', seq: hdr.seq, baseSeq, stamp, totalCmdCount: hdr.count, updates };
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

    static encodeGapAck(lastAckedSeq) {
        const buf = new ArrayBuffer(5);
        const view = new DataView(buf);
        view.setUint8(0, 7); // Opcode 0x07: GAP_ACK / COMBINED_DELTA_REQ
        view.setUint32(1, (lastAckedSeq || 0) >>> 0, true);
        return buf;
    }

    // Asset bridge request (0x08).
    //
    // The client is holding a frame because one or more textures that frame
    // references never completed - either dropped in transit, or split across
    // chunks of which one was lost. It names the texture ids it is missing and
    // the host resends exactly those.
    //
    // Naming the missing assets directly (rather than the held ones) is what
    // makes this reliable. An earlier version asked "resend what frame N needs"
    // and the host resolved that against its own copy of frame N; the client's
    // accumulated command buffer and that single frame disagree, so the host
    // concluded it had sent everything and resent nothing, leaving the texture
    // permanently incomplete.
    //
    //   byte  0      : 0x08
    //   bytes 1..4   : u32 frame seq the client is stuck on (diagnostics only)
    //   bytes 5..6   : u16 count of missing texture ids
    //   bytes 7..    : u16 missing texture ids
    static encodeAssetBridgeRequest(seq, missingIds) {
        const ids = [];
        const seen = new Set();
        for (const id of missingIds || []) {
            if (!Number.isInteger(id) || id <= 0 || id > 0xFFFF) continue;
            if (seen.has(id)) continue;
            seen.add(id);
            ids.push(id);
        }

        const buf = new ArrayBuffer(7 + ids.length * 2);
        const view = new DataView(buf);
        view.setUint8(0, 8);
        view.setUint32(1, (seq || 0) >>> 0, true);
        view.setUint16(5, ids.length, true);
        for (let i = 0; i < ids.length; i++) {
            view.setUint16(7 + i * 2, ids[i], true);
        }
        return buf;
    }
}
