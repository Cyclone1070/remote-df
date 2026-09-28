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
    console.error('Playwright not found');
    process.exit(2);
}

const { chromium } = playwright;

async function resetSessionToTitle(origin) {
    console.log(`Resetting fresh game session via ${origin}...`);
    try {
        execSync(`curl -s -X POST "${origin}/api/session/stop"`);
        await new Promise(r => setTimeout(r, 1000));
    } catch (_) {}
    try {
        execSync(`curl -s -X POST "${origin}/api/session/start" -H "Content-Type: application/json" -d '{"gameId":"dwarf-fortress"}'`);
        await new Promise(r => setTimeout(r, 2500));
    } catch (e) {
        console.error('Failed to start session:', e.message);
    }
}

async function testUrl(targetUrl, screenshotPath) {
    const urlObj = new URL(targetUrl);
    await resetSessionToTitle(urlObj.origin);

    console.log(`\n========================================================`);
    console.log(`  NATURAL FREEZE REPRODUCTION (ZERO MOCKS / ZERO CODE INJECTION)`);
    console.log(`  Target: ${targetUrl}`);
    console.log(`========================================================\n`);

    const browser = await chromium.launch({
        headless: true,
        args: ['--use-gl=angle', '--use-angle=gl', '--no-sandbox']
    });

    const context = await browser.newContext({ viewport: { width: 1544, height: 928 } });
    const page = await context.newPage();

    let logs = [];
    page.on('console', msg => {
        const t = msg.text();
        if (t.includes('WebRTC') || t.includes('DataChannel') || t.includes('closed') || t.includes('Connecting')) {
            console.log(`  [CONSOLE] ${t}`);
            logs.push(t);
        }
    });

    console.log('[1/4] Navigating to target...');
    await page.goto(targetUrl, { waitUntil: 'domcontentloaded' });
    const canvas = page.locator('#gameCanvas');
    await canvas.waitFor({ state: 'attached', timeout: 15000 });

    console.log('[2/4] Waiting for WebRTC video stream...');
    await page.waitForFunction(() => (window.__dfFrameCount || 0) >= 10, { timeout: 15000 });
    await page.waitForTimeout(500); // Allow input DataChannel to fully open
    const startFrames = await page.evaluate(() => window.__dfFrameCount || 0);
    console.log(`  -> Stream active. Initial frames: ${startFrames}`);

    const box = await canvas.boundingBox();

    console.log('[3/4] Performing natural in-game menu clicks (no artificial drops)...');
    // Click title menu Quit button (767, 657)
    await page.mouse.click(box.x + 767, box.y + 657, { button: 'left', delay: 50 });

    console.log('[4/4] Observing client freeze persistence across 4 seconds...');
    let overlayAlwaysVisible = true;
    let framesStatic = true;
    let lastObservedFrames = null;

    for (let s = 1; s <= 4; s++) {
        await page.waitForTimeout(1000);
        const status = await page.evaluate(() => {
            const spans = Array.from(document.querySelectorAll('span'));
            const s = spans.find(el => (el.textContent || '').includes('Connecting WebRTC P2P'));
            return {
                overlayVisible: Boolean(s),
                currentFrames: window.__dfFrameCount || 0
            };
        });
        console.log(`  - Second ${s}: overlayVisible=${status.overlayVisible}, frames=${status.currentFrames}`);
        if (!status.overlayVisible) {
            overlayAlwaysVisible = false;
        }
        if (lastObservedFrames !== null && status.currentFrames !== lastObservedFrames) {
            framesStatic = false;
        }
        lastObservedFrames = status.currentFrames;
    }

    const permanentlyFrozen = overlayAlwaysVisible && framesStatic;

    await page.screenshot({ path: screenshotPath });
    console.log(`  -> Saved screenshot to ${screenshotPath}`);

    await browser.close();

    if (permanentlyFrozen) {
        console.log(`  ✅ REPRODUCED NATURALLY: Permanent "CONNECTING WEBRTC P2P..." freeze on ${targetUrl}`);
        return true;
    } else {
        console.log(`  ❌ NOT REPRODUCED: Client did not enter permanent freeze on ${targetUrl}`);
        return false;
    }
}

(async () => {
    const urls = [
        { name: 'Direct IP', url: 'http://100.73.151.90:8484/df', screenshot: '/tmp/repro_natural_direct_ip.png' },
        { name: 'Cloudflare', url: 'https://gmc-bond-strategies-vocals.trycloudflare.com/df', screenshot: '/tmp/repro_natural_cloudflare.png' }
    ];

    let allReproduced = true;
    for (const item of urls) {
        const ok = await testUrl(item.url, item.screenshot);
        if (!ok) allReproduced = false;
    }

    console.log(`\n========================================================`);
    if (allReproduced) {
        console.log(`  🎉 NATURAL DETERMINISTIC REPRODUCTION PROVEN ON BOTH URLS!`);
        console.log(`========================================================\n`);
        process.exit(0);
    } else {
        console.log(`  ⚠️ FAILED TO REPRODUCE ON ALL URLS.`);
        console.log(`========================================================\n`);
        process.exit(1);
    }
})();
