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
    await page.waitForFunction(() => (window.__dfFrameCount || 0) >= 5, { timeout: 15000 });
    console.log('Stream connected and active!');

    // Replay the exact right clicks from log lines 24670 - 24685
    const clicks = [
        { x: 855, y: 606, btn: 'right' },
        { x: 847, y: 581, btn: 'left' },
        { x: 833, y: 630, btn: 'right' },
        { x: 836, y: 574, btn: 'left' },
        { x: 820, y: 682, btn: 'right' }
    ];

    let overlaySeen = false;
    for (let i = 0; i < clicks.length; i++) {
        const c = clicks[i];
        console.log(`[Click ${i + 1}/${clicks.length}] ${c.btn} at (${c.x}, ${c.y})...`);
        await page.mouse.click(c.x, c.y, { button: c.btn, delay: 40 });
        await page.waitForTimeout(300);

        const overlay = await page.evaluate(() => {
            const spans = Array.from(document.querySelectorAll('span'));
            const s = spans.find(el => (el.textContent || '').includes('Connecting WebRTC P2P'));
            return Boolean(s);
        });

        console.log(`  -> Overlay visible: ${overlay}`);
        if (overlay) {
            overlaySeen = true;
            break;
        }
    }

    console.log('Waiting 4 seconds to observe persistence...');
    await page.waitForTimeout(4000);

    const finalStatus = await page.evaluate(() => {
        const spans = Array.from(document.querySelectorAll('span'));
        const s = spans.find(el => (el.textContent || '').includes('Connecting WebRTC P2P'));
        return {
            overlayVisible: Boolean(s),
            frames: window.__dfFrameCount || 0
        };
    });

    console.log('Final Status:', finalStatus);
    await page.screenshot({ path: '/tmp/exact_sequence_repro.png' });
    console.log('Screenshot saved to /tmp/exact_sequence_repro.png');

    await browser.close();
    process.exit(finalStatus.overlayVisible ? 0 : 1);
})();
