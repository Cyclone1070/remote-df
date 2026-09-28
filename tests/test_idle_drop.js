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

const { chromium } = playwright;
const TARGET_URL = process.argv[2] || 'http://100.73.151.90:8484/df';

(async () => {
    console.log(`Connecting to: ${TARGET_URL}`);
    const browser = await chromium.launch({
        headless: true,
        args: ['--use-gl=angle', '--use-angle=gl', '--no-sandbox']
    });

    const page = await browser.newPage({ viewport: { width: 1544, height: 928 } });

    await page.addInitScript(() => {
        window.__events = [];
        const log = (msg) => {
            const t = Date.now();
            window.__events.push({ t, msg });
            console.log(`[T+${t - window.__startTime}ms] ${msg}`);
        };
        window.__startTime = Date.now();

        // Hook WebSocket
        const OrigWS = window.WebSocket;
        window.WebSocket = function(...args) {
            const ws = new OrigWS(...args);
            window.__ws = ws;
            log(`[WS] created: ${args[0]}`);
            ws.addEventListener('open', () => log('[WS] open'));
            ws.addEventListener('close', (e) => log(`[WS] close code=${e.code} reason='${e.reason}' wasClean=${e.wasClean}`));
            ws.addEventListener('error', (e) => log(`[WS] error`));
            return ws;
        };
        window.WebSocket.prototype = OrigWS.prototype;
        window.WebSocket.OPEN = OrigWS.OPEN;
        window.WebSocket.CLOSED = OrigWS.CLOSED;
        window.WebSocket.CLOSING = OrigWS.CLOSING;
        window.WebSocket.CONNECTING = OrigWS.CONNECTING;

        // Hook RTCPeerConnection
        const OrigPC = window.RTCPeerConnection;
        if (OrigPC) {
            window.RTCPeerConnection = function(...args) {
                const pc = new OrigPC(...args);
                window.__pc = pc;
                log(`[PC] created`);

                pc.addEventListener('connectionstatechange', () => log(`[PC] connectionState -> ${pc.connectionState}`));
                pc.addEventListener('iceconnectionstatechange', () => log(`[PC] iceConnectionState -> ${pc.iceConnectionState}`));

                const origCreateDataChannel = pc.createDataChannel;
                pc.createDataChannel = function(label, opts) {
                    const dc = origCreateDataChannel.call(pc, label, opts);
                    log(`[DC] '${label}' created`);
                    dc.addEventListener('open', () => log(`[DC] '${label}' open`));
                    dc.addEventListener('close', () => log(`[DC] '${label}' close`));
                    dc.addEventListener('error', (err) => log(`[DC] '${label}' error: ${err.message || err}`));
                    return dc;
                };
                return pc;
            };
            window.RTCPeerConnection.prototype = OrigPC.prototype;
        }
    });

    page.on('console', msg => {
        const text = msg.text();
        if (text.startsWith('[T+')) {
            console.log(text);
        }
    });

    await page.goto(TARGET_URL, { waitUntil: 'domcontentloaded' });
    const canvas = page.locator('#gameCanvas');
    await canvas.waitFor({ state: 'attached', timeout: 15000 });

    console.log('Waiting for initial WebRTC connection...');
    await page.waitForFunction(() => (window.__dfFrameCount || 0) >= 5, { timeout: 15000 });
    console.log('WebRTC active! Now monitoring idle connection for 30 seconds...');

    for (let s = 1; s <= 30; s++) {
        await page.waitForTimeout(1000);
        const status = await page.evaluate(() => {
            const overlay = document.querySelector('p');
            const overlayText = overlay ? overlay.innerText : null;
            return {
                frames: window.__dfFrameCount || 0,
                wsState: window.__ws ? window.__ws.readyState : null,
                pcState: window.__pc ? window.__pc.connectionState : null,
                overlayText
            };
        });

        if (status.overlayText && status.overlayText.includes('CONNECTING WEBRTC P2P')) {
            console.log(`🚨 At second ${s}: Overlay appeared!`, status);
            break;
        }

        if (status.wsState === 3 || status.pcState === 'closed' || status.pcState === 'failed') {
            console.log(`🚨 At second ${s}: Connection dropped!`, status);
            break;
        }

        if (s % 5 === 0) {
            console.log(`[Second ${s}/30] frames=${status.frames}, wsState=${status.wsState}, pcState=${status.pcState}`);
        }
    }

    const events = await page.evaluate(() => window.__events);
    console.log('\nFinal event history:');
    events.forEach(e => console.log(`  +${e.t - events[0].t}ms: ${e.msg}`));

    await browser.close();
})();
