const { chromium } = require("playwright");

const URL = process.env.TARGET_URL || \"http://localhost:48600/?nohud=1\";

async function main() {
    console.log("=== Benchmarking End-to-End Latency & Continuous Click Stability ===");

    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
    const page = await context.newPage();

    console.log(`Connecting to ${URL}...`);
    await page.goto(URL);
    await page.waitForTimeout(3000);

    const box = { x: 0, y: 0, width: 1280, height: 720 };

    const latencies = [];
    const NUM_CLICKS = 40;

    console.log(`\nExecuting ${NUM_CLICKS} rapid interactive click and navigation cycles...`);

    for (let i = 0; i < NUM_CLICKS; i++) {
        const isSettings = i % 2 === 0;
        const targetX = isSettings ? box.x + 640 : box.x + 100;
        const targetY = isSettings ? box.y + 475 : box.y + 35;

        const frameBefore = (await page.evaluate(() => window.__dfFrameCount)) || 0;
        const t0 = Date.now();

        if (isSettings) {
            await page.mouse.click(targetX, targetY);
        } else {
            await page.keyboard.press("Escape");
        }

        // Wait until a new frame arrives and renders
        let rendered = false;
        const timeout = 2000;
        const startWait = Date.now();

        while (Date.now() - startWait < timeout) {
            const currentFrames = (await page.evaluate(() => window.__dfFrameCount)) || 0;
            if (currentFrames > frameBefore) {
                rendered = true;
                break;
            }
            await new Promise(r => setTimeout(r, 4));
        }

        const elapsed = Date.now() - t0;
        if (!rendered) {
            console.error(`Click #${i + 1} TIMED OUT / FROZEN after ${timeout}ms!`);
            throw new Error(`Freeze detected at click #${i + 1}`);
        }

        latencies.push(elapsed);
        await page.waitForTimeout(40);
    }

    latencies.sort((a, b) => a - b);
    const p50 = latencies[Math.floor(latencies.length * 0.50)];
    const p90 = latencies[Math.floor(latencies.length * 0.90)];
    const p99 = latencies[Math.floor(latencies.length * 0.99)];
    const mean = (latencies.reduce((a, b) => a + b, 0) / latencies.length).toFixed(1);

    console.log("\n==========================================");
    console.log("       LATENCY & STABILITY RESULTS        ");
    console.log("==========================================");
    console.log(`Total Interactive Clicks Tested: ${NUM_CLICKS}`);
    console.log(`Freeze Failures:                 0 (100% responsive)`);
    console.log(`P50 Input-to-Render Latency:     ${p50} ms`);
    console.log(`P90 Input-to-Render Latency:     ${p90} ms`);
    console.log(`P99 Input-to-Render Latency:     ${p99} ms`);
    console.log(`Mean Input-to-Render Latency:    ${mean} ms`);

    await browser.close();
}

main().catch(err => {
    console.error("BENCHMARK FAILED:", err);
    process.exit(1);
});
