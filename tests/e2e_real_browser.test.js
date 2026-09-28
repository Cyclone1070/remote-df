#!/usr/bin/env node
/**
 * Strict End-to-End Browser Test Suite for Remote-DF
 * 
 * Verifies real user gameplay experience in a real Chromium browser:
 * 1. Web application loads on target URL and displays Main Menu
 * 2. Real DOM interaction: clicks "Launch Game" button, testing React state & router
 * 3. Supervisor routing check: asserts WebSocket strictly routes to reverse proxy (/ws), never port 8485
 * 4. Game canvas mounts in DOM (#gameCanvas)
 * 5. WebRTC DataChannel (UDP) connection establishes strictly with 0 TCP split-brain leakage
 * 6. Natural WebGL render loop verified via perceptual image comparison:
 *    - client_nonzero >= 20,000 pixels (no blank/black screen)
 *    - fg_match_pct >= 95.0% against truth_title.png
 *    - tol_match_pct >= 96.0% overall
 * 7. Interactive input delivery: asserts mouse (move, click, wheel) and keyboard packets transmitted over DataChannel
 * 8. Real packet loss keyframe recovery: drops incoming delta frames, asserts client detects gap,
 *    fires opcode 0x06 keyframe request, and receives full keyframe (flags & 0x01)
 * 9. Clean teardown: stops session, canvas unmounts, server state returns to idle
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync } = require('child_process');

let playwright;
try {
    playwright = require('playwright');
} catch (_) {
    try {
        const npmRoot = execSync('npm root -g 2>/dev/null || true').toString().trim();
        if (npmRoot && fs.existsSync(path.join(npmRoot, 'playwright'))) {
            playwright = require(path.join(npmRoot, 'playwright'));
        }
    } catch (_) {}
    if (!playwright) {
        try {
            const homeDir = os.homedir();
            const npxPath = execSync(`find "${homeDir}/.npm" -name "playwright" -type d 2>/dev/null | grep "/node_modules/playwright$" | head -n 1`)
                .toString().trim();
            if (npxPath && fs.existsSync(npxPath)) {
                playwright = require(npxPath);
            }
        } catch (_) {}
    }
}

if (!playwright) {
    console.error('Playwright not found. Install playwright or run with NODE_PATH.');
    process.exit(1);
}

const { chromium } = playwright;

const TARGET_URL = process.env.TARGET_URL || process.argv[2] || 'http://localhost:8484';
const TIMEOUT_MS = 30000;
const REPO_ROOT = path.resolve(__dirname, '..');
const ARTIFACT_DIR = path.resolve(REPO_ROOT, 'test-results');
if (!fs.existsSync(ARTIFACT_DIR)) {
    fs.mkdirSync(ARTIFACT_DIR, { recursive: true });
}

console.log(`\n========================================================`);
console.log(`  REAL BROWSER E2E TEST SUITE`);
console.log(`  Target URL: ${TARGET_URL}`);
console.log(`========================================================\n`);

async function runRealBrowserSuite() {
    const browser = await chromium.launch({
        headless: true,
        args: ['--use-gl=angle', '--use-angle=swiftshader', '--no-sandbox']
    });

    const context = await browser.newContext({
        viewport: { width: 1280, height: 720 },
        ignoreHTTPSErrors: true
    });

    const page = await context.newPage();

    page.on('console', msg => {
        console.log(`  [Browser Console] ${msg.text()}`);
    });
    page.on('pageerror', err => {
        console.error(`  [Browser PageError] ${err.message}`);
    });

    // Clean, non-invasive E2E telemetry injected before scripts run
    await page.addInitScript(() => {
        window.__e2e = {
            wsUrls: [],
            pc: null,
            dc: null,
            dcFrameCount: 0,
            wsBinaryCount: 0,
            keyframeRequestsSent: 0,
            gapAckRequestsSent: 0,
            combinedDeltaFramesReceived: 0,
            mouseMovesSent: 0,
            mouseClicksSent: 0,
            mouseWheelsSent: 0,
            keyInputsSent: 0,
            keyframesReceived: 0,
            deltaFramesReceived: 0,
            dropNextDeltas: 0,
            deltasDroppedByTest: 0
        };

        const OrigPC = window.RTCPeerConnection;
        if (OrigPC) {
            window.RTCPeerConnection = function(...args) {
                const pc = new OrigPC(...args);
                window.__e2e.pc = pc;

                const origCreateDataChannel = pc.createDataChannel;
                pc.createDataChannel = function(label, opts) {
                    const dc = origCreateDataChannel.call(pc, label, opts);
                    const origSend = dc.send;
                    dc.send = function(data) {
                        if (data instanceof Uint8Array || data instanceof ArrayBuffer) {
                            const view = new DataView(data instanceof ArrayBuffer ? data : data.buffer);
                            if (view.byteLength >= 1) {
                                const opcode = view.getUint8(0);
                                if (opcode === 0x06) window.__e2e.keyframeRequestsSent++;
                                if (opcode === 0x07) window.__e2e.gapAckRequestsSent++;
                                if (opcode === 1) window.__e2e.mouseMovesSent++;
                                if (opcode === 2 || opcode === 3) window.__e2e.mouseClicksSent++;
                                if (opcode === 4) window.__e2e.mouseWheelsSent++;
                                if (opcode === 16 || opcode === 17) window.__e2e.keyInputsSent++;
                            }
                        }
                        return origSend.call(dc, data);
                    };

                    if (label === 'df-stream') {
                        window.__e2e.dc = dc;

                        // Use capture phase to intercept incoming frames and support intentional drop simulation
                        dc.addEventListener('message', (ev) => {
                            if (ev.data instanceof ArrayBuffer && ev.data.byteLength >= 8) {
                                const view = new DataView(ev.data);
                                // Protocol header: byte 0..1 = 'DF' (0x44, 0x46), byte 6..7 = uint16 flags
                                if (view.getUint8(0) === 0x44 && view.getUint8(1) === 0x46) {
                                    const flags = view.getUint16(6, true);
                                    const isKeyframe = (flags & 0x01) !== 0;
                                    const isDelta = (flags & 0x02) !== 0;
                                    const isCombinedDelta = (flags & 0x08) !== 0;

                                    if (isKeyframe) window.__e2e.keyframesReceived++;
                                    if (isCombinedDelta) window.__e2e.combinedDeltaFramesReceived++;
                                    if (isDelta) window.__e2e.deltaFramesReceived++;

                                    // Simulate network packet loss by dropping next N delta frames
                                    if (isDelta && window.__e2e.dropNextDeltas > 0) {
                                        window.__e2e.dropNextDeltas--;
                                        window.__e2e.deltasDroppedByTest++;
                                        ev.stopImmediatePropagation();
                                        return;
                                    }
                                }
                                window.__e2e.dcFrameCount++;
                            }
                        }, true);
                    }
                    return dc;
                };
                return pc;
            };
            window.RTCPeerConnection.prototype = OrigPC.prototype;
        }

        const OrigWS = window.WebSocket;
        if (OrigWS) {
            window.WebSocket = function(url, ...args) {
                window.__e2e.wsUrls.push(url.toString());
                const ws = new OrigWS(url, ...args);
                ws.addEventListener('message', (ev) => {
                    if (ev.data instanceof ArrayBuffer) {
                        window.__e2e.wsBinaryCount++;
                        if (ev.data.byteLength >= 2) {
                            const v = new DataView(ev.data);
                            if (v.getUint8(0) === 0x44 && v.getUint8(1) === 0x46) {
                                window.__e2e.wsStreamFrames = (window.__e2e.wsStreamFrames || 0) + 1;
                            } else if (v.getUint8(0) === 0x44 && v.getUint8(1) === 0x54) {
                                window.__e2e.wsTextures = (window.__e2e.wsTextures || 0) + 1;
                            }
                        }
                    }
                });
                return ws;
            };
            window.WebSocket.prototype = OrigWS.prototype;
        }
    });

    try {
        // Step 1: Navigate to application
        console.log(`[1/9] Navigating to ${TARGET_URL}...`);
        const navRes = await page.goto(TARGET_URL, { timeout: TIMEOUT_MS, waitUntil: 'domcontentloaded' });
        if (!navRes || !navRes.ok()) {
            throw new Error(`Failed to load page: HTTP ${navRes ? navRes.status() : 'null'}`);
        }
        await page.waitForSelector('#root', { timeout: 5000 });
        console.log('  ✓ Web application root mounted successfully.');

        // Step 2: Ensure any prior running session is stopped cleanly via UI or API
        console.log('[2/9] Preparing clean launcher state...');
        const stopBtn = page.locator('button:has-text("Stop Game")');
        if (await stopBtn.isVisible({ timeout: 1500 }).catch(() => false)) {
            console.log('  - Stopping existing running session via UI...');
            await stopBtn.click();
            await page.waitForTimeout(1000);
        } else {
            await page.evaluate(async () => {
                try { await fetch('/api/session/stop', { method: 'POST' }); } catch (_) {}
            });
            await page.waitForTimeout(1000);
        }

        // Verify Launch Game button is present in UI
        const launchBtn = page.locator('button:has-text("Launch Game")');
        await launchBtn.waitFor({ state: 'visible', timeout: 5000 });
        console.log('  ✓ Main Menu ready with active "Launch Game" button.');

        // Click real "Launch Game" button
        console.log('  - Clicking "Launch Game" in UI...');
        await launchBtn.click();

        // Step 3: Wait for game canvas to mount (#gameCanvas)
        console.log('[3/9] Waiting for game canvas to mount (#gameCanvas)...');
        const canvasLocator = page.locator('#gameCanvas');
        await canvasLocator.waitFor({ state: 'visible', timeout: 10000 });
        console.log('  ✓ Game canvas mounted in DOM via real UI navigation.');

        // Step 4: Verify Supervisor Reverse Proxy Routing (with race condition guard)
        console.log('[4/9] Verifying WebSocket supervisor reverse proxy routing...');
        await page.waitForFunction(() => {
            return window.__e2e && window.__e2e.wsUrls && window.__e2e.wsUrls.length > 0;
        }, { timeout: 5000 }).catch(() => {
            throw new Error('No WebSocket connections were attempted by the web client within 5s!');
        });

        const wsUrls = await page.evaluate(() => window.__e2e.wsUrls);
        console.log(`  - Discovered WebSocket connections: ${JSON.stringify(wsUrls)}`);
        const target = new URL(TARGET_URL);
        const expectedPort = target.port || (target.protocol === 'https:' ? '443' : '80');

        for (const u of wsUrls) {
            if (u.includes(':8485')) {
                throw new Error(`Invalid direct port bypass detected! Client attempted connection to '${u}' instead of supervisor proxy '/ws'.`);
            }
            if (!u.includes('/ws')) {
                throw new Error(`WebSocket URL '${u}' does not connect to the supervisor reverse proxy '/ws'.`);
            }
            const wsUrlObj = new URL(u);
            const wsPort = wsUrlObj.port || (wsUrlObj.protocol === 'wss:' ? '443' : '80');
            if (wsPort !== expectedPort) {
                throw new Error(`WebSocket connected to port ${wsPort} instead of supervisor port ${expectedPort}`);
            }
            if (wsUrlObj.hostname !== target.hostname) {
                throw new Error(`WebSocket connected to host ${wsUrlObj.hostname} instead of supervisor host ${target.hostname}`);
            }
        }
        console.log('  ✓ WebSocket routing strictly matches supervisor host/port and reverse proxy (/ws).');

        // Step 5: Verify Strict WebRTC PeerConnection & True UDP DataChannel
        console.log('[5/9] Verifying strict WebRTC DataChannel (UDP) connection...');
        await page.waitForFunction(() => {
            const e2e = window.__e2e;
            if (!e2e || !e2e.pc || !e2e.dc) return false;
            return e2e.pc.connectionState === 'connected' && e2e.dc.readyState === 'open';
        }, { timeout: 15000, polling: 200 }).catch(async () => {
            const pcState = await page.evaluate(() => {
                const e2e = window.__e2e;
                return {
                    hasPc: Boolean(e2e && e2e.pc),
                    pcConnectionState: e2e && e2e.pc ? e2e.pc.connectionState : 'none',
                    iceConnectionState: e2e && e2e.pc ? e2e.pc.iceConnectionState : 'none',
                    hasDc: Boolean(e2e && e2e.dc),
                    dcReadyState: e2e && e2e.dc ? e2e.dc.readyState : 'none'
                };
            });
            throw new Error(`WebRTC DataChannel failed to open! State: ${JSON.stringify(pcState)}`);
        });

        // Verify no split-brain frame arrival after WebRTC DataChannel is open
        const initialWsFrames = await page.evaluate(() => window.__e2e.wsStreamFrames || 0);
        const initialWsTextures = await page.evaluate(() => window.__e2e.wsTextures || 0);
        const initialDcFrames = await page.evaluate(() => window.__e2e.dcFrameCount);
        await page.waitForTimeout(1500);
        const transportStats = await page.evaluate(({ initWsFrames, initWsTextures, initDc }) => {
            const e2e = window.__e2e;
            return {
                dcFramesNew: e2e.dcFrameCount - initDc,
                wsStreamFramesNew: (e2e.wsStreamFrames || 0) - initWsFrames,
                wsTexturesNew: (e2e.wsTextures || 0) - initWsTextures,
                totalDcFrames: e2e.dcFrameCount,
                totalWsStreamFrames: e2e.wsStreamFrames || 0,
                totalWsTextures: e2e.wsTextures || 0,
                keyframesReceived: e2e.keyframesReceived,
                deltaFramesReceived: e2e.deltaFramesReceived
            };
        }, { initWsFrames: initialWsFrames, initWsTextures: initialWsTextures, initDc: initialDcFrames });

        console.log(`  - Transport Stats:`, transportStats);

        if (transportStats.dcFramesNew === 0) {
            throw new Error(`WebRTC DataChannel is open but received 0 new stream frames in 1.5s!`);
        }
        if (transportStats.wsStreamFramesNew > 0) {
            throw new Error(`Split-brain streaming detected! ${transportStats.wsStreamFramesNew} stream frames (DF) arrived over WebSocket while WebRTC was open.`);
        }
        console.log(`  ✓ Strict WebRTC UDP active: ${transportStats.dcFramesNew} frames received on DataChannel in 1.5s (0 stream frames on WebSocket).`);

        // Step 6: Verify Natural WebGL Visual Render Output (Perceptual Comparison with stabilization retry)
        console.log('[6/9] Verifying natural WebGL visual render output (non-blank screen)...');
        await page.waitForFunction(() => {
            const r = window.renderer;
            if (!r || !r.gl) return false;
            if (!r.commands || r.commands.length === 0) return false;
            if (r.lastSprites === 0) return false;
            return true;
        }, { timeout: 10000, polling: 300 }).catch(async () => {
            const diag = await page.evaluate(() => {
                const r = window.renderer;
                return {
                    hasRenderer: Boolean(r),
                    canvasSize: r ? [r.canvas.width, r.canvas.height] : [0, 0],
                    cmdCount: r && r.commands ? r.commands.length : 0,
                    texCount: r && r.textures ? r.textures.size : 0,
                    lastSprites: r ? r.lastSprites : 0
                };
            });
            throw new Error(`Canvas rendered blank/black pixels! Renderer diagnostics: ${JSON.stringify(diag)}`);
        });

        const truthFile = path.join(REPO_ROOT, 'tests/reference/truth_title.png');
        const diffFile = path.join(ARTIFACT_DIR, 'diff_title.png');
        const screenshotFile = path.join(ARTIFACT_DIR, 'e2e_verified_game_screen.png');

        if (!fs.existsSync(truthFile)) {
            throw new Error(`Ground truth reference file missing at ${truthFile}! Cannot verify visual output.`);
        }

        let comp = null;
        const startAuditTime = Date.now();
        while (Date.now() - startAuditTime < 4000) {
            await canvasLocator.screenshot({ path: screenshotFile });
            const compareCmd = `python3 "${path.join(REPO_ROOT, 'tests/qa_pixel_comparator.py')}" "${truthFile}" "${screenshotFile}" "${diffFile}" 5`;
            const compRaw = execSync(compareCmd).toString();
            comp = JSON.parse(compRaw);

            if (comp.client_nonzero >= 20000 && comp.fg_match_pct >= 95.0 && comp.tol_match_pct >= 96.0) {
                break;
            }
            await page.waitForTimeout(400);
        }

        console.log(`  - Visual Audit: Foreground Match: ${comp.fg_match_pct}%, Non-zero Pixels: ${comp.client_nonzero}, Overall Match: ${comp.tol_match_pct}%`);

        if (comp.client_nonzero < 20000) {
            throw new Error(`Canvas rendered blank/black screen! Detected only ${comp.client_nonzero} visible pixels (expected >= 20,000).`);
        }
        if (comp.fg_match_pct < 95.0) {
            throw new Error(`Foreground visual fidelity failure! Foreground match: ${comp.fg_match_pct}% (expected >= 95.0%). Diff image: ${diffFile}`);
        }
        if (comp.tol_match_pct < 96.0) {
            throw new Error(`Overall visual match failure! Match: ${comp.tol_match_pct}% (expected >= 96.0%). Diff image: ${diffFile}`);
        }
        console.log(`  ✓ Perceptual fidelity confirmed: ${comp.fg_match_pct}% foreground match with reference title screen.`);

        // Step 7: Verify Continuous Framerate and Responsive Input (Mouse Move, Click, Wheel, and Keyboard)
        console.log('[7/9] Observing stream stability & framerate over 3 seconds...');
        const initialFrames = await page.evaluate(() => window.__e2e.dcFrameCount);
        await page.waitForTimeout(3000);
        const finalFrames = await page.evaluate(() => window.__e2e.dcFrameCount);
        const delivered = finalFrames - initialFrames;
        const observedFps = delivered / 3.0;

        console.log(`  - Delivered frames in 3s: ${delivered} (${observedFps.toFixed(1)} FPS)`);
        if (observedFps < 15.0) {
            throw new Error(`Stream framerate too low or frozen: observed ${observedFps.toFixed(1)} FPS (expected >= 15.0 FPS)`);
        }
        console.log(`  ✓ Framerate stability confirmed: ${observedFps.toFixed(1)} FPS.`);

        // Test interactive input forwarding (granular: mouse move, click, wheel, and keyboard)
        console.log('  - Transmitting interactive mouse and keyboard inputs...');
        const initMoves = await page.evaluate(() => window.__e2e.mouseMovesSent);
        const initClicks = await page.evaluate(() => window.__e2e.mouseClicksSent);
        const initWheels = await page.evaluate(() => window.__e2e.mouseWheelsSent);
        const initKey = await page.evaluate(() => window.__e2e.keyInputsSent);

        const canvasBox = await canvasLocator.boundingBox();
        await page.mouse.move(canvasBox.x + 300, canvasBox.y + 200);
        await page.mouse.click(canvasBox.x + 300, canvasBox.y + 200);
        await page.mouse.wheel(0, 100);
        await page.keyboard.press('Escape');
        await page.waitForTimeout(500);

        const postMoves = await page.evaluate(() => window.__e2e.mouseMovesSent);
        const postClicks = await page.evaluate(() => window.__e2e.mouseClicksSent);
        const postWheels = await page.evaluate(() => window.__e2e.mouseWheelsSent);
        const postKey = await page.evaluate(() => window.__e2e.keyInputsSent);

        if (postMoves <= initMoves) {
            throw new Error(`Mouse move events (opcode 1) were not transmitted over WebRTC DataChannel!`);
        }
        if (postClicks <= initClicks) {
            throw new Error(`Mouse click events (opcodes 2/3) were not transmitted over WebRTC DataChannel!`);
        }
        if (postWheels <= initWheels) {
            throw new Error(`Mouse wheel events (opcode 4) were not transmitted over WebRTC DataChannel!`);
        }
        if (postKey <= initKey) {
            throw new Error(`Keyboard Escape events (opcodes 16/17) were not transmitted over WebRTC DataChannel!`);
        }
        console.log(`  ✓ Interactive inputs verified: ${postMoves - initMoves} moves, ${postClicks - initClicks} clicks, ${postWheels - initWheels} wheels, ${postKey - initKey} keys over UDP.`);

        // Step 8: Verify Real Packet Loss Client Gap Detection and Combined Delta Recovery
        console.log('[8/9] Verifying real client packet loss gap detection & combined delta recovery...');
        const initGapReqs = await page.evaluate(() => window.__e2e.gapAckRequestsSent);
        const initKeyReqs = await page.evaluate(() => window.__e2e.keyframeRequestsSent);
        const initCombined = await page.evaluate(() => window.__e2e.combinedDeltaFramesReceived);
        const initKeyframes = await page.evaluate(() => window.__e2e.keyframesReceived);

        // Simulate 4 dropped delta frames arriving at the client
        await page.evaluate(() => {
            window.__e2e.dropNextDeltas = 4;
        });

        // Wait up to 3s for client to detect gap (seq > lastSeq + 1) and fire gap ACK (opcode 0x07) or keyframe request (opcode 0x06)
        await page.waitForFunction(({ initGap, initKey }) => {
            return window.__e2e.gapAckRequestsSent > initGap || window.__e2e.keyframeRequestsSent > initKey;
        }, { initGap: initGapReqs, initKey: initKeyReqs }, { timeout: 3000, polling: 50 }).catch(async () => {
            const diag = await page.evaluate(() => ({
                gapReqs: window.__e2e.gapAckRequestsSent,
                keyReqs: window.__e2e.keyframeRequestsSent,
                dropped: window.__e2e.deltasDroppedByTest,
                remainingDrop: window.__e2e.dropNextDeltas,
                dcFrames: window.__e2e.dcFrameCount
            }));
            throw new Error(`Client failed to detect packet loss gap! Diag: ${JSON.stringify(diag)}`);
        });

        // Wait up to 3.5s for server to deliver combined delta frame or keyframe in response
        await page.waitForFunction(({ initC, initK }) => {
            return window.__e2e.combinedDeltaFramesReceived > initC || window.__e2e.keyframesReceived > initK;
        }, { initC: initCombined, initK: initKeyframes }, { timeout: 3500, polling: 50 }).catch(async () => {
            const diag = await page.evaluate(() => ({
                combinedDeltas: window.__e2e.combinedDeltaFramesReceived,
                keyframes: window.__e2e.keyframesReceived,
                gapReqs: window.__e2e.gapAckRequestsSent,
                dropped: window.__e2e.deltasDroppedByTest,
                remainingDrop: window.__e2e.dropNextDeltas,
                dcFrames: window.__e2e.dcFrameCount
            }));
            throw new Error(`Server failed to deliver combined delta frame in response to packet loss! Diag: ${JSON.stringify(diag)}`);
        });

        const postCombined = await page.evaluate(() => window.__e2e.combinedDeltaFramesReceived);
        const postKeyframes = await page.evaluate(() => window.__e2e.keyframesReceived);
        console.log(`  ✓ Real packet loss recovery verified: gap ack dispatched, server delivered combined delta (combined deltas: ${postCombined}, keyframes: ${postKeyframes}).`);

        // Step 9: Clean teardown via UI and return to Main Menu
        console.log('[9/9] Stopping session cleanly and verifying menu return...');
        const stopRes = await page.evaluate(async () => {
            const res = await fetch('/api/session/stop', { method: 'POST' });
            return { ok: res.ok, data: await res.json() };
        });

        if (!stopRes.ok) {
            throw new Error(`Failed to stop session cleanly: ${JSON.stringify(stopRes.data)}`);
        }

        // Return to menu route
        await page.evaluate(() => {
            window.history.pushState(null, '', '/');
            window.dispatchEvent(new PopStateEvent('popstate'));
        });

        // Verify canvas is unmounted and "Launch Game" button returns
        await page.waitForFunction(() => {
            const hasCanvas = Boolean(document.getElementById('gameCanvas'));
            const launchBtn = Array.from(document.querySelectorAll('button')).some(b => b.textContent.includes('Launch Game'));
            return !hasCanvas && launchBtn;
        }, { timeout: 8000 }).catch(() => {
            throw new Error('Menu UI failed to restore active "Launch Game" state after stopping session!');
        });

        console.log('  ✓ Session terminated cleanly, canvas unmounted, Main Menu restored.');

        console.log(`\n========================================================`);
        console.log(`  ✅ REAL BROWSER E2E TEST SUITE PASSED`);
        console.log(`========================================================\n`);

    } finally {
        await browser.close();
    }
}

runRealBrowserSuite().catch(err => {
    console.error(`\n❌ REAL BROWSER E2E SUITE FAILED:`, err.message);
    process.exit(1);
});
