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
        const t = msg.text();
        if (t.includes('WebRTC') || t.includes('DataChannel') || t.includes('closed') || t.includes('Error') || t.includes('Connecting')) {
            console.log(`[BROWSER] ${t}`);
        }
    });

    await page.goto(TARGET_URL, { waitUntil: 'domcontentloaded' });
    const canvas = page.locator('#gameCanvas');
    await canvas.waitFor({ state: 'attached', timeout: 15000 });
    await page.waitForFunction(() => (window.__dfFrameCount || 0) >= 5, { timeout: 15000 });
    console.log('Stream connected and active!');

    const box = await canvas.boundingBox();
    console.log('Canvas box:', box);

    // Click "Back to main menu" at bottom right (~ x=1400, y=940 scaled to box)
    // Box is 1544x928. In the screenshot, "Back to main menu" is at x: 1380..1500, y: 935..955
    // Let's click it:
    console.log('Clicking "Back to main menu" at (1420, 940)...');
    await page.mouse.click(box.x + (1420 * box.width / 1544), box.y + (940 * box.height / 928));
    await page.waitForTimeout(500);

    // Let's check overlay:
    let overlay = await page.evaluate(() => {
        const spans = Array.from(document.querySelectorAll('span'));
        const s = spans.find(el => (el.textContent || '').includes('Connecting WebRTC P2P'));
        return Boolean(s);
    });
    console.log(`Overlay after Back to main menu: ${overlay}`);

    // Click around title menu
    for (let i = 0; i < 5; i++) {
        const x = box.x + 772;
        const y = box.y + 430 + (i * 30);
        console.log(`Clicking menu item at (${x}, ${y})...`);
        await page.mouse.click(x, y);
        await page.waitForTimeout(200);
        overlay = await page.evaluate(() => {
            const spans = Array.from(document.querySelectorAll('span'));
            const s = spans.find(el => (el.textContent || '').includes('Connecting WebRTC P2P'));
            return Boolean(s);
        });
        console.log(`  -> Overlay: ${overlay}`);
        if (overlay) break;
    }

    await page.waitForTimeout(3000);
    const finalFrames = await page.evaluate(() => window.__dfFrameCount || 0);
    console.log('Final frames:', finalFrames);

    await page.screenshot({ path: '/tmp/arena_menu_click_result.png' });
    console.log('Saved screenshot to /tmp/arena_menu_click_result.png');

    await browser.close();
    process.exit(overlay ? 0 : 1);
})();
