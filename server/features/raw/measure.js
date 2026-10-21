// Client-side measurement primitives for the bench.
//
// Everything here is pure so it can be tested without a browser, and so the
// bench's definition of "a freeze" is one function rather than several copies.
//
// The rule the bench is built on: a number that cannot be defended is worse than
// no number. A count of events survives a small sample; a percentile does not.

// How much later than the real change a sample can be recorded.
//
// Both paths observe the picture on animation frame callbacks, so a change that
// happened just after frame N is first seen at frame N+1. A gap measured between
// two observations is therefore the real gap plus up to one frame, which means a
// reported gap of 200.1ms is not evidence of a 200ms freeze. Every threshold
// quoted from this module is raised above the noise for that reason, and the
// printed output states the same bound.
export const RAF_BOUND_MS = 16.7;

/**
 * Freezes in a display timeline: the timestamps at which the picture the player
 * is looking at changed.
 *
 * Returns counts of the gaps over each threshold plus the single longest gap and
 * where it started, because "how bad was the worst one" is the question a count
 * alone leaves open and a percentile cannot answer at these sample counts.
 *
 * Three buckets, and the reason for each:
 *   over250  a real stutter. Raised from 200 so that the frame-quantisation
 *            error above cannot manufacture one: a reported gap over 250ms is a
 *            real gap of at least 233ms.
 *   over500  the picture was effectively stopped.
 *   over100  the sub-200ms hole. Twenty changes a second in three-change bursts
 *            with 100ms holes in between scores zero freezes on the two buckets
 *            above and looks terrible in the hand, so the small holes are
 *            counted too.
 */
export function freezeReport(times, { over100 = 100, over250 = 250, over500 = 500 } = {}) {
    const gaps100 = [];
    const gaps250 = [];
    const gaps500 = [];
    let longest = null;

    for (let i = 1; i < times.length; i++) {
        const ms = times[i] - times[i - 1];
        const atMs = times[i - 1];
        const gap = { ms: +ms.toFixed(1), atMs: +atMs.toFixed(1) };
        if (ms > over100) gaps100.push(gap);
        if (ms > over250) gaps250.push(gap);
        if (ms > over500) gaps500.push(gap);
        if (!longest || ms > longest.ms) longest = gap;
    }

    return { events: times.length, gaps100, gaps250, gaps500, longest };
}

/**
 * Nearest-rank percentile of an ascending array. One definition, used for gaps
 * and for latency, because two percentile rules in one bench would eventually
 * disagree about the same observation.
 */
export function percentile(sorted, p) {
    if (!sorted.length) return null;
    const rank = Math.ceil(p * sorted.length);
    return sorted[Math.min(sorted.length - 1, Math.max(0, rank - 1))];
}

/**
 * The shape of the gaps, not just how many crossed a line.
 *
 * The user's requirement is smooth and consistent: a stream that changes 19
 * times a second in evenly spaced steps and one that changes 19 times a second
 * in bursts with holes between them have the same change rate and the same mean
 * interval, and only the first is acceptable. jitterRatio is p90/median - about
 * 1 when the changes are evenly spaced, several times that when they arrive in
 * bursts - and it is a ratio of two order statistics of the same sample, so it
 * does not need the sample to be large to be read.
 */
export function gapStats(times) {
    const gaps = [];
    for (let i = 1; i < times.length; i++) gaps.push(times[i] - times[i - 1]);
    if (!gaps.length) {
        return { n: 0, median: null, p90: null, max: null, jitterRatio: null };
    }
    const sorted = gaps.slice().sort((a, b) => a - b);
    const median = percentile(sorted, 0.5);
    const p90 = percentile(sorted, 0.9);
    return {
        n: gaps.length,
        median: +median.toFixed(1),
        p90: +p90.toFixed(1),
        max: +sorted[sorted.length - 1].toFixed(1),
        jitterRatio: median > 0 ? +(p90 / median).toFixed(2) : null,
    };
}

/**
 * Whether a display timeline is worth reporting at all.
 *
 * The bench's whole job is to notice stalls, so a series that never varies is
 * the one result that must never be printed as "no freezes" - it means the
 * detector, not the stream, stopped. Counted on the gaps rather than the
 * timestamps because evenly spaced samples with jitter are healthy and identical
 * samples are not.
 *
 * The limits of this check, stated rather than implied: the event count and the
 * distinct-interval count catch a sampler that stopped recording or stopped
 * comparing. They cannot catch a sampler that MERGES two changes into one
 * observation, because that produces a perfectly ordinary-looking timeline. Two
 * things cover that instead, and both are separate gates in the bench: the
 * producer cross-check (the sampler's change count against the number of
 * different pictures the host says it sent) and, on the raw path, a
 * full-resolution verification pass that a downscaled sample cannot see past.
 * The rate check here catches the opposite failure - a detector that never
 * compares and so records every animation frame.
 */
export function samplerLiveness(times, {
    minEvents = 30, minDistinct = 3, spanMs = 0, minRate = 0.5, maxRate = 55,
} = {}) {
    if (times.length < minEvents) {
        return { alive: false, events: times.length, distinct: 0,
                 reason: `too few events (${times.length} < ${minEvents})` };
    }
    const distinct = new Set();
    for (let i = 1; i < times.length; i++) distinct.add((times[i] - times[i - 1]).toFixed(3));
    if (distinct.size < minDistinct) {
        return { alive: false, events: times.length, distinct: distinct.size,
                 reason: `sampler never varies (${distinct.size} distinct intervals < ${minDistinct})` };
    }
    if (spanMs > 0) {
        const perSecond = times.length / (spanMs / 1000);
        if (perSecond > maxRate) {
            return { alive: false, events: times.length, distinct: distinct.size,
                     changesPerSecond: +perSecond.toFixed(1),
                     reason: `sampler recorded ${perSecond.toFixed(1)} changes a second, more than a display ` +
                             `observed on animation frames can show (${maxRate}/s) - it is not comparing pictures` };
        }
        if (perSecond < minRate) {
            return { alive: false, events: times.length, distinct: distinct.size,
                     changesPerSecond: +perSecond.toFixed(1),
                     reason: `sampler recorded only ${perSecond.toFixed(1)} changes a second over ` +
                             `${(spanMs / 1000).toFixed(1)}s (${minRate}/s floor)` };
        }
        return { alive: true, events: times.length, distinct: distinct.size,
                 changesPerSecond: +perSecond.toFixed(1), reason: 'ok' };
    }
    return { alive: true, events: times.length, distinct: distinct.size, reason: 'ok' };
}

/**
 * The latency headline: p50 plus the tail.
 *
 * The user's requirement is that spikes matter as much as the median, so p90,
 * p95 and the maximum are reported alongside p50 whenever the sample supports a
 * percentile at all. They are real order statistics at these counts - at n=30
 * p90 is the 27th observation and p95 the 29th, at n=92 p95 is the 88th - not
 * the maximum wearing three names. p99 is deliberately not reported: at n=30 it
 * IS the maximum and at n=92 it is the second largest, which is one observation
 * presented as a percentile. The maximum is reported too, and labelled as one
 * observation rather than as a rate.
 *
 * Below the floor the answer is that there is no answer.
 */
export function latencySummary(samples, { minSamples = 30 } = {}) {
    const sorted = samples.slice().sort((a, b) => a - b);
    const n = sorted.length;
    if (n < minSamples) {
        return { n, p50: null, p90: null, p95: null, max: null, sufficient: false,
                 reason: `insufficient samples (${n} < ${minSamples})` };
    }
    const round = (v) => +v.toFixed(1);
    return {
        n,
        p50: round(percentile(sorted, 0.5)),
        p90: round(percentile(sorted, 0.9)),
        p95: round(percentile(sorted, 0.95)),
        max: round(sorted[n - 1]),
        sufficient: true,
        reason: 'ok',
    };
}

/**
 * Two independent 32-bit FNV-style passes over a byte range. One pass would
 * collide often enough over ten thousand pictures to show the wrong one, which is
 * why the picture dedup in the renderer does the same thing.
 */
function fnv2(bytes, seedA = 2166136261, seedB = 0x9e3779b9) {
    let a = seedA;
    let b = seedB;
    for (let i = 0; i < bytes.length; i++) {
        a = Math.imul(a ^ bytes[i], 16777619);
        b = Math.imul(b ^ bytes[i], 2246822519);
    }
    return [a, b];
}

const hex = ([a, b]) => (a >>> 0).toString(36) + ':' + (b >>> 0).toString(36);

/**
 * Identifies the picture the renderer just put on the canvas by the draw state
 * that produced it: the instance buffer it uploaded, the size of the surface, and
 * which generation of the atlas the texture coordinates refer to.
 *
 * Two frames with the same hash are the same picture. That is what makes it
 * possible to ignore an arrival that changes nothing on screen - the atlas is
 * append-only, so a texture id that resolves to the same slot resolves to the
 * same pixels, and a command buffer that has been rewritten to say the same thing
 * is not a redraw the player can see.
 *
 * Hashed as bytes rather than as numbers: instance data is float32 and rounding
 * it to compare would be a second, quiet way to lose a change.
 */
export function paintHash(instances, count, { width = 0, height = 0, atlasGeneration = 0 } = {}) {
    const floats = Math.max(0, Math.min(count, (instances.length / 12) | 0)) * 12;
    const bytes = new Uint8Array(instances.buffer, instances.byteOffset, floats * 4);
    const [a, b] = fnv2(bytes);
    return hex([
        Math.imul(Math.imul(a ^ width, 16777619) ^ height, 16777619),
        Math.imul(b ^ atlasGeneration, 2246822519),
    ]);
}

/**
 * Identifies a sampled view of a picture that can only be read through the
 * element that displays it. Cheaper than paintHash because it runs every frame
 * callback on a downscaled copy.
 */
export function viewHash(data) {
    return hex(fnv2(data));
}

/**
 * Turns a series of sampled pictures into the display timeline: one timestamp
 * per observed change, and nothing recorded when the picture is the same as last
 * time it was looked at.
 *
 * The first sighting is not a change - there was nothing on screen before it -
 * and it is deliberately not recorded, or every run would open with a frame time
 * that describes the page loading rather than the stream.
 */
export class ChangeDetector {
    constructor() {
        this.last = null;
        this.changes = [];
    }

    observe(hash, atMs) {
        if (this.last === null) {
            this.last = hash;
            return false;
        }
        if (hash === this.last) return false;
        this.last = hash;
        this.changes.push(atMs);
        return true;
    }

    reset() {
        this.last = null;
        this.changes.length = 0;
    }
}

/**
 * Credits an input with the paint that answered it, or refuses to.
 *
 * Two ways to refuse, and both matter. A paint that resolved to the picture
 * already on screen showed the player nothing, so the redraw it performed - which
 * is what the old measurement counted - was not an answer. And a stamp old
 * enough to have lost its frame is not a slow answer, it is a missing one; the
 * bound is what keeps a lost frame from being reported as a very slow one.
 */
export function attributePaint({ stamp, sentAt, now, paintChanged, maxAgeMs = 1500 }) {
    if (!paintChanged) return null;
    const ms = now - sentAt;
    if (!(ms >= 0) || ms > maxAgeMs) return null;
    return { stamp, sentAt, shownAt: now, ms: +ms.toFixed(1) };
}

/**
 * How much of the picture changed, as a fraction of the compared entries.
 *
 * `changeMagnitude` and the gate below are what make an action gate possible in a
 * game that animates by itself. Water ripples redraw a few tiles every frame; a
 * move or a zoom replaces the whole view. "Did anything change" cannot tell those
 * apart - and in this game the answer is yes about twenty times a second with no
 * input at all, which is why an earlier gate that asked exactly that passed an
 * action that does nothing.
 */
export function changeMagnitude(previous, current) {
    const n = Math.max(previous.length, current.length);
    if (n === 0) return 0;
    let differing = 0;
    for (let i = 0; i < n; i++) {
        if (previous[i] !== current[i]) differing++;
    }
    return differing / n;
}

/**
 * What happened to every input the bench sent, from both ends of the link.
 *
 * Two counters used to be reported as one number: the host's count of inputs it
 * put a stamp on, printed as though it were the number of samples the client
 * got. They are different quantities and the difference is the interesting part.
 * An input can be lost at four places, and none of them is a phantom:
 *
 *   1. before the host claims it - the stamp is a single slot, so a later input
 *      overwrites one the host had not yet attached to a frame;
 *   2. on the host's answer, if the frame it was attached to carried no visible
 *      change (it is not counted as an answer at all) or the input aged out;
 *   3. on the wire - the picture channel does not retransmit, so a stamped frame
 *      that is dropped takes its stamp with it;
 *   4. on the page - an answered frame whose picture turns out to be the one
 *      already on screen showed the player nothing and is not credited.
 *
 * Reported as counts, both percentages of the inputs that were really sent, and
 * one sentence saying which of the four is the likeliest gap in this run.
 */
/**
 * The line a reader sees for a run's gaps.
 *
 * One function, because this line is what the bench is read for and it has been
 * wrong in a way no test could catch: the first number counted every event the
 * classifier called `path` - freezes and slow samples alike - while the other two
 * counted freezes only. A run with one unclear gap and four path-caused samples
 * therefore printed "4 the path's own ..., 1 unclassified", which reads as a
 * partition of five gaps. The numbers here come from the partition of the gaps
 * (`gapCauses`, which is freezes only) and from `pathSamples`, which is named as
 * what it is on its own line.
 */
export function gapsLine({ gapCauses = { path: 0, quiet: 0, unclear: 0 }, pathSamples = 0, hostRatePerSecond = 0 } = {}) {
    const total = gapCauses.path + gapCauses.quiet + gapCauses.unclear;
    return `gaps: ${gapCauses.path} freeze(s) the path's own (the host sent, the page missed it)` +
           `, ${gapCauses.quiet} the host having nothing new to draw (against a ${hostRatePerSecond}/s rate of its own in this window)` +
           `, ${gapCauses.unclear} unclassified (the host sent frames the display did not show)` +
           `   ${total} gap(s) in all` +
           (pathSamples
               ? `; separately, ${pathSamples} slow sample(s) whose own window the page missed most of`
               : '');
}

/**
 * Whether two runs measured the same scene, which is the only case in which
 * comparing them means anything.
 *
 * The scene sets what the bench reports. On the smart path, two runs of the same
 * build under the same stimulus read a 934.6ms longest gap in the session that
 * changed the picture 16.8 times a second and 166.5ms in the one that changed it
 * 47.9 times a second: a still scene exposes gaps, an animating one covers them.
 * On the raw path the scene moves even the p50 - 19 changes a second reads 85.8ms
 * and 27 reads 54.0ms on one build.
 *
 * The band is 1.10 and it comes from those runs. Pairs 1% apart in activity read
 * p50s within 1% of each other (19.1/s: 68.3ms, 19.2/s: 85.9ms are 17ms apart for
 * other reasons, which is why the band is necessary and not sufficient); a 32%
 * difference in activity moved the p50 by 24%; the same stimulus has been measured
 * at 9.2 to 47.9 changes a second across sessions. Ten percent admits runs whose
 * difference is smaller than any effect the scene has been shown to have, and
 * refuses the rest - which is what "these two numbers are the same measurement"
 * has to mean before a comparison is printed.
 */
export function comparability(a = {}, b = {}, { band = 1.1 } = {}) {
    const x = typeof a.changesPerSecond === 'number' ? a.changesPerSecond : null;
    const y = typeof b.changesPerSecond === 'number' ? b.changesPerSecond : null;
    const rates = [x, y];
    if (x === null || y === null || x <= 0 || y <= 0) {
        return { comparable: false, band, rates, ratio: null,
                 reason: `no activity recorded for ${x === null ? (a.label ?? 'the first run') : (b.label ?? 'the second run')}, ` +
                         'and a run whose scene activity is unknown cannot be compared with anything' };
    }
    const ratio = +((Math.max(x, y) / Math.min(x, y))).toFixed(2);
    if (ratio <= band) return { comparable: true, band, rates, ratio, reason: 'the two runs changed the picture at the same rate, within the band' };
    return {
        comparable: false, band, rates, ratio,
        reason: `${x}/s against ${y}/s is ${ratio}x, past the ${band}x band: the scene sets the tail (and on the raw ` +
                'path the p50), so these two are not the same measurement. The rates are the evidence; the ' +
                'comparison is refused',
    };
}

export function coverage({ sent, hostReceived = null, hostAnswered = null, clientStamped = null,
                           latencySamples = null, overwritten = null, expired = null }) {
    const pct = (n, d) => (n === null || d === null || !d ? null : +(100 * n / d).toFixed(1));
    // Inputs that reached the host and were never answered. The stamp slot is one
    // slot deep, so the buckets that close this are the inputs a later one
    // displaced and the ones that aged out - and a note that cannot name them is
    // how "every input that was sent was answered" got printed over a run in
    // which the host answered 59 fewer than it received.
    const received = hostReceived === null ? sent : Math.min(hostReceived, sent ?? hostReceived);
    const unanswered = (received === null || hostAnswered === null) ? null : Math.max(0, received - hostAnswered);
    // The buckets are only meaningful when the answered figure comes from the
    // same accounting as they do: on the raw path the answers are the relay's echo
    // count, which the slot's buckets do not describe, so with no buckets supplied
    // the note names the gap and stops rather than blaming a counter it does not
    // have.
    const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
    const named = num(overwritten) + num(expired);
    const unaccounted = (unanswered === null || (!num(overwritten) && !num(expired)))
        ? null
        : Math.max(0, unanswered - named);
    const r = {
        inputsSent: sent,
        hostReceived,
        hostAnswered,
        clientStamped,
        latencySamples,
        overwritten,
        expired,
        unanswered,
        unaccounted,
        hostAnsweredPctOfSent: pct(hostAnswered, sent),
        clientStampedPctOfSent: pct(clientStamped, sent),
        clientStampedPctOfHostAnswered: pct(clientStamped, hostAnswered),
        latencySamplesPctOfClientStamped: pct(latencySamples, clientStamped),
    };

    const parts = [];
    if (hostReceived !== null && sent !== null && hostReceived < sent) {
        parts.push(`${sent - hostReceived} of ${sent} never reached the host (the stamp is one slot, so an input ` +
                   `is overwritten if another arrives before a frame claims it)`);
    }
    if (unanswered > 0) {
        const buckets = [];
        if (overwritten) buckets.push(`${overwritten} displaced by a later input before a frame claimed their stamp`);
        if (expired) buckets.push(`${expired} aged out`);
        // A bucket can be one larger than the gap it is meant to explain: the
        // buckets are counter deltas over the window, while the gap is a
        // difference of window-scoped arrivals, and a stamp displaced inside the
        // window can have arrived before it opened. Saying "83 were never
        // answered: 84 displaced" reads as a contradiction, so the boundary is
        // named instead of being resolved by silently shaving a number.
        const over = named > unanswered;
        parts.push(`${unanswered} of the ${received} that reached the host were never answered` +
                   (buckets.length && !over ? `: ${buckets.join(', ')}` : '') +
                   (!buckets.length ? '' : over
                       ? `; the slot's counters name ${named} displaced or aged out in the same window, ` +
                         'more than that difference, because a stamp the window displaced can have arrived before it opened'
                       : '') +
                   (unaccounted ? `, and ${unaccounted} the slot's counters do not name` : ''));
    }
    if (hostAnswered !== null && clientStamped !== null && hostAnswered > clientStamped) {
        parts.push(`${hostAnswered - clientStamped} stamp(s) the host attached to a frame never arrived at the client ` +
                   `(the picture channel does not retransmit)`);
    }
    if (latencySamples !== null && clientStamped !== null && latencySamples < clientStamped) {
        parts.push(`${clientStamped - latencySamples} arriving stamp(s) were not credited to a change the player could see`);
    }
    r.note = parts.length
        ? `${sent} inputs sent: the host answered ${hostAnswered}, the client saw ${clientStamped} of those answers ` +
          `and credited ${latencySamples} to a visible change. ` + parts.join('; ') + '.'
        : `${sent} inputs sent: the host answered ${hostAnswered}, the client saw ${clientStamped} and credited ` +
          `${latencySamples} - every input that was sent was answered and every answer was seen.`;
    return r;
}

/**
 * Drops the gaps that a finer look at the same picture proves were not gaps.
 *
 * The raw path cannot read the pixels of the element that shows the stream any
 * cheaper than by drawing it down to a small canvas and hashing that, and a
 * downscaled hash is blind to a change smaller than one sample cell: a 1-pixel
 * change is invisible to it wherever it lands inside a cell. A missed change can
 * only lengthen an apparent gap, so the bias is one-directional and it inflates
 * exactly the number this bench exists to report.
 *
 * The verification pass reads the element back at full resolution on its own
 * cadence (see the page's nativeChanges). Any gap with a full-resolution change
 * inside it is not a gap the player experienced - the picture did change, the
 * cheap sampler did not see it - and is withheld from the freeze counts and
 * reported separately rather than deleted.
 *
 * Limit, stated: the verification pass samples at its own interval, so it
 * confirms a gap it covered. A change that appeared and was reversed between two
 * verification samples is still invisible to it, which is why the withheld count
 * is printed next to the counts that were kept.
 */
export function reconcileGaps({ gaps, nativeChanges = [] }) {
    const kept = [];
    const withheld = [];
    for (const gap of gaps) {
        const inside = nativeChanges.some((t) => t > gap.atMs && t < gap.atMs + gap.ms);
        if (inside) {
            withheld.push({ ...gap, reason: 'a full-resolution change was observed inside this gap - the ' +
                                                   'downscaled sampler missed it, so the gap is not real' });
        } else {
            kept.push(gap);
        }
    }
    return { kept, withheld };
}

/**
 * Every message that came off the wire, kept as (time, kind, bytes).
 *
 * The kinds are named rather than enumerated on purpose: the point of this
 * recorder is that it must be able to hold a message the author did not think
 * of. An earlier version of this instrumentation recorded frames and keepalives and
 * left textures out, and since textures are ~99% of the bytes on this link,
 * every spike it explained read as "nothing was sent". Silence from a recorder
 * that only records two kinds is not evidence of silence.
 *
 * Capped, and the cap drops the OLDEST events: the bench reads this at the end
 * of a run, and the events that describe the measured window are the newest.
 */
export class WireRecorder {
    constructor({ max = 40000 } = {}) {
        this.max = max;
        this.events = [];
    }

    // `id` is the sequence number the sender put on the message where there is
    // one, and 0 otherwise. It is what lets a frame that never arrived be told
    // from one that arrived late: without it the two look identical from here.
    record(kind, bytes, atMs, id = 0) {
        this.events.push([+atMs.toFixed(1), kind, bytes, id]);
        if (this.events.length > this.max) {
            this.events.splice(0, this.events.length - this.max);
        }
    }

    reset() {
        this.events.length = 0;
    }

    between(fromMs, toMs) {
        return wireBetween(this.events, fromMs, toMs);
    }
}

/**
 * The make-up of the wire inside one window: how many messages, how many bytes,
 * and of what. Half-open at both ends, so tiling windows over one log cannot
 * count the same message twice or lose one between them.
 *
 * `dominant` is the kind that carried the most bytes, which is the question a
 * spike asks: a window in which 1.5 MB of artwork went out is not the same
 * window as one in which three deltas did, even if both are "traffic".
 */
export function wireBetween(events, fromMs, toMs, kinds = null) {
    const byKind = {};
    let count = 0;
    let bytes = 0;
    for (const [t, kind, size] of events) {
        if (t < fromMs || t >= toMs) continue;
        if (kinds && !kinds.includes(kind)) continue;
        const bucket = byKind[kind] || (byKind[kind] = { count: 0, bytes: 0 });
        bucket.count++;
        bucket.bytes += size;
        count++;
        bytes += size;
    }
    let dominant = null;
    for (const [kind, bucket] of Object.entries(byKind)) {
        if (!dominant || bucket.bytes > byKind[dominant].bytes) dominant = kind;
    }
    return { count, bytes, byKind, dominant, fromMs, toMs };
}

/**
 * The names of the kinds on the wire. The numbers are part of the contract with
 * the streamer's log (interposer/wire_log.hpp): a number retired is left free
 * rather than reused, because the dumps kept as evidence are read back by it.
 */
export const WIRE_KIND_NAMES = {
    0: 'frame', 1: 'keyframe', 2: 'artwork', 3: 'ping', 4: 'rawframe', 5: 'input',
};

export function wireKindName(kind) {
    return WIRE_KIND_NAMES[kind] || 'other';
}

/**
 * The page's own record of the inputs it sent.
 *
 * Two questions are asked of it and they need two different shapes. "Which input
 * is this echo about" is a lookup by stamp, and the newest send carrying that
 * stamp is the only one it can mean. "What did this window send, in order" is a
 * log, and a Map keyed by the stamp cannot be one: the stamp is a single byte
 * that rotates, so a 366-392 input window overwrites 63-66% of itself before
 * anything reads it - which is how the uplink pairing came to be built from the
 * last 255 sends of a 380 input window and reported a median transit of -5640ms.
 *
 * Both shapes come from the same records, so neither can disagree with the other.
 */
export function inputLog() {
    const entries = [];
    const byStamp = new Map();
    return {
        entries,
        record(stamp, atMs) {
            entries.push([stamp, atMs]);
            byStamp.set(stamp, atMs);
        },
        get(stamp) {
            return byStamp.get(stamp);
        },
        // The window query the bench uses: the sends whose stamp was issued at or
        // after `fromMs`, in send order.
        since(fromMs) {
            return entries.filter(([, t]) => t >= fromMs);
        },
        reset() {
            entries.length = 0;
            byStamp.clear();
        },
    };
}

/**
 * The host's own wire log, parsed once for both paths.
 *
 * A row is `[epoch_ms, kind, bytes, queue, extra, stamp]` - six fields - and the
 * per-kind payload in the fifth is NOT the same thing for every kind: a frame's
 * is its encode cost, an artwork chunk's is nothing, and an input's is zero
 * because an input's stamp is the sixth field. Reading the fifth as the stamp
 * made every uplink lookup miss, and a run then reported a 100% stamp mismatch
 * and a median transit of minus 5640ms as though both were measurements.
 *
 * `inputs` is what the uplink is matched against - (arrival on the page clock,
 * stamp) in arrival order - and `answers` is the host's own share of each
 * answered input, for this path only (the two paths share one stamp slot and
 * one log, so an unfiltered answer list attributes the other path's frames to
 * this one).
 */
export function hostWireLog(json, { toPage = (t) => t, path = 'smart' } = {}) {
    const events = [];
    const inputs = [];
    const queue = [];
    const answers = [];
    const pathId = path === 'raw' ? 1 : 0;
    for (const row of (json && json.events) || []) {
        const [epoch, kind, bytes, depth, extra, stamp] = row;
        const t = toPage(epoch);
        const name = wireKindName(kind);
        events.push([t, name, bytes, name === 'input' ? (stamp ?? 0) : (kind <= 1 ? (extra ?? 0) : 0)]);
        if (name === 'input') inputs.push([t, stamp ?? 0]);
        if (depth >= 0) queue.push([t, depth]);
    }
    for (const row of (json && json.stamps) || []) {
        const [stamp, ageMs, epoch, p] = row;
        if (p !== pathId) continue;
        answers.push([toPage(epoch), stamp, ageMs]);
    }
    return { events, inputs, queue, answers };
}

/**
 * The host's own share of one sample: how long it held the input that the change
 * answered.
 *
 * `answers` is the host's stamp log in order, each entry (when it sent the
 * answering frame, on the page clock, the stamp, how long it held the input).
 * The lookup is by the ANSWER, not by the stamp's value: the stamp is a byte and
 * it rotates, so one value answers many inputs - 1738 answers over 255 stamps in
 * one measured window, one of them twelve times - and a map keyed by value hands
 * every sample carrying that byte the same, usually wrong, share. The answer
 * that belongs to a change is the last one for that stamp at or before the
 * change; with nothing at or before it, there is no share and the bench says so
 * rather than quoting another input's.
 */
export function hostShareFor(answers, stamp, toMs) {
    if (!stamp) return null;
    let age = null;
    for (const [t, s, a] of answers || []) {
        if (t === null) continue;
        if (t > toMs) break;
        if (s === stamp) age = a;
    }
    return age;
}

/**
 * How much of a window the page's main thread spent blocked.
 *
 * The page records its own long tasks (PerformanceObserver, >50ms), because
 * "the picture did not change" and "the page was not running" look identical in
 * every other number this bench collects - a blocked page cannot receive a
 * message or paint one. Counted by overlap rather than by whole tasks: a task
 * that began before the window and ended inside it blocked only part of it, and
 * counting it in full would attribute a stall to whichever window it happened to
 * end in.
 */
export function blockedInWindow(tasks, fromMs, toMs) {
    let total = 0, count = 0, longest = 0, maxOverlap = 0;
    for (const [start, duration] of tasks) {
        const end = start + duration;
        if (end <= fromMs || start >= toMs) continue;
        const overlap = Math.min(end, toMs) - Math.max(start, fromMs);
        if (overlap <= 0) continue;
        total += overlap;
        count++;
        longest = Math.max(longest, duration);
        maxOverlap = Math.max(maxOverlap, overlap);
    }
    return {
        count,
        totalMs: +total.toFixed(1),
        longestMs: +longest.toFixed(1),
        maxOverlapMs: +maxOverlap.toFixed(1),
    };
}

/**
 * Lines up the inputs the page says it sent with the ones the host says it
 * received, by the stamp they share, and reports how long each took.
 *
 * This is the uplink's mirror of matchFrameSends, and it is what says WHICH
 * direction stalled. A downlink stall with inputs still arriving on time is one
 * finding; a stall in which the inputs are held too is another - it means the
 * whole path between the two processes stopped, not that one direction was
 * slow. The host answers an input in 10-40ms, so an input that arrives late is
 * not a slow answer, it is a late question, and every sample built on it
 * inherits the delay.
 */
export function matchInputs(clientSent, hostReceived, { minTransitMs = -25, maxTransitMs = 3000 } = {}) {
    // Paired by stamp, with a time tolerance. Both halves of that are load-bearing
    // and both were learned from a live failure:
    //
    //   * By stamp, because the two logs do not cover the same span. The page's
    //     send log is cleared when the measured window opens, and the host's
    //     arrival log still holds answers delivered inside the window to inputs
    //     sent before it - 18 of them in one run. Pairing by position put every
    //     pair one place out and refused the whole window: 369 of 369.
    //   * With a tolerance, because the uplink can hold inputs rather than lose
    //     them: one run has 1229ms in which no input arrived at all, followed by
    //     21 arrivals inside a single millisecond. Refusing anything slower than
    //     a round trip throws that measurement away, and the stall it shows is a
    //     finding in its own right.
    //
    // The tolerance has to be shorter than one turn of the stamp: it is a byte,
    // so the same value comes round every 256 inputs, which at these rates is
    // several seconds. Beyond that the pairing would be ambiguous, which is the
    // failure that produced transits of minus fifty seconds.
    const sent = clientSent instanceof Map
        ? [...clientSent.entries()].map(([stamp, t]) => [t, stamp]).sort((a, b) => a[0] - b[0])
        : clientSent.slice().sort((a, b) => a[0] - b[0]);
    const got = hostReceived.slice().sort((a, b) => a[0] - b[0]);
    const used = new Array(got.length).fill(false);
    const transitMs = [];
    const stamps = [];
    let missing = 0;
    let unmatchedByStamp = 0;
    // The arrival index only moves forward: both logs are in time order, so a
    // pair found later can never be the right one for an earlier send.
    // A pair whose arrival lands before its send by more than the alignment can
    // explain is not that send's arrival: it is an answer to an input sent before
    // the window opened, whose send this log does not contain. Those are counted
    // and dropped rather than quoted - and if they are a large share of the pairs,
    // it is the clock that is wrong and the window is refused.
    let earlyPairs = 0;
    let pairsConsidered = 0;
    for (const [t, stamp] of sent) {
        let found = -1;
        // Scanned from the start rather than from the last pair: an arrival that
        // was too early to belong to the previous send can be exactly the one a
        // later send is waiting for, and a cursor that only moves forward loses
        // it. Both lists are short (hundreds), so the scan is not worth bounding
        // more cleverly than the two time checks below.
        for (let i = 0; i < got.length; i++) {
            if (used[i]) continue;
            const [at, arrivalStamp] = got[i];
            if (at < t - maxTransitMs) continue;
            if (at > t + maxTransitMs) break;
            if (arrivalStamp === stamp) { found = i; break; }
        }
        if (found === -1) {
            missing++;
            if (!got.some(([, st]) => st === stamp)) unmatchedByStamp++;
            continue;
        }
        used[found] = true;
        pairsConsidered++;
        const transit = +(got[found][0] - t).toFixed(1);
        if (transit < minTransitMs) {
            earlyPairs++;
            continue;
        }
        transitMs.push(transit);
        stamps.push(stamp);
    }
    // Arrivals with no send in this window: answers to inputs sent before it
    // opened, or inputs this log did not see sent. Counted, never paired.
    const extra = used.filter((u) => !u).length;
    // A transit is a difference of two clocks that were put together from a round
    // trip, so it is only a latency when the pairing it came from is established.
    // Pairing by stamp removes the shifted-pairing failure; what is left is the
    // clock itself, and a transit below what the alignment can support is a clock
    // put together wrongly. A run that quoted the median of a shifted pairing
    // printed -5640ms as though it were a measurement; that is still impossible,
    // and the reason is printed in place of the number.
    const worst = transitMs.length ? Math.min(...transitMs) : 0;
    // Three fifths of the pairs landing before their own send is not a link
    // behaviour, it is two clocks put together wrongly: the alignment the bench
    // measured from a round trip does not describe these two logs, and no transit
    // from this window is a latency.
    const clockWrong = earlyPairs >= Math.max(3, 0.2 * pairsConsidered);
    const reason = !sent.length || !got.length
        ? 'the host log holds no input arrivals to pair with'
        : (clockWrong
            ? `${earlyPairs} of ${pairsConsidered} pairs put the arrival before its own send, which the clock ` +
              `alignment cannot support (${minTransitMs}ms), so these two logs are not on one clock`
            : (transitMs.length === 0
                ? `${unmatchedByStamp} of ${sent.length} sends found no arrival carrying their stamp, so no pair can ` +
                  'be established for this window'
                : null));
    const paired = reason === null;
    return {
        paired,
        reason,
        stamps,
        transitMs: paired ? transitMs : [],
        worstTransitMs: transitMs.length ? worst : null,
        minTransitMs,
        maxTransitMs,
        missing,
        extra,
        unmatchedByStamp,
        earlyPairs,
        pairsConsidered,
        matched: transitMs.length,
        basis: 'the send and the arrival carrying the same stamp, within the tolerance',
    };
}

/**
 * The longest stretch inside a window in which the host's log shows no input
 * arriving at all, and how many arrived in the burst that ended it.
 *
 * The uplink can hold inputs rather than lose them - one measured run has 1229ms
 * of silence followed by 21 arrivals inside a single millisecond - and that is a
 * finding about the link, not a reason to stop measuring. It is reported
 * separately from the transit so a stall cannot hide inside a percentile.
 */
export function arrivalHole(arrivals, { minMs = 300, burstMs = 10 } = {}) {
    const times = arrivals.map(([t]) => t).sort((a, b) => a - b);
    let worst = null;
    for (let i = 1; i < times.length; i++) {
        const ms = times[i] - times[i - 1];
        if (!worst || ms > worst.ms) worst = { ms: +ms.toFixed(1), fromMs: times[i - 1], toMs: times[i] };
    }
    if (!worst || worst.ms < minMs) return null;
    const burst = times.filter((t) => t >= worst.toMs && t <= worst.toMs + burstMs).length;
    return { ...worst, burst, basis: `no input arrived for ${worst.ms}ms` };
}

/**
 * What the uplink was doing during one window: the transit of the inputs the
 * page sent inside it. Reported as a median and a maximum rather than a mean,
 * because the question is whether ONE input took the whole window to arrive.
 */
export function uplinkInWindow(inputTransits, fromMs, toMs) {
    const values = inputTransits.filter(([t]) => t >= fromMs && t < toMs).map(([, ms]) => ms).sort((a, b) => a - b);
    if (!values.length) return { count: 0, medianMs: null, maxMs: null };
    return {
        count: values.length,
        medianMs: +percentile(values, 0.5).toFixed(1),
        maxMs: +values[values.length - 1].toFixed(1),
    };
}

/**
 * What the client itself was doing while it waited.
 *
 * A Wi-Fi station enters power save on its OWN idleness: the radio is kept awake
 * by the station transmitting, not by the host sending to it. So "the link was
 * quiet" has to be asked of this side's sends - which is why the page records
 * when it sent each input - and a spike in which the client sent nothing for a
 * quarter of a second is a different finding from one in which it kept
 * transmitting normally and still received nothing.
 *
 * The longest silence is bounded by the window: a client that last sent just
 * before the spike starts is silent for that whole stretch, and that counts.
 */
export function clientActivity(sendTimes, fromMs, toMs) {
    const inside = sendTimes.filter((t) => t >= fromMs && t < toMs).sort((a, b) => a - b);
    const before = sendTimes.filter((t) => t < fromMs);
    const lastBefore = before.length ? before[before.length - 1] : null;
    let longest = lastBefore === null ? null : fromMs - lastBefore;
    let previous = lastBefore === null ? fromMs : lastBefore;
    for (const t of inside) {
        longest = longest === null ? t - previous : Math.max(longest, t - previous);
        previous = t;
    }
    longest = longest === null ? toMs - fromMs : Math.max(longest, toMs - previous);
    return {
        count: inside.length,
        longestSilenceMs: +longest.toFixed(1),
        firstSendBeforeMs: lastBefore === null ? null : +(fromMs - lastBefore).toFixed(1),
    };
}

/**
 * Lines up the frames the host says it handed over with the frames the page says
 * it received, by the sequence number they share.
 *
 * This is the difference between two findings that look the same from either log
 * alone. A frame the host sent and the page never received is loss on the wire -
 * the picture is held until something replaces it, which on an unreliable
 * channel means a recovery round trip - while a frame that arrives late is
 * something holding the messages up, which no amount of retransmission fixes.
 *
 * `transitMs` is the arrival minus the send for the frames that did arrive - and
 * only for the ones that arrived before `arrivalBeforeMs`. Every run ends by
 * blocking the page for 1500ms on purpose (the freeze counter's own control), and
 * a frame delivered during that block was not slow, it was held. It doubles as a
 * check on the clock alignment: on a LAN it must be small and positive. A systematically negative transit means the two clocks were put
 * together wrongly, and every window described with them is shifted by that much.
 *
 * `clientLogEndMs` is the last moment the page's log describes. The two logs do
 * not end together: the page's is read when the bench asks for it, and the host
 * carries on producing pictures until it is told to stop, so every frame sent in
 * between has no arrival to find. Counting those as lost invents loss in
 * proportion to how fast the host was drawing, which is how a snapshot artefact
 * came to be read as a rate ceiling. A frame sent after the log ended is counted
 * in `beyondLog` - not delivered, and not claimed to be lost either.
 */
export function matchFrameSends(hostWire, clientWire, { arrivalBeforeMs = Infinity, clientLogEndMs = Infinity } = {}) {
    const arrivalBySeq = new Map();
    for (const [t, kind, , id] of clientWire) {
        if ((kind === 'frame' || kind === 'keyframe') && id) arrivalBySeq.set(id, t);
    }
    const lost = new Set();
    const transitMs = [];
    let sent = 0;
    let beyondLog = 0;
    for (const [t, kind, , id] of hostWire) {
        if ((kind !== 'frame' && kind !== 'keyframe') || !id) continue;
        sent++;
        const arrival = arrivalBySeq.get(id);
        if (arrival === undefined) {
            if (t > clientLogEndMs) beyondLog++;
            else lost.add(id);
        } else if (arrival <= arrivalBeforeMs) {
            transitMs.push(+(arrival - t).toFixed(1));
        }
    }
    return { sent, arrived: sent - lost.size - beyondLog, lost, transitMs, beyondLog };
}

/**
 * The context of one spike: everything that was true while the player was
 * waiting. See spikeReport.
 */
/**
 * Which kinds are a picture on the wire. The classification below is written in
 * frames, and every message kind that is not one - an arriving input, an artwork
 * chunk - must not be counted as the host having something to draw.
 */
export const FRAME_KINDS = [0, 1, 'frame', 'keyframe', 'part'];

/**
 * What a display gap can be charged to.
 *
 * The first version asked whether the host had sent at least three frames inside
 * the gap. That is a fixed count standing in for a rate, and it failed in both
 * directions: a short gap in which the host was working flat out could never be
 * the path's fault (two frames is under three), and a long gap in which the host
 * sent plenty was always "the host had nothing new to draw" - including one of
 * 1550ms in which it sent 11 frames and 9 of them arrived. Every post-fix run
 * printed "0 the path's own", which was a property of the threshold rather than
 * of the data.
 *
 * The host is judged against its own observed rate in the measured window: how
 * many frames it did send in the gap against how many that rate predicts. That
 * gives three answers instead of two, and the third is a real answer:
 *
 *   path    the host was sending at its rate and the page received a third or
 *           less of it - the bytes left and did not arrive
 *   quiet   the host sent little or nothing against its own rate: the game had
 *           no new picture to give, and blaming the path for that is how a still
 *           scene gets reported as a broken link
 *   unclear the host sent frames its rate does not explain and the page received
 *           most of them: they arrived and the display did not change. That is a
 *           sampler or a main-thread question, and neither of the other answers
 *           is supported by the data.
 *
 * `hostRatePerSecond` is counted from the same host send log and the same window
 * as the counts, so this compares two readings of one source.
 */
export function gapCause({ hostFrames, clientFrames, gapMs, hostRatePerSecond = 0 }) {
    const expectedFrames = Math.max(0, hostRatePerSecond) * Math.max(0, gapMs) / 1000;
    // Two pictures that left the host and at most a third of them arriving is a
    // delivery failure, and the host's rate does not come into it: the frames
    // were sent. The floor of two is not a stand-in for a rate - it is the
    // smallest sample in which "lost" can be told from "repaired by the next
    // delta", which is what one lost frame on a partially reliable channel looks
    // like from here.
    // Two edges this does not cover, neither of which has occurred in a measured
    // run: a gap in which the client received frames the host's log does not
    // contain (the host's log is capped, so a very long session could in
    // principle lose its oldest entries) reads as `quiet` because hostFrames is
    // small; and a window whose host rate is zero makes expectedFrames zero, so
    // every gap in it is `quiet`. Both are visible in the print - `hostFrames`
    // and `expectedHostFrames` sit on the same line as the verdict - which is the
    // only reason they are acceptable.
    const missedMost = hostFrames >= 2 && clientFrames * 3 <= hostFrames;
    // The rate is what judges the other way round: the host sent a quarter or
    // less of what its own rate predicts, so the game had no new picture to give.
    // Pure ratio, no absolute floor - a floor of "two frames is too few to judge"
    // is the same fixed-count heuristic this replaces, and it is what made a gap
    // in which the host sent two frames in 40ms read as stillness.
    const mostlyStill = hostFrames <= 0.25 * expectedFrames;
    const cause = missedMost ? 'path' : (mostlyStill ? 'quiet' : 'unclear');
    return { cause, expectedFrames, hostRatePerSecond, hostFrames, clientFrames };
}

/**
 * The frames each side had inside one window: what the host sent and what the
 * page received, counted in frames and nothing else. Every gap verdict in this
 * bench is built from these two numbers, from the per-gap lines to the headline
 * counts, so the two can never turn out to be different measurements of the same
 * window. Inputs and artwork are traffic, not pictures: counting them charged a
 * stall to the path on the strength of the uplink alone (see docs/bench.md).
 */
export function framesInWindow({ hostWire = [], wireLog = [], fromMs, toMs, frameKinds = FRAME_KINDS }) {
    let hostFrames = 0;
    for (const [t, kindName] of hostWire) {
        if (t < fromMs) continue;
        if (t >= toMs) break;
        if (frameKinds.includes(kindName)) hostFrames++;
    }
    return { hostFrames, clientFrames: wireBetween(wireLog, fromMs, toMs, frameKinds).count };
}

/**
 * A freeze bucket, split by the verdict each gap in it was given.
 *
 * `path` is delivery failing, `quiet` is the game having nothing new to draw, and
 * `unclear` is the data not settling which - three different things, and a total
 * that adds them reports a defect, correct behaviour and an admission of ignorance
 * as one number. A gap with no verdict at all is filed under `unclear`: that is
 * what "the data does not settle it" means, and dropping it would make the split
 * quietly disagree with the detail list beside it.
 */
export function verdictCounts(gaps, verdictFor) {
    const out = { path: 0, quiet: 0, unclear: 0 };
    for (const g of gaps) {
        const v = verdictFor ? verdictFor(g) : null;
        if (v === 'path' || v === 'quiet') out[v]++;
        else out.unclear++;
    }
    return out;
}

function spikeContext({ kind, ms, fromMs, toMs, stamp = 0, wireLog, hostWire, lostSeq, queue, park, hostAnswers,
                         display, longTasks, clientSends, inputTransits, frameKinds = FRAME_KINDS,
                         hostRatePerSecond = 0 }) {
    const wire = wireBetween(wireLog, fromMs, toMs);
    let queueMax = null;
    for (const [t, bytes] of queue) {
        if (t < fromMs) continue;
        if (t >= toMs) break;
        queueMax = queueMax === null ? bytes : Math.max(queueMax, bytes);
    }
    let parked = 0;
    for (const [t, missing] of park) {
        if (t > toMs) break;
        parked = missing;
    }
    // The gap that immediately preceded the spike, from the display timeline: a
    // slow sample that followed a 16ms step is an isolated event, and one that
    // followed a 200ms hole is the tail of a burst. Those are different faults
    // and the durations alone cannot tell them apart.
    //
    // Measured up to the change this spike IS (a latency sample is credited to
    // the change at the end of its own window), and up to its start for a freeze,
    // which is a hole with no change of its own.
    const reference = kind === 'latency' ? toMs : fromMs;
    let gapBeforeMs = null;
    for (const t of display) {
        if (t >= reference) break;
        gapBeforeMs = +(reference - t).toFixed(1);
    }
    // What the host handed to the link inside the same window. Compared with what
    // the page received, this is the difference between "the bytes never left"
    // and "the bytes left and never arrived", which are different faults with
    // different fixes and which the page's log alone cannot distinguish.
    let hostSent = 0;
    let hostBytes = 0;
    let lost = 0;
    for (const [t, kindName, size, id] of hostWire) {
        if (t < fromMs) continue;
        if (t >= toMs) break;
        hostSent++;
        hostBytes += size;
        if (id && lostSeq.has(id)) lost++;
    }
    const { hostFrames, clientFrames } = framesInWindow({ hostWire, wireLog, fromMs, toMs, frameKinds });
    return {
        kind, ms: +ms.toFixed(1), fromMs: +fromMs.toFixed(1), toMs: +toMs.toFixed(1), stamp,
        wire, queueMax, parked, hostSent, hostBytes, hostFrames, clientFrames, lost,
        blocked: blockedInWindow(longTasks, fromMs, toMs),
        // Did the host actually have a new picture to give during this gap, and
        // if it did, did the page get it? Judged against the host's own rate in
        // the window rather than a fixed count of frames: see gapCause. Counted in
        // FRAMES, as `docs/bench.md` defines it - a window in which the only
        // traffic was the client's own inputs arriving is not the host having
        // something to draw, and counting every message made a stall chargeable
        // to the path on the strength of the uplink alone.
        ...(() => {
            const c = gapCause({ hostFrames, clientFrames, gapMs: Math.max(1, toMs - fromMs), hostRatePerSecond });
            // Only a freeze gets the three-way verdict. A latency sample is a
            // window in which the picture DID change - that is what makes it a
            // sample - so "the host had nothing to draw" and "the frames arrived
            // and the display did not show them" are not answers about it. What
            // can still be said about one is that the page missed what was sent.
            const cause = kind === 'freeze' ? c.cause : (c.cause === 'path' ? 'path' : null);
            return { cause, expectedHostFrames: +c.expectedFrames.toFixed(1), blind: cause === 'path' };
        })(),
        client: clientActivity(clientSends, fromMs, toMs),
        uplink: uplinkInWindow(inputTransits, fromMs, toMs),
        hostMs: kind === 'freeze' ? null : hostShareFor(hostAnswers, stamp, toMs),
        gapBeforeMs,
    };
}

/**
 * The worst samples and every freeze, each with the context around it.
 *
 * A tail number on its own cannot say whether a path is jittery or has a hole
 * in it: a hundred samples that each went wrong for their own reason and a
 * hundred that went wrong for the same reason print as the same p90. So each
 * spike is described by what was on the wire during it, how deep the host's
 * send queue was, how long the host itself held that input, what the display
 * did immediately before it, and whether the client was parked waiting for
 * artwork - and then counted by signature, because a signature that repeats is
 * a hole and a scatter of one-offs is jitter.
 *
 * `latency` samples must carry `sentAt`, `shownAt`, `ms` and their `stamp`;
 * `display` is the ascending timeline of display changes; `wire`, `queue` and
 * `park` are the page's logged series (park is a level, so it is carried
 * forward); `hostAnswers` is the host's own ordered log of the answers it gave,
 * which is what each sample's host share is looked up in.
 */
export function spikeReport({
    latency = [], freezes = [], display = [], wire = [], queue = [], park = [],
    hostAnswers = [], hostWire = [], lostSeq = new Set(), longTasks = [], clientSends = [],
    inputTransits = [], frameKinds = FRAME_KINDS, hostRatePerSecond = 0,
    worstFraction = 0.05, maxEvents = 60, queueDeepAt = 65536, materialMs = null,
}) {
    const take = Math.max(1, Math.ceil(latency.length * worstFraction));
    const worst = latency.slice().sort((a, b) => b.ms - a.ms).slice(0, take);

    const events = [];
    for (const sample of worst) {
        events.push(spikeContext({
            kind: 'latency', ms: sample.ms, fromMs: sample.sentAt, toMs: sample.shownAt,
            stamp: sample.stamp, wireLog: wire, hostWire, lostSeq, queue, park, hostAnswers, display, longTasks,
            clientSends, inputTransits, frameKinds, hostRatePerSecond,
        }));
    }
    for (const gap of freezes) {
        events.push(spikeContext({
            kind: 'freeze', ms: gap.ms, fromMs: gap.atMs, toMs: gap.atMs + gap.ms,
            wireLog: wire, hostWire, lostSeq, queue, park, hostAnswers, display, longTasks, clientSends, inputTransits,
            frameKinds, hostRatePerSecond,
        }));
    }
    events.sort((a, b) => b.ms - a.ms);

    // One short string per spike, of the things that distinguish one cause from
    // another: what was on the wire, how deep the queue was, whether the client
    // was parked. Grouping by it is what turns a list of slow samples into an
    // answer.
    // What the repeat verdict is read on. The worst 5% of a tight distribution
    // are ordinary samples: at p50 50ms and p95 51ms they share a signature
    // because nothing happened in them, and counting them would call a healthy
    // path a hole. Only samples at least `materialMs` long (the caller passes
    // twice the median) and the freezes count.
    // A gap with no picture behind it is not part of the tail at all: the sample
    // distribution did not move, the workload did.
    const material = events.filter((e) => (e.kind === 'latency' && (materialMs === null || e.ms >= materialMs)) ||
                                          (e.kind === 'freeze' && e.blind));

    const groups = new Map();
    for (const event of events) {
        const signature = spikeSignature(event, { queueDeepAt });
        event.signature = signature;
        const group = groups.get(signature) || { signature, count: 0, maxMs: 0, minMs: Infinity };
        group.count++;
        group.maxMs = Math.max(group.maxMs, event.ms);
        group.minMs = Math.min(group.minMs, event.ms);
        groups.set(signature, group);
    }
    const signatures = [...groups.values()]
        .map((g) => ({ ...g, minMs: +g.minMs.toFixed(1), share: +(g.count / Math.max(1, events.length)).toFixed(2) }))
        .sort((a, b) => b.count - a.count || b.maxMs - a.maxMs);

    // The verdict reads only the material events, counted separately from the
    // signatures above so the printed list is still the whole worst 5%.
    const materialGroups = new Map();
    for (const event of material) {
        materialGroups.set(event.signature, (materialGroups.get(event.signature) || 0) + 1);
    }
    const materialTop = [...materialGroups.entries()].sort((a, b) => b[1] - a[1])[0] || null;

    // Half of the spikes sharing one signature, at least three times, is a hole:
    // a cause that recurs is a cause that can be found and triggered. A scatter
    // with no group that large is what jitter looks like from in here.
    const repeated = !!materialTop && materialTop[1] >= 3 && materialTop[1] >= material.length / 2;
    // The rule the count came from, stated in the note so a reader can disagree
    // with the rule rather than wonder what the number means.
    // Spelled out per kind, because "the path's own fault" covered two of them:
    // a freeze the page was never given, and a sample whose window the page
    // missed most of. The count is of the freezes; the samples are named after it.
    const pathFreezes = events.filter((e) => e.kind === 'freeze' && e.cause === 'path').length;
    const countPathSamples = (list) => list.filter((e) => e.kind === 'latency' && e.cause === 'path').length;
    const pathSamples = countPathSamples(events);
    const verdictOfSamples = (list) => {
        const n = countPathSamples(list);
        return n ? `, and ${n} slow sample(s) whose own window the page missed most of` : '';
    };
    const materialNote = `the ${pathFreezes} freeze(s) the path's own doing` +
        (pathSamples ? ` and ${pathSamples} slow sample(s) whose own window the page missed most of` : '') +
        `, of ${events.length} spikes`;
    const materialShort = materialMs === null ? `all ${material.length}` : `the ${material.length} past ${materialMs}ms`;
    // Split before judging: a material event in which the host kept producing
    // pictures the page never got is a hole in the path. A material event in
    // which the host had nothing to draw is the workload's stillness, and
    // counting the two together is how a quiet scene gets reported as a stall.
    // Freezes only. `pathSamples` below is the other population, and the two are
    // named for what they are: a latency sample can be `path` - the page missed
    // most of what was sent inside its own window - and can never be `quiet` or
    // `unclear`, so counting it here put two different populations under one set
    // of labels. The audit's run had one unclear freeze and four path-caused
    // samples and printed "4 the path's own ... 1 unclassified", which reads as a
    // partition of five gaps when the run had one gap.
    const stalls = events.filter((e) => e.kind === 'freeze' && e.cause === 'path').length;
    const quietGaps = events.filter((e) => e.kind === 'freeze' && e.cause === 'quiet').length;
    // The third answer, counted separately so it cannot hide inside "quiet": the
    // host sent frames the display did not show, and the data cannot say which
    // side did what. Reporting those as the workload being still is how a
    // classifier that only ever says "quiet" looks like a clean bill of health.
    const unclearGaps = events.filter((e) => e.kind === 'freeze' && e.cause === 'unclear').length;
    // The sentence the reader sees, built in one place so the three cases read
    // as three cases: nothing spiked, nothing spiked for the path's own reasons,
    // or a tail that either repeats one signature or scatters.
    const verdictNote = (() => {
        if (!events.length) return 'no spikes to describe';
        if (!material.length) {
            // Three answers, and the third one printed: a run whose gaps are all
            // "the host had nothing to draw" and a run whose gaps the data cannot
            // settle are different runs, and a note that only ever says the first
            // is a clean bill of health the classifier cannot support.
            const unclear = events.filter((e) => e.kind === 'freeze' && e.cause === 'unclear').length;
            const unclearNote = unclear
                ? `, ${unclear} of them unclassified (the host sent frames the display did not show, and the data ` +
                  'cannot settle which side did what)'
                : '';
            const quietNote = quietGaps
                ? 'the gaps are the host having nothing new to draw'
                : 'no gap in this run is chargeable to the path';
            const sampleNote = verdictOfSamples(events);
            return `none of the ${events.length} spikes is the path's own doing: ${quietNote}, no sample reached ` +
                   `twice the median${unclearNote}${sampleNote}`;
        }
        const composition = pathSamples
            ? ` (${pathFreezes} freeze(s), ${pathSamples} slow sample(s))`
            : '';
        if (repeated) {
            return `${materialTop[1]} of ${materialShort} share one signature (${materialTop[0]}) - a hole, not jitter${composition}`;
        }
        return `${materialNote} scatter over ${materialGroups.size} signatures with no common factor - jitter${composition}`;
    })();
    const verdict = {
        repeated,
        // A partition of the FREEZES: three verdicts, one population, and the
        // numbers add up to the number of freezes the run reported. A slow sample
        // is not a gap and is not in here - it is `pathSamples` below.
        gapCauses: { path: stalls, quiet: quietGaps, unclear: unclearGaps },
        stalls,
        quietGaps,
        unclearGaps,
        pathSamples,
        top: materialTop ? materialTop[0] : null,
        topCount: materialTop ? materialTop[1] : 0,
        of: material.length,
        total: events.length,
        materialMs,
        note: verdictNote,
    };

    return {
        worstSelected: take,
        worstOf: latency.length,
        freezeSelected: freezes.length,
        // The partition, at the top level as well as inside the verdict: the
        // printed gap line reads it from here, so a caller cannot pick up the
        // freeze-only `quiet`/`unclear` and the two-population `stalls` and print
        // them as one set of labels again.
        gapCauses: verdict.gapCauses,
        pathSamples,
        events: events.slice(0, maxEvents),
        eventsTotal: events.length,
        signatures,
        verdict,
    };
}

/**
 * What makes two spikes the same kind of spike, in one line.
 *
 * The payload term is the bytes on the wire and which kind carried them, because
 * a spike behind 1.5MB of artwork and a spike with an empty wire are different
 * faults. 64kB is the line for "deep": libdatachannel's own queue was measured
 * at 393kB under load, and a frame is ~114 bytes, so a queue above one artwork
 * chunk means frames are waiting behind pictures rather than behind each other.
 */
export function spikeSignature(event, { queueDeepAt = 65536 } = {}) {
    // Bucketed, not exact: an artwork chunk arrives in ones and twos and the
    // exact byte count of a window is a coin toss, so a signature that quoted it
    // would split one cause into a dozen near-identical groups and call every
    // real hole "jitter".
    const payload = `${event.wire.dominant === null ? 'nothing' : event.wire.dominant} ${payloadBucket(event.wire.bytes)}`;
    const queue = event.queueMax === null ? 'queue unknown'
        : event.queueMax >= queueDeepAt ? 'queue deep' : 'queue low';
    const state = event.parked > 0 ? 'parked' : 'clear';
    // The transport term. A spike in which the host handed messages over and the
    // page received none is the signature of bytes that were sent and did not
    // arrive - a stalled link, a sleeping radio, a queue that never drained. A
    // spike in which the host sent nothing either is a different fault.
    const transport = event.lost > 0 ? '|frame lost'
        : (event.hostSent > 0 && event.wire.count === 0) ? '|sent but not received' : '';
    // The page's own contribution. A window the page spent most of blocked is
    // not evidence about the link at all: it could not receive or paint.
    const blocked = event.blocked.maxOverlapMs >= 100 ? `|page blocked ${Math.round(event.blocked.maxOverlapMs)}ms` : '';
    // The station's own idleness: the only thing that puts its radio to sleep.
    const quiet = event.client.longestSilenceMs !== null && event.client.longestSilenceMs >= 100
        ? `|client sent nothing for ${Math.round(event.client.longestSilenceMs)}ms` : '';
    return `${payload}|${queue}|${state}${transport}${blocked}${quiet}`;
}

function payloadBucket(bytes) {
    if (bytes === 0) return 'none';
    if (bytes < 4096) return 'small';
    if (bytes < 65536) return 'medium';
    return 'large';
}

function humanBytes(n) {
    if (n < 1024) return `${n}B`;
    if (n < 1024 * 1024) return `${Math.round(n / 1024)}kB`;
    return `${(n / 1048576).toFixed(1)}MB`;
}

/**
 * Puts the host's clock on the client's clock.
 *
 * A spike's wire make-up is logged by the page and its queue depth and host
 * share by the host, and the two are on different clocks. The offset is
 * estimated the way any clock sync does it - a round trip, with the host's own
 * reading of "now" taken in the middle - so the estimate carries half the round
 * trip as its error. `spreadMs` is how far the individual estimates are from the
 * median, which is what makes that error visible instead of implied: on a
 * one-millisecond LAN it is a millisecond or two, and if it is larger than the
 * window being described, the alignment is not good enough to use.
 */
export function clockAlign(samples, { now = null } = {}) {
    const offsets = [];
    for (const { t0, t1, hostNow } of samples) {
        if (!(t1 >= t0)) continue;
        offsets.push(hostNow - (t0 + t1) / 2);
    }
    if (!offsets.length) {
        return { offsetMs: null, spreadMs: null, samples: 0, rttMs: null, toClient: () => null };
    }
    const sorted = offsets.slice().sort((a, b) => a - b);
    const offsetMs = percentile(sorted, 0.5);
    const spreadMs = +Math.max(...offsets.map((o) => Math.abs(o - offsetMs))).toFixed(1);
    const rtts = samples.filter((s) => s.t1 >= s.t0).map((s) => s.t1 - s.t0);
    const rttMs = percentile(rtts.slice().sort((a, b) => a - b), 0.5);
    return {
        offsetMs: +offsetMs.toFixed(1),
        spreadMs,
        samples: offsets.length,
        rttMs,
        // host reading -> client reading
        toClient: (hostMs) => (hostMs === null || hostMs === undefined ? null : +(hostMs - offsetMs).toFixed(1)),
    };
}

/**
 * Whether the stimulus kept moving the picture for the whole measured window.
 *
 * A window in which the workload stopped is not a measurement of the streaming
 * path: the picture goes still, the gaps in the display timeline grow for a
 * reason that has nothing to do with the network, and the freezes counted there
 * never happened. The previous rule only compared the halves, so a window with
 * almost no changes at all passed it vacuously (5 changes, then none: the first
 * half was below the threshold that was meant to arm the comparison). Both
 * halves must show that the picture is still being driven, in the same units the
 * rest of the bench counts in.
 */
export function workloadGate({ firstHalf, secondHalf, windowMs = 0, minPerHalf = 30, minRatio = 0.25 }) {
    const rate = (n) => (windowMs > 0 ? +(n / (windowMs / 2000)).toFixed(1) : null);
    const detail = {
        firstHalf, secondHalf, minPerHalf, minRatio,
        firstHalfPerSecond: rate(firstHalf), secondHalfPerSecond: rate(secondHalf),
        ratio: firstHalf > 0 ? +(secondHalf / firstHalf).toFixed(2) : null,
    };
    if (firstHalf < minPerHalf || secondHalf < minPerHalf) {
        return { ...detail, ok: false,
                 reason: `the workload moved the picture too few times to measure ` +
                         `(${firstHalf} changes in the first half of the window, ${secondHalf} in the second, ` +
                         `each half needs ${minPerHalf})` };
    }
    if (secondHalf < firstHalf * minRatio) {
        return { ...detail, ok: false,
                 reason: `the workload stopped moving the picture ` +
                         `(${firstHalf} changes in the first half, ${secondHalf} in the second)` };
    }
    return { ...detail, ok: true, reason: 'ok' };
}

/**
 * Whether an action changed the picture in a way that idling does not.
 *
 * The bar is a declared floor (a fifth of the picture) raised, never lowered, by
 * a multiple of what idling did in this run. The floor is the part that makes
 * the verdict reproducible: this scene's water animation redraws part of the
 * picture on its own, and the largest idle change measured across the stored
 * runs was 14.4% of it, so a floor of 20% sits above anything idling has been
 * seen to do and below anything a camera move does (a zoom or a pan replaces
 * most of the view).
 *
 * The idle term uses the peak of the untouched window, which is what makes it
 * conservative: an unusually busy idle window raises the bar rather than
 * lowering it. Using the idle peak ALONE was the defect - with an idle peak of
 * 0.0 the bar fell to the floor and an action that changed 7% of the picture
 * (the "wait" key, which does nothing in the arena) read as live.
 */
export function magnitudeGate({ controlMagnitudes, actionMagnitudes, minRatio = 1.5, minMagnitude = 0.20 }) {
    const peak = actionMagnitudes.length ? Math.max(...actionMagnitudes) : 0;
    const idle = controlMagnitudes.length ? Math.max(...controlMagnitudes) : 0;
    const needed = Math.max(idle * minRatio, minMagnitude);
    const live = actionMagnitudes.length > 0 && peak >= needed;

    const percent = (v) => `${(v * 100).toFixed(1)}% of the picture`;
    const reason = live
        ? `live: changed ${percent(peak)} against ${percent(idle)} while untouched ` +
          `(bar ${percent(needed)})`
        : `dead: changed at most ${percent(peak)} against ${percent(idle)} while untouched ` +
          `(bar ${percent(needed)})`;

    return {
        live, peak: +peak.toFixed(4), idlePeak: +idle.toFixed(4),
        floor: minMagnitude, needed: +needed.toFixed(4),
        barSetBy: idle * minRatio > minMagnitude ? 'idle' : 'floor',
        reason,
    };
}

/**
 * Decides which of the answers waiting for a paint is the one that paint shows.
 *
 * A stamped frame is proof the host answered an input, but the paint that shows
 * the answer can happen a tick or two later - the client holds frames while it
 * waits for artwork. Dropping the stamp at the end of every tick therefore threw
 * away most of the answers; keeping them all forever would credit one paint to
 * every frame behind it. So they wait, and the newest one takes the credit,
 * because the picture on screen is the result of the last frame applied.
 */
export function attributePending(pending, { now, paintChanged, maxAgeMs = 1500 }) {
    const fresh = pending.filter((p) => now - p.sentAt <= maxAgeMs);
    if (!paintChanged || fresh.length === 0) return { sample: null, remaining: fresh };

    const newest = fresh[fresh.length - 1];
    return {
        // sentAt and shownAt are the window this sample measured. They are
        // carried rather than left implicit because the spike forensics has to
        // ask what was on the wire while this input waited, and that question
        // needs both ends of the wait.
        sample: { stamp: newest.stamp, sentAt: newest.sentAt, shownAt: now, ms: +(now - newest.sentAt).toFixed(1) },
        remaining: [],
    };
}

/**
 * How often the bench drives an input, from the environment.
 *
 * The rate is a run parameter, not part of what the bench measures: the client
 * transmits once per input, so this is the uplink's packet rate, and the
 * question "does the downlink tail depend on how often the station transmits"
 * cannot be asked at all with the rate compiled in. Unset keeps the value every
 * run so far used, so a run that does not ask for a rate measures what the
 * earlier ones measured.
 *
 * Anything that is not a positive number falls back rather than being coerced:
 * a zero or negative interval drives inputs in a tight loop and measures the
 * bench's own load, and a non-number would silently become zero.
 */
export function pressIntervalMs(raw, fallback = 25) {
    const value = Number(raw);
    return raw === undefined || raw === null || raw === '' || !Number.isFinite(value) || value <= 0
        ? fallback
        : value;
}

/**
 * Extra Chromium arguments for the bench's browser, from the environment.
 *
 * The bench launches the browser with --no-sandbox and nothing else, which on a
 * host with a GPU still renders through SwiftShader: headless Chromium does not
 * pick up a hardware driver unless it is told which GL implementation to use.
 * Which arguments are needed is a property of the machine (measured here, not
 * assumed: with `--use-angle=gl-egl` the WebGL renderer reports the Intel UHD
 * 630 through Mesa, and without it, SwiftShader), so they are passed in rather
 * than compiled in.
 */
export function extraChromeArgs(raw) {
    return String(raw ?? '').split(/\s+/).filter(Boolean);
}

/**
 * The launch arguments that ask this platform for hardware GL.
 *
 * Leaving the choice to the environment meant the default was "whatever
 * headless Chromium falls back to", and that fallback is SwiftShader - a
 * software rasteriser that blocks the page's main thread for 1-4 seconds at a
 * time. It does not make the measurements noisier, it makes them measurements of
 * the rasteriser: on the same Mac and the same Wi-Fi, p95 was 84-149 ms through
 * SwiftShader and 51-52 ms through Metal. Every run taken that way has to be
 * retaken, so the default is the hardware one and an explicit
 * BENCH_CHROME_ARGS still overrides it.
 *
 * Only the platforms whose answer has actually been measured get an argument. A
 * guess here would be indistinguishable from a working default, which is how
 * this went wrong the first time.
 */
export function defaultChromeArgs(platform) {
    switch (platform) {
        case 'darwin': return ['--use-angle=metal'];
        case 'linux': return ['--use-angle=gl-egl'];
        default: return [];
    }
}

/**
 * How many probe messages went missing, from three numbers.
 *
 * The controlled-load probe numbers every message it sends, and the channel is
 * ordered, so the arrivals are too. That makes the highest number seen, the
 * lowest and the count enough to say exactly how many are missing in between -
 * without keeping a set of every number, which at the rates the probe reaches
 * would be the measurement rather than of it, and without the page's wire log,
 * which is capped and drops its oldest entries.
 *
 * `beforeFirstSeen` is the count of numbers below the first one seen. Those were
 * sent before this page was listening, which is a different thing from lost, and
 * they are reported separately for exactly that reason.
 *
 * A duplicate or an out-of-order arrival breaks the arithmetic - the range and
 * the count no longer determine what is missing - and the answer is then `null`
 * rather than a number that looks like a measurement.
 */
export function probeArrivals({ count, min, max, reordered = 0 }) {
    if (!count || min === null || min === undefined || max === null || max === undefined) {
        return { expected: 0, arrived: 0, missing: null, beforeFirstSeen: 0 };
    }
    const expected = max - min + 1;
    if (reordered > 0 || count > expected) {
        return { expected, arrived: count, missing: null, beforeFirstSeen: min - 1 };
    }
    return { expected, arrived: count, missing: expected - count, beforeFirstSeen: min - 1 };
}

/**
 * Whether the renderer string the page reported is a real GPU.
 *
 * The counterpart to defaultChromeArgs: asking for hardware GL is not the same
 * as getting it, and a run that silently fell back would be reported with the
 * same confidence as one that did not.
 *
 * An ALLOWLIST, which is what the document claimed and what this was not: a
 * denylist accepts anything its author did not think of, and it had not been
 * told about lavapipe, softpipe, a bare `Mesa`, or arbitrary junk. The string
 * now has to name a GPU. `Mesa` is deliberately NOT a rejection token - the
 * hardware renderer on this project's Linux host reports itself through Mesa
 * ("ANGLE (Intel, Mesa Intel(R) UHD Graphics 630 (CFL GT2), OpenGL ES 3.2)"),
 * so rejecting it would reject the real GPU. A string that names Mesa and no
 * GPU ("Mesa/X.org", "lavapipe") is rejected, because it names no GPU.
 */
const SOFTWARE_GL = ['swiftshader', 'llvmpipe', 'softpipe', 'lavapipe', 'swangle',
                     'software rasterizer', 'software rasteriser', 'software adapter',
                     'microsoft basic render', 'warp', 'virgl', 'zink', 'mesa offscreen'];
const HARDWARE_GL = ['intel', 'nvidia', 'geforce', 'quadro', 'rtx', 'gtx', 'radeon', 'amd',
                     'apple m', 'apple gpu', 'adreno', 'mali', 'powervr', 'videocore',
                     'uhd graphics', 'hd graphics', 'iris', 'arc a', 'arc b', 'apple'];

export function isHardwareGL(renderer) {
    const s = String(renderer ?? '').toLowerCase().trim();
    if (!s || s === 'unknown') return false;
    if (SOFTWARE_GL.some((token) => s.includes(token))) return false;
    return HARDWARE_GL.some((token) => s.includes(token));
}

/**
 * The GL renderer the page is actually using, read from a probe context.
 *
 * The smart page already has a WebGL context and reports that one's renderer.
 * The raw page has none - it displays an `<img>` - so without this it reported
 * no renderer at all, and the runs kept as evidence carry no record of which GL
 * stack took them. The probe is a throwaway context created once, purely to
 * answer the question; it draws nothing and is released immediately.
 */
export function glRendererReport() {
    try {
        const canvas = document.createElement('canvas');
        const gl = canvas.getContext('webgl') || canvas.getContext('experimental-webgl');
        if (!gl) return null;
        const dbg = gl.getExtension('WEBGL_debug_renderer_info');
        const name = dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : null;
        const lose = gl.getExtension('WEBGL_lose_context');
        if (lose) lose.loseContext();
        return name || null;
    } catch {
        return null;
    }
}
