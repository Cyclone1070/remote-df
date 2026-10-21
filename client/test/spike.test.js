import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { wireBetween, WireRecorder, spikeReport, clockAlign, matchFrameSends, blockedInWindow, clientActivity, matchInputs, uplinkInWindow, hostWireLog, hostShareFor, inputLog, gapCause, arrivalHole, verdictCounts, framesInWindow, gapsLine } from '../src/core/measure.js';

// A spike's context is only worth having if the wire traffic in it is COMPLETE.
// The previous attempt at this recorded frames and keepalives and silently left out
// textures, which on this link are ~99% of the bytes - so a spike caused by an
// artwork burst read as "nothing was sent". The recorder therefore takes any
// kind, and the window has to account for every byte it was given.
describe('wireBetween', () => {
    it('sums every message kind in the window, artwork included', () => {
        const events = [
            [100, 'frame', 114],
            [110, 'artwork', 131088],
            [130, 'probe', 18],
            [140, 'artwork', 131088],
            [200, 'frame', 114],
        ];
        const w = wireBetween(events, 105, 150);

        assert.equal(w.count, 3);
        assert.equal(w.bytes, 131088 + 18 + 131088);
        assert.equal(w.byKind.artwork.count, 2);
        assert.equal(w.byKind.artwork.bytes, 262176);
        assert.equal(w.byKind.probe.bytes, 18);
        assert.equal(w.byKind.frame, undefined, 'the frame outside the window must not be counted');
        assert.equal(w.dominant, 'artwork');
    });

    it('is half-open, so two adjacent windows cannot count one message twice', () => {
        const events = [[100, 'frame', 114], [200, 'probe', 18]];
        assert.equal(wireBetween(events, 100, 200).count, 1);
        assert.equal(wireBetween(events, 200, 300).count, 1);
        assert.equal(wireBetween(events, 100, 300).count, 2);
    });
});

describe('WireRecorder', () => {
    it('keeps the newest events when the log is capped, and never drops a kind', () => {
        const rec = new WireRecorder({ max: 3 });
        rec.record('frame', 114, 1);
        rec.record('artwork', 131088, 2);
        rec.record('probe', 18, 3);
        rec.record('artwork', 131088, 4);

        assert.equal(rec.events.length, 3);
        assert.equal(rec.events[0][2], 131088, 'the oldest event is the one dropped');
        assert.deepEqual(rec.events.map((e) => e[1]), ['artwork', 'probe', 'artwork']);
    });
});

// A spike is only worth reporting with the context that tells two causes apart:
// what else was on the wire, how deep the host's send queue was, how long the
// host itself held the input, what the display did immediately before it, and
// whether the client was parked waiting for artwork.
describe('spikeReport', () => {
    // Twenty changes, evenly spaced; the sixth input took 134ms where the others
    // took 5, so it is the worst 5% and the only latency spike.
    const display = Array.from({ length: 20 }, (_, i) => 1016 + i * 16);
    const latency = display.map((shownAt, i) => {
        const ms = i === 5 ? 134 : 5;
        return { stamp: i + 1, sentAt: shownAt - ms, shownAt, ms };
    });
    const wire = [
        [950, 'frame', 114],        // before the slow input was sent
        [963, 'artwork', 131088],   // arriving while that input was being answered
        [970, 'artwork', 131088],
        [975, 'probe', 18],
        [1300, 'frame', 114],       // before the freeze, not during it
    ];

    it('takes the worst 5% of the samples and every freeze gap, with their context', () => {
        const report = spikeReport({
            latency,
            freezes: [{ ms: 300, atMs: 1400 }],
            display,
            wire,
            queue: [[955, 1000], [965, 393216], [985, 2000]],
            park: [[900, 0], [964, 3]],
            hostAnswers: [[1090, 6, 14]],
        });

        assert.equal(report.worstSelected, 1, '20 samples -> the worst 1');
        assert.equal(report.events.length, 2, 'one worst sample plus one freeze gap');

        const sample = report.events.find((e) => e.kind === 'latency');
        assert.equal(sample.ms, 134);
        assert.equal(sample.fromMs, 962, 'the window is the sample itself: input sent -> shown');
        assert.equal(sample.toMs, 1096);
        assert.equal(sample.wire.byKind.artwork.count, 2, 'the frame at 950 was sent before this input');
        assert.equal(sample.wire.byKind.frame, undefined);
        assert.equal(sample.wire.bytes, 131088 * 2 + 18);
        assert.equal(sample.wire.dominant, 'artwork');
        assert.equal(sample.queueMax, 393216);
        assert.equal(sample.hostMs, 14);
        assert.equal(sample.parked, 3, 'the park level is carried forward, not just sampled in the window');
        assert.equal(sample.gapBeforeMs, 16, 'the gap that ended at this very sample');

        const gap = report.events.find((e) => e.kind === 'freeze');
        assert.equal(gap.ms, 300);
        assert.equal(gap.wire.count, 0, 'nothing at all was on the wire during the freeze');
        assert.equal(gap.hostMs, null, 'a freeze carries no stamp, so it has no host share of its own');
        assert.equal(gap.gapBeforeMs, 80, 'the gap that ran into the freeze');
    });
});

// The discriminating question: do the worst samples share a signature (a hole
// in the algorithm) or does each one have its own reason (jitter)? A count of
// how often the commonest signature repeats, and what it is, is the answer.
// The question the whole exercise is for: when the page saw nothing, was the
// host silent too? A window in which the host handed over three messages and the
// page received none is a transport stall - the bytes were sent and did not
// arrive. A window in which the host sent nothing either is a quiet game or a
// blocked host, which is a different fault with a different fix. One side alone
// cannot tell them apart.
describe('spikeReport host side', () => {
    const display = Array.from({ length: 100 }, (_, i) => 1000 + i * 16);
    const latency = display.map((shownAt, i) => ({
        stamp: i + 1, sentAt: shownAt - (i === 1 ? 120 : 5), shownAt, ms: i === 1 ? 120 : 5,
    }));

    it('marks a spike the host sent through and the page never saw', () => {
        const report = spikeReport({
            latency, freezes: [], display, wire: [],
            hostWire: [[display[1] - 100, 'frame', 114], [display[1] - 80, 'artwork', 400]],
        });
        const spike = report.events.find((e) => e.kind === 'latency');
        assert.equal(spike.hostSent, 2, 'the host handed over two messages');
        assert.equal(spike.wire.count, 0, 'and the page received none');
        assert.match(spike.signature, /sent but not received/);
    });

    // And when some of what the host sent did arrive, the sequence numbers say
    // whether this particular frame was lost or merely late.
    it('counts the frames that were lost inside the spike, not just the ones that never showed up', () => {
        const report = spikeReport({
            latency, freezes: [], display, wire: [[display[1] - 50, 'frame', 114, 9]],
            hostWire: [[display[1] - 100, 'frame', 114, 8], [display[1] - 50, 'frame', 114, 9]],
            lostSeq: new Set([8]),
        });
        const spike = report.events.find((e) => e.kind === 'latency');
        assert.equal(spike.hostSent, 2);
        assert.equal(spike.wire.count, 1, 'one of the two arrived');
        assert.equal(spike.lost, 1, 'and the seq says which one did not');
        assert.match(spike.signature, /frame lost/);
    });

    it('does not mark a spike the host was quiet through', () => {
        const report = spikeReport({ latency, freezes: [], display, wire: [], hostWire: [] });
        const spike = report.events.find((e) => e.kind === 'latency');
        assert.equal(spike.hostSent, 0);
        assert.doesNotMatch(spike.signature, /sent but not received/);
    });
});

describe('spikeReport signatures', () => {
    // A hundred samples, so the worst 5% is five of them: the four 120ms outliers
    // and one ordinary sample, which is what the signature count is read against.
    const display = Array.from({ length: 100 }, (_, i) => 1000 + i * 16);

    // The signature used to carry a fifth term, "host pinging" / "host silent",
    // read off the keepalives the streamer sent while it had nothing to draw. The
    // keepalive was measured as doing nothing and removed, so the term has no
    // producer: a signature that still printed it would be describing a message
    // this path can no longer send.
    it('says nothing about keepalives, because this path no longer sends any', () => {
        const latency = display.map((shownAt, i) => ({
            stamp: i + 1, sentAt: shownAt - (i === 1 ? 120 : 5), shownAt, ms: i === 1 ? 120 : 5,
        }));
        // A keepalive inside the slow sample's own window. It used to be the term
        // that decided whether this spike read as "host busy" or "host idle".
        const report = spikeReport({
            latency, freezes: [], display,
            wire: [[display[1] - 110, 'ping', 10], [display[1] - 100, 'frame', 114]],
        });
        assert.ok(report.signatures.length > 0);
        for (const s of report.signatures) {
            assert.doesNotMatch(s.signature, /ping/i);
        }
    });

    it('counts a repeated signature and calls it a hole rather than jitter', () => {
        // Four slow samples, each waiting behind a deep queue with artwork on the
        // wire, and one that was slow with an empty queue and nothing sent.
        const latency = display.map((shownAt, i) => {
            const slow = [3, 7, 11, 15].includes(i);
            return { stamp: i + 1, sentAt: shownAt - (slow ? 120 : 5), shownAt, ms: slow ? 120 : 5 };
        });
        const wire = [];
        const queue = [];
        for (const i of [3, 7, 11, 15]) {
            const shownAt = display[i];
            wire.push([shownAt - 100, 'artwork', 131088]);
            queue.push([shownAt - 100, 400000]);
        }
        wire.push([display[20] - 100, 'frame', 114]);

        const report = spikeReport({ latency, freezes: [], display, wire, queue });
        assert.equal(report.signatures.length, 2);
        assert.equal(report.signatures[0].count, 4);
        assert.equal(report.signatures[0].signature.includes('artwork'), true);
        assert.equal(report.signatures[0].signature.includes('queue deep'), true);
        assert.equal(report.verdict.repeated, true, '4 of 5 worst samples share one signature');
        assert.equal(report.verdict.of, 5);
    });

    // "Deep" is a different number on each path: the draw-command path's queue is
    // in bytes and libdatachannel's was measured at 393kB under load, while the
    // raw path's equivalent is how long the relay's write to the browser took.
    // One threshold for both would call every raw spike shallow.
    // The worst 5% of a tight distribution is not a tail. When p50 is 50ms and
    // p95 is 51ms, the "worst" samples are ordinary samples wearing a
    // percentile's clothes, and counting them as a repeated signature would call
    // a healthy path a hole. Only samples that are materially slow - twice the
    // median - and the freezes count toward the verdict.
    it('judges repeats on the samples that are materially slow, not on the worst of a tight set', () => {
        const latency = display.map((shownAt, i) => ({
            stamp: i + 1, sentAt: shownAt - (i < 3 ? 52 : 50), shownAt, ms: i < 3 ? 52 : 50,
        }));
        const tight = spikeReport({ latency, freezes: [], display, wire: [], materialMs: 100 });
        assert.equal(tight.events.length, 5);
        assert.equal(tight.verdict.of, 0, 'nothing here is materially slow');
        assert.match(tight.verdict.note, /no sample reached twice the median|is not a tail/i);

        const withOneHole = spikeReport({
            latency: latency.map((s, i) => (i === 7 ? { ...s, ms: 300, sentAt: s.shownAt - 300 } : s)),
            freezes: [], display, wire: [[display[7] - 200, 'artwork', 131088]], materialMs: 100,
        });
        assert.equal(withOneHole.verdict.of, 1, 'only the 300ms sample is in the tail');
        assert.equal(withOneHole.verdict.repeated, false, 'one sample is not a repeat');
    });

    it('takes the depth that means deep on this path, not one number for both', () => {
        const latency = display.map((shownAt, i) => ({
            stamp: i + 1, sentAt: shownAt - (i === 3 ? 120 : 5), shownAt, ms: i === 3 ? 120 : 5,
        }));
        const queue = [[display[3] - 110, 30000]];
        const byBytes = spikeReport({ latency, freezes: [], display, wire: [], queue, queueDeepAt: 65536 });
        const byMicros = spikeReport({ latency, freezes: [], display, wire: [], queue, queueDeepAt: 20000 });
        assert.equal(byBytes.signatures.some((s) => s.signature.includes('queue deep')), false);
        assert.equal(byMicros.signatures.some((s) => s.signature.includes('queue deep')), true);
    });

    it('calls a scatter of one-off signatures jitter', () => {
        const latency = display.map((shownAt, i) => {
            const slow = [3, 7, 11, 15].includes(i);
            return { stamp: i + 1, sentAt: shownAt - (slow ? 120 : 5), shownAt, ms: slow ? 120 : 5 };
        });
        // Every slow sample has a different wire make-up and a different queue.
        const wire = [
            [display[3] - 100, 'artwork', 131088],
            [display[7] - 100, 'frame', 114],
            [display[11] - 100, 'probe', 18],
        ];
        const queue = [[display[3] - 100, 400000], [display[7] - 100, 1000], [display[15] - 100, 200000]];

        const report = spikeReport({ latency, freezes: [], display, wire, queue });
        assert.equal(report.signatures[0].count, 1, 'no signature repeats');
        assert.equal(report.verdict.repeated, false);
        assert.match(report.verdict.note, /jitter|no common factor|scatter/i);
    });
});

// A spike's context is collected on two machines: the page's wire log is on the
// client's clock and the host's queue and stamp log are on the host's. Putting
// one inside the other needs an offset, and the offset has to be estimated
// rather than assumed - the two machines' clocks differ by an unknown amount.
describe('clockAlign', () => {
    it('estimates the host clock offset from a round trip and says how far the estimates scatter', () => {
        // Every round trip took 4ms and the host clock runs 1500ms ahead.
        const align = clockAlign([
            { t0: 1000, t1: 1004, hostNow: 2502 },
            { t0: 2000, t1: 2004, hostNow: 3502 },
            { t0: 3000, t1: 3006, hostNow: 4504 },
        ]);
        assert.equal(align.offsetMs, 1500);
        assert.equal(align.spreadMs, 1, 'the estimates differ by 1ms because one round trip took 6ms');
        assert.equal(align.samples, 3);
    });

    it('puts a host timestamp on the client clock', () => {
        const align = clockAlign([{ t0: 1000, t1: 1004, hostNow: 2502 }]);
        assert.equal(align.toClient(3502), 2002);
    });

    it('has no answer with no samples, rather than an offset of zero', () => {
        const align = clockAlign([]);
        assert.equal(align.offsetMs, null);
        assert.equal(align.toClient(5000), null);
    });
});

// A frame that never arrived and a frame that arrived late are different
// findings: the first is loss on the wire, the second is something holding the
// messages up. The only way to tell them apart from the logs is the sequence
// number the sender put on the message.
// "The picture did not change for a quarter of a second" has two very different
// explanations: nothing arrived, or the page was not running to notice. The
// second is invisible in every other number this bench collects, so the page
// watches its own main thread and this counts how much of a spike it was busy
// for. Overlap, not full duration: a task that started before the window and
// ended inside it blocked only part of it.
describe('blockedInWindow', () => {
    it('counts the main-thread time inside the window, not the tasks that merely touch it', () => {
        const tasks = [[1000, 400], [1500, 20], [2400, 50]];
        const b = blockedInWindow(tasks, 1200, 1600);
        assert.equal(b.count, 2);
        assert.equal(b.maxOverlapMs, 200, 'the 400ms task only overlapped 200ms of the window');
        assert.equal(b.totalMs, 220);
        assert.equal(b.longestMs, 400);
    });

    it('reports nothing for a window the page ran straight through', () => {
        const b = blockedInWindow([[1000, 400]], 2000, 2200);
        assert.equal(b.count, 0);
        assert.equal(b.totalMs, 0);
    });
});

// Wi-Fi power save is entered by the STATION, on its own idleness: what keeps a
// radio awake is the station transmitting, not the host sending to it. So the
// question "was the link quiet?" is asked of the client's own sends, and the
// answer is the longest stretch inside the spike with nothing sent.
describe('clientActivity', () => {
    it('measures the longest silence inside the window, bounded by the window itself', () => {
        const sends = [1000, 1025, 1050, 1300];
        const a = clientActivity(sends, 1040, 1400);
        assert.equal(a.count, 2, 'the sends at 1050 and 1300 fall inside');
        assert.equal(a.longestSilenceMs, 250, 'nothing was sent between 1050 and 1300');
        assert.equal(a.firstSendBeforeMs, 15, 'how long before the spike the client last transmitted');
    });

    it('reports a client that kept transmitting as having no silence', () => {
        const sends = Array.from({ length: 20 }, (_, i) => 1000 + i * 25);
        const a = clientActivity(sends, 1000, 1500);
        assert.equal(a.longestSilenceMs, 25);
    });
});

// Which direction stalled? The uplink is the mirror of the frame transit: the
// page knows when it sent each input, the host knows when each arrived. If
// inputs sent during a downlink stall reach the host on time, only the downlink
// held; if they arrive in a burst at the end, the stall was in the browser's
// whole network path. One side's log cannot say which.
describe('matchInputs', () => {
    it('measures the uplink transit of the inputs the host received', () => {
        const clientSent = [[1000, 1], [1025, 2], [1500, 3]];
        const hostGot = [[1005, 1], [1030, 2], [1600, 3]];
        const match = matchInputs(clientSent, hostGot);
        assert.deepEqual(match.transitMs, [5, 5, 100], 'paired in time order');
        assert.equal(match.matched, 3);
        assert.equal(match.missing, 0);
        assert.equal(match.extra, 0, 'and nothing arrived that no send accounts for');
    });

    // An input that never arrived used to shift every pair after it and force the
    // whole window to be refused. Pairing by stamp and time measures the inputs
    // that DID arrive and counts the one that did not, which is the answer a
    // reader wants from a lossy link.
    it('counts an input that never arrived and still measures the rest', () => {
        const clientSent = [[1000, 1], [1025, 2], [1500, 3]];
        const hostGot = [[1005, 1], [1600, 3]];
        const match = matchInputs(clientSent, hostGot);
        assert.equal(match.missing, 1);
        assert.equal(match.matched, 2);
        assert.deepEqual(match.transitMs, [5, 100], 'the two that arrived are paired with their own sends');
        assert.equal(match.paired, true);
    });

    // The live failure this replaces: the page's send log is reset when the
    // window opens, and the host's arrival log still holds answers delivered
    // inside the window to inputs sent before it. Pairing by position put every
    // pair one place out and refused the whole window - 369 of 369 pairs.
    it('is not shifted by arrivals whose send happened before the window opened', () => {
        const clientSent = [[1000, 5], [1050, 6], [1100, 7]];
        const hostGot = [[900, 4], [1010, 5], [1060, 6], [1110, 7]];
        const match = matchInputs(clientSent, hostGot);
        assert.equal(match.paired, true, 'three sends, three arrivals with the same stamps');
        assert.deepEqual(match.transitMs, [10, 10, 10]);
        assert.equal(match.extra, 1, 'the pre-window arrival is counted as unpaired, not used');
        assert.equal(match.missing, 0);
    });

    // The other live failure: 1229ms in which the host's arrival log shows no
    // input at all, then 21 arrivals inside one millisecond. The inputs were not
    // lost, they were held, and a matcher that refuses anything slower than a
    // round trip throws the measurement away.
    it('measures through an arrival hole', () => {
        const clientSent = [[1000, 1], [1050, 2], [1100, 3], [1150, 4]];
        const hostGot = [[2500, 1], [2500.4, 2], [2500.8, 3], [2501.2, 4]];
        const match = matchInputs(clientSent, hostGot);
        assert.equal(match.paired, true);
        assert.equal(match.matched, 4, 'every input is paired with its own arrival');
        assert.deepEqual(match.transitMs, [1500, 1450.4, 1400.8, 1351.2]);
    });

    // The stamp is a byte and wraps every 256 inputs. Matching on it alone paired
    // an input from the measured window with an arrival from the connect phase
    // and produced transits of minus fifty seconds.
    // A transit is the arrival minus the send, across two clocks that were put
    // together from a round trip. A pairing whose stamps disagree is a pairing of
    // the wrong two inputs, and one whose transit comes out far below zero is a
    // clock that was put together wrongly: neither is a latency, and quoting a
    // median of them is how a run printed -5640ms as a measurement.
    it('refuses to quote a transit when the pairing is not established', () => {
        // The archived failure, in full: every host stamp is zero because the
        // reader took the wrong field, so no send can find its own arrival.
        const allZero = matchInputs([[1000, 5], [1025, 6], [1500, 7]], [[1005, 0], [1030, 0], [1600, 0]]);
        assert.equal(allZero.paired, false, 'no send finds an arrival carrying its stamp');
        assert.match(allZero.reason, /stamp/);
        assert.deepEqual(allZero.transitMs, [], 'so no transit is quoted from it');
        assert.equal(allZero.unmatchedByStamp, 3);
        assert.equal(allZero.missing, 3, 'and they are counted as never having arrived');

        const sent = [[1000, 1], [1025, 2], [1500, 3]];
        // An arrival that lands before its own send is not that send's arrival:
        // it is an answer to an input sent before the window opened. Counted and
        // dropped, never quoted - and a window in which that happens to most
        // pairs is two logs on two different clocks, which refuses the window.
        const someEarly = matchInputs(sent, [[1005, 1], [1030, 2], [946, 3]], { minTransitMs: -25 });
        assert.equal(someEarly.paired, true, 'one pair out of three is not a broken clock');
        assert.equal(someEarly.earlyPairs, 1);
        assert.deepEqual(someEarly.transitMs, [5, 5], 'and the early pair is not quoted as a transit');
        assert.equal(someEarly.missing, 0, 'the arrival was still accounted for');

        const allEarly = matchInputs(sent, sent.map(([t, st]) => [t - 500, st]), { minTransitMs: -25 });
        assert.equal(allEarly.paired, false, 'every arrival five hundred ms before its send is a broken clock');
        assert.match(allEarly.reason, /before its own send/);
        assert.deepEqual(allEarly.transitMs, [], 'so nothing from this window is quoted');

        const good = matchInputs(sent, [[1005, 1], [1030, 2], [1600, 3]]);
        assert.equal(good.paired, true);
        assert.deepEqual(good.transitMs, [5, 5, 100]);
        assert.equal(good.reason, null);
    });

    it('says so when the host log holds no input arrivals at all', () => {
        const match = matchInputs([[1000, 1], [1025, 2]], []);
        assert.equal(match.paired, false);
        assert.match(match.reason, /no input arrivals/);
        assert.equal(match.matched, 0);
    });

    it('pairs by stamp, so the wrap of the stamp does not break the pairing', () => {
        const clientSent = [[1000, 254], [1100, 255], [1200, 1]];
        const hostGot = [[1004, 254], [1108, 255], [1205, 1]];
        const match = matchInputs(clientSent, hostGot);
        assert.equal(match.paired, true);
        assert.deepEqual(match.transitMs, [4, 8, 5], 'the wrap is just another value');
        assert.equal(match.missing, 0);
        assert.equal(match.extra, 0);
    });

    // A stamp is one byte and cycles every 256 inputs, so the tolerance has to be
    // shorter than the time it takes the same value to come round again.
    it('will not pair a send with an arrival one stamp cycle later', () => {
        const clientSent = [[1000, 42]];
        const hostGot = [[1005, 42], [20000, 42]];
        const match = matchInputs(clientSent, hostGot);
        assert.deepEqual(match.transitMs, [5], 'the near arrival is the pair');
        assert.equal(match.extra, 1);
    });

    // An arrival whose stamp belongs to no send in the window is not evidence
    // that the pairing is wrong: it is an answer to an input sent before the
    // window opened, and it is counted as one.
    it('reports an arrival no send accounts for instead of using it as a pair', () => {
        const clientSent = [[1000, 255], [1100, 0], [1200, 1]];
        const hostGot = [[1004, 255], [1108, 7], [1205, 1]];
        const match = matchInputs(clientSent, hostGot);
        assert.equal(match.extra, 1);
        assert.equal(match.matched, 2);
        assert.equal(match.paired, true);
        assert.deepEqual(match.transitMs, [4, 5], 'only the two sends that found their own arrival');
        assert.equal(match.unmatchedByStamp, 1, 'the send whose stamp the host never logged');
    });
});

// A gap in which the host had nothing new to draw is the workload's quiet, not
// the path failing: the picture could not change because nothing was produced.
// Only a gap in which the host kept sending and the page kept missing is the
// path's. Without this, an idle scene reads as a stall.
describe('what a gap can be charged to', () => {
    // The three-way rule, on the auditor's own numbers: a 17.3/s host rate in
    // the window and a 1550ms gap in which the host sent 11 frames and the page
    // received 9. The host was NOT keeping up with its own rate (11 against 27
    // expected), and the page got most of what it did send, so the data cannot
    // say the path dropped it or that the game was still - which is a third
    // answer, not a quiet one.
    it('will not call a gap quiet when the host sent frames its own rate does not explain', () => {
        const g = gapCause({ hostFrames: 11, clientFrames: 9, gapMs: 1550, hostRatePerSecond: 17.3 });
        assert.equal(g.cause, 'unclear', 'the host sent 11 of an expected 27 and 9 arrived: the data cannot settle this');
        assert.equal(+g.expectedFrames.toFixed(1), 26.8);
    });
    it('judges the host against its own rate, not a fixed count of three', () => {
        // Two frames in a 40ms gap when the host runs at 50/s IS the host
        // sending: the old rule needed three and called this quiet.
        const busy = gapCause({ hostFrames: 2, clientFrames: 0, gapMs: 40, hostRatePerSecond: 50 });
        assert.equal(busy.cause, 'path', 'the host was sending at its rate and the page got none of it');
        // One frame in 740ms against 17.3/s is the game being still.
        const still = gapCause({ hostFrames: 1, clientFrames: 1, gapMs: 740, hostRatePerSecond: 17.3 });
        assert.equal(still.cause, 'quiet');
    });
    // A latency sample is a gap in which the picture DID change - that is what
    // makes it a sample - so "the host had nothing to draw" and "the frames
    // arrived and the display did not show them" are not answers about it. The
    // one thing that can still be said is that the page missed what was sent.
    it('passes no judgement on a slow sample beyond whether the page missed frames', () => {
        const one = spikeReport({
            latency: [{ stamp: 1, sentAt: 5000, shownAt: 5100, ms: 100 }], freezes: [], display: [4900, 5100],
            wire: [], hostWire: [[5050, 'frame', 1000, 1]], hostRatePerSecond: 17, worstFraction: 1,
        });
        assert.equal(one.events[0].cause, null, 'one frame in a 100ms sample is not a verdict');

        const missed = spikeReport({
            latency: [{ stamp: 1, sentAt: 5000, shownAt: 5100, ms: 100 }], freezes: [], display: [4900, 5100],
            wire: [],
            hostWire: [[5010, 'frame', 1000, 1], [5040, 'frame', 1000, 2], [5070, 'frame', 1000, 3]],
            hostRatePerSecond: 17, worstFraction: 1,
        });
        assert.equal(missed.events[0].cause, 'path', 'three frames sent and none arrived is a delivery failure');
        assert.equal(missed.verdict.pathSamples, 1, 'it is a sample, so it is counted as one');
        assert.equal(missed.verdict.stalls, 0, 'and not as a gap');
    });

    it('calls a gap the path\'s when the page missed most of what the host sent', () => {
        const g = gapCause({ hostFrames: 6, clientFrames: 0, gapMs: 300, hostRatePerSecond: 20 });
        assert.equal(g.cause, 'path');
        const kept = gapCause({ hostFrames: 6, clientFrames: 6, gapMs: 300, hostRatePerSecond: 20 });
        assert.equal(kept.cause, 'unclear', 'everything the host sent arrived, so the path did not drop it');
    });
});

describe('blind stalls', () => {
    // The host's own rate in the window is what its gap is judged against, so
    // the fixture states one: a slow scene at 3 frames a second.
    function fixture(frameSends, hostRatePerSecond = 3, arrived = []) {
        const latency = [{ stamp: 1, sentAt: 5000, shownAt: 5100, ms: 100 }];
        const hostWire = frameSends.map((t, i) => [t, 0, 1000, 0, i]);
        const wire = new WireRecorder();
        for (const t of arrived) wire.record('frame', 1000, t);
        return spikeReport({ latency, freezes: [{ atMs: 5000, ms: 600 }], wire: wire.events.slice(), hostWire,
                             hostRatePerSecond, display: [4800, 5000, 5600], worstFraction: 1 });
    }

    it('calls a gap blind only when the host kept sending through it', () => {
        const busy = fixture([5010, 5030, 5050, 5070]);
        assert.equal(busy.events[0].blind, true, 'four frames went out and none arrived');
        // One frame in 600ms against a 3/s rate is a fifth of what the host was
        // doing elsewhere in the window: the game had nothing to draw.
        const quiet = fixture([5010], 17);
        assert.equal(quiet.events[0].blind, false, 'one frame against a 17/s rate is the game being still');
        assert.equal(quiet.events[0].cause, 'quiet');
    });

    // What the classification is FOR is the difference between a path that lost
    // pictures and a game with nothing new to draw, and `docs/bench.md` defines
    // it in FRAMES: "the host sent at least three frames and the page got a third
    // of them or less". Counting every message instead charged a stall to the
    // path when the only traffic on the wire was the client's own uplink
    // arriving, which is the one thing a smart-path stall is guaranteed to have.
    it('does not blame the path for a gap whose only traffic was the client\'s own inputs', () => {
        const latency = [{ stamp: 1, sentAt: 5000, shownAt: 5100, ms: 100 }];
        const inputs = [[5010, 5, 17, 7], [5030, 5, 17, 8], [5050, 5, 17, 9]];
        const report = spikeReport({
            latency, freezes: [{ atMs: 5000, ms: 600 }], display: [4800, 5000, 5600],
            wire: inputs.map((e) => [e[0], 'input', e[2], e[3]]),
            hostWire: [...inputs.map((e) => [e[0], 'input', 17, e[3]]), [5070, 'frame', 114, 4]],
            worstFraction: 1,
        });
        const gap = report.events.find((e) => e.kind === 'freeze');
        assert.equal(gap.hostFrames, 1, 'one frame went out, and three inputs came in');
        assert.equal(gap.blind, false, 'three messages is not three frames');
        assert.equal(report.verdict.stalls, 0);
    });

    it('reports a gap it cannot settle as unclassified rather than as quiet', () => {
        // The auditor's live case: a 1550ms gap in which the host sent 11 frames
        // and 9 arrived, against a window rate of 17.3/s. 11 against the 26.8 its
        // own rate predicts, and the page got 9 of them, so this is neither the
        // path dropping pictures nor the game being still.
        const hostWire = [];
        for (let i = 0; i < 11; i++) hostWire.push([5000 + i * 140, 'frame', 1000, i]);
        const wire = new WireRecorder();
        for (let i = 0; i < 9; i++) wire.record('frame', 1000, 5000 + i * 140, i);
        const report = spikeReport({
            latency: [], freezes: [{ atMs: 5000, ms: 1550 }], display: [4900, 5000, 6550],
            wire: wire.events.slice(), hostWire, hostRatePerSecond: 17.3, worstFraction: 1,
        });
        const gap = report.events[0];
        assert.equal(gap.hostFrames, 11);
        assert.equal(gap.clientFrames, 9);
        assert.equal(gap.cause, 'unclear', 'the data cannot settle this one');
        assert.equal(report.verdict.quietGaps, 0, 'and it must not be counted as the host being quiet');
        assert.equal(report.verdict.unclearGaps, 1);
        assert.match(report.verdict.note, /cannot settle|unclassified/);
    });

    it('still calls it the path\'s when three frames went out and the page got none', () => {
        const latency = [{ stamp: 1, sentAt: 5000, shownAt: 5100, ms: 100 }];
        const report = spikeReport({
            latency, freezes: [{ atMs: 5000, ms: 600 }], display: [4800, 5000, 5600], wire: [],
            hostWire: [[5010, 'input', 17, 7], [5020, 'frame', 114, 1], [5040, 'frame', 114, 2], [5060, 'frame', 114, 3]],
            hostRatePerSecond: 17, worstFraction: 1,
        });
        const gap = report.events.find((e) => e.kind === 'freeze');
        assert.equal(gap.hostFrames, 3);
        assert.equal(gap.blind, true);
    });

    it('counts the host busy with one frame per keepalive in the summary', () => {
        const busy = fixture([5010, 5030, 5050, 5070]);
        // A gap and the slow sample inside it are two observations of one fault,
        // and they are counted as two different things: the freeze is in
        // `gapCauses` (it is a gap) and the sample is in `pathSamples`. Counting
        // both under `path` made the printed triple look like a partition of the
        // gaps when it was a sum of two populations - the audit caught that on a
        // run with 1 unclear freeze and 4 path-caused samples printing "4 the
        // path's own ... 1 unclassified".
        assert.equal(busy.verdict.gapCauses.path, 1, 'one freeze, this run has one gap');
        assert.equal(busy.verdict.pathSamples, 1, 'and one slow sample, counted separately');
        assert.equal(busy.verdict.quietGaps, 0);
        // Two frames that both arrived, against the same 3/s rate elsewhere in
        // the window: nothing left the host and failed to arrive, and the rate
        // says it was not quiet either. That is the third answer.
        const settled = fixture([5010, 5030], 3, [5010, 5030]);
        assert.equal(settled.verdict.unclearGaps, 1, 'what cannot be settled is counted as its own case');
        assert.equal(settled.verdict.quietGaps, 0, 'and not folded into the quiet ones');
        assert.equal(settled.verdict.stalls, 0);
        const quiet = fixture([5010], 17, [5010]);
        assert.equal(quiet.verdict.quietGaps, 1, 'one frame against a 17/s rate is the host being still');
        assert.equal(quiet.verdict.stalls, 0);
    });
});

describe('the counted verdicts and the labels they are printed under', () => {
    // `path` was counted without a kind filter while `quiet` and `unclear` were
    // counted on freezes only, so one set of labels covered two populations: a
    // latency sample can be `path` (the page missed most of what was sent during
    // its own window) and can never be `quiet` or `unclear`. The audit's run had
    // 1 unclear freeze and 4 path-caused latency spikes and printed "4 the path's
    // own ... 1 unclassified", which reads as five gaps when there is one.
    const fixtureWithBoth = () => spikeReport({
        latency: [
            { stamp: 1, sentAt: 5000, shownAt: 5300, ms: 300 },
            { stamp: 2, sentAt: 5400, shownAt: 5700, ms: 300 },
            { stamp: 3, sentAt: 5800, shownAt: 6100, ms: 300 },
            { stamp: 4, sentAt: 6200, shownAt: 6500, ms: 300 },
        ],
        freezes: [{ ms: 400, atMs: 7000 }],
        display: [4900, 5300, 5700, 6100, 6500, 7000, 7400],
        wire: [],
        // 3 frames sent, none delivered, in every sample: `path` by the rule.
        hostWire: [[5010, 'frame', 1000, 1], [5040, 'frame', 1000, 2], [5070, 'frame', 1000, 3],
                   [5410, 'frame', 1000, 4], [5440, 'frame', 1000, 5], [5470, 'frame', 1000, 6],
                   [5810, 'frame', 1000, 7], [5840, 'frame', 1000, 8], [5870, 'frame', 1000, 9],
                   [6210, 'frame', 1000, 10], [6240, 'frame', 1000, 11], [6270, 'frame', 1000, 12],
                   // the freeze's own window: one frame of an expected few
                   [7100, 'frame', 1000, 13]],
        hostRatePerSecond: 30, worstFraction: 1,
    });

    it('counts freezes in gapCauses and latency samples separately', () => {
        const r = fixtureWithBoth();
        const pathSamples = r.events.filter((e) => e.kind === 'latency' && e.cause === 'path').length;
        assert.equal(pathSamples, 4, 'the fixture is meant to have four path-caused samples');
        assert.deepEqual(r.gapCauses, { path: 0, quiet: 1, unclear: 0 },
                         'gapCauses is a partition of the freezes, and this run has one quiet freeze');
        assert.equal(r.verdict.pathSamples, 4, 'the samples are counted, under a name that says samples');
        assert.equal(Object.values(r.gapCauses).reduce((a, b) => a + b, 0), 1);
        assert.deepEqual(r.gapCauses, r.verdict.gapCauses);
    });

    // The printed line itself, as a function, so what a reader sees can be
    // asserted rather than eyeballed. Its numbers come from the partition and
    // from the sample count, and never from one number that holds both.
    it('prints the gaps as a partition, with the samples named separately', () => {
        const line = gapsLine({ gapCauses: { path: 0, quiet: 0, unclear: 1 }, pathSamples: 4, hostRatePerSecond: 30 });
        assert.match(line, /0 freeze\(s\) the path's own/);
        assert.match(line, /0 the host having nothing new to draw/);
        assert.match(line, /1 unclassified/);
        assert.match(line, /1 gap\(s\) in all/);
        assert.match(line, /separately, 4 slow sample\(s\)/);
        assert.ok(!/gaps: 4/.test(line), 'four samples are not four gaps');

        const withFreeze = gapsLine({ gapCauses: { path: 2, quiet: 1, unclear: 1 }, pathSamples: 3, hostRatePerSecond: 30 });
        assert.match(withFreeze, /2 freeze\(s\) the path's own/);
        assert.match(withFreeze, /4 gap\(s\) in all/);
        assert.match(withFreeze, /separately, 3 slow sample\(s\)/);

        const none = gapsLine({ gapCauses: { path: 0, quiet: 0, unclear: 0 }, pathSamples: 0, hostRatePerSecond: 12.4 });
        assert.match(none, /0 gap\(s\) in all/);
        assert.ok(!/separately/.test(none), 'nothing to say about samples when there were none');
        assert.match(none, /12\.4\/s rate/);
    });

    it('does not print "the path\'s own" over a gap count when only samples were path-caused', () => {
        const r = fixtureWithBoth();
        // The gaps in this run are quiet; the path's part is four slow samples.
        assert.equal(r.gapCauses.path, 0);
        assert.equal(r.verdict.gapCauses.path, 0);
        assert.match(r.verdict.note, /sample/i, 'the note names them for what they are');
        assert.ok(!/the 4 of .* gaps?/.test(r.verdict.note), r.verdict.note);
    });
});

describe('what a freeze count is made of', () => {
    // A headline "4 freezes over 250ms" that mixes a delivery failure, a still
    // scene and a gap nobody can explain is not a measurement, and one that adds
    // up gaps the bench has itself declined to classify is worse: the readers of
    // bench_smart_r3_1 saw "4" next to "unverified: 4" and asked what it meant.
    it('splits a bucket by the verdict each gap was given', () => {
        const gaps = [{ atMs: 100, ms: 300 }, { atMs: 500, ms: 400 }, { atMs: 1000, ms: 900 }];
        const split = verdictCounts(gaps, (g) => (g.ms > 800 ? 'path' : g.ms > 350 ? 'quiet' : 'unclear'));
        assert.deepEqual(split, { path: 1, quiet: 1, unclear: 1 });
    });

    it('files a gap with no verdict under unclear rather than dropping it', () => {
        const gaps = [{ atMs: 100, ms: 300 }, { atMs: 500, ms: 400 }];
        assert.deepEqual(verdictCounts(gaps, () => null), { path: 0, quiet: 0, unclear: 2 });
        assert.deepEqual(verdictCounts(gaps, null), { path: 0, quiet: 0, unclear: 2 });
    });

    // The same two numbers the verdict is built from, so a headline count and a
    // per-gap verdict can never be two different measurements of one window.
    it('counts the frames each side had in a window, in frames', () => {
        const hostWire = [[100, 'frame', 900, 1], [150, 'input', 20, 0], [200, 'artwork', 400, 0],
                          [300, 'frame', 900, 2], [500, 'keyframe', 1200, 3]];
        const wireLog = [[120, 'frame', 900, 1], [320, 'frame', 900, 2]];
        assert.deepEqual(framesInWindow({ hostWire, wireLog, fromMs: 50, toMs: 400 }),
                         { hostFrames: 2, clientFrames: 2 });
        assert.deepEqual(framesInWindow({ hostWire, wireLog, fromMs: 250, toMs: 400 }),
                         { hostFrames: 1, clientFrames: 1 });
    });
});

describe('arrival holes', () => {
    it('names the longest stretch with no arrival as the host hands nothing back', () => {
        const arrivals = [[1000, 1], [1010, 2], [2240, 3], [2240.4, 4], [2240.8, 5], [2250, 6]];
        const hole = arrivalHole(arrivals, { minMs: 300 });
        assert.equal(hole.ms, 1230);
        assert.equal(hole.fromMs, 1010);
        assert.equal(hole.toMs, 2240);
        assert.equal(hole.burst, 4, 'four arrivals landed inside 10ms of the hole ending');
    });
    it('says nothing when the arrivals are evenly spread', () => {
        const arrivals = Array.from({ length: 40 }, (_, i) => [1000 + i * 50, i % 8]);
        assert.equal(arrivalHole(arrivals, { minMs: 300 }), null);
    });
});

describe('uplinkInWindow', () => {
    it('reports the median and worst transit of the inputs sent inside the window', () => {
        const t = [[1000, 5], [1100, 8], [1200, 300], [1300, 6]];
        const u = uplinkInWindow(t, 1050, 1250);
        assert.equal(u.count, 2);
        assert.equal(u.medianMs, 8);
        assert.equal(u.maxMs, 300);
        assert.equal(uplinkInWindow(t, 2000, 3000).count, 0);
    });
});

describe('frame arrivals', () => {
    it('keeps the sequence number of a frame, so a lost one can be named', () => {
        const rec = new WireRecorder();
        rec.record('frame', 114, 100, 41);
        rec.record('artwork', 131088, 101);
        assert.equal(rec.events[0].length, 4);
        assert.equal(rec.events[0][3], 41);
        assert.equal(rec.events[1][3], 0, 'a message with no sequence number carries 0');
    });

    it('names the frames the host sent that never arrived at all', () => {
        const host = [[100, 'frame', 114, 1], [120, 'frame', 114, 2], [140, 'frame', 114, 3], [160, 'artwork', 400, 0]];
        const client = [[110, 'frame', 114, 1], [150, 'frame', 114, 3]];
        const match = matchFrameSends(host, client);
        assert.equal(match.sent, 3, 'only a frame carries a frame number of its own');
        assert.equal(match.arrived, 2);
        assert.deepEqual([...match.lost], [2]);
        assert.equal(match.transitMs.length, 2);
    });

    // The page's log stops when the page is asked for it, and the host keeps
    // sending until it is told to stop. Every host frame sent after that moment
    // has no arrival to find, and calling those lost invents loss that scales
    // with how fast the host was producing pictures - which is exactly how a
    // measurement artefact was read as a rate ceiling for two sessions.
    it('does not call a frame lost when the page stopped logging before it was sent', () => {
        const host = [[100, 'frame', 114, 1], [120, 'frame', 114, 2], [2000, 'frame', 114, 3]];
        const client = [[110, 'frame', 114, 1], [130, 'frame', 114, 2]];
        const match = matchFrameSends(host, client, { clientLogEndMs: 130 });
        assert.equal(match.sent, 3);
        assert.equal(match.arrived, 2);
        assert.deepEqual([...match.lost], [], 'a frame sent after the log ended was never watched for');
        assert.equal(match.beyondLog, 1, 'and it is reported as unobserved rather than as delivered');
    });

    it('leaves the transits that arrived after the window out of the transit figure', () => {
        // The page is blocked for 1500ms on purpose at the end of every run (the
        // freeze counter's own control). Frames sent in the window and delivered
        // during that block are not slow frames, and counting them would put the
        // control's cost into the path's tail.
        const host = [[100, 'frame', 114, 1], [120, 'frame', 114, 2]];
        const client = [[110, 'frame', 114, 1], [1600, 'frame', 114, 2]];
        const match = matchFrameSends(host, client, { arrivalBeforeMs: 500 });
        assert.equal(match.arrived, 2, 'it did arrive, so it is not lost');
        assert.deepEqual(match.transitMs, [10]);
    });
});

// The host's wire log is one JSON shape for both paths: an event row is
// [epoch_ms, kind, bytes, queue, extra, stamp], six fields. The kind that
// matters most - an input ARRIVING from the client - carries its stamp in the
// last field, and the per-kind payloads are not interchangeable: a frame's
// `extra` is its encode cost, an input's is always zero. Reading the fifth field
// as the stamp made every uplink lookup miss, which is how a run reported
// 255/255 stamp mismatches and a median transit of minus 5640ms.
describe('hostWireLog', () => {
    const json = {
        now: 1_000_000,
        events: [
            [999_900, 0, 114, 393216, 0, 0],     // a delta frame, queued 384kB deep
            [999_910, 5, 17, -1, 0, 42],         // an input arriving, stamp 42
            [999_920, 2, 131088, -1, 0, 0],      // an artwork chunk
            [999_930, 1, 4000, 500, 900, 0],     // a keyframe with an encode cost
            [999_940, 5, 17, -1, 0, 43],         // a second input
        ],
        stamps: [[42, 13, 999_915, 0], [43, 9, 999_945, 1]],
    };
    const toPage = (t) => t - 1_000_000;

    it('reads the input stamp from the sixth field and keeps the kinds apart', () => {
        const log = hostWireLog(json, { toPage, path: 'smart' });
        assert.deepEqual(log.events.map((e) => e[1]), ['frame', 'input', 'artwork', 'keyframe', 'input']);
        assert.deepEqual(log.inputs, [[-90, 42], [-60, 43]], 'an input carries its stamp, not its (zero) extra');
        assert.equal(log.events[3][3], 900, 'a frame carries its encode cost');
        assert.equal(log.events[1][3], 42, 'and an input carries nothing but its stamp');
        assert.equal(log.events[2][3], 0, 'artwork carries neither');
    });

    it('takes only its own path\'s answers, on the page clock, in log order', () => {
        const smart = hostWireLog(json, { toPage, path: 'smart' });
        assert.deepEqual(smart.answers, [[-85, 42, 13]], 'the raw answer is a different path\'s');
        const raw = hostWireLog(json, { toPage, path: 'raw' });
        assert.deepEqual(raw.answers, [[-55, 43, 9]]);
    });
});

// The host's share of a sample is looked up by the input that sample answered,
// not by the stamp's VALUE. The stamp is one byte and it rotates, so one value
// answers many inputs: in a measured window 1738 answers covered only 255
// stamps, one of them 12 times, and a lookup by value then handed the same
// (wrong) share to every sample that happened to carry it - a 777ms error at the
// top of a distribution whose median was 7ms. The answers are an ordered log on
// the page's clock, so the answer that belongs to a change is the last one for
// that stamp at or before the change.
describe('hostShareFor', () => {
    const answers = [[1000, 5, 11], [1100, 6, 900], [1200, 5, 12], [1300, 7, 4]];

    it('takes the answer at or before the change, not the last one with that stamp', () => {
        assert.equal(hostShareFor(answers, 5, 1150), 11, 'the second answer for stamp 5 is after this change');
        assert.equal(hostShareFor(answers, 5, 1250), 12);
        assert.equal(hostShareFor(answers, 7, 1400), 4);
    });

    it('reports nothing rather than a number when there is no answer for it', () => {
        assert.equal(hostShareFor(answers, 9, 1400), null);
        assert.equal(hostShareFor(answers, 5, 999), null);
        assert.equal(hostShareFor(answers, 0, 1400), null, 'a freeze carries no stamp');
    });

    it('is what a spike reports, and a freeze reports none', () => {
        const latency = [{ stamp: 5, sentAt: 1000, shownAt: 1150, ms: 150 }];
        const report = spikeReport({
            latency, freezes: [{ atMs: 2000, ms: 600 }], display: [900, 1150, 2000, 2600], wire: [],
            hostAnswers: answers, worstFraction: 1,
        });
        assert.equal(report.events.find((e) => e.kind === 'latency').hostMs, 11);
        assert.equal(report.events.find((e) => e.kind === 'freeze').hostMs, null);
    });
});

// The page's own record of the inputs it sent has to be readable as an ORDERED
// log, because that is what the uplink pairing is done in. It used to be a Map
// keyed by the stamp - and the stamp is one byte that rotates, so a Map cannot
// hold more than 255 of them: a 21 s window has 366-392 inputs, 63-66% of the
// window was overwritten in the map before the bench read it, and every pairing
// built from it was built from a third of the window.
describe('inputLog', () => {
    it('keeps every send in order, however many times the stamp wraps', () => {
        const log = inputLog();
        for (let i = 1; i <= 400; i++) log.record(((i - 1) % 255) + 1, 1000 + i);
        assert.equal(log.entries.length, 400, 'a rotating byte cannot key a log of 400 sends');
        assert.deepEqual(log.entries[0], [1, 1001]);
        assert.deepEqual(log.entries[255], [1, 1256], 'the 256th send reuses stamp 1 and is still its own entry');
        assert.deepEqual(log.entries[399], [145, 1400]);
        assert.equal(log.since(1250).length, 151, 'restricted to a window by time');
        log.reset();
        assert.equal(log.entries.length, 0);
    });

    it('still answers a lookup by stamp with the newest send that carried it', () => {
        const log = inputLog();
        log.record(7, 1000);
        log.record(8, 1010);
        log.record(7, 1500);
        assert.equal(log.get(7), 1500, 'an echo names a stamp, and the newest one is the one it can mean');
        assert.equal(log.get(9), undefined);
    });
});
