import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { freezeReport, gapStats, samplerLiveness, latencySummary, paintHash, viewHash, ChangeDetector, attributePaint, attributePending,
    changeMagnitude, magnitudeGate, workloadGate, coverage, comparability, reconcileGaps, RAF_BOUND_MS } from '../src/core/measure.js';

// A freeze is a gap in the display timeline. Counts are used rather than
// percentiles because a count of events survives a small sample and a
// percentile does not.
//
// The threshold is 250ms, not 200ms, because the timeline is sampled on
// animation frames: a change is only ever noticed at the next frame callback, so
// a reported gap can be up to one frame longer than the real one AND the real
// gap can be up to one frame shorter than a reported 200ms. A reported 200.1ms
// gap is not evidence of a 200ms freeze.
describe('freezeReport', () => {
    it('counts the gaps over 100ms, 250ms and 500ms and reports the longest', () => {
        const times = [0, 16, 32, 250, 266, 800, 816];
        const r = freezeReport(times);
        assert.equal(r.gaps100.length, 2);
        assert.equal(r.gaps250.length, 1);
        assert.equal(r.gaps500.length, 1);
        assert.equal(r.longest.ms, 534);
        assert.equal(r.longest.atMs, 266);
        assert.equal(r.events, times.length);
    });

    it('reports no freezes for an evenly sampled series, and states the frame bound', () => {
        const times = Array.from({ length: 60 }, (_, i) => i * 16);
        const r = freezeReport(times);
        assert.equal(r.gaps100.length, 0);
        assert.equal(r.gaps250.length, 0);
        assert.equal(r.gaps500.length, 0);
        assert.equal(r.longest.ms, 16);
        assert.ok(RAF_BOUND_MS >= 16 && RAF_BOUND_MS <= 17);
    });
});

// Same mean rate, different experience. A stream that changes 19 times a second
// in three-change bursts with 100ms holes and one that changes 19 times a second
// evenly have the same rate and the same freeze count, and only the second looks
// smooth. The p90/median ratio separates them.
describe('gapStats', () => {
    it('reports the median and p90 gap and how far the tail is from the median', () => {
        const even = Array.from({ length: 50 }, (_, i) => i * 50);
        const r = gapStats(even);
        assert.equal(r.n, 49);
        assert.equal(r.median, 50);
        assert.equal(r.p90, 50);
        assert.equal(r.jitterRatio, 1);
    });

    it('separates bursty from even at the same mean rate', () => {
        const bursty = [];
        let t = 0;
        for (let i = 0; i < 20; i++) {
            bursty.push(t, t + 16, t + 32);
            t += 160;
        }
        const burstyStats = gapStats(bursty);
        const evenStats = gapStats(bursty.map((_, i) => i * (bursty[bursty.length - 1] / (bursty.length - 1))));
        assert.ok(burstyStats.jitterRatio > 2);
        assert.ok(evenStats.jitterRatio < 1.5);
        assert.ok(burstyStats.median < burstyStats.p90);
    });
});

// A sampler that never varies is broken, not idle: either the picture really
// never changed (nothing was being measured) or the detector stopped working.
// Either way every freeze number built on it is meaningless, so the run must
// fail rather than report a clean zero.
//
// The cheap checks it shipped with (30 events, 3 distinct intervals) can only
// really catch "fewer than 30 events": a detector that has stopped comparing,
// and therefore records every animation frame as a change, passes both. The rate
// the timeline implies is added for that case - a display timeline cannot show
// more changes than the picture is being watched at, and none of these two paths
// is watched faster than 60 times a second.
describe('samplerLiveness', () => {
    it('rejects a series that never varies', () => {
        const times = Array.from({ length: 200 }, () => 1234);
        const r = samplerLiveness(times);
        assert.equal(r.alive, false);
        assert.match(r.reason, /varies|distinct|events/i);
    });

    it('rejects a timeline that records a change on every animation frame', () => {
        const times = [];
        let t = 0;
        for (let i = 0; i < 600; i++) { t += 16 + (i % 5) * 0.25; times.push(t); }
        const r = samplerLiveness(times, { spanMs: 10000 });
        assert.equal(r.alive, false);
        assert.match(r.reason, /rate|frame/i);
        assert.ok(r.changesPerSecond > 55);
    });

    it('accepts a series with enough distinct intervals at a plausible rate', () => {
        const times = [];
        let t = 0;
        for (let i = 0; i < 200; i++) { t += 16 + (i % 7); times.push(t); }
        const r = samplerLiveness(times, { spanMs: times[times.length - 1] });
        assert.equal(r.alive, true);
        assert.ok(r.distinct >= 3);
        assert.ok(r.changesPerSecond > 0.5 && r.changesPerSecond < 55);
    });
});

// How many inputs were answered, reported honestly from both ends.
//
// The bench used to print the client's count as "n of N answered inputs" where N
// was the HOST's count, which is how a run with 485 host-claimed answers and 381
// stamps actually delivered was reported as if the two were the same number. The
// host can claim more answers than the client receives - a ping consumed the
// stamp while carrying no stamp at all, and a stamped frame that is lost on the
// non-retransmitting stream takes its stamp with it - so both numbers are
// reported, with the gap explained rather than hidden.
describe('whether two runs can be compared at all', () => {
    // The scene sets the tail: on the smart path a still session (16.8 changes a
    // second) reported a 934.6ms longest gap while a busy one (47.9/s) reported
    // 166.5ms, on the same build and the same stimulus. On the raw path the scene
    // moves the p50 too: 19/s reads 85.8ms and 27/s reads 54.0ms. So a comparison
    // across two runs is only a comparison if their activity is close, and the
    // band comes from those runs: pairs within 1% of each other read p50s within
    // 1%, while a 32% difference in activity moved p50 by 24%.
    it('admits a pair whose activity is within the band', () => {
        const c = comparability({ label: 'a', changesPerSecond: 19.1 }, { label: 'b', changesPerSecond: 19.2 });
        assert.equal(c.comparable, true);
        assert.equal(c.ratio, 1.01);
        assert.equal(c.band, 1.1);
        assert.deepEqual(c.rates, [19.1, 19.2]);
    });

    it('refuses a pair whose activity differs beyond it, and says by how much', () => {
        const c = comparability({ label: 'smart-r3-1', changesPerSecond: 16.8 },
                                { label: 'smart-r3-2', changesPerSecond: 47.9 });
        assert.equal(c.comparable, false);
        assert.equal(c.ratio, 2.85);
        assert.match(c.reason, /16\.8/);
        assert.match(c.reason, /47\.9/);
        assert.match(c.reason, /band/);
    });

    it('refuses a pair when either side has no activity recorded', () => {
        for (const pair of [[{ label: 'a' }, { label: 'b', changesPerSecond: 19 }],
                            [{ label: 'a', changesPerSecond: null }, { label: 'b', changesPerSecond: 19 }]]) {
            const c = comparability(...pair);
            assert.equal(c.comparable, false);
            assert.match(c.reason, /no activity recorded/i);
        }
    });
});

describe('coverage', () => {
    it('reports what the host answered and what the client actually saw, side by side', () => {
        const r = coverage({ sent: 400, hostReceived: 400, hostAnswered: 485, clientStamped: 381, latencySamples: 300 });
        assert.equal(r.inputsSent, 400);
        assert.equal(r.hostAnswered, 485);
        assert.equal(r.clientStamped, 381);
        assert.equal(r.latencySamples, 300);
        assert.equal(r.hostAnsweredPctOfSent, 121.3);
        assert.equal(r.clientStampedPctOfSent, 95.3);
        assert.ok(r.clientStampedPctOfHostAnswered < 100);
    });

    // The note used to say "every input that was sent was answered and every
    // answer was seen" whenever the host had RECEIVED everything the page sent,
    // even when it had answered far fewer: the audit's own run printed "366
    // inputs sent: the host answered 307 ... every input that was sent was
    // answered", which is 59 unanswered inputs described as answered. The stamp
    // slot is one slot deep, so the bucket that closes that gap is the inputs a
    // later one displaced - a number the input-accounting gate already has.
    it('does not claim every input was answered when the host answered fewer', () => {
        const r = coverage({ sent: 366, hostReceived: 366, hostAnswered: 307, clientStamped: 307,
                             latencySamples: 300, overwritten: 59, expired: 0 });
        assert.ok(!/every input that was sent was answered/.test(r.note), r.note);
        assert.match(r.note, /59/);
        assert.match(r.note, /overwritten|displaced|replaced/i);
        assert.equal(r.unanswered, 59);
        assert.equal(r.unaccounted, 0);
    });

    it('says what is left over when the buckets do not close', () => {
        const r = coverage({ sent: 100, hostReceived: 100, hostAnswered: 80, clientStamped: 80,
                             latencySamples: 80, overwritten: 5, expired: 2 });
        assert.equal(r.unanswered, 20);
        assert.equal(r.unaccounted, 13, '20 unanswered, 7 of them named by a bucket, 13 not');
        assert.match(r.note, /13/);
    });

    // The raw path's answer counter is the relay's echo count, not the stamp
    // slot's, so the two cannot be explained by the slot's buckets and the note
    // must not pretend otherwise: it names the gap and stops.
    it('says nothing about buckets when no bucket counters were supplied', () => {
        const r = coverage({ sent: 385, hostReceived: 385, hostAnswered: 381, clientStamped: 381, latencySamples: 336 });
        assert.match(r.note, /4 of the 385 that reached the host were never answered/);
        assert.ok(!/slot's counters/.test(r.note), r.note);
        assert.ok(!/displaced|aged out/.test(r.note), r.note);
        assert.equal(r.unaccounted, null);
    });

    // Live shape from bench_smart_r4_1: 83 inputs that reached the host were
    // never answered, and the slot's counters name 84 displaced in the same
    // window - one more than the gap, because a stamp displaced INSIDE the window
    // can have arrived before it opened, and the bucket is a counter delta while
    // the gap is a difference of window-scoped arrivals. The note said "83 ... : 84
    // displaced", which is a sentence that contradicts itself.
    it('does not explain a gap with a bucket bigger than the gap', () => {
        const r = coverage({ sent: 371, hostReceived: 371, hostAnswered: 288, clientStamped: 288,
                             latencySamples: 287, overwritten: 84, expired: 0 });
        assert.ok(!/83 of the 371 that reached the host were never answered: 84/.test(r.note), r.note);
        assert.match(r.note, /83 of the 371/);
        assert.match(r.note, /boundary|arrived before it opened/i);
        assert.equal(r.unaccounted, 0);
    });

    it('explains where a stamp can go missing instead of showing one side', () => {
        const r = coverage({ sent: 100, hostReceived: 100, hostAnswered: 100, clientStamped: 60, latencySamples: 40 });
        assert.match(r.note, /overwritten|retransmit|player could see/i);
        assert.ok(r.note.includes('100') && r.note.includes('60'));
        const clean = coverage({ sent: 100, hostReceived: 100, hostAnswered: 100, clientStamped: 100, latencySamples: 100 });
        assert.match(clean.note, /every|all/i);
    });
});

// The raw path reads its picture back through an <img>, and a 1280x720 picture
// read back at 256x144 cannot see a change smaller than about five pixels across:
// measured on this host, a one-pixel change is missed at 96.7% of positions at
// every delta from 1 to 128, a 2x2 change at 85.6%, 3x3 at 61.5%, 4x4 at 36.5%,
// and 5x5 or larger at none.
//
// A missed change can only ever LENGTHEN an apparent gap - the change happened,
// the sampler did not see it, so two observations that were seconds apart are
// treated as one interval. That inflates the freeze counts, which is the number
// this bench exists to report, so a gap is only counted when the full-resolution
// verification pass also saw the picture unchanged across it.
describe('reconcileGaps', () => {
    it('withholds a gap that the full-resolution pass saw the picture change inside', () => {
        const gaps = [{ ms: 320, atMs: 1000 }, { ms: 260, atMs: 5000 }];
        const r = reconcileGaps({ gaps, nativeChanges: [1150] });
        assert.equal(r.kept.length, 1);
        assert.equal(r.kept[0].atMs, 5000);
        assert.equal(r.withheld.length, 1);
        assert.equal(r.withheld[0].atMs, 1000);
        assert.match(r.withheld[0].reason, /missed|full-resolution/i);
    });

    it('keeps a gap with no change inside it, and a change on the boundary is not inside', () => {
        const gaps = [{ ms: 300, atMs: 2000 }];
        const r = reconcileGaps({ gaps, nativeChanges: [2000, 2300, 100] });
        assert.equal(r.kept.length, 1);
        assert.equal(r.withheld.length, 0);
    });
});

// There is exactly one action gate. measure.js used to export a second one
// (actionGate, on change RATES) that the bench never called, so the test suite
// covered a gate that could not run while the gate that decided every run was
// untested here. The bench uses magnitudeGate; a second gate in the module is a
// second answer to the same question.
describe('the module exports one action gate', () => {
    it('has no rate-based actionGate left to drift away from the one in use', async () => {
        const mod = await import('../src/core/measure.js');
        assert.equal(mod.actionGate, undefined);
        assert.equal(typeof mod.magnitudeGate, 'function');
    });
});

// The latency headline, with a tail.
//
// An earlier version of this module claimed p90, p95 and p99 all evaluate to the
// maximum at these sample counts and reported p50 only. That is false: at n=30
// p90 is the 27th of 30 observations and p95 is the 29th; at n=92 p95 is the
// 88th of 92. The user's requirement is that spikes matter as much as the
// median, so the tail is reported whenever the sample supports it - and the
// maximum is reported at any count, because one observation is a fact, not an
// estimate.
describe('latencySummary', () => {
    const ramp = (n) => Array.from({ length: n }, (_, i) => i + 1);

    it('refuses to quote a percentile below the sample floor, and quotes nothing at all', () => {
        const r = latencySummary(ramp(29));
        assert.equal(r.sufficient, false);
        assert.equal(r.p50, null);
        assert.equal(r.p90, null);
        assert.equal(r.p95, null);
        assert.match(r.reason, /insufficient/i);
    });

    it('reports p50 with p90 and p95 as real order statistics, not as the maximum', () => {
        const r = latencySummary(ramp(30));
        assert.equal(r.n, 30);
        // Nearest rank: ceil(0.5 * 30) = 15, the 15th of 30.
        assert.equal(r.p50, 15);
        assert.equal(r.p90, 27);
        assert.equal(r.p95, 29);
        assert.equal(r.max, 30);
        assert.ok(r.p90 < r.max);
    });

    it('keeps p95 below the maximum at the larger counts a window produces', () => {
        const r = latencySummary(ramp(92));
        assert.equal(r.p95, 88);
        assert.equal(r.max, 92);
    });
});

// What is on the canvas is identified by the draw state that produced it. Two
// frames that resolve to the same instances on the same surface are the same
// picture, and a picture that is the same as the last one is not a frame the
// player saw change - which is the whole defect this bench exists to remove.
describe('paintHash', () => {
    const buf = () => new Float32Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
    const view = { width: 1280, height: 720, atlasGeneration: 0 };

    it('is equal for identical draw state and different when a coordinate moves', () => {
        const a = paintHash(buf(), 1, view);
        const b = paintHash(buf(), 1, view);
        const moved = buf();
        moved[0] = 1.5;
        assert.equal(a, b);
        assert.notEqual(a, paintHash(moved, 1, view));
    });

    it('changes when the surface or the atlas generation changes', () => {
        const a = paintHash(buf(), 1, view);
        assert.notEqual(a, paintHash(buf(), 1, { ...view, width: 1920 }));
        assert.notEqual(a, paintHash(buf(), 1, { ...view, atlasGeneration: 1 }));
    });
});

// The raw path displays through an <img>, and an image element fed by
// multipart/x-mixed-replace reports neither when it drew nor what it drew: it
// fires exactly one load event, for the first part. The only honest reading of
// what is on screen is to look at it, so the picture is sampled through the
// element itself and the samples are compared.
describe('viewHash', () => {
    it('is equal for the same pixels and different when one pixel moves', () => {
        const a = new Uint8ClampedArray(64);
        const b = new Uint8ClampedArray(64);
        assert.equal(viewHash(a), viewHash(b));
        b[17] = 9;
        assert.notEqual(viewHash(a), viewHash(b));
    });
});

describe('ChangeDetector', () => {
    it('reports the first sighting as no change and a repeat as no change', () => {
        const d = new ChangeDetector();
        assert.equal(d.observe('x', 100), false);
        assert.equal(d.observe('x', 200), false);
        assert.equal(d.changes.length, 0);
    });

    it('records a change at the time it was observed', () => {
        const d = new ChangeDetector();
        d.observe('x', 100);
        assert.equal(d.observe('y', 116), true);
        assert.deepEqual(d.changes, [116]);
    });
});

// How an input is credited with an answer. The rule that matters is the second
// one: a redraw that resolves to the picture already on screen did not answer
// anything, because the player did not see anything happen.
describe('attributePaint', () => {
    it('credits the input when the paint changed the picture', () => {
        const r = attributePaint({ stamp: 4, sentAt: 1000, now: 1064, paintChanged: true });
        assert.equal(r.ms, 64);
    });

    it('produces nothing for a paint that changed nothing, or one too old to answer', () => {
        assert.equal(attributePaint({ stamp: 4, sentAt: 1000, now: 1064, paintChanged: false }), null);
        assert.equal(attributePaint({ stamp: 4, sentAt: 1000, now: 3000, paintChanged: true, maxAgeMs: 1500 }), null);
    });
});

// How MUCH of the picture changed, not just whether it did.
//
// This is what makes an action gate possible at all in a game that animates by
// itself: water ripples change a few tiles every frame, a move or a zoom changes
// the whole view, and "did anything change" cannot tell them apart.
describe('changeMagnitude', () => {
    it('is the fraction of entries that differ, and zero for the same picture', () => {
        const a = new Float32Array([1, 2, 3, 4]);
        const b = new Float32Array([1, 2, 3, 4]);
        const c = new Float32Array([1, 9, 3, 9]);
        assert.equal(changeMagnitude(a, b), 0);
        assert.equal(changeMagnitude(a, c), 0.5);
        assert.equal(changeMagnitude(a, new Float32Array([9, 9, 9, 9, 9])), 1);
    });
});

// The action gate decides whether a candidate input is a usable stimulus, and
// its reference used to be the untouched window's PEAK. That reference is not
// stable: in the stored runs the idle peak was 0.0 in three of four, and 0.1442
// in the fourth, so the same action at the same magnitude got opposite verdicts
// (a 7.31% change was dead when the idle peak was 14.42% and LIVE when it was
// 0.0 - the gate collapsed to its 5% floor and the water animation passed it).
//
// The floor is now above the largest idle change this scene has ever produced
// (14.42% of the picture, measured), and the idle term can only raise the bar
// further. An action that the player cannot see scores below the floor whichever
// idle window the run happened to catch; a camera move replaces most of the
// view and clears it either way.
describe('magnitudeGate', () => {
    it('gives the same verdict for the same action whatever the idle window did', () => {
        const busyIdle = [0.01, 0.1442, 0.02];
        const stillIdle = [0, 0, 0];
        const busy = magnitudeGate({ controlMagnitudes: busyIdle, actionMagnitudes: [0.0731, 0.02, 0.01] });
        const still = magnitudeGate({ controlMagnitudes: stillIdle, actionMagnitudes: [0.073, 0.01, 0.02] });
        assert.equal(busy.live, false);
        assert.equal(still.live, false);
        assert.match(busy.reason, /untouched/i);
    });

    it('accepts a camera move that replaces most of the picture, busy idle or not', () => {
        const zoom = [0.62, 0.58, 0.66];
        assert.equal(magnitudeGate({ controlMagnitudes: [0.1442, 0.02], actionMagnitudes: zoom }).live, true);
        assert.equal(magnitudeGate({ controlMagnitudes: [], actionMagnitudes: zoom }).live, true);
    });

    it('says which term set the bar, so a raised floor cannot pass silently', () => {
        const r = magnitudeGate({ controlMagnitudes: [0.4], actionMagnitudes: [0.5] });
        assert.equal(r.floor, 0.2);
        assert.equal(r.needed, 0.6);
        assert.equal(r.live, false);
        assert.ok(r.peak < r.needed);
    });
});

// The workload gate's job is to throw away a window in which the stimulus stopped
// moving the picture, because a still screen is then scored as a freeze that never
// happened. It used to be `firstHalf >= 20 && secondHalf < firstHalf * 0.25`, so a
// window with almost no changes AT ALL passed vacuously - and its numbers were never
// written to the result file, so after the run there was no way to check it.
describe('workloadGate', () => {
    it('rejects a window that never moved enough to measure, instead of passing vacuously', () => {
        const r = workloadGate({ firstHalf: 5, secondHalf: 0, windowMs: 10000 });
        assert.equal(r.ok, false);
        assert.match(r.reason, /too few|stopped/i);
    });

    it('rejects a window whose second half collapsed, and accepts one that kept moving', () => {
        assert.equal(workloadGate({ firstHalf: 240, secondHalf: 12, windowMs: 10000 }).ok, false);
        const ok = workloadGate({ firstHalf: 240, secondHalf: 180, windowMs: 10000 });
        assert.equal(ok.ok, true);
        assert.equal(ok.ratio, 0.75);
    });
});

// A stamped frame says the host answered an input. Which paint shows it can be a
// tick or two later - the client holds frames while it waits for artwork - so the
// stamp has to survive until a paint happens, and only ONE paint can be the
// answer however many stamped frames have piled up behind it.
describe('attributePending', () => {
    const sentAt = (stamp) => stamp * 100;
    const queue = (stamps) => stamps.map((s) => ({ stamp: s, sentAt: sentAt(s) }));

    it('keeps waiting while nothing has been painted', () => {
        const r = attributePending(queue([1, 2]), { now: 250, paintChanged: false });
        assert.equal(r.sample, null);
        assert.equal(r.remaining.length, 2);
    });

    it('credits the newest answer and retires the stamps it superseded', () => {
        const r = attributePending(queue([1, 2]), { now: 250, paintChanged: true });
        assert.equal(r.sample.stamp, 2);
        assert.equal(r.sample.ms, 50);
        assert.equal(r.remaining.length, 0);
    });

    // A latency sample has to carry the window it measured, not just its length:
    // the spike forensics has to know what was on the wire while this input was
    // waiting, and that is the interval between these two times.
    it('carries the window it measured, so the wire during the wait can be looked up', () => {
        const r = attributePending(queue([1, 2]), { now: 250, paintChanged: true });
        assert.equal(r.sample.sentAt, 200);
        assert.equal(r.sample.shownAt, 250);
    });

    it('drops stamps too old to explain a paint', () => {
        const r = attributePending(queue([1]), { now: 9999, paintChanged: false, maxAgeMs: 1500 });
        assert.equal(r.remaining.length, 0);
    });
});
