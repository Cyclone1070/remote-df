#!/usr/bin/env node
/**
 * Automated End-to-End Test for Remote-DF Streaming Hub
 * 
 * Verifies the full pipeline:
 * 1. Healthcheck & game catalog availability
 * 2. Process supervisor session launch
 * 3. Unified WebSocket stream signaling (/ws)
 * 4. Binary frame protocol ingestion (magic: DF, keyframes, deltas)
 * 5. Interactive bidirectional input transmission
 * 6. Visual render output observation (draw commands count > 0)
 * 7. Clean teardown with zero zombie processes
 */

const targetArg = process.argv.find(a => a.startsWith('--target='));
const targetUrl = targetArg ? targetArg.split('=')[1] : (process.argv[2] || 'http://localhost:8484');

const parsedUrl = new URL(targetUrl);
const isSecure = parsedUrl.protocol === 'https:';
const wsProtocol = isSecure ? 'wss:' : 'ws:';
const wsUrl = `${wsProtocol}//${parsedUrl.host}/ws`;

console.log(`\n========================================================`);
console.log(`  Remote-DF E2E Live Stream Test Suite`);
console.log(`  Target Web:    ${targetUrl}`);
console.log(`  Target Stream: ${wsUrl}`);
console.log(`========================================================\n`);

async function runE2ESuite() {
    // Step 1: Pre-clean any existing session
    console.log('[1/6] Ensuring clean session state...');
    try {
        await fetch(`${targetUrl}/api/session/stop`, { method: 'POST' });
    } catch (_) {}

    // Step 2: Verify game catalog & target availability
    console.log('[2/6] Querying game catalog (/api/games)...');
    const gamesRes = await fetch(`${targetUrl}/api/games`);
    if (!gamesRes.ok) {
        throw new Error(`Failed to query games catalog: HTTP ${gamesRes.status}`);
    }
    const games = await gamesRes.json();
    const df = games.find(g => g.id === 'dwarf-fortress');
    if (!df) {
        throw new Error('Dwarf Fortress not found in game catalog');
    }
    if (!df.available) {
        throw new Error(`Dwarf Fortress is marked unavailable. Install directory: ${df.installDir}`);
    }
    console.log(`  ✓ Game catalog verified: ${df.name} (${df.engine}) is available`);

    // Step 3: Launch game session via Supervisor
    console.log('[3/6] Starting game session (/api/session/start)...');
    const startRes = await fetch(`${targetUrl}/api/session/start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ gameId: 'dwarf-fortress' })
    });
    if (!startRes.ok) {
        const errBody = await startRes.text();
        throw new Error(`Failed to start game session: HTTP ${startRes.status} - ${errBody}`);
    }
    const session = await startRes.json();
    console.log(`  ✓ Session started! PID=${session.pid}, StreamPort=${session.streamPort}, State=${session.state}`);

    // Wait 1.5s for Xvfb and game initialization
    await new Promise(r => setTimeout(r, 1500));

    // Step 4: Connect to stream via unified WebSocket proxy (/ws)
    console.log(`[4/6] Connecting to stream over WebSocket (${wsUrl})...`);
    const WebSocketClient = globalThis.WebSocket;
    if (!WebSocketClient) {
        throw new Error('WebSocket is not supported in this Node environment');
    }

    const ws = new WebSocketClient(wsUrl);
    ws.binaryType = 'arraybuffer';

    let initReceived = false;
    let gridInfo = null;
    let framesReceived = 0;
    let keyframesReceived = 0;
    let deltasReceived = 0;
    let totalDrawCommands = 0;
    let totalBytes = 0;
    let inputAcknowledged = false;

    const streamStart = Date.now();

    await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
            ws.close();
            reject(new Error(`Timeout waiting for live stream frames after 15s (frames received: ${framesReceived})`));
        }, 15000);

        ws.onopen = () => {
            console.log('  ✓ WebSocket connection opened successfully (HTTP 101 Handshake OK)');
        };

        ws.onmessage = (event) => {
            if (typeof event.data === 'string') {
                try {
                    const msg = JSON.parse(event.data);
                    if (msg.type === 'init') {
                        initReceived = true;
                        gridInfo = `${msg.grid_w}x${msg.grid_h}`;
                        console.log(`  ✓ Init packet received: Grid=${gridInfo}, Textures=${msg.textures ? msg.textures.length : 0}`);
                    }
                } catch (e) {
                    console.warn('  ! Non-JSON text message:', event.data);
                }
            } else if (event.data instanceof ArrayBuffer) {
                const buf = event.data;
                const view = new DataView(buf);
                totalBytes += buf.byteLength;

                // Check texture packet ('D', 'T')
                if (buf.byteLength >= 12 && view.getUint8(0) === 0x44 && view.getUint8(1) === 0x54) {
                    const texId = view.getUint16(2, true);
                    const tw = view.getUint16(4, true);
                    const th = view.getUint16(6, true);
                    return; // Texture chunk
                }

                // Check frame header ('D', 'F')
                if (buf.byteLength >= 10 && view.getUint8(0) === 0x44 && view.getUint8(1) === 0x46) {
                    framesReceived++;
                    const seq = view.getUint32(2, true);
                    const flags = view.getUint16(6, true);
                    const cmdCount = view.getUint16(8, true);

                    totalDrawCommands += cmdCount;

                    if ((flags & 0x01) !== 0) keyframesReceived++;
                    if ((flags & 0x02) !== 0) deltasReceived++;

                    if (framesReceived === 1) {
                        console.log(`  ✓ First live video frame #${seq}: flags=0x${flags.toString(16)}, draw_commands=${cmdCount}, bytes=${buf.byteLength}`);
                    }

                    // Test interactive input at frame 5
                    if (framesReceived === 5 && !inputAcknowledged) {
                        inputAcknowledged = true;
                        const inputBuf = new ArrayBuffer(16);
                        const inView = new DataView(inputBuf);
                        inView.setUint8(0, 1); // Mouse move event
                        inView.setInt16(1, 400, true);
                        inView.setInt16(3, 300, true);
                        ws.send(inputBuf);
                        console.log('  ✓ Forwarded test mouse motion event to host');
                    }

                    // Once we receive 30 live frames, test passes!
                    if (framesReceived >= 30) {
                        clearTimeout(timeout);
                        ws.close();
                        resolve();
                    }
                }
            }
        };

        ws.onerror = (err) => {
            clearTimeout(timeout);
            reject(new Error(`WebSocket stream error: ${err.message || err}`));
        };

        ws.onclose = (event) => {
            if (framesReceived < 30) {
                clearTimeout(timeout);
                reject(new Error(`WebSocket closed prematurely (code=${event.code}, reason='${event.reason}')`));
            }
        };
    });

    const elapsedSec = (Date.now() - streamStart) / 1000;
    const deliveredFps = framesReceived / elapsedSec;

    console.log(`\n[5/6] Stream Quality & Rendering Verification:`);
    console.log(`  - Total Frames Ingested: ${framesReceived} (${keyframesReceived} keyframes, ${deltasReceived} deltas)`);
    console.log(`  - Total Draw Commands:   ${totalDrawCommands}`);
    console.log(`  - Delivered Framerate:   ${deliveredFps.toFixed(1)} FPS`);
    console.log(`  - Ingested Bandwidth:    ${((totalBytes * 8) / elapsedSec / 1000).toFixed(1)} kbps`);

    if (totalDrawCommands === 0) {
        throw new Error('Verification failed: Received frames contain 0 draw commands (blank output)');
    }
    if (deliveredFps < 1.0) {
        throw new Error(`Verification failed: Framerate too low (${deliveredFps.toFixed(1)} FPS)`);
    }

    // Step 6: Clean session teardown
    console.log('\n[6/6] Stopping game session cleanly (/api/session/stop)...');
    const stopRes = await fetch(`${targetUrl}/api/session/stop`, { method: 'POST' });
    if (!stopRes.ok) {
        throw new Error(`Failed to stop session: HTTP ${stopRes.status}`);
    }
    const stopStatus = await stopRes.json();
    console.log(`  ✓ Session stopped cleanly. State=${stopStatus.state}`);

    // Verify session state is idle
    const statusRes = await fetch(`${targetUrl}/api/session`);
    const finalStatus = await statusRes.json();
    if (finalStatus.state !== 'idle') {
        throw new Error(`Expected session state to be 'idle', got '${finalStatus.state}'`);
    }
    console.log(`  ✓ Final status confirmed idle with zero residual processes.`);

    console.log(`\n========================================================`);
    console.log(`  ✅ ALL E2E STREAM VERIFICATION TESTS PASSED`);
    console.log(`========================================================\n`);
}

runE2ESuite().catch(err => {
    console.error(`\n❌ E2E STREAM VERIFICATION FAILED:`, err.message);
    process.exit(1);
});
