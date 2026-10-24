import React, { useEffect, useRef, useState } from 'react';
import { DFRenderer } from '../core/renderer.js';
import { DFProtocol } from '../core/protocol.js';
import { attributePending, WireRecorder, inputLog } from '../core/measure.js';
import * as fzstd from 'fzstd';
import { DFInput } from '../core/input.js';
import { FrameSequencer } from '../core/frameSequencer.js';

export function GameCanvas({ onStatusChange, onMetricsUpdate, onTransportChange, isDebug, streamPort, onTerminate }) {
    const canvasRef = useRef(null);
    const [isWebRTCReady, setIsWebRTCReady] = useState(false);
    // True once a frame has actually been drawn. The channel opening is not
    // the picture arriving: between the two the overlay used to disappear
    // and leave a bare black canvas, so the user saw the spinner stop and
    // then nothing for as long as the pictures took to arrive. Waiting for
    // a drawn frame means the screen goes from spinner to game.
    const [hasDrawn, setHasDrawn] = useState(false);

    useEffect(() => {
        const canvas = canvasRef.current;
        if (!canvas) return;

        const initW = Math.max(912, Math.floor(window.innerWidth));
        const initH = Math.max(552, Math.floor(window.innerHeight));
        canvas.width = initW;
        canvas.height = initH;

        const renderer = new DFRenderer(canvas);
        window.renderer = renderer;

        // The bench's view of this page. Everything the bench reports is read
        // from here, so there is exactly one definition of each number.
        //
        //   display  - when the picture on the canvas became a different picture.
        //              A redraw that resolves to the same instances is not in it,
        //              which is the point: an artwork arrival the client already
        //              holds changes nothing on screen and used to be counted as
        //              a frame, hiding exactly the stalls this is for.
        //   inputSent - every input this page sent, in order, with the stamp it
        //              carried, so a latency sample is tied to its own input
        //              instead of to a position in a list that one unanswered
        //              key press shifts - and so the uplink can be paired from
        //              the whole window rather than from its last 255 sends.
        //   latency  - input sent -> the paint that showed the answer.
        const bench = {
            path: 'smart',
            startedAt: performance.now(),
            display: [],
            changeMagnitude: [],
            // The ordered log of the inputs this page sent, with the stamp
            // lookup built from the same records. A Map keyed by the stamp alone
            // cannot hold more inputs than the stamp space - a 20 s window sends
            // 366-392 of them, so two thirds of the window was overwritten in the
            // map before the bench could read it. See measure.js's inputLog.
            inputSent: inputLog(),
            latency: [],
            missing: [],
            bytesIn: { frames: 0, textures: 0 },
            // The controlled-load probe's arrival counters. See probeArrivals.
            probe: { count: 0, min: null, max: null, last: null, reordered: 0 },
            webgl: renderer.isWebGL,
            glRenderer: renderer.glRenderer,
            stampedFrames: 0,
            paints: 0,
            paintsUnchanged: 0,
            // Coverage. inputsSent is what this page asked the host to answer;
            // stampFramesSeen is how many of those answers came back carrying a
            // stamp at all. The host counts its own answers separately and the
            // two numbers are printed side by side, never one as the other: a
            // stamp is lost with its frame (the stream channel does not
            // retransmit) and an input can be overwritten in the host's single
            // stamp slot before any frame claims it.
            inputsSent: 0,
            stampFramesSeen: 0,
            stampsUnknown: 0,
        };
        // Every message that comes off the wire, of every kind, with its size.
        // Not just frames: pictures are ~99% of the bytes on this
        // link, and a log that leaves them out reports an artwork burst as
        // silence. See measure.js's WireRecorder.
        const wire = new WireRecorder();
        bench.wire = wire;
        // The page's own main thread. A blocked page cannot receive a message or
        // paint one, so a display gap during a block is not evidence about the
        // link - and without this the two are indistinguishable from here.
        bench.longTasks = [];
        try {
            new PerformanceObserver((list) => {
                for (const entry of list.getEntries()) {
                    bench.longTasks.push([+entry.startTime.toFixed(1), +entry.duration.toFixed(1)]);
                }
            }).observe({ type: 'longtask', buffered: true });
        } catch (e) { /* not exposed here; the bench reports the gap as unattributed */ }
        // The connection's own statistics. Without them a delay seen inside the
        // message handler cannot be told apart from a delay on the wire: the
        // timestamp is taken after dispatching, so it includes both. These counters
        // are measured by the transport itself.
        bench.transport = async () => {
            if (!pc || !pc.getStats) return null;
            const out = { inbound: {}, pair: {}, channel: {} };
            const stats = await pc.getStats();
            stats.forEach((r) => {
                if (r.type === 'candidate-pair' && (r.nominated || r.selected)) {
                    out.pair = { rtt: r.currentRoundTripTime, jitter: r.jitter, inFlight: r.bytesInFlight, available: r.availableOutgoingBitrate };
                }
                if (r.type === 'data-channel') { out.channel[r.label] = { messages: r.messagesReceived, bytes: r.bytesReceived }; }
                if (r.type === 'inbound-rtp') { out.inbound = { jitter: r.jitter, packetsLost: r.packetsLost }; }
            });
            return out;
        };
        window.__dfBench = bench;

        let lastMissingLogged = -1;
        function noteMissing(n) {
            if (n !== lastMissingLogged) {
                lastMissingLogged = n;
                bench.missing.push([performance.now(), n]);
            }
        }

        let ws = null;
        let pc = null;
        let dc = null;
        let inputDc = null;
        let assetDc = null;
        // Pictures waiting to be turned into textures. Bounded by the transport,
        // not by this queue: the sender is back-pressured by the channel, and a
        // queue here only reorders work that has already arrived.
        const assetQueue = [];
        // How long one frame may spend ingesting pictures. Small enough that the
        // loop keeps its cadence, large enough that a steady trickle clears in
        // one pass instead of being spread across frames.
        const ASSET_INGEST_BUDGET_MS = 4;
        let holdStartedAt = 0;
        let holdMaxMissing = 0;
        let drawnOnce = false;
        const markDrawn = () => {
            if (drawnOnce) return;
            drawnOnce = true;
            setHasDrawn(true);
        };
        let input = null;
        let isDestroyed = false;

        // Frame sequencing + loss recovery. Retries are driven by arriving
        // frames rather than a wall clock, so the cadence follows the stream
        // rate instead of a fixed interval. See core/frameSequencer.js.
        // ── trace ────────────────────────────────────────────────────────────
        // Every decision and every arrival, timestamped, into one array that can
        // be dumped after the fact. Aggregates say a stream was slow; a trace
        // says which frame was held, behind which gap, and for how long.
        const trace = (window.__trace = window.__trace || []);
        let deltaStatN = 0, deltaStatEmpty = 0, deltaStatCarry = 0;
        // The trace has to be switchable from outside: the only way to know what it
        // costs is to run the same interaction with it on and off, and a cost nobody
        // measured is a cost nobody can defend.
        let traceOn = new URLSearchParams(window.location.search).get('trace') !== '0';
        window.__setTrace = (on) => { traceOn = on; };
        const T = (kind, data) => { if (traceOn && trace.length < 200000) trace.push([performance.now(), kind, data || 0]); };

        // An atlas reset throws away every picture the client holds while the host
        // still believes it holds them, so the host will skip resending them. This
        // is the moment that disagreement begins, so it goes in the log with the
        // number of pictures invalidated.
        renderer.onAtlasReset = (generation, cleared) => {
            T('atlas-reset', { generation, cleared });
        };

        // A picture that has been decoded and uploaded is the only kind a frame can
        // actually draw. Recorded so "the host sent it" can be told from "the client
        // can use it" without guessing.
        renderer.onPictureUploaded = (id, w, h) => {
            T('pic-upload', { id, w, h });
        };

        renderer.onDeltaStat = (d) => { deltaStatN++; if (!d.changed) deltaStatEmpty++; deltaStatCarry += d.updates; };
        const sequencer = new FrameSequencer({
            applyFullFrame: cmds => {
                bench.lastFrameAt = performance.now();
                if (bench.frameArrivedAt) {
                    bench.arrivalToApply = bench.arrivalToApply || [];
                    bench.arrivalToApply.push(+(bench.lastFrameAt - bench.frameArrivedAt).toFixed(1));
                    if (bench.arrivalToApply.length > 4000) bench.arrivalToApply.shift();
                }
                bench.framesApplied = (bench.framesApplied || 0) + 1;
                renderer.applyFullFrame(cmds);
                syncAssets();
                if (renderer.missingTextureIds().size === 0) markDrawn();
                window.__dfFrameCount = (window.__dfFrameCount || 0) + 1;
            },
            applyDelta: (totalCmdCount, updates) => {
                bench.lastFrameAt = performance.now();
                if (bench.frameArrivedAt) {
                    bench.arrivalToApply = bench.arrivalToApply || [];
                    bench.arrivalToApply.push(+(bench.lastFrameAt - bench.frameArrivedAt).toFixed(1));
                    if (bench.arrivalToApply.length > 4000) bench.arrivalToApply.shift();
                }
                bench.framesApplied = (bench.framesApplied || 0) + 1;
                renderer.applyDelta(totalCmdCount, updates);
                syncAssets();
                if (renderer.missingTextureIds().size === 0) markDrawn();
                window.__dfFrameCount = (window.__dfFrameCount || 0) + 1;
            },
            onEvent: T,
            // The client's half of the gap repair. The host logs when a GAP_ACK
            // arrives; without this the log could not say whether a repair was never
            // asked for or never answered.
            requestBridgingDelta: lastSeq => {
                // lastSeq is the last frame this client holds; the frames it does not
                // hold come before the one that arrived out of order and are named in
                // the bridge-request record beside this one.
                T('gap-request', { lastSeq });
                sendInputBuffer(DFProtocol.encodeGapAck(lastSeq));
            },
            requestFullFrame: () => sendInputBuffer(DFProtocol.encodeKeyframeRequest()),
            onGapRequest: (lastSeq, frame) => {
                if (isDebug) {
                    console.log(`[WebRTC Recovery] Frame gap detected (seq: ${frame.seq}, lastRendered: ${lastSeq}). Requesting combined delta (opcode 0x07)...`);
                }
            },
            onKeyframeRequest: () => {
                if (isDebug) {
                    console.log('[WebRTC Recovery] No baseline keyframe. Requesting initial keyframe (opcode 0x06)...');
                }
            },
            onRecovered: () => {
                if (isDebug) {
                    console.log('[WebRTC Recovery] Full keyframe received! Stream recovered successfully.');
                }
            }
        });
        window.__dfSequencer = sequencer;

        // Asset gating.
        //
        // A frame is not displayable until every texture it references has
        // arrived. When one is missing we hold the last good frame on screen
        // and tell the host which assets we already hold, so it resends only
        // what is genuinely missing. The draw loops used to skip absent
        // textures silently, which is how one lost asset became black tiles
        // and a missing wordmark instead of a visibly held frame.
        let assetBridgeKey = '';
        let assetBridgeAt = 0;
        // Re-asking for the same absent assets on every arriving frame would be
        // pure amplification: a texture that did not arrive either gets dropped
        // again or was never sendable in the first place.
        const ASSET_BRIDGE_BACKOFF_MS = 1500;
        const ASSET_BRIDGE_MAX_TRIES = 3;

        // Some textures can never arrive: one whose RGBA exceeds the
        // DataChannel message size limit is rejected every time it is offered.
        // Holding the frame on those forever bricks the display, so an asset
        // that has survived this many attempts is marked unfetchable and stops
        // gating. Until chunking lands, that degrades to the old draw-with-holes
        // behaviour for those ids only - strictly better than never rendering.
        const assetTries = new Map();
        const unfetchable = new Set();
        let assetGeneration = -1;
        // Set whenever a picture lands. Used to tell "this one is unsendable"
        // apart from "the stream is still working through a backlog".
        let pictureArrivedSinceRequest = false;

        let msgCostMs = 0;
        let msgCostN = 0;

        function syncAssets() {
            const syncT0 = performance.now();
            try { syncAssetsInner(); } finally {
                // Accumulated, not thresholded. A cost small enough to pass a
                // threshold is still a cost when it runs once per frame, and
                // reporting only the outliers is how a per-frame cost hides.
                syncTotalMs += performance.now() - syncT0;
                syncCalls++;
            }
        }

        function syncAssetsInner() {
            // A reclaimed atlas means the textures we gave up on are no longer
            // hopeless - there is simply an empty atlas to put them in now.
            // Forget the earlier verdict, or those ids would stay black forever.
            if (renderer.atlasGeneration !== assetGeneration) {
                if (assetGeneration !== -1) {
                    assetTries.clear();
                    unfetchable.clear();
                    assetBridgeKey = '';
                    assetBridgeAt = 0;
                }
                assetGeneration = renderer.atlasGeneration;
            }

            const allMissing = renderer.missingTextureIds();
            const missing = new Set();
            for (const id of allMissing) {
                if (!unfetchable.has(id)) missing.add(id);
            }

            renderer.assetsReady = missing.size === 0;
            window.__dfAssetsMissing = allMissing.size;
            window.__dfAssetsUnfetchable = unfetchable.size;
            noteMissing(missing.size);
            if (missing.size === 0) {
                assetBridgeKey = '';
                if (isDebug && assetBridgeAt !== 0) {
                    assetBridgeAt = 0;
                    console.log('[Assets] Frame displayable - resuming');
                }
                return;
            }

            const key = Array.from(missing).sort((a, b) => a - b).join(',');
            const now = performance.now();
            if (key === assetBridgeKey && now - assetBridgeAt < ASSET_BRIDGE_BACKOFF_MS) return;
            assetBridgeKey = key;
            assetBridgeAt = now;

            // A picture arriving proves the pipeline works, so nothing should be
            // written off while it is still delivering. The three tries were
            // counted against a fixed clock, so a client catching up on a few
            // hundred pictures exhausted them purely because the stream was
            // slow, then left permanent holes in the display. Only a picture
            // that stops making progress while nothing else arrives is genuinely
            // unsendable.
            if (pictureArrivedSinceRequest) {
                assetTries.clear();
                pictureArrivedSinceRequest = false;
            }

            const exhausted = [];
            for (const id of missing) {
                const tries = (assetTries.get(id) || 0) + 1;
                assetTries.set(id, tries);
                if (tries >= ASSET_BRIDGE_MAX_TRIES) {
                    unfetchable.add(id);
                    exhausted.push(id);
                }
            }
            if (exhausted.length > 0) {
                // Diagnostic: how far each abandoned picture actually got. Tells
                // "no chunks ever arrived" apart from "it was arriving and then
                // stalled", which point at completely different causes.
                const progress = exhausted.map((id) => {
                    const p = pendingTextures.get(id);
                    return `${id}:${p ? p.chunks.size + '/' + p.chunkCount : 'none'}`;
                }).join(' ');
                console.warn(`[Assets] progress at give-up: ${progress}`);
                console.warn(
                    `[Assets] Giving up on ${exhausted.length} texture(s) after ${ASSET_BRIDGE_MAX_TRIES} attempts: ` +
                    `${exhausted.join(',')}. These are unsendable - display continues without them.`
                );
                // Re-evaluate immediately: this pass may have just unfrozen the frame.
                syncAssets();
                return;
            }

            const seq = sequencer.lastSeq;
            // Send the missing ids themselves, not the held set: the host then
            // resends exactly these, with no frame lookup that could disagree.
            const askedChunks = missingChunksFor(missing);
            sendInputBuffer(DFProtocol.encodeAssetBridgeRequest(seq, missing, askedChunks));
            // The request as sent, with every id in it. A truncated list here is how
            // "which picture was missing" turns back into a guess.
            T('bridge-send', {
                seq,
                n: missing.size,
                ids: [...missing],
                chunks: askedChunks ? [...askedChunks] : [],
            });
            if (isDebug) {
                console.log(`[Assets] Holding frame ${seq}: ${missing.size} texture(s) missing [${key}], requesting bridge (opcode 0x08)`);
            }
        }

        // One call, one instant, one answer. The load gate used to subtract a
        // give-up count collected at one time from a missing count collected at
        // another, which can go negative and pass the gate on a client that is
        // missing everything - a gate that cannot fail is not a gate.
        window.__dfBenchSnapshot = () => {
            const allMissing = renderer.missingTextureIds();
            let obtainable = 0;
            for (const id of allMissing) {
                if (!unfetchable.has(id)) obtainable++;
            }
            const t = performance.now();
            return {
                t,
                missingTotal: allMissing.size,
                obtainable,
                displayEvents: bench.display.length,
                webgl: renderer.isWebGL,
                glRenderer: renderer.glRenderer,
                seq: sequencer.lastSeq,
            };
        };

        // Rotating 1-byte debug stamp (1..255) for physical M2P latency
        let currentDebugStamp = 0;
        const pendingStamps = new Map();
        const pendingRenderStamps = [];
        const m2pSamples = [];
        window.__m2pSamples = m2pSamples;

        // Frames that answered an input and have been applied but not yet shown.
        // Cleared by the next paint rather than by the next frame: a frame the
        // client is holding for missing artwork has not been seen yet, and the
        // wait for that artwork is part of what the input cost the player.
        const benchPendingStamps = [];
        // A stamp older than this answers a question nobody asked any more. It
        // is not attributed, so a lost frame cannot be reported as a very slow
        // one.
        const BENCH_STAMP_MAX_AGE_MS = 1500;

        function getNextDebugStamp() {
            if (!isDebug && !window.__enableM2P) return 0;
            currentDebugStamp = (currentDebugStamp % 255) + 1;
            const at = performance.now();
            bench.inputsSent++;
            pendingStamps.set(currentDebugStamp, at);
            bench.inputSent.record(currentDebugStamp, at);
            if (pendingStamps.size > 100) {
                const oldestKey = pendingStamps.keys().next().value;
                pendingStamps.delete(oldestKey);
            }
            return currentDebugStamp;
        }

        // Telemetry
        let streamFrameCount = 0;
        let renderFrameCount = 0;
        let bytesReceived = 0;
        let lastMetricTime = performance.now();

        function updateMetrics() {
            if (!isDebug) return;
            const now = performance.now();
            const elapsed = (now - lastMetricTime) / 1000;
            if (elapsed >= 0.5) {
                const streamFps = Math.round(streamFrameCount / elapsed);
                const renderFps = Math.round(renderFrameCount / elapsed);
                const kbps = Math.round((bytesReceived * 8) / elapsed / 1000);
                
                let m2pStr = '--';
                if (m2pSamples.length > 0) {
                    const cur = m2pSamples[m2pSamples.length - 1];
                    const avg = m2pSamples.reduce((a, b) => a + b, 0) / m2pSamples.length;
                    const sorted = [...m2pSamples].sort((a, b) => a - b);
                    const p95 = sorted[Math.floor(sorted.length * 0.95)] || cur;
                    m2pStr = `${cur.toFixed(1)}ms (avg: ${avg.toFixed(1)}ms, p95: ${p95.toFixed(1)}ms)`;
                } else {
                    m2pStr = 'waiting...';
                }

                if (onMetricsUpdate) {
                    onMetricsUpdate({
                        streamFps,
                        renderFps,
                        bandwidth: kbps,
                        sprites: renderer.lastSprites || 0,
                        drawCalls: renderer.lastDrawCalls || 0,
                        m2p: m2pStr,
                    });
                }

                streamFrameCount = 0;
                renderFrameCount = 0;
                bytesReceived = 0;
                lastMetricTime = now;
            }
        }

        let animationFrameId = null;
        let lastLoopAt = 0;
        let pendingInputMs = 0;
        let syncTotalMs = 0;
        let syncCalls = 0;
        let cmdsSeen = 0;
        function renderLoop() {
            if (isDestroyed) return;

            if (isDebug) renderFrameCount++;

            // Pictures first, so a frame that is waiting on one can be drawn in
            // this same frame rather than the next - but only for as long as the
            // budget allows. Whatever is left waits; nothing is lost, because a
            // picture is only ever held until it has been ingested once.
            if (assetQueue.length > 0) {
                const until = performance.now() + ASSET_INGEST_BUDGET_MS;
                while (assetQueue.length > 0 && performance.now() < until) {
                    ingestTextureChunk(assetQueue.shift());
                }
                syncAssets();
            }

            // Holding a frame is measured as an EPISODE, not as a count of loop
            // turns. Logging it every iteration made the number track the frame
            // rate rather than the stall: the same client reported 3,397 holds at
            // 900 loops a second and 28 at 22, which says nothing about how long a
            // picture was actually withheld. What matters is when the wait began,
            // how long it lasted and how much was missing at its worst.
            if (!renderer.assetsReady && renderer.dirty) {
                if (!holdStartedAt) {
                    const miss = renderer.missingTextureIds();
                    holdStartedAt = performance.now();
                    holdMaxMissing = miss.size;
                    // The ids, not just the count: a hold saying "315 missing" cannot
                    // be joined to the host's log, so it cannot say whether the host
                    // refused to send them or never had them.
                    T('hold-start', { missing: miss.size, ids: [...miss] });
                } else {
                    const n = renderer.missingTextureIds().size;
                    if (n > holdMaxMissing) holdMaxMissing = n;
                }
            } else if (holdStartedAt) {
                T('hold-end', { ms: Math.round(performance.now() - holdStartedAt), maxMissing: holdMaxMissing });
                holdStartedAt = 0;
                holdMaxMissing = 0;
            }
            // How long the paint itself takes, and how long the loop took to come
            // round again. A slow paint and a throttled loop produce the same
            // stutter and need opposite fixes, so both are recorded.
            const loopAt = performance.now();
            if (pendingInputMs > 20) T('input-cost', { ms: Math.round(pendingInputMs) });
            pendingInputMs = 0;
            if (deltaStatN > 0) {
                T('delta-stat', { n: deltaStatN, changedNothing: deltaStatEmpty, updates: deltaStatCarry });
                deltaStatN = 0; deltaStatEmpty = 0; deltaStatCarry = 0;
            }
            if (syncTotalMs > 0) {
                T('sync-total', { ms: Math.round(syncTotalMs), calls: syncCalls, cmds: renderer.commands ? renderer.commands.length : -1 });
                syncTotalMs = 0; syncCalls = 0;
            }
            if (msgCostN > 0) {
                T('msg-cost', { ms: Math.round(msgCostMs), n: msgCostN });
                msgCostMs = 0; msgCostN = 0;
            }
            if (lastLoopAt) T('loop-gap', { ms: loopAt - lastLoopAt });
            lastLoopAt = loopAt;
            const paintT0 = performance.now();
            const didRender = renderer.render();
            const paintMs = performance.now() - paintT0;
            if (paintMs > 10) T('paint-cost', { ms: Math.round(paintMs), drew: didRender });
            if (didRender) T('draw', { seq: sequencer.lastSeq });

            if (didRender) {
                bench.paints++;
                const now = performance.now();
                // Counted only when the canvas now shows something it did not
                // show before. This is the frame the player saw change.
                if (renderer.paintChanged) {
                    bench.display.push(now);
                    // How long the client held the newest frame before showing it.
                    // This is the client's own share of latency: the interval
                    // between a frame being applied and the pixels changing. If it
                    // grows while the bytes fall, the cost is reconstruction, not
                    // transport - which is exactly the question a lower payload but
                    // higher latency raises.
                    if (bench.lastFrameAt) {
                        bench.frameToDraw = bench.frameToDraw || [];
                        bench.frameToDraw.push(+(now - bench.lastFrameAt).toFixed(1));
                        if (bench.frameToDraw.length > 4000) bench.frameToDraw.shift();
                    }
                    // How much of the picture changed, for telling a response
                    // apart from the animation the game does by itself.
                    bench.changeMagnitude.push(renderer.paintMagnitude);
                } else {
                    bench.paintsUnchanged++;
                }

                {
                    const { sample, remaining } = attributePending(benchPendingStamps, {
                        now,
                        paintChanged: renderer.paintChanged,
                        maxAgeMs: BENCH_STAMP_MAX_AGE_MS,
                    });
                    benchPendingStamps.length = 0;
                    for (let i = 0; i < remaining.length; i++) benchPendingStamps.push(remaining[i]);
                    if (sample) bench.latency.push(sample);
                }

                if ((isDebug || window.__enableM2P) && pendingRenderStamps.length > 0) {
                    for (let i = 0; i < pendingRenderStamps.length; i++) {
                        const stamp = pendingRenderStamps[i];
                        const sentTime = pendingStamps.get(stamp);
                        if (sentTime !== undefined) {
                            const m2p = now - sentTime;
                            m2pSamples.push(m2p);
                            if (!window.__m2pHistory) window.__m2pHistory = [];
                            window.__m2pHistory.push(m2p);
                            if (m2pSamples.length > 30) m2pSamples.shift();
                            for (const [s, t] of pendingStamps.entries()) {
                                if (t <= sentTime) pendingStamps.delete(s);
                            }
                        }
                    }
                    pendingRenderStamps.length = 0;
                }

                if (window.__DF_RECORD_FRAMES && window.__saveFrame) {
                    window.__saveFrame(window.__dfFrameCount, canvas.toDataURL('image/png'));
                }
            }

            if (isDebug) {
                updateMetrics();
            }

            // How much of the turn was spent working, as opposed to waiting for
            // the browser to call back. The gap alone cannot tell the two apart,
            // and one means our code is slow while the other means the loop is
            // never getting a turn.
            T('loop-cost', { ms: Math.round(performance.now() - loopAt), drew: didRender });
            animationFrameId = requestAnimationFrame(renderLoop);
        }
        animationFrameId = requestAnimationFrame(renderLoop);

        function handleResize(force = false) {
            try {
                const w = window.innerWidth;
                const h = window.innerHeight;
                const targetW = Math.max(912, Math.floor(w));
                const targetH = Math.max(552, Math.floor(h));
                const needResize = force || canvas.width !== targetW || canvas.height !== targetH;
                if (needResize) {
                    renderer.resize(targetW, targetH);
                }
                const resizePacket = DFProtocol.encodeResize(targetW, targetH);
                sendInputBuffer(resizePacket);
            } catch (e) {
                console.error('[HANDLE_RESIZE ERROR]', e);
            }
        }

        let resizeTimeout = null;
        const onWindowResize = () => {
            clearTimeout(resizeTimeout);
            resizeTimeout = setTimeout(() => handleResize(false), 100);
        };
        window.addEventListener('resize', onWindowResize);

        // The browser's own view of the connection, once a second. The host can say
        // what it handed over; only this can say what arrived. A stall where the
        // host's queue is empty and these counters stop is a lost-packet stall; a
        // stall where the host's queue grows is the browser refusing delivery.
        let netSampler = null;
        function startNetSampler() {
            if (netSampler) return;
            let lastRecv = 0;
            netSampler = setInterval(async () => {
                if (!pc || pc.connectionState === 'closed') return;
                try {
                    const report = await pc.getStats();
                    let recvMsgs = 0, sentMsgs = 0, bytes = 0;
                    report.forEach((r) => {
                        if (r.type === 'data-channel') {
                            recvMsgs += r.messagesReceived || 0;
                            sentMsgs += r.messagesSent || 0;
                            bytes += r.bytesReceived || 0;
                        }
                    });
                    T('net-stats', { recvMsgs, sentMsgs, bytes, delta: recvMsgs - lastRecv });
                    lastRecv = recvMsgs;
                } catch { /* stats are diagnostic; never break the stream for them */ }
            }, 1000);
        }

        function sendInputBuffer(buf) {
            // Timed because the send is the only thing that runs per pointer move,
            // and a pointer move is what a drag is made of. A blocking send here
            // starves the frame loop directly.
            const inT0 = performance.now();
            let sent = false;
            try {
                sent = sendInputBufferInner(buf);
            } finally {
                pendingInputMs += performance.now() - inT0;
                // The client's half of the input path. The host records arrival and
                // delivery to the game; without this the log cannot say whether a
                // keypress that did nothing was never sent, sent and lost, or sent
                // and ignored - three different bugs that look identical.
                // byteLength covers the ArrayBuffer-backed views the encoders return;
                // length covers plain arrays. A field that reads `undefined` for the
                // normal case is worse than no field.
                const bytes = buf && (buf.byteLength !== undefined ? buf.byteLength : buf.length);
                T('input-send', { bytes, sent });
            }
        }

        // Returns whether the buffer actually went out. "Sent" has to mean sent: an
        // input with no open channel is dropped silently, and that is precisely the
        // case the log needs to distinguish from a keypress the game ignored.
        function sendInputBufferInner(buf) {
            if (inputDc && inputDc.readyState === 'open') {
                inputDc.send(buf); // True Reliable Ordered WebRTC DataChannel!
                return true;
            } else if (dc && dc.readyState === 'open') {
                dc.send(buf); // Fallback to stream DC
                return true;
            } else if (ws && ws.readyState === WebSocket.OPEN) {
                ws.send(buf); // TCP fallback
                return true;
            }
            return false;
        }

        // Incomplete textures, keyed by texId. A texture is only handed to the
// renderer once every chunk has arrived; until then the frame that references
// it stays gated.
const pendingTextures = new Map();

// Which chunk of each missing picture the client is actually waiting for.
//
// Without this the request can only say "I am missing picture 10", and the host
// answers by sending all 37 chunks again. The transport is at its fullest when
// the last chunk is queued, so the chunk that gets dropped is the last one -
// the same chunk that was lost - and the pair repeats indefinitely while the
// screen stays black. Naming the chunk makes the repair a single message.
function missingChunksFor(ids) {
    const out = new Map();
    for (const id of ids) {
        const p = pendingTextures.get(id);
        if (!p || p.chunkCount <= 1) {
            out.set(id, 0);
            continue;
        }
        let at = 0;
        while (at < p.chunkCount && p.chunks.has(at)) at++;
        out.set(id, at < p.chunkCount ? at : 0);
    }
    return out;
}

function ingestTextureChunk(chunk) {
            // Any chunk arriving proves the picture pipeline is working, so it
            // counts as progress. This used to be set only when a picture
            // finished assembling, which meant a large picture - the 8 MB title
            // backdrop is 64 chunks - could be arriving steadily, chunk by
            // chunk, while still being written off as unsendable, because none
            // of the pictures completing in that window happened to be this one.
            // Measured at give-up: 23 of its 64 chunks had already arrived.
            pictureArrivedSinceRequest = true;
            // Fast path: fits in one message, no assembly and no extra copy.
            // A compressed picture still has to be decompressed first.
            if (chunk.chunkCount === 1 && !chunk.compressed && !chunk.jpeg) {
                const rgba = new Uint8ClampedArray(
                    chunk.data.buffer, chunk.data.byteOffset, chunk.data.byteLength
                );
                renderer.setTexture(chunk.texId, { texId: chunk.texId, w: chunk.w, h: chunk.h, rgba });
                pictureArrivedSinceRequest = true;
                return;
            }

            let pending = pendingTextures.get(chunk.texId);
            if (!pending) {
                pending = {
                    w: chunk.w, h: chunk.h,
                    totalLen: chunk.totalLen,
                    chunkCount: chunk.chunkCount,
                    compressed: chunk.compressed,
                    jpeg: chunk.jpeg,
                    chunks: new Map()
                };
                pendingTextures.set(chunk.texId, pending);
            }

            if (!pending.chunks.has(chunk.chunkIndex)) {
                // Copy out of the receive buffer so we are not pinning it.
                pending.chunks.set(chunk.chunkIndex, chunk.data.slice());
            }
            if (pending.chunks.size < pending.chunkCount) return;

            const out = new Uint8ClampedArray(pending.totalLen);
            let off = 0;
            for (let i = 0; i < pending.chunkCount; i++) {
                const c = pending.chunks.get(i);
                if (!c) { pendingTextures.delete(chunk.texId); return; }
                out.set(c, off);
                off += c.length;
            }
            if (off !== pending.totalLen) {
                // Sizes disagree; refuse rather than upload a corrupt texture.
                console.warn(`[Assets] Texture ${chunk.texId} assembled ${off} of ${pending.totalLen} bytes - discarding`);
                pendingTextures.delete(chunk.texId);
                return;
            }

            pendingTextures.delete(chunk.texId);

            // Artwork arrives in the pixel path's own codec: decode it the way a
            // browser decodes any image, then hand the renderer a drawable. The
            // alternative - shipping raw RGBA - is what made the two paths
            // incomparable in the first place.
            if (pending.jpeg) {
                const blob = new Blob([out], { type: 'image/jpeg' });
                createImageBitmap(blob).then((bitmap) => {
                    renderer.setTexture(chunk.texId, bitmap);
                    pictureArrivedSinceRequest = true;
                }).catch(() => {
                    console.warn(`[Assets] Texture ${chunk.texId} failed to decode as JPEG - discarding`);
                });
                return;
            }

            let rgba = out;
            if (pending.compressed) {
                // The wire carried w*h*4 bytes after zstd. Decompressing is
                // lossless, so this is the same picture the game drew, just
                // smaller on the way here. A picture that fails to decompress is
                // dropped rather than uploaded: a half-decoded texture would be
                // corruption the client then caches.
                const want = pending.w * pending.h * 4;
                try {
                    const plain = fzstd.decompress(new Uint8Array(out.buffer, out.byteOffset, out.byteLength),
                                                   new Uint8Array(want));
                    if (plain.byteLength !== want) {
                        console.warn(`[Assets] Texture ${chunk.texId} decompressed to ${plain.byteLength}, want ${want} - discarding`);
                        return;
                    }
                    rgba = new Uint8ClampedArray(plain.buffer, plain.byteOffset, plain.byteLength);
                } catch (e) {
                    console.warn(`[Assets] Texture ${chunk.texId} failed to decompress - discarding`, e);
                    return;
                }
            }

            renderer.setTexture(chunk.texId, {
                texId: chunk.texId, w: pending.w, h: pending.h, rgba
            });
            pictureArrivedSinceRequest = true;
        }

        function handleFrameBinary(buffer) {
            // Stamped before decode: what the client does with a frame, and how
            // long it is held before it can be shown, are different costs and were
            // being confused. A held frame waits for artwork, not for the transport.
            bench.frameArrivedAt = performance.now();
            if (isDestroyed) return;
            if (isDebug) bytesReceived += buffer.byteLength;

            const probe = DFProtocol.decodeProbe(buffer);
            if (probe) {
                // Counted in three numbers as well as logged. The wire log is
                // capped and drops its oldest entries, so at the rates this probe
                // reaches it stops describing the window - and a gap count read
                // back from it would then be counting the log's own eviction. The
                // channel is ordered, so the lowest number seen, the highest and
                // the count say exactly what is missing (probeArrivals).
                const p = bench.probe;
                p.count++;
                if (p.min === null || probe.seq < p.min) p.min = probe.seq;
                if (p.max === null || probe.seq > p.max) p.max = probe.seq;
                if (p.last !== null && probe.seq <= p.last) p.reordered++;
                p.last = probe.seq;
                wire.record('probe', buffer.byteLength, performance.now(), probe.seq);
                return;
            }

            const chunk = DFProtocol.decodeTexture(buffer);
            if (chunk) {
                bench.bytesIn.textures += buffer.byteLength;
                wire.record('artwork', buffer.byteLength, performance.now());
                ingestTextureChunk(chunk);
                // A held frame may now be displayable, or may still be waiting
                // on others; re-check rather than assuming this one unblocked it.
                syncAssets();
                return;
            }
            if (isDebug) streamFrameCount++;
            const handlerT0 = performance.now();
            const frame = DFProtocol.decodeFrame(buffer);
            if (frame) {
                T('frame-in', { seq: frame.seq, type: frame.type, bytes: buffer.byteLength });
                bench.bytesIn.frames += buffer.byteLength;
                // A keyframe and a delta are different things on the wire: one
                // is a whole screen and one is a handful of changed cells, and a
                // spike that turns out to be a keyframe is a different fault
                // from one behind a burst of deltas.
                wire.record(frame.type === 'full' ? 'keyframe' : 'frame', buffer.byteLength,
                            performance.now(), frame.seq);
                // This frame answers an input. Which paint shows it is decided
                // by the paint itself, not by the arrival: if the client is
                // holding this frame for artwork, the wait belongs to the answer.
                if ((isDebug || window.__enableM2P) && frame.stamp) {
                    if (pendingStamps.has(frame.stamp)) {
                        pendingRenderStamps.push(frame.stamp);
                        const sentAt = bench.inputSent.get(frame.stamp);
                        if (sentAt !== undefined) {
                            bench.stampedFrames++;
                            bench.stampFramesSeen++;
                            benchPendingStamps.push({ stamp: frame.stamp, sentAt });
                        } else {
                            // The answer outlived the record of the input it
                            // belongs to, so it cannot be tied to one. Counted,
                            // not credited.
                            bench.stampsUnknown++;
                        }
                    } else {
                        // A stamp this page never issued, or one it has already
                        // forgotten: the same thing from the bench's side, and
                        // not an answer the client can be said to have seen.
                        bench.stampsUnknown++;
                    }
                }

                if (isDebug) {
                    window.__simulatePacketLoss = () => {
                        console.log('[WebRTC Test] Simulating packet drop by rewinding the sequencer');
                        sequencer.rewind(10);
                    };
                }

                sequencer.onFrame(frame);
            }
        }

        let reconnectTimer = null;

        let pendingIceCandidates = [];
        let isRemoteDescriptionSet = false;

        async function setupWebRTC() {
            console.log('[WebRTC] Starting setupWebRTC...');
            pendingIceCandidates = [];
            isRemoteDescriptionSet = false;
            if (!window.RTCPeerConnection) {
                console.warn('[WebRTC] RTCPeerConnection not supported in browser');
                return;
            }
            try {
                if (pc) {
                    pc.close();
                    pc = null;
                }
                pc = new RTCPeerConnection({
                    iceServers: [
                        { urls: 'stun:stun.l.google.com:19302' },
                        { urls: 'stun:stun1.l.google.com:19302' }
                    ]
                });

                pc.oniceconnectionstatechange = () => {
                    console.log('[WebRTC] iceConnectionState:', pc.iceConnectionState);
                };
                pc.onconnectionstatechange = () => {
                    console.log('[WebRTC] connectionState:', pc.connectionState);
                    if (pc.connectionState === 'closed' || pc.connectionState === 'failed') {
                        if (!ws || ws.readyState === WebSocket.CLOSED || ws.readyState === WebSocket.CLOSING) {
                            if (onTerminate) onTerminate();
                        }
                    }
                };

                // Create stream DataChannel (UDP deltas) and reliable input DataChannel
                console.log('[WebRTC] Creating df-stream and df-input DataChannels...');
                dc = pc.createDataChannel('df-stream', {
                    // Ordered, but no SCTP retransmission. Frames arrive in the
                    // order they were sent, and one that is still lost is
                    // repaired by the bridging protocol rather than by a
                    // retransmit, which would stall and head-of-line block
                    // every later frame queued behind it.
                    //
                    // Making this reliable was measured and was worse: with the
                    // link busy the retransmits queue behind the traffic they
                    // were meant to protect, and draws fell from 3/s to 2/s.
                    ordered: true,
                    maxRetransmits: 0
                });
                dc.binaryType = 'arraybuffer';

                // Pictures get their own reliable channel.
                //
                // They shared the unreliable stream channel, and that channel is
                // right for frames: a frame is small and one that is lost is
                // replaced by asking again, so retransmitting it - and blocking
                // every frame queued behind it - would make the display late in
                // order to fix something it can already replace. A picture chunk
                // is different: it cannot be replaced by a later chunk, it has to
                // be resent, and no frame that names the picture can be drawn
                // until the last chunk lands. One channel for both means choosing
                // between a display that is late and a display that is black.
                assetDc = pc.createDataChannel('df-assets', {
                    ordered: true
                });
                assetDc.binaryType = 'arraybuffer';
                // Received here, ingested in the render loop.
                //
                // Decoding and uploading a picture is the most expensive thing
                // this page does - a full-screen picture is several megabytes
                // that has to be decompressed and copied into the atlas - and
                // doing it inside the message callback gives the browser no
                // chance to paint until the whole backlog is consumed. Measured
                // while panning: pictures arriving at 124 a second, frames at 29,
                // and only 2 draws, because the render loop was starving behind
                // the pictures it was waiting for. Queuing them moves the work
                // into the frame loop, where it can be given a time budget.
                assetDc.onmessage = ev => {
                    const chunk = DFProtocol.decodeTexture(ev.data);
                    if (!chunk) return;
                    bench.bytesIn.textures += ev.data.byteLength;
                    wire.record('artwork', ev.data.byteLength, performance.now());
                    T('pic-in', { id: chunk.texId, idx: chunk.chunkIndex, of: chunk.chunkCount, bytes: ev.data.byteLength });
                    assetQueue.push(chunk);
                };

                inputDc = pc.createDataChannel('df-input', {
                    ordered: true
                });
                inputDc.binaryType = 'arraybuffer';

                inputDc.onopen = () => {
                    console.log('[WebRTC] Reliable Ordered Input DataChannel OPENED!');
                };
                inputDc.onclose = () => {
                    console.log('[WebRTC] Input DataChannel closed');
                };

                dc.onopen = () => {
                    startNetSampler();
                    console.log('[WebRTC] Ordered stream DataChannel (no retransmit) + reliable input DataChannel OPENED!');
                    setIsWebRTCReady(true);
                    if (onTransportChange) onTransportChange('UDP (WebRTC)');
                    handleResize(true);
                };

                dc.onclose = () => {
                    console.log('[WebRTC] DataChannel closed, using WebSocket');
                    setIsWebRTCReady(false);
                    if (onTransportChange) onTransportChange('TCP (WebSocket)');
                    if (!ws || ws.readyState === WebSocket.CLOSED || ws.readyState === WebSocket.CLOSING) {
                        if (onTerminate) onTerminate();
                    }
                };

                dc.onerror = (err) => {
                    console.warn('[WebRTC] DataChannel error:', err);
                };

                // TCP frame probe: the same frames over a plain TCP WebSocket, so
                // their arrival can be compared with the data channel's. Only opened
                // when the page is asked for it; it displays nothing.
                if (new URLSearchParams(location.search).get('tcpprobe') === '1') {
                    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
                    const probe = new WebSocket(`${proto}://${location.hostname}:8000/frames-tcp`);
                    probe.binaryType = 'arraybuffer';
                    probe.onmessage = (ev) => {
                        if (!(ev.data instanceof ArrayBuffer) || ev.data.byteLength < 4) return;
                        T('frame-in-tcp', { seq: new DataView(ev.data).getUint32(0), bytes: ev.data.byteLength - 4 });
                    };
                }

                dc.onmessage = (event) => {
                    // Time spent in the handler, accumulated and reported once a second.
                    // The loop's own cost is already known to be ~1 ms, so if the frame
                    // callback is late the work must be here, between turns, and nothing
                    // else was measuring it.
                    const msgT0 = performance.now();
                    try {
                        if (event.data instanceof ArrayBuffer) {
                            handleFrameBinary(event.data);
                        }
                    } finally {
                        msgCostMs += performance.now() - msgT0;
                        msgCostN++;
                    }
                };

                // The bench's view of the transport itself. Every other counter
                // in this page counts what the JavaScript handler ran; this one
                // counts what the browser's own data channel took in, and the
                // difference between the two is where a message was discarded if
                // it was discarded above this code rather than in it. Exposed as
                // a function because getStats() is async and a snapshot has to be
                // taken at a moment the bench chooses.
                window.__dfTransportStats = async () => {
                    if (!pc) return null;
                    const report = await pc.getStats();
                    const out = { dataChannels: {}, transport: null, candidatePairs: [] };
                    report.forEach((s) => {
                        if (s.type === 'data-channel') {
                            out.dataChannels[s.label || s.id] = {
                                id: s.id, label: s.label ?? null, state: s.state ?? null,
                                messagesSent: s.messagesSent ?? null, bytesSent: s.bytesSent ?? null,
                                messagesReceived: s.messagesReceived ?? null,
                                bytesReceived: s.bytesReceived ?? null,
                            };
                        } else if (s.type === 'transport') {
                            out.transport = {
                                bytesSent: s.bytesSent ?? null, bytesReceived: s.bytesReceived ?? null,
                                packetsSent: s.packetsSent ?? null, packetsReceived: s.packetsReceived ?? null,
                            };
                        } else if (s.type === 'candidate-pair' && (s.selected || s.state === 'succeeded')) {
                            out.candidatePairs.push({
                                id: s.id, selected: !!s.selected, state: s.state ?? null,
                                bytesSent: s.bytesSent ?? null, bytesReceived: s.bytesReceived ?? null,
                                packetsSent: s.packetsSent ?? null, packetsReceived: s.packetsReceived ?? null,
                            });
                        }
                    });
                    out.iceConnectionState = pc.iceConnectionState;
                    out.connectionState = pc.connectionState;
                    out.streamChannelState = dc ? dc.readyState : null;
                    out.streamBufferedAmount = dc ? dc.bufferedAmount : null;
                    return out;
                };

                pc.onicecandidate = (event) => {
                    console.log('[WebRTC] Local ICE candidate:', event.candidate ? event.candidate.candidate : 'null');
                    if (event.candidate && ws && ws.readyState === 1) {
                        ws.send(JSON.stringify({
                            type: 'webrtc_ice',
                            candidate: event.candidate.candidate,
                            mid: event.candidate.sdpMid || '0'
                        }));
                    }
                };

                console.log('[WebRTC] Creating offer...');
                const offer = await pc.createOffer();
                console.log('[WebRTC] Setting local description...');
                await pc.setLocalDescription(offer);

                console.log('[WebRTC] ws check:', Boolean(ws), 'readyState:', ws ? ws.readyState : 'null', 'WebSocket.OPEN:', typeof WebSocket !== 'undefined' ? WebSocket.OPEN : 'undef');
                if (ws && ws.readyState === 1) {
                    console.log('[WebRTC] Sending webrtc_offer, sdp length:', offer.sdp.length);
                    ws.send(JSON.stringify({
                        type: 'webrtc_offer',
                        sdp: offer.sdp
                    }));
                } else {
                    console.warn('[WebRTC] WebSocket not open when sending offer! readyState:', ws ? ws.readyState : 'null');
                }
            } catch (e) {
                console.warn('[WebRTC] Setup failed:', e);
            }
        }

        function connect() {
            if (isDestroyed) return;
            if (onStatusChange) onStatusChange('connecting');
            if (onTransportChange) onTransportChange('TCP (WebSocket)');

            const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
            const wsUrl = `${protocol}//${location.host}/ws`;

            ws = new WebSocket(wsUrl);
            ws.binaryType = 'arraybuffer';

            ws.onopen = () => {
                if (isDestroyed) {
                    ws.close();
                    return;
                }
                if (onStatusChange) onStatusChange('connected');
                console.log('Connected to Dwarf Fortress streamer (TCP signaling)!');

                window.__sendDebugWs = (msg) => {
                    try {
                        if (ws && ws.readyState === WebSocket.OPEN) ws.send(msg);
                    } catch (e) {}
                };

                if (!input) {
                    input = new DFInput(canvas, sendInputBuffer, getNextDebugStamp);
                    window.input = input;
                }

                handleResize(true);
                setupWebRTC();
            };

            ws.onmessage = async (event) => {
                if (isDestroyed) return;

                if (typeof event.data === 'string') {
                    try {
                        const msg = JSON.parse(event.data);
                        if (msg.type === 'init') {
                            handleResize(true);
                            if (!input) {
                                input = new DFInput(canvas, sendInputBuffer, getNextDebugStamp);
                                window.input = input;
                            }
                        } else if (msg.type === 'webrtc_answer') {
                            console.log('[WebRTC] Received webrtc_answer from server! Has pc:', !!pc);
                            if (pc) {
                                await pc.setRemoteDescription(new RTCSessionDescription({ type: 'answer', sdp: msg.sdp }));
                                console.log('[WebRTC] Remote description (answer) set successfully');
                                isRemoteDescriptionSet = true;
                                while (pendingIceCandidates.length > 0) {
                                    const cand = pendingIceCandidates.shift();
                                    try {
                                        await pc.addIceCandidate(new RTCIceCandidate(cand));
                                        console.log('[WebRTC] Drained queued ICE candidate:', cand.candidate);
                                    } catch (err) {
                                        console.warn('[WebRTC] Error adding drained candidate:', err);
                                    }
                                }
                            }
                        } else if (msg.type === 'webrtc_ice') {
                            console.log('[WebRTC] Received webrtc_ice from server:', msg.candidate);
                            if (pc) {
                                const candObj = { candidate: msg.candidate, sdpMid: msg.mid };
                                if (isRemoteDescriptionSet) {
                                    try {
                                        await pc.addIceCandidate(new RTCIceCandidate(candObj));
                                    } catch (err) {
                                        console.warn('[WebRTC] Error adding immediate candidate:', err);
                                    }
                                } else {
                                    console.log('[WebRTC] Queuing ICE candidate until remote description is set');
                                    pendingIceCandidates.push(candObj);
                                }
                            }
                        }
                    } catch (e) {
                        console.error('[WS] Error handling message:', e);
                    }
                } else if (event.data instanceof ArrayBuffer) {
                    if (event.data.byteLength >= 2) {
                        const v = new DataView(event.data);
                        const isStreamFrame = (v.getUint8(0) === 0x44 && v.getUint8(1) === 0x46);
                        // If WebRTC is active or connecting, suppress leaking video frames over WebSocket
                        if (isStreamFrame && (pc || (dc && dc.readyState === 'open'))) {
                            return;
                        }
                    }
                    handleFrameBinary(event.data);
                }
            };

            ws.onclose = () => {
                if (isDestroyed) return;
                if (onStatusChange) onStatusChange('disconnected');
                if (inputDc) { inputDc.close(); inputDc = null; }
                if (dc) { dc.close(); dc = null; }
                if (pc) { pc.close(); pc = null; }
                setIsWebRTCReady(false);
                if (onTerminate) {
                    onTerminate();
                }
            };

            ws.onerror = (err) => {
                console.error('WebSocket error:', err);
                ws.close();
            };
        }

        connect();

        return () => {
            isDestroyed = true;
            if (reconnectTimer) clearTimeout(reconnectTimer);
            if (resizeTimeout) clearTimeout(resizeTimeout);
            window.removeEventListener('resize', onWindowResize);
            if (animationFrameId) cancelAnimationFrame(animationFrameId);
            if (input) {
                input.destroy();
                window.input = null;
            }
            if (inputDc) inputDc.close();
            if (dc) dc.close();
            if (pc) pc.close();
            if (ws) ws.close();
        };
    }, [isDebug, onStatusChange, onMetricsUpdate, onTerminate]);

    return (
        <div className="relative w-full h-full">
            <canvas
                id="gameCanvas"
                ref={canvasRef}
                className="block w-full h-full cursor-default [image-rendering:pixelated] [image-rendering:crisp-edges]"
            />
            {(!isWebRTCReady || !hasDrawn) && (
                <div data-df-overlay className="absolute inset-0 flex items-center justify-center bg-black/60 z-10 backdrop-blur-sm pointer-events-none transition-opacity duration-300">
                    <div className="flex flex-col items-center gap-3 text-slate-200">
                        <div className="w-8 h-8 border-2 border-emerald-500 border-t-transparent rounded-full animate-spin"></div>
                        <span className="text-xs font-mono uppercase tracking-widest text-slate-400">{isWebRTCReady ? 'Loading picture...' : 'Connecting WebRTC P2P...'}</span>
                    </div>
                </div>
            )}
        </div>
    );
}
