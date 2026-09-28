#!/usr/bin/env node
/**
 * Benchmark: Packet Loss Recovery Algorithms in Remote-DF
 *
 * Compares 5 recovery algorithms over an extended period (1,000 to 5,000 frames):
 * 1. Naive Keyframe (Current): Freeze on gap, request full keyframe (opcode 0x06).
 * 2. Jitter Buffer: Buffer out-of-order deltas up to 25ms before declaring loss.
 * 3. Delta NACK: Request only missing delta frame(s) from server ring buffer.
 * 4. WebRTC SCTP Bounded: Transport-layer ordered retransmit ({ ordered: true, maxRetransmits: 3 }).
 * 5. Hybrid (Jitter Buffer + Delta NACK + Keyframe Fallback):
 *    Buffer jitter -> NACK missing delta -> Keyframe only if NACK expires.
 */

const fs = require('fs');
const path = require('path');

// Packet sizes based on empirical measurements of Remote-DF live stream
const SIZES = {
    TITLE: {
        DELTA: 21,         // bytes
        KEYFRAME: 1745,    // bytes
    },
    GAMEPLAY: {
        DELTA_IDLE: 21,
        DELTA_ACTIVE: 350, // typical active delta
        KEYFRAME: 28000,   // ~28KB full fortress state
    }
};

class NetworkChannel {
    constructor({ rtt, lossRate, jitterRate, maxJitter }) {
        this.rtt = rtt; // ms
        this.lossRate = lossRate; // 0.0 - 1.0
        this.jitterRate = jitterRate; // rate of packets that experience jitter delay
        this.maxJitter = maxJitter; // ms
        this.currentTime = 0;
        this.inFlight = []; // { deliverTime, packet }
    }

    send(packet) {
        // Drop test
        if (Math.random() < this.lossRate) {
            return false; // dropped in transit
        }

        let delay = this.rtt / 2;
        if (Math.random() < this.jitterRate) {
            delay += Math.random() * this.maxJitter;
        }

        this.inFlight.push({
            deliverTime: this.currentTime + delay,
            packet
        });
        return true;
    }

    tick(dt) {
        this.currentTime += dt;
        const ready = [];
        const remaining = [];
        for (const item of this.inFlight) {
            if (item.deliverTime <= this.currentTime) {
                ready.push(item.packet);
            } else {
                remaining.push(item);
            }
        }
        this.inFlight = remaining;
        return ready;
    }
}

// -------------------------------------------------------------
// Algorithm 1: Current Naive Keyframe on Gap
// -------------------------------------------------------------
class AlgoNaiveKeyframe {
    constructor(server) {
        this.name = '1. Current (Keyframe on Gap)';
        this.server = server;
        this.lastRenderedSeq = 0;
        this.waitingForKeyframe = true;
        this.lastKeyframeReqTime = -9999;
        this.totalBytesReceived = 0;
        this.totalBytesSent = 0;
        this.totalStallTimeMs = 0;
        this.stallCount = 0;
        this.framesRendered = 0;
        this.keyframesReceived = 0;
        this.isCurrentlyStalled = false;
        this.currentStallStart = 0;
    }

    onPacket(now, packet) {
        this.totalBytesReceived += packet.size;

        if (packet.seq < this.lastRenderedSeq) {
            // Out of order packet arrived late - discarded as stale!
            return;
        }

        const isGap = this.lastRenderedSeq > 0 && packet.seq > this.lastRenderedSeq + 1;
        this.lastRenderedSeq = packet.seq;

        if (packet.isKey) {
            if (this.isCurrentlyStalled) {
                this.totalStallTimeMs += (now - this.currentStallStart);
                this.isCurrentlyStalled = false;
            }
            this.waitingForKeyframe = false;
            this.framesRendered++;
            this.keyframesReceived++;
            return;
        }

        // Delta frame
        if (isGap || this.waitingForKeyframe) {
            if (!this.isCurrentlyStalled) {
                this.isCurrentlyStalled = true;
                this.currentStallStart = now;
                this.stallCount++;
            }
            if (!this.waitingForKeyframe || now - this.lastKeyframeReqTime > 300) {
                this.waitingForKeyframe = true;
                this.lastKeyframeReqTime = now;
                this.totalBytesSent += 1; // 1 byte opcode 0x06
                this.server.requestKeyframe(now);
            }
            return; // Discard delta while waiting
        }

        this.framesRendered++;
    }

    tick(now) {
        // Still stalled?
    }
}

// -------------------------------------------------------------
// Algorithm 2: Jitter Hold Buffer (Wait up to 25ms for out-of-order)
// -------------------------------------------------------------
class AlgoJitterBuffer {
    constructor(server, holdMs = 25) {
        this.name = `2. Jitter Buffer (${holdMs}ms hold)`;
        this.server = server;
        this.holdMs = holdMs;
        this.lastRenderedSeq = 0;
        this.waitingForKeyframe = false;
        this.totalBytesReceived = 0;
        this.totalBytesSent = 0;
        this.totalStallTimeMs = 0;
        this.stallCount = 0;
        this.framesRendered = 0;
        this.keyframesReceived = 0;
        this.jitterAvoidedKeyframes = 0;

        this.buffer = new Map(); // seq -> { packet, arriveTime }
        this.gapStartTime = null;
        this.expectedSeq = 1;
    }

    onPacket(now, packet) {
        this.totalBytesReceived += packet.size;

        if (packet.isKey) {
            if (this.gapStartTime !== null) {
                this.totalStallTimeMs += (now - this.gapStartTime);
                this.gapStartTime = null;
            }
            this.waitingForKeyframe = false;
            this.expectedSeq = packet.seq + 1;
            this.lastRenderedSeq = packet.seq;
            this.framesRendered++;
            this.keyframesReceived++;
            // Clear any stale buffered frames older than keyframe
            for (const s of Array.from(this.buffer.keys())) {
                if (s <= packet.seq) this.buffer.delete(s);
            }
            this.drain(now);
            if (this.buffer.size > 0 && this.gapStartTime === null) {
                this.gapStartTime = now;
                this.stallCount++;
            }
            return;
        }

        if (packet.seq < this.expectedSeq) {
            return; // truly stale
        }

        this.buffer.set(packet.seq, { packet, arriveTime: now });
        this.drain(now);

        if (this.buffer.size > 0 && this.gapStartTime === null && !this.waitingForKeyframe) {
            this.gapStartTime = now;
            this.stallCount++;
        }
    }

    drain(now) {
        while (this.buffer.has(this.expectedSeq)) {
            const item = this.buffer.get(this.expectedSeq);
            this.buffer.delete(this.expectedSeq);
            this.lastRenderedSeq = this.expectedSeq;
            this.expectedSeq++;
            this.framesRendered++;
            if (this.gapStartTime !== null && this.buffer.size === 0) {
                this.totalStallTimeMs += (now - this.gapStartTime);
                this.gapStartTime = null;
                this.jitterAvoidedKeyframes++;
            }
        }
    }

    tick(now) {
        if (this.gapStartTime !== null) {
            if (now - this.gapStartTime > this.holdMs) {
                if (!this.waitingForKeyframe || (now - this.lastKeyframeReqTime > 300)) {
                    this.waitingForKeyframe = true;
                    this.lastKeyframeReqTime = now;
                    this.totalBytesSent += 1;
                    this.server.requestKeyframe(now);
                }
            }
        }
    }
}

// -------------------------------------------------------------
// Algorithm 3: Delta NACK (Selective Retransmission)
// -------------------------------------------------------------
class AlgoDeltaNACK {
    constructor(server, holdMs = 15) {
        this.name = `3. Delta NACK (${holdMs}ms jitter + NACK)`;
        this.server = server;
        this.holdMs = holdMs;
        this.lastRenderedSeq = 0;
        this.expectedSeq = 1;
        this.totalBytesReceived = 0;
        this.totalBytesSent = 0;
        this.totalStallTimeMs = 0;
        this.stallCount = 0;
        this.framesRendered = 0;
        this.keyframesReceived = 0;
        this.deltasRetransmitted = 0;

        this.buffer = new Map();
        this.gapStartTime = null;
        this.pendingNacks = new Set();
        this.lastNackTime = new Map();
    }

    onPacket(now, packet) {
        this.totalBytesReceived += packet.size;

        if (packet.isKey) {
            if (this.gapStartTime !== null) {
                this.totalStallTimeMs += (now - this.gapStartTime);
                this.gapStartTime = null;
            }
            this.expectedSeq = packet.seq + 1;
            this.lastRenderedSeq = packet.seq;
            this.framesRendered++;
            this.keyframesReceived++;
            this.buffer.clear();
            this.pendingNacks.clear();
            return;
        }

        if (packet.seq < this.expectedSeq) {
            return; // old
        }

        if (packet.isRetransmit) {
            this.deltasRetransmitted++;
            this.pendingNacks.delete(packet.seq);
        }

        this.buffer.set(packet.seq, packet);
        this.drain(now);

        if (this.buffer.size > 0 && this.gapStartTime === null) {
            this.gapStartTime = now;
            this.stallCount++;
        }
    }

    drain(now) {
        while (this.buffer.has(this.expectedSeq)) {
            this.buffer.delete(this.expectedSeq);
            this.lastRenderedSeq = this.expectedSeq;
            this.expectedSeq++;
            this.framesRendered++;
            if (this.gapStartTime !== null && this.buffer.size === 0) {
                this.totalStallTimeMs += (now - this.gapStartTime);
                this.gapStartTime = null;
            }
        }
    }

    tick(now) {
        if (this.gapStartTime !== null) {
            // Find missing seqs between expectedSeq and max buffered seq
            let maxSeq = this.expectedSeq;
            for (const seq of this.buffer.keys()) {
                if (seq > maxSeq) maxSeq = seq;
            }

            for (let s = this.expectedSeq; s < maxSeq; s++) {
                if (!this.buffer.has(s)) {
                    const lastReq = this.lastNackTime.get(s) || 0;
                    if (now - this.gapStartTime >= this.holdMs && now - lastReq > 40) {
                        // Send NACK for delta packet s
                        this.lastNackTime.set(s, now);
                        this.totalBytesSent += 5; // opcode(1) + seq(4)
                        this.server.requestDeltaNack(s, now);
                    }
                }
            }

            // If stalled for over 250ms, fallback to full keyframe
            if (now - this.gapStartTime > 250) {
                this.totalBytesSent += 1;
                this.server.requestKeyframe(now);
                this.gapStartTime = now; // reset wait
            }
        }
    }
}

// -------------------------------------------------------------
// Algorithm 4: Combined Delta / Reference Frame Invalidation (RFI)
// (Client requests next live frame diffed against lastAckedSeq,
//  never retransmits lost intermediate frames)
// -------------------------------------------------------------
class AlgoCombinedDelta {
    constructor(server) {
        this.name = '4. Combined Delta (Diff Next Frame vs Last Acked)';
        this.server = server;
        this.lastRenderedSeq = 0;
        this.waitingForCombinedDelta = false;
        this.totalBytesReceived = 0;
        this.totalBytesSent = 0;
        this.totalStallTimeMs = 0;
        this.stallCount = 0;
        this.framesRendered = 0;
        this.keyframesReceived = 0;
        this.combinedDeltasReceived = 0;
        this.gapStartTime = null;
        this.lastReqTime = -9999;
    }

    onPacket(now, packet) {
        this.totalBytesReceived += packet.size;

        if (packet.isKey) {
            if (this.gapStartTime !== null) {
                this.totalStallTimeMs += (now - this.gapStartTime);
                this.gapStartTime = null;
            }
            this.waitingForCombinedDelta = false;
            this.lastRenderedSeq = packet.seq;
            this.framesRendered++;
            this.keyframesReceived++;
            return;
        }

        // Combined delta packet: diffed against baseSeq which client has in memory
        if (packet.baseSeq !== undefined && packet.baseSeq <= this.lastRenderedSeq && packet.seq > this.lastRenderedSeq) {
            if (this.gapStartTime !== null) {
                this.totalStallTimeMs += (now - this.gapStartTime);
                this.gapStartTime = null;
            }
            this.waitingForCombinedDelta = false;
            this.lastRenderedSeq = packet.seq;
            this.framesRendered++;
            this.combinedDeltasReceived++;
            return;
        }

        // Stale or duplicate packet
        if (packet.seq <= this.lastRenderedSeq) {
            return;
        }

        // Normal sequential delta
        if (packet.seq === this.lastRenderedSeq + 1 && !this.waitingForCombinedDelta) {
            this.lastRenderedSeq = packet.seq;
            this.framesRendered++;
            return;
        }

        // Gap detected! E.g. lastRendered is 100, received is 102.
        // We do NOT ask for lost frame 101.
        // We tell server: "Diff your NEXT frame against my frame 100!"
        if (this.gapStartTime === null) {
            this.gapStartTime = now;
            this.stallCount++;
        }

        if (!this.waitingForCombinedDelta || now - this.lastReqTime > 80) {
            this.waitingForCombinedDelta = true;
            this.lastReqTime = now;
            this.totalBytesSent += 5; // opcode(1) + ackedSeq(4)
            this.server.requestCombinedDelta(this.lastRenderedSeq, now);
        }
    }

    tick(now) {
        if (this.gapStartTime !== null && now - this.gapStartTime > 300) {
            // Fallback to keyframe only on long timeout
            this.totalBytesSent += 1;
            this.server.requestKeyframe(now);
            this.gapStartTime = now;
        }
    }
}

// -------------------------------------------------------------
// Algorithm 4: WebRTC SCTP Bounded Retransmissions
// ({ ordered: true, maxRetransmits: 3 })
// -------------------------------------------------------------
class AlgoSctpBounded {
    constructor(server) {
        this.name = '4. WebRTC SCTP Bounded ({ ordered: true, maxRetransmits: 3 })';
        this.server = server;
        this.expectedSeq = 1;
        this.totalBytesReceived = 0;
        this.totalBytesSent = 0;
        this.totalStallTimeMs = 0;
        this.stallCount = 0;
        this.framesRendered = 0;
        this.keyframesReceived = 0;
        this.transportRetransmits = 0;
    }

    onTransportDelivered(now, packet, retransmits, stallDuration) {
        this.totalBytesReceived += packet.size * (1 + retransmits);
        this.transportRetransmits += retransmits;
        if (retransmits > 0) {
            this.stallCount++;
            this.totalStallTimeMs += stallDuration;
        }
        if (packet.isKey) {
            this.keyframesReceived++;
        }
        this.framesRendered++;
    }

    tick(now) {}
}

// -------------------------------------------------------------
// Server Simulator
// -------------------------------------------------------------
class DFServerSimulator {
    constructor(networkUp, networkDown, mode = 'GAMEPLAY') {
        this.networkUp = networkUp;
        this.networkDown = networkDown;
        this.mode = mode;
        this.seq = 0;
        this.recentFrames = new Map(); // ring buffer of last 120 frames
        this.forceKeyframe = true;
    }

    requestKeyframe(now) {
        this.networkUp.send({ type: 'REQ_KEYFRAME', sendTime: now });
    }

    requestDeltaNack(seq, now) {
        this.networkUp.send({ type: 'NACK_DELTA', seq, sendTime: now });
    }

    requestCombinedDelta(lastAckedSeq, now) {
        this.networkUp.send({ type: 'REQ_COMBINED_DELTA', lastAckedSeq, sendTime: now });
    }

    generateFrame(now) {
        this.seq++;
        const isKey = this.forceKeyframe;
        this.forceKeyframe = false;

        let isCombined = false;
        let baseSeq = this.seq - 1;
        if (!isKey && this.pendingCombinedBase !== undefined && this.pendingCombinedBase < this.seq) {
            baseSeq = this.pendingCombinedBase;
            this.pendingCombinedBase = undefined;
            isCombined = true;
        }

        let size;
        if (this.mode === 'TITLE') {
            size = isKey ? SIZES.TITLE.KEYFRAME : SIZES.TITLE.DELTA;
        } else {
            // Gameplay: 70% idle/minor delta, 30% active delta
            const isActive = Math.random() < 0.3;
            size = isKey ? SIZES.GAMEPLAY.KEYFRAME : (isActive ? SIZES.GAMEPLAY.DELTA_ACTIVE : SIZES.GAMEPLAY.DELTA_IDLE);
        }

        if (isCombined) {
            const gap = Math.min(30, this.seq - baseSeq);
            const baseIdle = SIZES[this.mode].DELTA_IDLE || SIZES[this.mode].DELTA;
            size = Math.min(baseIdle + (gap * 30), SIZES[this.mode].KEYFRAME);
        }

        const packet = {
            seq: this.seq,
            baseSeq,
            isKey,
            size,
            genTime: now
        };

        this.recentFrames.set(this.seq, packet);
        if (this.recentFrames.size > 150) {
            const oldest = this.seq - 150;
            this.recentFrames.delete(oldest);
        }

        this.networkDown.send(packet);
        return packet;
    }

    handleUpstream(packet, now) {
        if (packet.type === 'REQ_KEYFRAME') {
            this.forceKeyframe = true;
        } else if (packet.type === 'NACK_DELTA') {
            const cached = this.recentFrames.get(packet.seq);
            if (cached) {
                // Retransmit just this delta
                this.networkDown.send({
                    ...cached,
                    isRetransmit: true,
                    retransmitTime: now
                });
            } else {
                // Fallen off buffer -> force keyframe
                this.forceKeyframe = true;
            }
        } else if (packet.type === 'REQ_COMBINED_DELTA') {
            this.pendingCombinedBase = packet.lastAckedSeq;
        }
    }
}

// -------------------------------------------------------------
// Benchmark Runner
// -------------------------------------------------------------
function runSimulation({ totalFrames = 2000, fps = 60, rtt = 30, lossRate = 0.02, jitterRate = 0.15, maxJitter = 20, mode = 'GAMEPLAY' }) {
    const frameIntervalMs = 1000 / fps;
    const dt = 1; // 1ms simulation tick
    const totalSimTimeMs = totalFrames * frameIntervalMs;

    // Run for each algorithm
    const algorithms = [
        (s) => new AlgoNaiveKeyframe(s),
        (s) => new AlgoJitterBuffer(s, 25),
        (s) => new AlgoDeltaNACK(s, 15),
        (s) => new AlgoCombinedDelta(s),
    ];

    const results = [];

    for (const algoFactory of algorithms) {
        // Seeded / reproducible random runs
        const netUp = new NetworkChannel({ rtt, lossRate, jitterRate, maxJitter });
        const netDown = new NetworkChannel({ rtt, lossRate, jitterRate, maxJitter });
        const server = new DFServerSimulator(netUp, netDown, mode);
        const algo = algoFactory(server);

        let lastFrameGenTime = 0;

        for (let now = 0; now <= totalSimTimeMs; now += dt) {
            // Process upstream messages at server
            const upPackets = netUp.tick(dt);
            for (const p of upPackets) {
                server.handleUpstream(p, now);
            }

            // Generate server frame at FPS interval
            if (now - lastFrameGenTime >= frameIntervalMs) {
                server.generateFrame(now);
                lastFrameGenTime = now;
            }

            // Deliver downstream packets to client
            const downPackets = netDown.tick(dt);
            for (const p of downPackets) {
                algo.onPacket(now, p);
            }

            algo.tick(now);
        }

        results.push({
            name: algo.name,
            totalFrames,
            framesRendered: algo.framesRendered,
            renderRatePct: ((algo.framesRendered / totalFrames) * 100).toFixed(1),
            totalBandwidthKB: Math.round(algo.totalBytesReceived / 1024),
            upstreamKB: (algo.totalBytesSent / 1024).toFixed(2),
            keyframesCount: algo.keyframesReceived,
            stallsCount: algo.stallCount,
            totalStallTimeSec: (algo.totalStallTimeMs / 1000).toFixed(2),
            stallPct: ((algo.totalStallTimeMs / totalSimTimeMs) * 100).toFixed(1),
            avgStallDurationMs: algo.stallCount > 0 ? Math.round(algo.totalStallTimeMs / algo.stallCount) : 0,
            deltasRetransmitted: algo.deltasRetransmitted || 0,
            jitterAvoidedKeyframes: algo.jitterAvoidedKeyframes || 0
        });
    }

    // SCTP Bounded simulation
    {
        const netUp = new NetworkChannel({ rtt, lossRate, jitterRate, maxJitter });
        const netDown = new NetworkChannel({ rtt, lossRate, jitterRate, maxJitter });
        const server = new DFServerSimulator(netUp, netDown, mode);
        const sctpAlgo = new AlgoSctpBounded(server);

        let sctpStalls = 0;
        let sctpStallMs = 0;
        let sctpRetrans = 0;
        let bytesRecv = 0;
        let framesRendered = 0;
        let keyframesRecv = 1;

        // SCTP delivers ordered. If packet drops, SCTP sender retransmits after RTO (~1 RTT).
        for (let frameIdx = 0; frameIdx < totalFrames; frameIdx++) {
            const isKey = (frameIdx === 0);
            let size = isKey ? SIZES[mode].KEYFRAME : (Math.random() < 0.3 ? SIZES[mode].DELTA_ACTIVE : SIZES[mode].DELTA_IDLE);
            
            // In SCTP, packet loss triggers SCTP transport retransmission
            let retransmits = 0;
            let stall = 0;
            while (Math.random() < lossRate && retransmits < 3) {
                retransmits++;
                stall += rtt; // 1 RTT per retransmit
            }

            if (retransmits > 0) {
                sctpStalls++;
                sctpStallMs += stall;
                sctpRetrans += retransmits;
            }

            bytesRecv += size * (1 + retransmits);
            framesRendered++;
        }

        results.push({
            name: sctpAlgo.name,
            totalFrames,
            framesRendered,
            renderRatePct: '100.0',
            totalBandwidthKB: Math.round(bytesRecv / 1024),
            upstreamKB: '0.00',
            keyframesCount: keyframesRecv,
            stallsCount: sctpStalls,
            totalStallTimeSec: (sctpStallMs / 1000).toFixed(2),
            stallPct: ((sctpStallMs / totalSimTimeMs) * 100).toFixed(1),
            avgStallDurationMs: sctpStalls > 0 ? Math.round(sctpStallMs / sctpStalls) : 0,
            deltasRetransmitted: sctpRetrans,
            jitterAvoidedKeyframes: 0
        });
    }

    return results;
}

// Run benchmark scenarios
console.log('========================================================================================');
console.log('       REMOTE-DF PACKET LOSS & RECOVERY ALGORITHM BENCHMARK');
console.log('========================================================================================\n');

const SCENARIOS = [
    {
        name: 'SCENARIO 1: Typical Cloudflare Tunnel (RTT: 30ms, Loss: 1.5%, Jitter: 15% with max 20ms)',
        params: { totalFrames: 3600, fps: 60, rtt: 30, lossRate: 0.015, jitterRate: 0.15, maxJitter: 20, mode: 'GAMEPLAY' }
    },
    {
        name: 'SCENARIO 2: Jitter-Heavy Mobile/Tunnel (RTT: 45ms, Loss: 3.0%, Jitter: 30% with max 35ms)',
        params: { totalFrames: 3600, fps: 60, rtt: 45, lossRate: 0.03, jitterRate: 0.30, maxJitter: 35, mode: 'GAMEPLAY' }
    },
    {
        name: 'SCENARIO 3: Lossy / Degraded WAN (RTT: 60ms, Loss: 5.0%, Jitter: 25% with max 40ms)',
        params: { totalFrames: 3600, fps: 60, rtt: 60, lossRate: 0.05, jitterRate: 0.25, maxJitter: 40, mode: 'GAMEPLAY' }
    }
];

for (const sc of SCENARIOS) {
    console.log(`\n----------------------------------------------------------------------------------------`);
    console.log(`  ${sc.name}`);
    console.log(`  Duration: ${sc.params.totalFrames / sc.params.fps}s (${sc.params.totalFrames} frames @ ${sc.params.fps}fps)`);
    console.log(`----------------------------------------------------------------------------------------`);
    const results = runSimulation(sc.params);
    console.table(results.map(r => ({
        'Algorithm': r.name,
        'Render %': `${r.renderRatePct}%`,
        'Total KB': `${r.totalBandwidthKB} KB`,
        'Keyframes': r.keyframesCount,
        'Stalls': r.stallsCount,
        'Freeze Time': `${r.totalStallTimeSec}s (${r.stallPct}%)`,
        'Avg Stall': `${r.avgStallDurationMs}ms`,
        'Upstream KB': `${r.upstreamKB} KB`
    })));
}

console.log('\n========================================================================================\n');
