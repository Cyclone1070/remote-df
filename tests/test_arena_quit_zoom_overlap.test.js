const test = require('node:test');
const assert = require('node:assert/strict');
const { chromium } = require("playwright");
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const URL = process.env.TARGET_URL || \"http://localhost:48600/?nohud=1';

function checkTitleScreen(pngBuffer) {
    const tmpPath = '/tmp/test_title_measure.png\";
    fs.writeFileSync(tmpPath, pngBuffer);
    const cmd = `python3 -c "
from PIL import Image
im = Image.open('${tmpPath}')
pixels = im.load()

# Check for white DWARF text (y=200..260, x=500..750)
dwarf_count = sum(1 for y in range(200, 260) for x in range(500, 750) if pixels[x, y][:3] == (255, 255, 255))
if dwarf_count < 1000:
    print('-1')
    exit(0)

# Measure top Y of green 'Create new world' button
green_ys = [y for y in range(250, 500) for x in range(400, 880) if pixels[x, y][1] > 200 and pixels[x, y][0] < 50 and pixels[x, y][2] < 120]
if green_ys:
    print(min(green_ys))
else:
    print('-1')
"`;
    const res = execSync(cmd, { encoding: 'utf8' }).trim();
    return parseInt(res, 10);
}

test('Arena zoom causes Title screen overlap upon quitting without saving', { timeout: 180000 }, async (t) => {
    console.log('[TDD TEST] Restarting DF for clean baseline...');
    execSync('bash scripts/restart_stream.sh 0', { stdio: 'inherit' });
    for (let i = 0; i < 30; i++) {
        try {
            execSync('curl -s -f -I http://localhost:48600/', { stdio: 'ignore' });
            break;
        } catch {
            execSync('sleep 0.5');
        }
    }

    const browser = await chromium.launch({ headless: true });
    try {
        const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
        const page = await context.newPage();

        const log = (msg) => console.log(`[${new Date().toISOString()}] ${msg}`);

        log('[TDD TEST] Navigating to client...');
        await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 15000 });
        await page.waitForTimeout(2500);

        const titleDataUrl1 = await page.evaluate(() => {
            const c = document.getElementById('gameCanvas');
            return c ? c.toDataURL('image/png') : null;
        });
        const titleBuf1 = Buffer.from(titleDataUrl1.replace(/^data:image\/png;base64,/, ''), 'base64');
        const baselineY = checkTitleScreen(titleBuf1);
        log(`[TDD TEST] Baseline 'Create new world' top Y: ${baselineY}`);
        assert.ok(baselineY >= 380, `Baseline menu must be below FORTRESS logo (y >= 380), got ${baselineY}`);

        // 1. Enter Object testing arena
        log('[TDD TEST] Clicking Object testing arena at (631, 437)...');
        await page.mouse.click(631, 437);
        await page.waitForTimeout(2000);

        log('[TDD TEST] Clicking Create arena at (1000, 685)...');
        await page.mouse.click(1000, 685);
        
        // Wait for in-game arena playfield
        log('[TDD TEST] Waiting for Arena generation...');
        await page.waitForTimeout(5000);

        // 2. Zoom in 3 times with '[' to reach 9x13 font
        log('[TDD TEST] Zooming in 3 times with BracketLeft...');
        for (let z = 0; z < 3; z++) {
            await page.keyboard.press('BracketLeft');
            await page.waitForTimeout(500);
        }
        await page.waitForTimeout(1000);

        // 3. Open Escape menu
        log('[TDD TEST] Pressing Escape...');
        await page.keyboard.press('Escape');
        await page.waitForTimeout(1500);

        // 4. Click 'Quit without saving' at (635, 378)
        log('[TDD TEST] Clicking Quit without saving at (635, 378)...');
        await page.mouse.click(635, 378);
        await page.waitForTimeout(1500);

        // 5. Click 'Quit' confirmation button at (431, 401)
        log('[TDD TEST] Clicking Quit confirmation at (431, 401)...');
        await page.mouse.click(431, 401);

        // 6. Wait for return to Title screen
        log('[TDD TEST] Waiting for return to Title screen...');
        let returnedY = -1;
        for (let i = 0; i < 45; i++) {
            await page.waitForTimeout(1000);
            const titleDataUrlAfter = await page.evaluate(() => {
                if (window.renderer) window.renderer.render();
                const c = document.getElementById('gameCanvas');
                return c ? c.toDataURL('image/png') : null;
            });
            if (!titleDataUrlAfter) continue;
            const titleBufAfter = Buffer.from(titleDataUrlAfter.replace(/^data:image\/png;base64,/, ''), 'base64');
            returnedY = checkTitleScreen(titleBufAfter);
            if (returnedY > 0) {
                log(`[TDD TEST] Title screen detected after ${i + 1}s with 'Create new world' top Y: ${returnedY}`);
                fs.writeFileSync('/tmp/tdd_title_after_quit.png', titleBufAfter);
                break;
            }
        }

        // Assert: Title menu MUST NOT overlap FORTRESS logo (FORTRESS bottom is at 323, Title menu must be >= 380)
        assert.ok(returnedY >= 380, `Title menu must not overlap FORTRESS logo (expected y >= 380, but got y=${returnedY})`);
    } finally {
        await browser.close();
    }
});
