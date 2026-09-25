const test = require('node:test');
const assert = require('node:assert/strict');

// Model of Dwarf Fortress event loop from g_src/enabler.cpp:926-980
class SimulatedDFEnabler {
    constructor() {
        this.eventQueue = [];
        this.mouse_rbut = 0;
        this.mouse_lbut = 0;
        this.framesRendered = 0;
        this.rightClicksDetectedInFrames = 0;
    }

    pushEvent(ev) {
        this.eventQueue.push(ev);
    }

    pollEvent() {
        return this.eventQueue.shift() || null;
    }

    // Runs 1 DF frame tick (enabler.cpp)
    runFrameTick(interposer = null) {
        let ev;
        while ((ev = this.pollEvent()) !== null) {
            if (ev.type === 'MOUSEDOWN') {
                if (ev.button === 3) this.mouse_rbut = 1;
                if (ev.button === 1) this.mouse_lbut = 1;
            } else if (ev.type === 'MOUSEUP') {
                if (ev.button === 3) this.mouse_rbut = 0;
                if (ev.button === 1) this.mouse_lbut = 0;
            }
        }

        // DF game logic tick (interface.cpp:1489)
        if (this.mouse_rbut) {
            this.rightClicksDetectedInFrames++;
            this.mouse_rbut = 0; // DF consumes the click
        }

        this.framesRendered++;
        if (interposer && typeof interposer.onRenderPresent === 'function') {
            interposer.onRenderPresent(this);
        }
    }
}

// Interposer event synchronizer
class FrameSyncInputQueue {
    constructor(df) {
        this.df = df;
        this.pendingUp = new Map(); // btn -> ev
        this.hasActiveDown = new Map(); // btn -> bool
    }

    handleButtonDown(button, x = 0, y = 0) {
        this.hasActiveDown.set(button, true);
        this.df.pushEvent({ type: 'MOUSEDOWN', button, x, y });
    }

    handleButtonUp(button, x = 0, y = 0) {
        if (this.hasActiveDown.get(button)) {
            // Button was pressed this frame and DF hasn't presented frame yet. Defer UP.
            this.pendingUp.set(button, { type: 'MOUSEUP', button, x, y });
        } else {
            this.df.pushEvent({ type: 'MOUSEUP', button, x, y });
        }
    }

    onRenderPresent(df) {
        // Frame N has been presented and consumed by DF. Now flush deferred UPs for frame N+1.
        for (const [btn, ev] of this.pendingUp.entries()) {
            df.pushEvent(ev);
            this.hasActiveDown.set(btn, false);
        }
        this.pendingUp.clear();
    }
}

test('Replication: Rapid tap without frame sync drops right-click in DF event loop', () => {
    const df = new SimulatedDFEnabler();

    // Rapid tap arrives in same tick: DOWN followed immediately by UP
    df.pushEvent({ type: 'MOUSEDOWN', button: 3 });
    df.pushEvent({ type: 'MOUSEUP', button: 3 });

    // DF processes frame tick
    df.runFrameTick();

    // Without frame sync, DF's while(SDL_PollEvent) drained both, leaving mouse_rbut = 0
    assert.equal(df.rightClicksDetectedInFrames, 0, 'Unsynchronized rapid tap is dropped!');
});

test('Fix Verification: Frame-synchronized input queue guarantees 100% click delivery', () => {
    const df = new SimulatedDFEnabler();
    const queue = new FrameSyncInputQueue(df);

    // Rapid tap arrives via network
    queue.handleButtonDown(3);
    queue.handleButtonUp(3);

    // Frame 1 runs
    df.runFrameTick(queue);

    // DF detected right-click in frame 1!
    assert.equal(df.rightClicksDetectedInFrames, 1, 'Right click MUST be detected in frame 1');

    // Frame 2 runs (UP is popped)
    df.runFrameTick(queue);
    assert.equal(df.mouse_rbut, 0, 'Mouse right button released in frame 2');
    assert.equal(df.rightClicksDetectedInFrames, 1, 'No duplicate clicks');
});
