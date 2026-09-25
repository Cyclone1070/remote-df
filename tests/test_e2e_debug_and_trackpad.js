const { chromium } = require("playwright");
const assert = require('node:assert/strict');
const { execSync } = require('child_process');

async function main() {
    console.log('=== Starting E2E Verification: Debug HUD & Trackpad Translation ===');
    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext();
    const page = await context.newPage();

    // 1. Verify Default URL has NO HUD
    console.log('\n--- 1. Testing Default URL (No HUD) ---');
    await page.goto('http://localhost:48600/', { waitUntil: 'domcontentloaded', timeout: 15000 });
    await page.waitForTimeout(1000);

    const isNoHud = await page.evaluate(() => document.body.classList.contains('no-hud'));
    const hudDisplay = await page.evaluate(() => {
        const hud = document.getElementById('hud');
        return hud ? window.getComputedStyle(hud).display : null;
    });
    console.log('body has no-hud class:', isNoHud);
    console.log('#hud computed display:', hudDisplay);
    assert.equal(isNoHud, true, 'Default URL must have no-hud class');
    assert.equal(hudDisplay, 'none', 'HUD must be hidden by default');

    // 2. Testing Debug URL (?debug=1)
    console.log('\n--- 2. Testing Debug URL (?debug=1) ---');
    await page.goto('http://localhost:48600/?debug=1', { waitUntil: 'domcontentloaded', timeout: 15000 });
    await page.waitForTimeout(2000);

    const isDebugNoHud = await page.evaluate(() => document.body.classList.contains('no-hud'));
    const debugHudDisplay = await page.evaluate(() => {
        const hud = document.getElementById('hud');
        return hud ? window.getComputedStyle(hud).display : null;
    });
    console.log('body has no-hud class in debug mode:', isDebugNoHud);
    console.log('#hud computed display in debug mode:', debugHudDisplay);
    assert.equal(isDebugNoHud, false, 'Debug URL must NOT have no-hud class');
    assert.notEqual(debugHudDisplay, 'none', 'HUD must be visible in debug mode');

    // Wait for frames to stream and trigger inputs to measure M2P
    console.log('Sending inputs to test rotating debug stamp & M2P measurement...');
    for (let i = 0; i < 5; i++) {
        await page.mouse.click(640, 360);
        await page.waitForTimeout(200);
    }

    // Wait for HUD telemetry to update
    await page.waitForTimeout(1500);

    const hudValues = await page.evaluate(() => {
        return {
            fps: document.getElementById('hud-fps')?.textContent,
            bandwidth: document.getElementById('hud-bandwidth')?.textContent,
            m2p: document.getElementById('hud-m2p')?.textContent,
            draws: document.getElementById('hud-drawcalls')?.textContent
        };
    });

    console.log('Live HUD Telemetry:', hudValues);
    assert.ok(hudValues.fps && hudValues.fps.includes('fps'), 'FPS must be displayed');
    assert.ok(hudValues.m2p && hudValues.m2p.includes('ms'), `M2P latency must be measured with rotating stamp, got: ${hudValues.m2p}`);

    // 3. Testing Trackpad Tap Behavior
    console.log('\n--- 3. Testing Trackpad Tap Minimum Duration ---');
    // Clear log marker on remote host
    execSync('ssh ${HOST} "> /tmp/df_game.log"');

    // Perform rapid 2ms mouse down/up burst (trackpad tap)
    await page.mouse.move(500, 300);
    await page.mouse.down();
    await page.waitForTimeout(2);
    await page.mouse.up();

    // Allow network and minimum hold duration to flush
    await page.waitForTimeout(500);

    // Check remote df_game.log for left tap
    const log = execSync('ssh ${HOST} "grep -a -A 2 \'\\[INPUT\\] btn=1\' /tmp/df_game.log"').toString();
    console.log('Remote host log for tap:\n' + log.trim());
    assert.ok(log.includes('state=2'), 'Left DOWN event logged');
    assert.ok(log.includes('state=3'), 'Left UP event logged');

    // 4. Testing Right Click & macOS Ctrl+Click
    console.log('\n--- 4. Testing macOS Ctrl+Click Translation to Right Click ---');
    await page.evaluate(() => {
        const c = document.getElementById('gameCanvas');
        const down = new MouseEvent('mousedown', { clientX: 450, clientY: 250, button: 0, ctrlKey: true, bubbles: true });
        const up = new MouseEvent('mouseup', { clientX: 450, clientY: 250, button: 0, ctrlKey: true, bubbles: true });
        c.dispatchEvent(down);
        c.dispatchEvent(up);
    });
    await page.waitForTimeout(500);

    const rightLog = execSync('ssh ${HOST} "grep -a -A 2 \'\\[INPUT\\] btn=3\' /tmp/df_game.log"').toString();
    console.log('Remote host log for right click:\n' + rightLog.trim());
    assert.ok(rightLog.includes('state=2'), 'Right DOWN event logged');
    assert.ok(rightLog.includes('state=3'), 'Right UP event logged');

    await browser.close();
    console.log('\n=== All E2E Verifications PASSED! ===');
}

main().catch(err => {
    console.error('Test Failed:', err);
    process.exit(1);
});
