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
    console.log(`\n========================================================`);
    console.log(`  PROVING ROOT CAUSE: DATACHANNEL CLOSE PERM-FREEZE`);
    console.log(`  Target: ${TARGET_URL}`);
    console.log(`========================================================\n`);

    const browser = await chromium.launch({
        headless: true,
        args: ['--use-gl=angle', '--use-angle=gl', '--no-sandbox']
    });

    const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });

    await page.addInitScript(() => {
        const OrigPC = window.RTCPeerConnection;
        if (OrigPC) {
            window.RTCPeerConnection = function(...args) {
                const pc = new OrigPC(...args);
                const origCreateDataChannel = pc.createDataChannel;
                pc.createDataChannel = function(label, opts) {
                    const dc = origCreateDataChannel.call(pc, label, opts);
                    if (label === 'df-stream') {
                        window.__streamDc = dc;
                    }
                    return dc;
                };
                return pc;
            };
            window.RTCPeerConnection.prototype = OrigPC.prototype;
        }
    });

    await page.goto(TARGET_URL, { waitUntil: 'domcontentloaded' });
    const canvas = page.locator('#gameCanvas');
    await canvas.waitFor({ state: 'attached', timeout: 15000 });

    console.log('[1/4] Waiting for WebRTC streaming...');
    await page.waitForFunction(() => (window.__dfFrameCount || 0) >= 5, { timeout: 15000 });
    console.log('  -> WebRTC stream is active and running.');

    console.log('\n[2/4] Triggering DataChannel close (dc.close())...');
    await page.evaluate(() => {
        if (window.__streamDc) {
            window.__streamDc.close();
        }
    });

    console.log('\n[3/4] Observing client behavior over 6 seconds...');
    let overlayObserved = false;
    let recovered = false;

    for (let s = 1; s <= 6; s++) {
        await page.waitForTimeout(1000);
        const status = await page.evaluate(() => {
            const bodyText = document.body.innerText || '';
            const spans = Array.from(document.querySelectorAll('span'));
            const overlaySpan = spans.find(s => (s.textContent || '').toLowerCase().includes('connecting webrtc p2p'));
            return {
                overlayVisible: Boolean(overlaySpan),
                overlayText: overlaySpan ? overlaySpan.textContent : null,
                frames: window.__dfFrameCount || 0
            };
        });

        console.log(`  - Second ${s}: overlayVisible=${status.overlayVisible}, frames=${status.frames}, text='${status.overlayText}'`);
        if (status.overlayVisible) {
            overlayObserved = true;
        }
        if (overlayObserved && !status.overlayVisible) {
            recovered = true;
        }
    }

    console.log('\n[4/4] Verification results:');
    console.log(`  - Did permanent freeze overlay appear? ${overlayObserved}`);
    console.log(`  - Did client recover autonomously? ${recovered}`);

    await page.screenshot({ path: '/tmp/proven_dc_freeze_repro.png' });
    console.log('Saved screenshot to /tmp/proven_dc_freeze_repro.png');

    await browser.close();

    if (overlayObserved && !recovered) {
        console.log(`\n🎯 100% REPRODUCED: dc.close() permanently locks client on Connecting WebRTC P2P... with zero recovery!\n`);
        process.exit(0);
    } else {
        console.log(`\n❌ Not reproduced as expected.\n`);
        process.exit(1);
    }
})();
