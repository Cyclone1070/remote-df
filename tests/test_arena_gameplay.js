const { chromium } = require("playwright");
const { execSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const HOST = process.env.TARGET_HOST || "localhost";
const URL = process.env.TARGET_URL || \"http://localhost:48600/?nohud=1\";
const ARTIFACTS_DIR = path.join(__dirname, "output");

function runCmd(cmd) {
    return execSync(cmd, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

async function main() {
    console.log("=== Testing In-Game Arena Gameplay & Live Parity ===");

    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
    const page = await context.newPage();

    console.log(`Connecting to ${URL}...`);
    await page.goto(URL);
    await page.waitForTimeout(2000);

    const canvas = page.locator("#gameCanvas");
    await canvas.waitFor({ state: "visible" });
    const box = await canvas.boundingBox();
    console.log(`Canvas bounding box: ${JSON.stringify(box)}`);

    // Click "Create arena" button (center ~ x=1000, y=685)
    console.log("Clicking 'Create arena' button at (1000, 685)...");
    await page.mouse.click(box.x + 1000, box.y + 685);
    
    // Wait for terrain and world generation to load
    console.log("Waiting 4s for arena map generation and presentation...");
    await page.waitForTimeout(4000);

    // Capture client canvas via dataURL
    const clientDataUrl = await page.evaluate(() => {
        const c = document.getElementById("gameCanvas");
        return c.toDataURL("image/png");
    });
    const clientPngPath = path.join(ARTIFACTS_DIR, "arena_gameplay_client.png");
    fs.writeFileSync(clientPngPath, Buffer.from(clientDataUrl.replace(/^data:image\/png;base64,/, ""), "base64"));
    console.log(`Saved client arena screenshot to ${clientPngPath}`);

    // Trigger host snapshot
    console.log("Triggering host snapshot via /tmp/df_snap_trigger...");
    runCmd(`ssh ${HOST} "touch /tmp/df_snap_trigger"`);
    await page.waitForTimeout(1000);

    // Fetch host snapshot
    runCmd(`scp ${HOST}:/tmp/df_snap_host.raw /tmp/df_snap_host.raw`);
    
    // Convert host raw to PNG
    const hostPngPath = path.join(ARTIFACTS_DIR, "arena_gameplay_host.png");
    const diffPngPath = path.join(ARTIFACTS_DIR, "arena_gameplay_diff.png");
    
    runCmd(`python3 -c "
from PIL import Image
import numpy as np
with open('/tmp/df_snap_host.raw', 'rb') as f:
    data = f.read()
arr = np.frombuffer(data, dtype=np.uint8).reshape((720, 1280, 4))
img = Image.fromarray(arr, 'RGBA')
img.save('${hostPngPath}')
"`);
    console.log(`Saved host arena screenshot to ${hostPngPath}`);

    // Compare host vs client
    const compScript = "./tests/qa_pixel_comparator.py";
    const out = runCmd(`python3 ${compScript} ${hostPngPath} ${clientPngPath} ${diffPngPath} 0`);
    const res = JSON.parse(out.trim());
    console.log("=== In-Game Arena Parity Result ===");
    console.log(JSON.stringify(res, null, 2));

    // Test camera panning
    console.log("\nTesting camera panning in active arena...");
    for (let i = 0; i < 4; i++) {
        await page.keyboard.press("ArrowRight");
        await page.waitForTimeout(150);
    }
    for (let i = 0; i < 4; i++) {
        await page.keyboard.press("ArrowDown");
        await page.waitForTimeout(150);
    }
    await page.waitForTimeout(1000);

    // Check client stats from HUD
    const stats = await page.evaluate(() => {
        const fpsElem = document.getElementById("statFps");
        const bwElem = document.getElementById("statBw");
        const cmdsElem = document.getElementById("statCmds");
        return {
            fps: fpsElem ? fpsElem.innerText : "N/A",
            bw: bwElem ? bwElem.innerText : "N/A",
            cmds: cmdsElem ? cmdsElem.innerText : "N/A"
        };
    });
    console.log("Client In-Game Telemetry:", stats);

    await browser.close();
}

main().catch(err => {
    console.error("Test failed:", err);
    process.exit(1);
});
