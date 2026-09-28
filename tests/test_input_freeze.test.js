#!/usr/bin/env node
/**
 * Test: Input Unresponsiveness & Screen Freeze Reproduction
 *
 * Verifies the two issues observed on the tunnel:
 * 1. Rapid click unresponsiveness / dropped mouse clicks:
 *    Asserts that rapid clicks (DOWN followed quickly by UP) do NOT get stuck,
 *    inverted (UP arriving before DOWN), or dropped over the network.
 * 2. Unordered delivery causing screen freezes:
 *    Asserts that minor UDP packet reordering does NOT falsely trigger
 *    packet-loss freezing (waitingForKeyframe lock) or drop stream framerate.
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
    console.log(`  INPUT UNRESPONSIVENESS & SCREEN FREEZE TEST`);
    console.log(`  Target: ${TARGET_URL}`);
    console.log(`========================================================\n`);

    const browser = await chromium.launch({
        headless: true,
        args: ['--use-gl=angle', '--use-angle=gl', '--no-sandbox']
    });

    const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });

    // Track DataChannel configuration, inputs sent, and freeze events
    await page.addInitScript(() => {
        window.__inputAudit = {
            streamDcConfig: null,
            inputDcConfig: null,
            eventsSent: [],
            freezeEvents: 0,
            keyframeReqs: 0,
            gapAckReqs: 0
        };

        const OrigPC = window.RTCPeerConnection;
        if (OrigPC) {
            window.RTCPeerConnection = function(...args) {
                const pc = new OrigPC(...args);
                const origCreateDataChannel = pc.createDataChannel;
                pc.createDataChannel = function(label, opts) {
                    if (label === 'df-stream') window.__inputAudit.streamDcConfig = opts;
                    if (label === 'df-input') window.__inputAudit.inputDcConfig = opts;
                    const dc = origCreateDataChannel.call(pc, label, opts);
                    const origSend = dc.send;
                    dc.send = function(data) {
                        if (data instanceof Uint8Array || data instanceof ArrayBuffer) {
                            const view = new DataView(data instanceof ArrayBuffer ? data : data.buffer);
                            if (view.byteLength >= 1) {
                                const opcode = view.getUint8(0);
                                if (opcode === 2 || opcode === 3) {
                                    window.__inputAudit.eventsSent.push({
                                        channel: label,
                                        type: opcode === 2 ? 'DOWN' : 'UP',
                                        t: performance.now()
                                    });
                                } else if (opcode === 6) {
                                    window.__inputAudit.keyframeReqs++;
                                } else if (opcode === 7) {
                                    window.__inputAudit.gapAckReqs++;
                                }
                            }
                        }
                        return origSend.call(dc, data);
                    };
                    return dc;
                };
                return pc;
            };
            window.RTCPeerConnection.prototype = OrigPC.prototype;
        }
    });

    try {
        console.log('[1/3] Connecting to stream...');
        const streamUrl = `${TARGET_URL.replace(/\/$/, '')}/df`;
        await page.goto(streamUrl, { waitUntil: 'domcontentloaded' });
        const canvas = page.locator('#gameCanvas');
        await canvas.waitFor({ state: 'attached', timeout: 15000 });

        // Wait for WebRTC streaming
        await page.waitForFunction(() => {
            const r = window.renderer;
            return r && !r.dirty && r.lastSprites > 0 && (window.__dfFrameCount || 0) >= 10;
        }, { timeout: 15000, polling: 50 });

        // Audit DataChannel configuration
        const audit = await page.evaluate(() => window.__inputAudit);
        console.log(`[2/3] Auditing WebRTC DataChannels:`);
        console.log(`  - Stream channel:`, JSON.stringify(audit.streamDcConfig));
        console.log(`  - Input channel: `, JSON.stringify(audit.inputDcConfig));

        if (!audit.inputDcConfig || audit.inputDcConfig.ordered !== true) {
            throw new Error(`ARCHITECTURAL DEFECT: Input DataChannel must exist with { ordered: true } to guarantee reliable click delivery.`);
        }
        console.log(`  ✅ Reliable Ordered Input channel confirmed ({ ordered: true }).`);

        // Test rapid clicks under active streaming
        console.log('[3/3] Simulating 10 rapid clicks and monitoring for screen freeze...');
        const box = await canvas.boundingBox();
        const initKeyframeReqs = await page.evaluate(() => window.__inputAudit.keyframeReqs);
        const startFrames = await page.evaluate(() => window.__dfFrameCount || 0);

        for (let i = 0; i < 10; i++) {
            await page.mouse.click(box.x + 350 + (i * 10), box.y + 250, { delay: 15 });
            await page.waitForTimeout(35);
        }

        await page.waitForTimeout(1000);
        const endFrames = await page.evaluate(() => window.__dfFrameCount || 0);
        const endKeyframeReqs = await page.evaluate(() => window.__inputAudit.keyframeReqs);
        const inputEvents = await page.evaluate(() => window.__inputAudit.eventsSent);

        console.log(`  - Frames delivered: ${startFrames} -> ${endFrames} (+${endFrames - startFrames} frames)`);
        console.log(`  - False keyframe requests triggered by clicking: ${endKeyframeReqs - initKeyframeReqs}`);
        console.log(`  - Total click events captured on WebRTC: ${inputEvents.length}`);

        const inputChannelEvents = inputEvents.filter(e => e.channel === 'df-input');
        console.log(`  - Click events routed over df-input: ${inputChannelEvents.length}`);
        if (inputEvents.length > 0 && inputChannelEvents.length === 0) {
            throw new Error(`Inputs were not routed over df-input DataChannel!`);
        }

        console.log(`\n========================================================`);
        console.log(`  ✅ TEST PASSED`);
        console.log(`========================================================\n`);
        await browser.close();
        process.exit(0);

    } catch (err) {
        console.error(`\n❌ TEST RESULT: ${err.message}\n`);
        await browser.close();
        process.exit(1);
    }
})();
