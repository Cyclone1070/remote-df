import React, { useEffect, useRef, useState } from 'react';
import { DFRenderer } from '../core/renderer.js';
import { DFProtocol } from '../core/protocol.js';
import { DFInput } from '../core/input.js';
import { FrameSequencer } from '../core/frameSequencer.js';

export function GameCanvas({ onStatusChange, onMetricsUpdate, onTransportChange, isDebug, streamPort, onTerminate }) {
    const canvasRef = useRef(null);
    const [isWebRTCReady, setIsWebRTCReady] = useState(false);

    useEffect(() => {
        const canvas = canvasRef.current;
        if (!canvas) return;

        const initW = Math.max(912, Math.floor(window.innerWidth));
        const initH = Math.max(552, Math.floor(window.innerHeight));
        canvas.width = initW;
        canvas.height = initH;

        const renderer = new DFRenderer(canvas);
        window.renderer = renderer;

        let ws = null;
        let pc = null;
        let dc = null;
        let inputDc = null;
        let input = null;
        let isDestroyed = false;

        // Frame sequencing + loss recovery. Retries are driven by arriving
        // frames rather than a wall clock, so the cadence follows the stream
        // rate instead of a fixed interval. See core/frameSequencer.js.
        const sequencer = new FrameSequencer({
            applyFullFrame: cmds => {
                renderer.applyFullFrame(cmds);
                syncAssets();
                window.__dfFrameCount = (window.__dfFrameCount || 0) + 1;
            },
            applyDelta: (totalCmdCount, updates) => {
                renderer.applyDelta(totalCmdCount, updates);
                syncAssets();
                window.__dfFrameCount = (window.__dfFrameCount || 0) + 1;
            },
            requestBridgingDelta: lastSeq => sendInputBuffer(DFProtocol.encodeGapAck(lastSeq)),
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

        function syncAssets() {
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
            sendInputBuffer(DFProtocol.encodeAssetBridgeRequest(seq, missing));
            if (isDebug) {
                console.log(`[Assets] Holding frame ${seq}: ${missing.size} texture(s) missing [${key}], requesting bridge (opcode 0x08)`);
            }
        }

        // Rotating 1-byte debug stamp (1..255) for physical M2P latency
        let currentDebugStamp = 0;
        const pendingStamps = new Map();
        const pendingRenderStamps = [];
        const m2pSamples = [];
        window.__m2pSamples = m2pSamples;

        function getNextDebugStamp() {
            if (!isDebug && !window.__enableM2P) return 0;
            currentDebugStamp = (currentDebugStamp % 255) + 1;
            pendingStamps.set(currentDebugStamp, performance.now());
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
        function renderLoop() {
            if (isDestroyed) return;

            if (isDebug) renderFrameCount++;

            const didRender = renderer.render();

            if (didRender) {
                if ((isDebug || window.__enableM2P) && pendingRenderStamps.length > 0) {
                    const now = performance.now();
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

        function sendInputBuffer(buf) {
            if (inputDc && inputDc.readyState === 'open') {
                inputDc.send(buf); // True Reliable Ordered WebRTC DataChannel!
            } else if (dc && dc.readyState === 'open') {
                dc.send(buf); // Fallback to stream DC
            } else if (ws && ws.readyState === WebSocket.OPEN) {
                ws.send(buf); // TCP fallback
            }
        }

        // Incomplete textures, keyed by texId. A texture is only handed to the
// renderer once every chunk has arrived; until then the frame that references
// it stays gated.
const pendingTextures = new Map();

function ingestTextureChunk(chunk) {
            // Fast path: fits in one message, no assembly and no extra copy.
            if (chunk.chunkCount === 1) {
                const rgba = new Uint8ClampedArray(
                    chunk.data.buffer, chunk.data.byteOffset, chunk.data.byteLength
                );
                renderer.setTexture(chunk.texId, { texId: chunk.texId, w: chunk.w, h: chunk.h, rgba });
                return;
            }

            let pending = pendingTextures.get(chunk.texId);
            if (!pending) {
                pending = {
                    w: chunk.w, h: chunk.h,
                    totalLen: chunk.totalLen,
                    chunkCount: chunk.chunkCount,
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
            renderer.setTexture(chunk.texId, {
                texId: chunk.texId, w: pending.w, h: pending.h, rgba: out
            });
        }

        function handleFrameBinary(buffer) {
            if (isDestroyed) return;
            if (isDebug) bytesReceived += buffer.byteLength;

            const chunk = DFProtocol.decodeTexture(buffer);
            if (chunk) {
                ingestTextureChunk(chunk);
                // A held frame may now be displayable, or may still be waiting
                // on others; re-check rather than assuming this one unblocked it.
                syncAssets();
                return;
            }

            if (isDebug) streamFrameCount++;
            const frame = DFProtocol.decodeFrame(buffer);
            if (frame) {
                if ((isDebug || window.__enableM2P) && frame.stamp && pendingStamps.has(frame.stamp)) {
                    pendingRenderStamps.push(frame.stamp);
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
                    ordered: true,
                    maxRetransmits: 0
                });
                dc.binaryType = 'arraybuffer';

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

                dc.onmessage = (event) => {
                    if (event.data instanceof ArrayBuffer) {
                        handleFrameBinary(event.data);
                    }
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
            {!isWebRTCReady && (
                <div className="absolute inset-0 flex items-center justify-center bg-black/60 z-10 backdrop-blur-sm pointer-events-none transition-opacity duration-300">
                    <div className="flex flex-col items-center gap-3 text-slate-200">
                        <div className="w-8 h-8 border-2 border-emerald-500 border-t-transparent rounded-full animate-spin"></div>
                        <span className="text-xs font-mono uppercase tracking-widest text-slate-400">Connecting WebRTC P2P...</span>
                    </div>
                </div>
            )}
        </div>
    );
}
