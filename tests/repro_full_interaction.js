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

    const context = await browser.newContext({ viewport: { width: 1544, height: 928 } });
    const page = await context.newPage();

    page.on('console', msg => {
        const text = msg.text();
        if (text.includes('[WebRTC]') || text.includes('[WS]') || text.includes('error') || text.includes('Error') || text.includes('close') || text.includes('state')) {
            console.log(`[CONSOLE] ${text}`);
        }
    });

    page.on('pageerror', err => {
        console.error(`[PAGE ERROR] ${err.message}`);
    });

    await page.goto(TARGET_URL, { waitUntil: 'domcontentloaded' });
    const canvas = page.locator('#gameCanvas');
    await canvas.waitFor({ state: 'attached', timeout: 15000 });

    console.log('Waiting for stream frames...');
    await page.waitForFunction(() => (window.__dfFrameCount || 0) >= 5, { timeout: 15000 });

    const box = await canvas.boundingBox();
    console.log('Canvas bounding box:', box);

    // Track overlay visibility
    let overlayDetected = false;
    const checkOverlay = async (actionDesc) => {
        const isOverlay = await page.evaluate(() => {
            const el = document.querySelector('p');
            return el && el.innerText.includes('CONNECTING WEBRTC P2P');
        });
        if (isOverlay && !overlayDetected) {
            overlayDetected = true;
            console.log(`🚨 OVERLAY DETECTED after action: ${actionDesc}!`);
            const status = await page.evaluate(() => {
                const el = document.querySelector('p');
                return {
                    text: el ? el.innerText : null,
                    frames: window.__dfFrameCount || 0
                };
            });
            console.log('Status on overlay detection:', status);
        }
        return isOverlay;
    };

    console.log('\n--- Phase 1: Realistic mouse moves and clicks on Title screen ---');
    // Move across menu options
    const menuCoords = [
        { name: 'Create World', x: 772, y: 430 },
        { name: 'Start Playing', x: 772, y: 470 },
        { name: 'Arena', x: 772, y: 510 },
        { name: 'Options', x: 772, y: 550 },
        { name: 'Quit', x: 772, y: 620 }
    ];

    for (const item of menuCoords) {
        console.log(`Hovering over ${item.name} (${item.x}, ${item.y})...`);
        await page.mouse.move(box.x + item.x, box.y + item.y, { steps: 5 });
        await page.waitForTimeout(100);
        if (await checkOverlay(`Hover ${item.name}`)) break;
    }

    if (!overlayDetected) {
        console.log('\n--- Phase 2: Clicks on title menu items ---');
        // Click Create World, then Right Click to cancel/back
        console.log('Clicking Create World (772, 430)...');
        await page.mouse.click(box.x + 772, box.y + 430);
        await page.waitForTimeout(300);
        await checkOverlay('Click Create World');

        console.log('Right clicking to cancel (772, 430)...');
        await page.mouse.click(box.x + 772, box.y + 430, { button: 'right' });
        await page.waitForTimeout(300);
        await checkOverlay('Right Click');

        // Rapid clicks (multi-clicking)
        console.log('Rapid left clicks in middle of screen...');
        for (let i = 0; i < 5; i++) {
            await page.mouse.click(box.x + 600 + i * 20, box.y + 350 + i * 20, { delay: 15 });
            await page.waitForTimeout(50);
        }
        await checkOverlay('Rapid Left Clicks');

        // Mixed left/right rapid clicks
        console.log('Mixed left & right clicks...');
        for (let i = 0; i < 6; i++) {
            const btn = (i % 2 === 0) ? 'left' : 'right';
            await page.mouse.click(box.x + 700, box.y + 400, { button: btn, delay: 20 });
            await page.waitForTimeout(40);
        }
        await checkOverlay('Mixed Clicks');

        // Mouse wheel scrolling
        console.log('Mouse wheel scrolling...');
        await page.mouse.wheel(0, 100);
        await page.waitForTimeout(100);
        await page.mouse.wheel(0, -100);
        await page.waitForTimeout(100);
        await checkOverlay('Mouse Wheel');
    }

    console.log('\n--- Phase 3: Observing for 5 seconds ---');
    for (let s = 1; s <= 5; s++) {
        await page.waitForTimeout(1000);
        if (await checkOverlay(`Observation second ${s}`)) break;
    }

    const finalFrames = await page.evaluate(() => window.__dfFrameCount || 0);
    console.log(`\nFinal frame count: ${finalFrames}`);
    console.log(`Overlay visible at end: ${overlayDetected}`);

    await page.screenshot({ path: '/tmp/full_interaction_result.png' });
    console.log('Screenshot saved to /tmp/full_interaction_result.png');

    await browser.close();
    process.exit(overlayDetected ? 1 : 0);
})();
