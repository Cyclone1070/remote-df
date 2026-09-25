import React, { useEffect, useRef } from 'react';
import { DFRenderer } from '../core/renderer.js';
import { DFProtocol } from '../core/protocol.js';
import { DFInput } from '../core/input.js';

export function GameCanvas({ onStatusChange, onMetricsUpdate, onTransportChange, isDebug }) {
    const canvasRef = useRef(null);

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
        let input = null;
        let isDestroyed = false;
        let lastRenderedSeq = 0;
        let waitingForKeyframe = false;

        // Rotating 1-byte debug stamp (1..255) for physical M2P latency
        let currentDebugStamp = 0;
        const pendingStamps = new Map();
        const pendingRenderStamps = [];
        const m2pSamples = [];

        function getNextDebugStamp() {
            if (!isDebug) return 0;
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
                if (isDebug && pendingRenderStamps.length > 0) {
                    const now = performance.now();
                    for (let i = 0; i < pendingRenderStamps.length; i++) {
                        const stamp = pendingRenderStamps[i];
                        const sentTime = pendingStamps.get(stamp);
                        if (sentTime !== undefined) {
                            const m2p = now - sentTime;
                            m2pSamples.push(m2p);
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
            if (dc && dc.readyState === 'open') {
                dc.send(buf); // True UDP datagram!
            } else if (ws && ws.readyState === WebSocket.OPEN) {
                ws.send(buf); // TCP fallback
            }
        }

        function handleFrameBinary(buffer) {
            if (isDestroyed) return;
            if (isDebug) bytesReceived += buffer.byteLength;

            const tex = DFProtocol.decodeTexture(buffer);
            if (tex) {
                renderer.setTexture(tex.texId, tex);
                return;
            }

            if (isDebug) streamFrameCount++;
            const frame = DFProtocol.decodeFrame(buffer);
            if (frame) {
                // Drop stale out-of-order UDP frames
                if (frame.seq && frame.seq < lastRenderedSeq) {
                    return;
                }

                const packetLossDetected = (lastRenderedSeq > 0 && frame.seq > lastRenderedSeq + 1);
                lastRenderedSeq = frame.seq;

                if (isDebug && frame.stamp && pendingStamps.has(frame.stamp)) {
                    pendingRenderStamps.push(frame.stamp);
                }

                if (isDebug) {
                    window.__simulatePacketLoss = () => {
                        console.log('[WebRTC Test] Simulating packet drop by rewinding lastRenderedSeq');
                        lastRenderedSeq = Math.max(1, lastRenderedSeq - 10);
                    };
                }

                if (frame.type === 'full') {
                    if (isDebug && waitingForKeyframe) {
                        console.log('[WebRTC Recovery] Full keyframe received! Stream recovered successfully.');
                    }
                    waitingForKeyframe = false;
                    renderer.applyFullFrame(frame.cmds);
                } else if (frame.type === 'delta') {
                    if (packetLossDetected && !waitingForKeyframe) {
                        if (isDebug) {
                            console.log(`[WebRTC Recovery] Packet loss detected! Current seq: ${frame.seq}. Requesting keyframe (opcode 0x06)...`);
                        }
                        waitingForKeyframe = true;
                        sendInputBuffer(DFProtocol.encodeKeyframeRequest());
                    }
                    if (!waitingForKeyframe) {
                        renderer.applyDelta(frame.totalCmdCount, frame.updates);
                    }
                }
                window.__dfFrameCount = (window.__dfFrameCount || 0) + 1;
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
                };

                // Create True UDP DataChannel: unordered, 0 retransmissions
                console.log('[WebRTC] Creating df-stream DataChannel...');
                dc = pc.createDataChannel('df-stream', {
                    ordered: false,
                    maxRetransmits: 0
                });
                dc.binaryType = 'arraybuffer';

                dc.onopen = () => {
                    console.log('[WebRTC] True UDP DataChannel OPENED!');
                    if (onTransportChange) onTransportChange('UDP (WebRTC)');
                    handleResize(true);
                };

                dc.onclose = () => {
                    console.log('[WebRTC] DataChannel closed, using WebSocket');
                    if (onTransportChange) onTransportChange('TCP (WebSocket)');
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
                    handleFrameBinary(event.data);
                }
            };

            ws.onclose = () => {
                if (isDestroyed) return;
                if (onStatusChange) onStatusChange('disconnected');
                if (dc) { dc.close(); dc = null; }
                if (pc) { pc.close(); pc = null; }
                reconnectTimer = setTimeout(connect, 2000);
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
            if (ws) ws.close();
        };
    }, [isDebug, onStatusChange, onMetricsUpdate]);

    return (
        <canvas
            id="gameCanvas"
            ref={canvasRef}
            className="block w-full h-full cursor-default [image-rendering:pixelated] [image-rendering:crisp-edges]"
        />
    );
}
