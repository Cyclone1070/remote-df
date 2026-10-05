// Pure frame-sequencing and loss-recovery state machine.
//
// Deliberately free of DOM, timers and wall-clock reads: every retry is driven
// by arriving frames rather than elapsed milliseconds, so the recovery cadence
// follows the stream rate instead of a hard-coded interval. All side effects
// are injected callbacks.

export class FrameSequencer {
    constructor({
        applyFullFrame,
        applyDelta,
        requestBridgingDelta,
        requestFullFrame,
        onGapRequest,
        onKeyframeRequest,
        onRecovered,
        gapRetryFrames = 4,
        keyframeRetryFrames = 15,
        maxPending = 30
    } = {}) {
        this.applyFullFrame = applyFullFrame || (() => {});
        this.applyDelta = applyDelta || (() => {});
        this.requestBridgingDelta = requestBridgingDelta || (() => {});
        this.requestFullFrame = requestFullFrame || (() => {});
        this.onGapRequest = onGapRequest || (() => {});
        this.onKeyframeRequest = onKeyframeRequest || (() => {});
        this.onRecovered = onRecovered || (() => {});
        this.gapRetryFrames = gapRetryFrames;
        this.keyframeRetryFrames = keyframeRetryFrames;
        this.maxPending = maxPending;
        this.reset();
    }

    reset() {
        this.lastSeq = 0;
        this.hasBaseline = false;
        this.awaitingBridge = false;
        this.awaitingKeyframe = false;
        this.gapFrames = 0;
        this.keyframeFrames = 0;
        this.pending = new Map();
    }

    get pendingSize() {
        return this.pending.size;
    }

    // Used by the debug loss simulator: drop the stream back by N frames so the
    // next arrival looks like a gap.
    rewind(frames) {
        this.lastSeq = Math.max(1, this.lastSeq - frames);
        this.pending.clear();
        this.awaitingBridge = false;
        this.awaitingKeyframe = false;
        this.gapFrames = 0;
    }

    onFrame(frame) {
        if (frame.type === 'full') {
            const wasRecovering = this.awaitingBridge || this.awaitingKeyframe;
            this.hasBaseline = true;
            this.awaitingBridge = false;
            this.awaitingKeyframe = false;
            this.gapFrames = 0;
            this.keyframeFrames = 0;
            this.lastSeq = frame.seq;
            this.pending.clear();
            this.applyFullFrame(frame.cmds);
            if (wasRecovering) this.onRecovered();
            return;
        }

        // Nothing to patch yet: a partial frame is meaningless without a scene
        // to patch. Ask for a whole frame (slower cadence than a gap retry -
        // this is a cold start, not a stream that just hiccupped).
        if (!this.hasBaseline) {
            if (!this.awaitingKeyframe || ++this.keyframeFrames >= this.keyframeRetryFrames) {
                this.awaitingKeyframe = true;
                this.keyframeFrames = 0;
                this.requestFullFrame();
                this.onKeyframeRequest(frame);
            }
            return;
        }

        if (frame.seq <= this.lastSeq) return;

        // A bridging delta is described against a frame we already hold, so it
        // can be applied even though frames in between were lost.
        const isBridge = frame.baseSeq !== undefined && frame.baseSeq <= this.lastSeq;

        if (isBridge) {
            this.awaitingBridge = false;
            this.awaitingKeyframe = false;
            this.gapFrames = 0;
            this.applyAt(frame);
            return;
        }

        if (frame.seq === this.lastSeq + 1 && !this.awaitingBridge && !this.awaitingKeyframe) {
            this.applyAt(frame);
            return;
        }

        // Gap: hold the frame and ask the host to re-describe the current frame
        // relative to the last one we actually hold.
        this.pending.set(frame.seq, frame);
        if (this.pending.size > this.maxPending) {
            this.pending.delete(Math.min(...this.pending.keys()));
        }

        if (!this.awaitingBridge || ++this.gapFrames >= this.gapRetryFrames) {
            this.awaitingBridge = true;
            this.gapFrames = 0;
            this.onGapRequest(this.lastSeq, frame);
            this.requestBridgingDelta(this.lastSeq);
        }
    }

    // Applies a frame, drops anything it supersedes, then replays whatever
    // buffered frames now sit contiguously on top of it.
    applyAt(frame) {
        this.lastSeq = frame.seq;
        this.applyDelta(frame.totalCmdCount, frame.updates);

        for (const seq of this.pending.keys()) {
            if (seq <= this.lastSeq) this.pending.delete(seq);
        }

        while (this.pending.has(this.lastSeq + 1)) {
            const next = this.pending.get(this.lastSeq + 1);
            this.pending.delete(this.lastSeq + 1);
            this.lastSeq = next.seq;
            this.applyDelta(next.totalCmdCount, next.updates);
        }
    }
}
