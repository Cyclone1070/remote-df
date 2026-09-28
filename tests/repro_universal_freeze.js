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
const TARGET_URL = process.argv[2] || 'http://100.73.151.90:8484/df';
const SCREENSHOT_PATH = process.argv[3] || '/tmp/repro_universal_freeze.png';

(async () => {
    console.log(`\n========================================================`);
    console.log(`  UNIVERSAL FREEZE REPRODUCTION TEST`);
    console.log(`  Target: ${TARGET_URL}`);
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
        if (t.includes('WebRTC') || t.includes('DataChannel') || t.includes('Connecting') || t.includes('closed') || t.includes('error') || t.includes('State')) {
            console.log(`[CONSOLE] ${t}`);
            logs.push(t);
        }
    });

    console.log('[1/4] Navigating to target...');
    await page.goto(TARGET_URL, { waitUntil: 'domcontentloaded' });
    const canvas = page.locator('#gameCanvas');
    await canvas.waitFor({ state: 'attached', timeout: 15000 });

    console.log('[2/4] Waiting for WebRTC video stream...');
    await page.waitForFunction(() => (window.__dfFrameCount || 0) >= 5, { timeout: 15000 });
    console.log('  -> Stream is active.');

    const box = await canvas.boundingBox();

    // Sequence of clicks from normal interaction on title screen
    const clickSequence = [
        { desc: 'Left click menu area', x: 838, y: 581, btn: 'left' },
        { desc: 'Right click cancel/back', x: 855, y: 606, btn: 'right' },
        { desc: 'Left click lower menu', x: 847, y: 581, btn: 'left' },
        { desc: 'Right click cancel/back', x: 833, y: 630, btn: 'right' },
        { desc: 'Left click menu item', x: 836, y: 574, btn: 'left' },
        { desc: 'Right click / context click', x: 820, y: 682, btn: 'right' }
    ];

    console.log(`\n[3/4] Executing ${clickSequence.length} normal in-game clicks...`);
    let freezeTriggered = false;

    for (let i = 0; i < clickSequence.length; i++) {
        const c = clickSequence[i];
        console.log(`  - [Click ${i + 1}/${clickSequence.length}] ${c.desc} at (${c.x}, ${c.y}) [${c.btn}]...`);
        const targetX = box.x + (c.x * box.width / 1544);
        const targetY = box.y + (c.y * box.height / 928);
        await page.mouse.click(targetX, targetY, { button: c.btn, delay: 30 });
        await page.waitForTimeout(200);

        const isOverlay = await page.evaluate(() => {
            const spans = Array.from(document.querySelectorAll('span'));
            const s = spans.find(el => (el.textContent || '').includes('Connecting WebRTC P2P'));
            return Boolean(s);
        });

        if (isOverlay) {
            console.log(`\n🚨 PERMANENT FREEZE TRIGGERED at click ${i + 1} (${c.desc})!`);
            freezeTriggered = true;
            break;
        }
    }

    console.log('\n[4/4] Observing client persistence for 4 seconds...');
    let stillVisible = false;
    for (let s = 1; s <= 4; s++) {
        await page.waitForTimeout(1000);
        const status = await page.evaluate(() => {
            const spans = Array.from(document.querySelectorAll('span'));
            const s = spans.find(el => (el.textContent || '').includes('Connecting WebRTC P2P'));
            return {
                overlay: Boolean(s),
                frames: window.__dfFrameCount || 0
            };
        });
        console.log(`  - Second ${s}: overlayVisible=${status.overlay}, frames=${status.frames}`);
        if (status.overlay) stillVisible = true;
    }

    await page.screenshot({ path: SCREENSHOT_PATH });
    console.log(`Saved screenshot to ${SCREENSHOT_PATH}`);

    await browser.close();

    if (stillVisible) {
        console.log(`\n✅ REPRODUCED: Screen permanently frozen with "CONNECTING WEBRTC P2P..."!\n`);
        process.exit(0);
    } else {
        console.log(`\n❌ NOT REPRODUCED: Overlay did not appear or recovered.\n`);
        process.exit(1);
    }
})();
