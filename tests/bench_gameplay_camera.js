const { chromium } = require("playwright");
const { execSync } = require("child_process");
const fs = require("fs");

const HOST = process.env.TARGET_HOST || "localhost";
const URL = process.env.TARGET_URL || \"http://localhost:48600/?nohud=1\";

async function main() {
    console.log("=== Benchmarking Real In-Game Gameplay & Camera Pan ===");
    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
    const page = await context.newPage();

    await page.goto(URL);
    await page.waitForTimeout(2000);

    const canvas = page.locator("#gameCanvas");
    const box = await canvas.boundingBox();

    // 1. Click "Create arena" at (990, 677)
    console.log("Clicking 'Create arena' at (990, 677)...");
    await page.mouse.move(box.x + 990, box.y + 677);
    await page.mouse.down();
    await page.waitForTimeout(150);
    await page.mouse.up();

    // Wait for arena world generation & load (takes ~3-5s)
    console.log("Waiting for arena in-game map to load...");
    await page.waitForTimeout(5000);

    // Capture initial in-game screenshot
    const dataUrl1 = await page.evaluate(() => document.getElementById("gameCanvas").toDataURL("image/png"));
    fs.writeFileSync("/tmp/df_gameplay_initial.png", Buffer.from(dataUrl1.replace(/^data:image\/png;base64,/, ""), "base64"));
    console.log("Saved initial in-game screenshot /tmp/df_gameplay_initial.png");

    // 2. Fast Camera Movement: Arrow keys and Shift+Arrows
    console.log("Panning camera FAST: ArrowRight x 20, ArrowDown x 20...");
    const startTime = Date.now();
    for (let i = 0; i < 20; i++) {
        await page.keyboard.press("ArrowRight");
        await page.keyboard.press("ArrowDown");
        await page.waitForTimeout(50); // Fast 20 ticks/sec pan
    }
    const panDuration = (Date.now() - startTime) / 1000;
    console.log(`Fast pan completed in ${panDuration.toFixed(2)}s`);

    await page.waitForTimeout(1000);

    // Capture after fast pan
    const dataUrl2 = await page.evaluate(() => document.getElementById("gameCanvas").toDataURL("image/png"));
    fs.writeFileSync("/tmp/df_gameplay_after_pan.png", Buffer.from(dataUrl2.replace(/^data:image\/png;base64,/, ""), "base64"));
    console.log("Saved after pan screenshot /tmp/df_gameplay_after_pan.png");

    // 3. Pixel Parity Test in Gameplay
    console.log("Capturing host native frame for in-game parity check...");
    execSync(`ssh ${HOST} "xwd -root -display :99 -out /tmp/qa_game_host.xwd && python3 /tmp/decode_xwd.py /tmp/qa_game_host.xwd /tmp/qa_game_host.png"`);
    execSync(`scp ${HOST}:/tmp/qa_game_host.png /tmp/df_gameplay_host.png`);

    const compScript = "./tests/qa_pixel_comparator.py";
    const out = execSync(`python3 ${compScript} /tmp/df_gameplay_host.png /tmp/df_gameplay_after_pan.png /tmp/df_gameplay_diff.png 2`, { encoding: "utf8" });
    console.log("\nIn-Game Gameplay Parity Result:");
    console.log(out.trim());

    await browser.close();
}

main().catch(err => { console.error(err); process.exit(1); });
