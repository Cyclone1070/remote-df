#!/usr/bin/env node
/**
 * Test: WebRTC Direct P2P Texture Delivery
 *
 * Verifies that once WebRTC DataChannel is connected:
 * 1. Textures are delivered directly over WebRTC DataChannel (UDP).
 * 2. Textures do NOT leak over the WebSocket tunnel.
 * 3. The tunnel is solely used for signaling, making the stream identical to direct IP.
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
const TARGET_URL = process.argv[2] || 'http://100.73.151.90:8484';

(async () => {
    console.log(`\n========================================================`);
    console.log(`  WEBRTC DIRECT TEXTURE DELIVERY TEST`);
    console.log(`  Target: ${TARGET_URL}`);
    console.log(`========================================================\n`);

    const browser = await chromium.launch({
        headless: true,
        args: ['--use-gl=angle', '--use-angle=gl', '--no-sandbox']
    });

    const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });

    // Track texture packets received on DataChannel vs WebSocket
    await page.addInitScript(() => {
        window.__transportAudit = {
            dcTextures: 0,
            wsTextures: 0,
            dcFrames: 0,
            wsFrames: 0
        };

        const OrigPC = window.RTCPeerConnection;
        if (OrigPC) {
            window.RTCPeerConnection = function(...args) {
                const pc = new OrigPC(...args);
                const origCreateDataChannel = pc.createDataChannel;
                pc.createDataChannel = function(label, opts) {
                    const dc = origCreateDataChannel.call(pc, label, opts);
                    if (label === 'df-stream') {
                        dc.addEventListener('message', (ev) => {
                            if (ev.data instanceof ArrayBuffer && ev.data.byteLength >= 2) {
                                const v = new DataView(ev.data);
                                if (v.getUint8(0) === 0x44 && v.getUint8(1) === 0x54) { // 'DT'
                                    window.__transportAudit.dcTextures++;
                                } else if (v.getUint8(0) === 0x44 && v.getUint8(1) === 0x46) { // 'DF'
                                    window.__transportAudit.dcFrames++;
                                }
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
                const ws = new OrigWS(url, ...args);
                ws.addEventListener('message', (ev) => {
                    if (ev.data instanceof ArrayBuffer && ev.data.byteLength >= 2) {
                        const v = new DataView(ev.data);
                        if (v.getUint8(0) === 0x44 && v.getUint8(1) === 0x54) { // 'DT'
                            window.__transportAudit.wsTextures++;
                        } else if (v.getUint8(0) === 0x44 && v.getUint8(1) === 0x46) { // 'DF'
                            window.__transportAudit.wsFrames++;
                        }
                    }
                });
                return ws;
            };
            window.WebSocket.prototype = OrigWS.prototype;
        }
    });

    try {
        console.log('[1/3] Navigating to application and ensuring session active...');
        const streamUrl = `${TARGET_URL.replace(/\/$/, '')}/df`;
        await page.goto(streamUrl, { waitUntil: 'domcontentloaded' });
        await page.waitForSelector('#gameCanvas', { timeout: 15000 });

        console.log('[2/3] Waiting for WebRTC DataChannel to open and stream...');
        await page.waitForFunction(() => {
            const audit = window.__transportAudit;
            return audit && audit.dcFrames >= 20;
        }, { timeout: 15000, polling: 100 });

        // Sample for 2 seconds while DataChannel is fully active
        await page.waitForTimeout(2000);

        const audit = await page.evaluate(() => window.__transportAudit);
        console.log(`[3/3] Transport Audit Results:`, JSON.stringify(audit, null, 2));

        if (audit.wsFrames > 0) {
            throw new Error(`LEAK DETECTED: ${audit.wsFrames} stream frames leaked over WebSocket! Stream must wait for WebRTC DataChannel.`);
        }
        if (audit.wsTextures > 0) {
            throw new Error(`LEAK DETECTED: ${audit.wsTextures} textures leaked over WebSocket! All textures must travel over WebRTC DataChannel.`);
        }
        if (audit.dcTextures === 0) {
            throw new Error(`Zero textures delivered over WebRTC DataChannel!`);
        }
        if (audit.dcFrames === 0) {
            throw new Error(`Zero stream frames delivered over WebRTC DataChannel!`);
        }

        console.log(`\n========================================================`);
        console.log(`  ✅ TEST PASSED: Textures are streaming over direct WebRTC DataChannel.`);
        console.log(`========================================================\n`);
        await browser.close();
        process.exit(0);

    } catch (err) {
        console.error(`\n❌ TEST FAILED: ${err.message}\n`);
        await browser.close();
        process.exit(1);
    }
})();
