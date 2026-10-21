import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { DFProtocol } from '../src/core/protocol.js';
import { probeArrivals } from '../src/core/measure.js';

// A controlled message stream the host can offer on demand, so the link's
// behaviour under a chosen rate and a chosen message size can be measured
// instead of inferred from whatever the game happened to send
// (scripts/df_load_probe.mjs). The page is the only place that sees every
// message, so the page is where they are counted.
function probeMessage({ seq = 1, size = 64 } = {}) {
    const buf = new ArrayBuffer(size);
    const view = new DataView(buf);
    view.setUint8(0, 0x44);      // 'D'
    view.setUint8(1, 0x50);      // 'P'
    view.setUint32(2, seq, true);
    view.setUint32(6, size, true);
    return buf;
}

describe('load probe messages', () => {
    it('carries its own sequence number, so a gap names a message', () => {
        const probe = DFProtocol.decodeProbe(probeMessage({ seq: 4242, size: 64 }));
        assert.equal(probe.seq, 4242);
        assert.equal(probe.size, 64);
    });

    // The probe is not part of the protocol: a frame, a picture chunk or a
    // message from a host that does not have the probe must not be read as one.
    it('is not confused with the messages the path really sends', () => {
        const frame = new ArrayBuffer(16);
        new DataView(frame).setUint8(0, 0x44);
        new DataView(frame).setUint8(1, 0x46);   // 'D','F'
        assert.equal(DFProtocol.decodeProbe(frame), null);

        const texture = new ArrayBuffer(16);
        new DataView(texture).setUint8(0, 0x44);
        new DataView(texture).setUint8(1, 0x54); // 'D','T'
        assert.equal(DFProtocol.decodeProbe(texture), null);

        assert.equal(DFProtocol.decodeProbe(new ArrayBuffer(4)), null,
            'a message too short to carry the header is not a probe');
    });
});

// Counting arrivals by sequence number, without keeping every number.
//
// The page's wire log is capped and drops its oldest entries, so at the rates the
// probe reaches the log stops describing the whole window - and a gap count taken
// from it then reads the log's own eviction as loss. The channel is ordered, so
// arrivals are not: the highest number seen, the lowest and the count are enough
// to say exactly how many are missing in between.
describe('probeArrivals', () => {
    it('finds the missing numbers from the range and the count alone', () => {
        const a = probeArrivals({ count: 8, min: 1, max: 10, reordered: 0 });
        assert.equal(a.expected, 10);
        assert.equal(a.missing, 2);
        assert.equal(a.beforeFirstSeen, 0);

        const b = probeArrivals({ count: 5, min: 11, max: 15, reordered: 0 });
        assert.equal(b.missing, 0, 'a window that starts mid-stream is not missing its beginning');
        assert.equal(b.beforeFirstSeen, 10, 'and the numbers before it are reported separately');
    });

    it('refuses to invent a gap count from numbers that cannot describe one', () => {
        assert.equal(probeArrivals({ count: 0, min: null, max: null, reordered: 0 }).missing, null);
        // A duplicate or an out-of-order arrival means the range and the count are
        // no longer enough to say what is missing, and the honest answer is that
        // this measurement cannot be made rather than a number that looks like one.
        assert.equal(probeArrivals({ count: 12, min: 1, max: 10, reordered: 1 }).missing, null);
    });
});
