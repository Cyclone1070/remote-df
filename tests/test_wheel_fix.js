const { chromium } = require("playwright");
const { execSync } = require('child_process');

const HOST = process.env.TARGET_HOST || "localhost";
const URL = process.env.TARGET_URL || \"http://localhost:48600/?nohud=1\";

function getRemoteWheelLogCount() {
    try {
        const out = execSync(`ssh -o ConnectTimeout=5 ${HOST} "grep -c '\\[INPUT\\] wheel' /tmp/df_game.log || true"`, { encoding: 'utf8' });
        return parseInt(out.trim() || '0', 10);
    } catch {
        return 0;
    }
}

function getRemoteRecentLog(lines = 20) {
    return execSync(`ssh -o ConnectTimeout=5 ${HOST} "tail -n ${lines} /tmp/df_game.log"`, { encoding: 'utf8' });
}

async function main() {
    console.log('=== Testing Mouse Wheel Single-Step & Shift Key Isolation ===');

    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });

    console.log(`Connecting to ${URL}...`);
    await page.goto(URL);
    await page.waitForSelector('#gameCanvas', { timeout: 10000 });
    await page.waitForTimeout(2000); // let initial stream connect and sync

    const initialWheelCount = getRemoteWheelLogCount();
    console.log(`Initial remote wheel log count: ${initialWheelCount}`);

    console.log('\n--- Step 1: Dispatch single discrete wheel tick ---');
    // Scroll 1 notch down (deltaY = 100 in DOM)
    await page.mouse.move(640, 360);
    await page.mouse.wheel(0, 100);

    // Wait 1.5 seconds to observe if any trailing/runaway events fire
    await page.waitForTimeout(1500);

    const postWheelCount = getRemoteWheelLogCount();
    const wheelDiff = postWheelCount - initialWheelCount;
    console.log(`Wheel events logged after 1 notch: ${wheelDiff}`);
    if (wheelDiff !== 1) {
        console.error(`FAILURE: Expected exactly 1 wheel event, got ${wheelDiff}`);
        process.exit(1);
    }
    console.log('PASS: Exactly 1 wheel event processed by server.');

    console.log('\n--- Step 2: Press Shift + . (>) immediately ---');
    // Press Shift and '.' to verify that Shift does NOT re-trigger zombie wheel events
    await page.keyboard.press('Shift+Period');
    await page.waitForTimeout(1000);

    const postShiftWheelCount = getRemoteWheelLogCount();
    const shiftWheelDiff = postShiftWheelCount - postWheelCount;
    console.log(`Wheel events logged during/after Shift+Period: ${shiftWheelDiff}`);
    if (shiftWheelDiff !== 0) {
        console.error(`FAILURE: Shift key re-triggered ${shiftWheelDiff} zombie wheel event(s)!`);
        process.exit(1);
    }
    console.log('PASS: Zero zombie wheel events triggered by modifier key.');

    console.log('\n--- Step 3: Rapid wheel ticks followed by direction reversal ---');
    // Scroll up 1 tick, wait 200ms, then scroll down 1 tick
    await page.mouse.move(640, 360);
    await page.mouse.wheel(0, -100);
    await page.waitForTimeout(200);
    await page.mouse.wheel(0, 100);
    await page.waitForTimeout(1000);

    const finalWheelCount = getRemoteWheelLogCount();
    const finalDiff = finalWheelCount - postShiftWheelCount;
    console.log(`Wheel events logged for 2 directional ticks: ${finalDiff}`);
    if (finalDiff !== 2) {
        console.error(`FAILURE: Expected 2 wheel events, got ${finalDiff}`);
        process.exit(1);
    }
    console.log('PASS: Exact 1:1 discrete wheel ticks on reversal.');

    console.log('\nRecent game log:');
    console.log(getRemoteRecentLog(15));

    await browser.close();
    console.log('\n=== ALL TESTS PASSED SUCCESSFULLY ===');
}

main().catch(err => {
    console.error('Test error:', err);
    process.exit(1);
});
