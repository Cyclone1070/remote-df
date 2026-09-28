const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');
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

async function ensureSessionRunning(baseUrl) {
    console.log(`Checking session status via ${baseUrl}/api/session...`);
    try {
        const res = execSync(`curl -s "${baseUrl}/api/session"`).toString().trim();
        const json = JSON.parse(res);
        if (json.state === 'running') {
            console.log(`  -> Session is already running (PID: ${json.pid}).`);
            return;
        }
    } catch (_) {}

    console.log(`  -> Starting fresh session via POST ${baseUrl}/api/session/start...`);
    try {
        execSync(`curl -s -X POST "${baseUrl}/api/session/start" -H "Content-Type: application/json" -d '{"gameId":"dwarf-fortress"}'`);
        await new Promise(r => setTimeout(r, 2000));
    } catch (e) {
        console.error('Failed to start session:', e.message);
    }
}

async function testNaturalRepro(targetUrl, screenshotPath) {
    const urlObj = new URL(targetUrl);
    const origin = urlObj.origin;
    await ensureSessionRunning(origin);

    console.log(`\n========================================================`);
    console.log(`  NATURAL FREEZE REPRODUCTION TEST (NO MOCKS / NO DROPS)`);
    console.log(`  Target: ${targetUrl}`);
    console.log(`========================================================\n`);

    const browser = await chromium.launch({
        headless: true,
        args: ['--use-gl=angle', '--use-angle=gl', '--no-sandbox']
    });

    const context = await browser.newContext({ viewport: { width: 1544, height: 928 } });
    const page = await context.newPage();

    let consoleLogs = [];
    page.on('console', msg => {
        const t = msg.text();
        if (t.includes('WebRTC') || t.includes('DataChannel') || t.includes('closed') || t.includes('Connecting')) {
            console.log(`  [CONSOLE] ${t}`);
            consoleLogs.push(t);
        }
    });

    console.log('[1/4] Navigating to game stream...');
    await page.goto(targetUrl, { waitUntil: 'domcontentloaded' });
    const canvas = page.locator('#gameCanvas');
    await canvas.waitFor({ state: 'attached', timeout: 15000 });

    console.log('[2/4] Waiting for WebRTC game stream to begin...');
    await page.waitForFunction(() => (window.__dfFrameCount || 0) >= 5, { timeout: 15000 });
    const initialFrames = await page.evaluate(() => window.__dfFrameCount || 0);
    console.log(`  -> Stream is actively rendering. Frame count: ${initialFrames}`);

    const box = await canvas.boundingBox();

    console.log('[3/4] Performing natural in-game clicks on title menu...');
    // In 1544x928, title screen menu buttons:
    // Box 1 (Create new world): y ≈ 516
    // Box 2 (Object testing arena): y ≈ 563
    // Box 3 (Settings): y ≈ 610
    // Box 4 (About DF): y ≈ 656
    // Box 5 (Quit): y ≈ 702
    
    // Normal user clicks navigating menu
    const clickX = box.x + (box.width * 0.5);
    const clickY = box.y + (702 * box.height / 928); // Natural click on Quit / exit option
    console.log(`  -> Clicking naturally at (${Math.round(clickX)}, ${Math.round(clickY)})...`);
    await page.mouse.click(clickX, clickY, { button: 'left', delay: 40 });

    console.log('[4/4] Observing client reaction for 5 seconds (testing for permanent freeze trap)...');
    let overlayAlwaysVisible = true;
    let framesStatic = true;
    let lastFrames = null;

    for (let s = 1; s <= 5; s++) {
        await page.waitForTimeout(1000);
        const status = await page.evaluate(() => {
            const spans = Array.from(document.querySelectorAll('span'));
            const s = spans.find(el => (el.textContent || '').includes('Connecting WebRTC P2P'));
            return {
                overlayVisible: Boolean(s),
                frames: window.__dfFrameCount || 0
            };
        });
        console.log(`  - Second ${s}: overlayVisible=${status.overlayVisible}, frames=${status.frames}`);
        if (!status.overlayVisible) overlayAlwaysVisible = false;
        if (lastFrames !== null && status.frames !== lastFrames) framesStatic = false;
        lastFrames = status.frames;
    }

    await page.screenshot({ path: screenshotPath });
    console.log(`  -> Saved screenshot to ${screenshotPath}`);

    await browser.close();

    const isFrozen = overlayAlwaysVisible && framesStatic;
    if (isFrozen) {
        console.log(`  ✅ REPRODUCED: Screen is permanently frozen with "CONNECTING WEBRTC P2P..." on ${targetUrl}\n`);
        return true;
    } else {
        console.log(`  ❌ NOT REPRODUCED on ${targetUrl}\n`);
        return false;
    }
}

(async () => {
    const urls = [
        { name: 'Direct IP', url: 'http://100.73.151.90:8484/df', screenshot: '/tmp/natural_freeze_direct_ip.png' },
        { name: 'Cloudflare', url: 'https://gmc-bond-strategies-vocals.trycloudflare.com/df', screenshot: '/tmp/natural_freeze_cloudflare.png' }
    ];

    let allPassed = true;
    for (const u of urls) {
        const ok = await testNaturalRepro(u.url, u.screenshot);
        if (!ok) allPassed = false;
    }

    console.log(`========================================================`);
    if (allPassed) {
        console.log(`  🎉 NATURAL REPRODUCTION CONFIRMED ON BOTH URLS!`);
        console.log(`========================================================\n`);
        process.exit(0);
    } else {
        console.log(`  ❌ FAILED TO REPRODUCE ON ALL URLS.`);
        console.log(`========================================================\n`);
        process.exit(1);
    }
})();
