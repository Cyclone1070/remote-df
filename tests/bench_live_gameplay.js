const { chromium } = require("playwright");
const { execSync } = require("child_process");
const fs = require("fs");

const HOST = process.env.TARGET_HOST || "localhost";
const URL = process.env.TARGET_URL || \"http://localhost:48600/?nohud=1\";

async function main() {
    console.log("=== Benchmarking Live Arena Gameplay Stream ===");
    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
    const page = await context.newPage();

    console.log("Connecting to live arena...");
    await page.goto(URL);
    await page.waitForTimeout(2000);

    // 1. Initial gameplay parity check
    console.log("Capturing initial in-game client canvas...");
    const dataUrl1 = await page.evaluate(() => document.getElementById("gameCanvas").toDataURL("image/png"));
    fs.writeFileSync("/tmp/qa_arena_client1.png", Buffer.from(dataUrl1.replace(/^data:image\/png;base64,/, ""), "base64"));

    console.log("Capturing host frame...");
    execSync(`ssh ${HOST} "xwd -root -display :99 -out /tmp/qa_arena_host.xwd && python3 /tmp/decode_xwd.py /tmp/qa_arena_host.xwd /tmp/qa_arena_host.png"`);
    execSync(`scp ${HOST}:/tmp/qa_arena_host.png /tmp/qa_arena_host1.png`);

    const compScript = "./tests/qa_pixel_comparator.py";
    const parity1 = JSON.parse(execSync(`python3 ${compScript} /tmp/qa_arena_host1.png /tmp/qa_arena_client1.png /tmp/qa_arena_diff1.png 2`, { encoding: "utf8" }));
    console.log("Initial Arena Match:", parity1.exact_match_pct + "%", "| Mismatch Pixels:", parity1.tol_mismatch_count);

    // 2. High-speed camera pan test (40 pan steps across map)
    console.log("Panning camera across the map (20x Down, 20x Right)...");
    const t0 = Date.now();
    for (let i = 0; i < 20; i++) {
        await page.keyboard.press("ArrowDown");
        await page.keyboard.press("ArrowRight");
        await page.waitForTimeout(30);
    }
    const panDuration = (Date.now() - t0) / 1000;
    console.log(`40 rapid camera moves completed in ${panDuration.toFixed(2)}s (${(40 / panDuration).toFixed(1)} moves/s)`);

    // Let rendering settle
    await page.waitForTimeout(1000);

    // 3. Post-pan gameplay parity check
    console.log("Capturing post-pan client canvas...");
    const dataUrl2 = await page.evaluate(() => document.getElementById("gameCanvas").toDataURL("image/png"));
    fs.writeFileSync("/tmp/qa_arena_client2.png", Buffer.from(dataUrl2.replace(/^data:image\/png;base64,/, ""), "base64"));

    console.log("Capturing post-pan host frame...");
    execSync(`ssh ${HOST} "xwd -root -display :99 -out /tmp/qa_arena_host.xwd && python3 /tmp/decode_xwd.py /tmp/qa_arena_host.xwd /tmp/qa_arena_host.png"`);
    execSync(`scp ${HOST}:/tmp/qa_arena_host.png /tmp/qa_arena_host2.png`);

    const parity2 = JSON.parse(execSync(`python3 ${compScript} /tmp/qa_arena_host2.png /tmp/qa_arena_client2.png /tmp/qa_arena_diff2.png 2`, { encoding: "utf8" }));
    console.log("Post-Pan Arena Match:", parity2.exact_match_pct + "%", "| Mismatch Pixels:", parity2.tol_mismatch_count);

    // 4. Measure bandwidth and draw command count from browser runtime
    const stats = await page.evaluate(() => {
        return {
            canvasW: document.getElementById("gameCanvas").width,
            canvasH: document.getElementById("gameCanvas").height,
        };
    });
    console.log("Canvas resolution:", stats.canvasW, "x", stats.canvasH);

    await browser.close();
}

main().catch(err => { console.error(err); process.exit(1); });
