const test = require('node:test');
const assert = require('node:assert/strict');
const { chromium } = require("playwright");
const { execSync } = require('child_process');

const URL = process.env.TARGET_URL || \"http://localhost:48600/?nohud=1\";

test('End-to-End Input Smoke Test: Mouse Clicks, Escape Toggle, and Navigation', { timeout: 180000 }, async (t) => {
    const browser = await chromium.launch({ headless: true });
    try {
        const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
        const page = await context.newPage();

        console.log('[INPUT SMOKE] Connecting to client...');
        await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 15000 });
        await page.waitForTimeout(2500);

        // 1. Mouse Click: Object testing arena at (631, 437)
        console.log('[INPUT SMOKE] Clicking Object testing arena at (631, 437)...');
        await page.mouse.click(631, 437);
        await page.waitForTimeout(2000);

        // Verify Arena setup screen reached (look for Create arena button at 1000, 685)
        console.log('[INPUT SMOKE] Clicking Create arena at (1000, 685)...');
        await page.mouse.click(1000, 685);

        // Wait for In-Game Arena Playfield (DF arena generation takes ~60-85s)
        console.log('[INPUT SMOKE] Waiting for Arena generation...');
        let inArena = false;
        for (let i = 0; i < 100; i++) {
            await page.waitForTimeout(1000);
            inArena = await page.evaluate(() => {
                if (window.renderer) window.renderer.render();
                const c = document.getElementById('gameCanvas');
                const gl = c ? c.getContext('webgl2') : null;
                if (!gl) return false;
                const w = 20, h = 10;
                const px = new Uint8Array(w * h * 4);
                gl.readPixels(1100, 450, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);
                let count = 0;
                for (let j = 0; j < px.length; j += 4) {
                    if (px[j] > 200 && px[j+1] > 200 && px[j+2] > 200) count++;
                }
                return count > 15;
            });
            if (inArena) {
                console.log(`[INPUT SMOKE] Arena playfield active after ${i + 1}s`);
                break;
            }
        }
        assert.ok(inArena, 'Mouse click navigation failed to reach in-game arena playfield');

        // 2. Keyboard Test: Escape menu toggle
        console.log('[INPUT SMOKE] Pressing Escape to open menu...');
        await page.keyboard.press('Escape', { delay: 50 });
        await page.waitForTimeout(2000);

        const menuOpen = await page.evaluate(() => {
            if (window.renderer) window.renderer.render();
            const c = document.getElementById('gameCanvas');
            const gl = c ? c.getContext('webgl2') : null;
            if (!gl) return false;
            const px = new Uint8Array(20 * 10 * 4);
            gl.readPixels(630, 470, 20, 10, gl.RGBA, gl.UNSIGNED_BYTE, px);
            let yellowCount = 0;
            for (let j = 0; j < px.length; j += 4) {
                if (px[j] > 200 && px[j+1] > 180 && px[j+2] < 50) yellowCount++;
            }
            return yellowCount > 5;
        });
        assert.ok(menuOpen, 'Escape key failed to open in-game menu');
        console.log('[INPUT SMOKE] Escape menu successfully opened via Escape key!');

        // 3. Mouse Test: Close Escape menu with 'Return to game' button
        console.log('[INPUT SMOKE] Clicking Return to game at (630, 450) to close menu...');
        await page.mouse.click(630, 450);
        await page.waitForTimeout(2000);

        const menuClosed = await page.evaluate(() => {
            if (window.renderer) window.renderer.render();
            const c = document.getElementById('gameCanvas');
            const gl = c ? c.getContext('webgl2') : null;
            if (!gl) return true;
            const px = new Uint8Array(20 * 10 * 4);
            gl.readPixels(630, 470, 20, 10, gl.RGBA, gl.UNSIGNED_BYTE, px);
            let yellowCount = 0;
            for (let j = 0; j < px.length; j += 4) {
                if (px[j] > 200 && px[j+1] > 180 && px[j+2] < 50) yellowCount++;
            }
            return yellowCount <= 5;
        });
        assert.ok(menuClosed, 'Return to game failed to close in-game menu');
        console.log('[INPUT SMOKE] Escape menu successfully closed via Return to game button!');

    } finally {
        await browser.close();
    }
});
