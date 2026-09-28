import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { execSync } from 'child_process';

const TARGETS = [
    { name: 'Direct IP', url: 'http://100.73.151.90:8484/df', origin: 'http://100.73.151.90:8484' },
    { name: 'Cloudflare', url: 'https://gmc-bond-strategies-vocals.trycloudflare.com/df', origin: 'http://100.73.151.90:8484' }
];

function resetSession(origin) {
    try {
        execSync(`curl -s -X POST "${origin}/api/session/stop"`);
        execSync('sleep 1');
    } catch (_) {}
    execSync(`curl -s -X POST "${origin}/api/session/start" -H "Content-Type: application/json" -d '{"gameId":"dwarf-fortress"}'`);
    execSync('sleep 3');
}

for (const target of TARGETS) {
    test(`When game channels terminate while streaming on ${target.name}, user is routed back to home page without retry`, async (t) => {
        resetSession(target.origin);

        const browser = await chromium.launch({
            headless: true,
            args: ['--use-gl=angle', '--use-angle=gl', '--no-sandbox']
        });

        try {
            const context = await browser.newContext({ viewport: { width: 1544, height: 928 } });
            const page = await context.newPage();

            // 1. Navigate to stream
            console.log(`[${target.name}] Navigating to stream...`);
            await page.goto(target.url, { waitUntil: 'domcontentloaded' });
            const canvas = page.locator('#gameCanvas');
            await canvas.waitFor({ state: 'attached', timeout: 20000 });

            // 2. Wait for stream to be active
            console.log(`[${target.name}] Waiting for active stream frames...`);
            await page.waitForFunction(() => (window.__dfFrameCount || 0) >= 10, { timeout: 20000 });
            const initialFrames = await page.evaluate(() => window.__dfFrameCount || 0);
            assert.ok(initialFrames >= 10, 'Stream must be active');

            const box = await canvas.boundingBox();
            assert.ok(box, 'Canvas bounding box must exist');

            // 3. User clicks Quit on title menu (767, 657)
            console.log(`[${target.name}] Clicking Quit button in game...`);
            await page.mouse.click(box.x + 767, box.y + 657, { button: 'left', delay: 50 });

            // 4. Assert: user must be routed back to the home page (view='menu', url='/')
            console.log(`[${target.name}] Waiting for route back to home page...`);
            await page.waitForFunction(() => {
                const isHomeUrl = window.location.pathname === '/' || window.location.pathname === '';
                const hasMainMenu = Boolean(document.querySelector('button') && Array.from(document.querySelectorAll('button')).some(b => b.textContent.includes('Launch') || b.textContent.includes('Resume') || b.textContent.includes('Start')));
                return isHomeUrl && hasMainMenu;
            }, { timeout: 10000 });

            const currentPath = await page.evaluate(() => window.location.pathname);
            assert.equal(currentPath, '/', 'Must navigate back to root /');

            const hasFreezeOverlay = await page.evaluate(() => {
                const spans = Array.from(document.querySelectorAll('span'));
                return spans.some(el => (el.textContent || '').includes('Connecting WebRTC P2P'));
            });
            assert.equal(hasFreezeOverlay, false, 'Must not display freeze overlay');
            console.log(`[${target.name}] Successfully routed back to home page without freeze overlay!`);

        } finally {
            await browser.close();
        }
    });
}
