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
            const npxPath = execSync(`find "${homeDir}/.npm" -name "playwright" -type d 2>/dev/null | grep "/node_modules/playwright$" | head -n 1`).toString().trim();
            if (npxPath && fs.existsSync(npxPath)) {
                playwright = require(npxPath);
            }
        } catch (_) {}
    }
}

if (!playwright) {
    console.error('Playwright not found.');
    process.exit(1);
}

const { chromium } = playwright;
const TARGET_URL = process.argv[2] || 'http://100.73.151.90:8484/df';

(async () => {
    console.log(`Connecting to: ${TARGET_URL}`);
    const browser = await chromium.launch({
        headless: true,
        args: ['--use-gl=angle', '--use-angle=gl', '--no-sandbox']
    });

    const context = await browser.newContext({ viewport: { width: 1544, height: 928 } });
    const page = await context.newPage();

    page.on('console', msg => {
        console.log(`[BROWSER CONSOLE] ${msg.text()}`);
    });

    page.on('pageerror', err => {
        console.error(`[PAGE ERROR] ${err.message}`);
    });

    // Instrument RTCPeerConnection and WebSocket
    await page.addInitScript(() => {
        window.__eventsLog = [];

        // Intercept WebSocket
        const OrigWS = window.WebSocket;
        window.WebSocket = function(...args) {
            const ws = new OrigWS(...args);
            console.log(`[HOOK WS] new WebSocket(${args[0]})`);
            ws.addEventListener('open', () => {
                console.log(`[HOOK WS] open`);
                window.__eventsLog.push({ t: Date.now(), type: 'ws_open' });
            });
            ws.addEventListener('close', (e) => {
                console.log(`[HOOK WS] close code=${e.code} reason=${e.reason} wasClean=${e.wasClean}`);
                window.__eventsLog.push({ t: Date.now(), type: 'ws_close', code: e.code, reason: e.reason });
            });
            ws.addEventListener('error', (e) => {
                console.log(`[HOOK WS] error`);
                window.__eventsLog.push({ t: Date.now(), type: 'ws_error' });
            });
            return ws;
        };
        window.WebSocket.prototype = OrigWS.prototype;
        window.WebSocket.OPEN = OrigWS.OPEN;
        window.WebSocket.CLOSED = OrigWS.CLOSED;
        window.WebSocket.CLOSING = OrigWS.CLOSING;
        window.WebSocket.CONNECTING = OrigWS.CONNECTING;

        // Intercept RTCPeerConnection
        const OrigPC = window.RTCPeerConnection;
        if (OrigPC) {
            window.RTCPeerConnection = function(...args) {
                const pc = new OrigPC(...args);
                console.log(`[HOOK PC] new RTCPeerConnection`);

                pc.addEventListener('connectionstatechange', () => {
                    console.log(`[HOOK PC] connectionState -> ${pc.connectionState}`);
                    window.__eventsLog.push({ t: Date.now(), type: 'pc_connectionState', state: pc.connectionState });
                });
                pc.addEventListener('iceconnectionstatechange', () => {
                    console.log(`[HOOK PC] iceConnectionState -> ${pc.iceConnectionState}`);
                    window.__eventsLog.push({ t: Date.now(), type: 'pc_iceConnectionState', state: pc.iceConnectionState });
                });
                pc.addEventListener('signalingstatechange', () => {
                    console.log(`[HOOK PC] signalingState -> ${pc.signalingState}`);
                    window.__eventsLog.push({ t: Date.now(), type: 'pc_signalingState', state: pc.signalingState });
                });

                const origCreateDataChannel = pc.createDataChannel;
                pc.createDataChannel = function(label, opts) {
                    const dc = origCreateDataChannel.call(pc, label, opts);
                    console.log(`[HOOK DC] createDataChannel('${label}', ${JSON.stringify(opts)})`);

                    dc.addEventListener('open', () => {
                        console.log(`[HOOK DC] '${label}' open`);
                        window.__eventsLog.push({ t: Date.now(), type: 'dc_open', label });
                    });
                    dc.addEventListener('close', () => {
                        console.log(`[HOOK DC] '${label}' close (readyState: ${dc.readyState})`);
                        window.__eventsLog.push({ t: Date.now(), type: 'dc_close', label });
                    });
                    dc.addEventListener('error', (err) => {
                        console.log(`[HOOK DC] '${label}' error: ${err.message || err}`);
                        window.__eventsLog.push({ t: Date.now(), type: 'dc_error', label, err: String(err) });
                    });
                    return dc;
                };

                const origClose = pc.close;
                pc.close = function() {
                    console.log(`[HOOK PC] pc.close() called by script! Call stack: ${new Error().stack}`);
                    window.__eventsLog.push({ t: Date.now(), type: 'pc_close_called', stack: new Error().stack });
                    return origClose.call(pc);
                };

                return pc;
            };
            window.RTCPeerConnection.prototype = OrigPC.prototype;
        }
    });

    await page.goto(TARGET_URL, { waitUntil: 'domcontentloaded' });

    console.log('Waiting for #gameCanvas...');
    const canvas = page.locator('#gameCanvas');
    await canvas.waitFor({ state: 'attached', timeout: 15000 });

    // Wait until WebRTC is ready
    console.log('Waiting for stream frames...');
    await page.waitForFunction(() => (window.__dfFrameCount || 0) >= 5, { timeout: 15000 });

    // Clicks from the user incident
    const testClicks = [
        { x: 593, y: 377, button: 'left' },
        { x: 1244, y: 383, button: 'right' },
        { x: 286, y: 226, button: 'left' },
        { x: 992, y: 298, button: 'left' },
        { x: 1059, y: 443, button: 'left' },
        { x: 743, y: 237, button: 'left' },
        { x: 797, y: 434, button: 'left' },
        { x: 421, y: 514, button: 'right' },
        { x: 597, y: 661, button: 'left' },
        { x: 1171, y: 253, button: 'right' },
        { x: 1283, y: 672, button: 'left' },
        { x: 1095, y: 524, button: 'left' },
        { x: 1055, y: 329, button: 'left' },
        { x: 354, y: 686, button: 'left' },
        { x: 365, y: 253, button: 'right' },
        { x: 366, y: 423, button: 'right' },
        { x: 643, y: 209, button: 'right' },
        { x: 570, y: 468, button: 'left' },
        { x: 412, y: 215, button: 'right' },
        { x: 920, y: 336, button: 'left' },
        { x: 850, y: 558, button: 'left' },
        { x: 924, y: 711, button: 'right' },
        { x: 263, y: 749, button: 'right' },
        { x: 432, y: 614, button: 'left' },
        { x: 584, y: 274, button: 'left' },
        { x: 537, y: 562, button: 'left' },
        { x: 795, y: 531, button: 'left' },
        { x: 684, y: 715, button: 'left' },
        { x: 337, y: 243, button: 'left' },
        { x: 469, y: 151, button: 'left' }
    ];

    console.log(`Starting replay of ${testClicks.length} clicks...`);
    const box = await canvas.boundingBox();

    let reproduced = false;
    for (let i = 0; i < testClicks.length; i++) {
        const c = testClicks[i];
        const clickX = box.x + (c.x * box.width / 1544);
        const clickY = box.y + (c.y * box.height / 928);

        if (c.button === 'right') {
            await page.mouse.click(clickX, clickY, { button: 'right', delay: 30 });
        } else {
            await page.mouse.click(clickX, clickY, { button: 'left', delay: 30 });
        }
        await page.waitForTimeout(80);

        // Check if overlay appeared
        const overlayVisible = await page.evaluate(() => {
            const el = document.querySelector('p');
            return el && el.innerText.includes('CONNECTING WEBRTC P2P');
        });

        if (overlayVisible) {
            console.log(`🚨 REPRODUCED at click ${i + 1} (${c.button} at ${c.x}, ${c.y})! Overlay CONNECTING WEBRTC P2P is visible!`);
            reproduced = true;
            break;
        }
    }

    console.log('Post-clicks observation: waiting 5 seconds...');
    await page.waitForTimeout(5000);

    const finalStatus = await page.evaluate(() => {
        const overlay = document.querySelector('p');
        return {
            overlayText: overlay ? overlay.innerText : null,
            frameCount: window.__dfFrameCount || 0,
            eventsLog: window.__eventsLog || []
        };
    });

    console.log('Final status:', JSON.stringify(finalStatus, null, 2));

    await page.screenshot({ path: '/tmp/repro_freeze_result.png' });
    console.log('Saved screenshot to /tmp/repro_freeze_result.png');

    await browser.close();
    process.exit(reproduced ? 0 : 2);
})();
