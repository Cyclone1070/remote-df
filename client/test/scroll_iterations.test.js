import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

// --- Shared Test Data / Scroll Patterns ---

// Pattern A: Single Physical Notch under Mac Mouse Fix
// Synthesized into 8 easing micro-events over 112ms summing to 54px
const SINGLE_NOTCH_EVENTS = [
    { deltaY: 5, timestamp: 0 },
    { deltaY: 7, timestamp: 16 },
    { deltaY: 8, timestamp: 32 },
    { deltaY: 9, timestamp: 48 },
    { deltaY: 8, timestamp: 64 },
    { deltaY: 7, timestamp: 80 },
    { deltaY: 6, timestamp: 96 },
    { deltaY: 4, timestamp: 112 },
];

// Pattern B: Rapid Double Notch (User intentionally flicks twice in 140ms)
// Notch 1: 0ms - 112ms
// Notch 2: 130ms - 242ms (starts 18ms after notch 1 finishes)
const RAPID_DOUBLE_NOTCH_EVENTS = [
    ...SINGLE_NOTCH_EVENTS,
    { deltaY: 5, timestamp: 130 },
    { deltaY: 7, timestamp: 146 },
    { deltaY: 8, timestamp: 162 },
    { deltaY: 9, timestamp: 178 },
    { deltaY: 8, timestamp: 194 },
    { deltaY: 7, timestamp: 210 },
    { deltaY: 6, timestamp: 226 },
    { deltaY: 4, timestamp: 242 },
];

// ============================================================================
// Iteration 1: Baseline Guacamole Accumulator (SCROLL_THRESHOLD = 53)
// ============================================================================
class Iteration1Baseline {
    constructor(onTick) {
        this.onTick = onTick;
        this.wheelAccumulator = 0;
        this.SCROLL_THRESHOLD = 53;
    }

    handleEvent(e) {
        this.wheelAccumulator += e.deltaY;
        if (Math.abs(this.wheelAccumulator) >= this.SCROLL_THRESHOLD) {
            this.onTick({ dir: 'down', timestamp: e.timestamp });
            this.wheelAccumulator = 0;
        }
    }
}

// ============================================================================
// Iteration 2: Eager Tick on Event 1 without budget deduction (Double-Scroll Bug)
// ============================================================================
class Iteration2EagerNoDeduction {
    constructor(onTick) {
        this.onTick = onTick;
        this.wheelAccumulator = 0;
        this.SCROLL_THRESHOLD = 53;
        this.lastTime = -999;
    }

    handleEvent(e) {
        const isNewGesture = (e.timestamp - this.lastTime > 80);
        this.lastTime = e.timestamp;

        if (isNewGesture) {
            // Eager tick fired immediately on event 1
            this.onTick({ dir: 'down', timestamp: e.timestamp, tag: 'eager' });
        }

        // Remaining stream continues accumulating without deducting the eager tick
        this.wheelAccumulator += e.deltaY;
        if (Math.abs(this.wheelAccumulator) >= this.SCROLL_THRESHOLD) {
            this.onTick({ dir: 'down', timestamp: e.timestamp, tag: 'accumulator' });
            this.wheelAccumulator = 0;
        }
    }
}

// ============================================================================
// Iteration 3: Lockout Timer (Multi-Scroll Lockout Bug)
// ============================================================================
class Iteration3LockoutTimer {
    constructor(onTick) {
        this.onTick = onTick;
        this.lockoutUntil = 0;
        this.LOCKOUT_MS = 200;
    }

    handleEvent(e) {
        if (e.timestamp < this.lockoutUntil) {
            // Drop event during lockout window
            return;
        }

        this.onTick({ dir: 'down', timestamp: e.timestamp });
        this.lockoutUntil = e.timestamp + this.LOCKOUT_MS;
    }
}

// ============================================================================
// Test Suite: Replicating Exact Results Across All 3 Iterations
// ============================================================================
describe('Scroll Iterations Reproduction Suite', () => {

    describe('Iteration 1: Baseline Guacamole Accumulator', () => {
        it('reproduces high initial latency (112ms delay on single notch)', () => {
            const ticks = [];
            const handler = new Iteration1Baseline(tick => ticks.push(tick));

            for (const event of SINGLE_NOTCH_EVENTS) {
                handler.handleEvent(event);
            }

            // Exactly 1 tick fired
            assert.equal(ticks.length, 1, 'Should fire 1 tick');
            // BUT fired on event 8 at t=112ms, NOT at t=0ms!
            assert.equal(ticks[0].timestamp, 112, 'Tick is delayed until tail arrives at 112ms');
        });
    });

    describe('Iteration 2: Eager Tick on Event 1 without budget deduction', () => {
        it('reproduces double-scroll bug on a single notch', () => {
            const ticks = [];
            const handler = new Iteration2EagerNoDeduction(tick => ticks.push(tick));

            for (const event of SINGLE_NOTCH_EVENTS) {
                handler.handleEvent(event);
            }

            // Fired TWICE for 1 physical notch!
            assert.equal(ticks.length, 2, 'Double scroll: 1 physical notch generated 2 ticks');
            // Tick 1 fired at 0ms, Tick 2 fired at 112ms
            assert.equal(ticks[0].timestamp, 0, 'Tick 1 fires immediately');
            assert.equal(ticks[1].timestamp, 112, 'Tick 2 fires 112ms later from tail');
        });
    });

    describe('Iteration 3: Lockout Timer', () => {
        it('reproduces multi-scroll lockout (rapid second notch is swallowed)', () => {
            const ticks = [];
            const handler = new Iteration3LockoutTimer(tick => ticks.push(tick));

            for (const event of RAPID_DOUBLE_NOTCH_EVENTS) {
                handler.handleEvent(event);
            }

            // Exactly 2 ticks were produced, but tick 2 was delayed from 130ms to 210ms!
            assert.equal(ticks.length, 2, 'Two ticks fired');
            assert.equal(ticks[0].timestamp, 0, 'Tick 1 fires immediately');
            // The initial events of notch 2 (at 130ms, 146ms, 162ms...) were locked out!
            // Tick 2 only registered when the tail leaked through at 210ms!
            assert.equal(ticks[1].timestamp, 210, 'Tick 2 delayed until 210ms due to lockout swallowing the impulse');

        });
    });
});
