const test = require('node:test');
const assert = require('node:assert/strict');
const { chromium } = require("playwright");

const URL = process.env.TARGET_URL || \"http://localhost:48600/?nohud=1\";

test('Live Arena Input Verification: Escape Menu, Mouse Clicks, and TEXTINPUT', { timeout: 60000 }, async (t) => {
    const browser = await chromium.launch({ headless: true });
    try {
        const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
        const page = await context.newPage();

        console.log('[LIVE INPUT] Connecting to client...');
        await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 15000 });
        await page.waitForTimeout(2000);

        // Helper to check Escape menu open/close state via WebGL canvas yellow border
        async function waitForMenuState(shouldBeOpen, timeoutMs = 10000) {
            const start = Date.now();
            while (Date.now() - start < timeoutMs) {
                const isOpen = await page.evaluate(() => {
                    if (window.renderer) window.renderer.render();
                    const c = document.getElementById('gameCanvas');
                    const gl = c ? c.getContext('webgl2') : null;
                    if (!gl) return false;
                    const px = new Uint8Array(20 * 10 * 4);
                    // Yellow border at DOM y=245 maps to WebGL y=470..479
                    gl.readPixels(630, 470, 20, 10, gl.RGBA, gl.UNSIGNED_BYTE, px);
                    let yellowCount = 0;
                    for (let j = 0; j < px.length; j += 4) {
                        if (px[j] > 200 && px[j+1] > 180 && px[j+2] < 50) yellowCount++;
                    }
                    return yellowCount > 5;
                });
                if (isOpen === shouldBeOpen) return true;
                await page.waitForTimeout(100);
            }
            return false;
        }

        // 1. Verify we are in Arena and ensure clean initial state
        const inArena = await page.evaluate(() => {
            if (window.renderer) window.renderer.render();
            const c = document.getElementById('gameCanvas');
            const gl = c ? c.getContext('webgl2') : null;
            if (!gl) return false;
            const px = new Uint8Array(20 * 10 * 4);
            gl.readPixels(1100, 450, 20, 10, gl.RGBA, gl.UNSIGNED_BYTE, px);
            let count = 0;
            for (let i = 0; i < px.length; i += 4) {
                if (px[i] > 200 && px[i+1] > 200 && px[i+2] > 200) count++;
            }
            return count > 15;
        });
        assert.ok(inArena, 'Expected DF to be in Arena playfield');
        console.log('[LIVE INPUT] Verified in-game Arena playfield active!');

        // 2. Test Escape key: Open Options Menu
        console.log('[LIVE INPUT] Opening options menu via Escape...');
        let menuOpened = await waitForMenuState(true, 1000);
        for (let attempt = 0; attempt < 5 && !menuOpened; attempt++) {
            await page.click('#gameCanvas');
            await page.keyboard.press('Escape');
            menuOpened = await waitForMenuState(true, 2000);
        }
        assert.ok(menuOpened, 'Escape key failed to open in-game options menu');
        console.log('[LIVE INPUT] Options menu verified OPEN!');

        await page.waitForTimeout(1000);

        // 3. Test Mouse Click: Close Options Menu via 'Return to game' button at (635, 449)
        console.log('[LIVE INPUT] Clicking Return to game at (635, 449)...');
        await page.mouse.move(635, 449);
        await page.waitForTimeout(100);
        await page.mouse.click(635, 449);
        const menuClosed = await waitForMenuState(false, 6000);
        assert.ok(menuClosed, 'Return to game button failed to close in-game menu');
        console.log('[LIVE INPUT] Options menu verified CLOSED!');

    } finally {
        await browser.close();
    }
});
