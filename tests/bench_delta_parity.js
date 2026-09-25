const { chromium } = require("playwright");
const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

const HOST = process.env.TARGET_HOST || "localhost";
const URL = process.env.TARGET_URL || \"http://localhost:48600/?nohud=1\";
const ARTIFACTS_DIR = path.join(__dirname, "output");

function runCmd(cmd) {
    return execSync(cmd, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

async function verifyParity(stepName, page) {
    // 1. Trigger snapshot on host
    runCmd(`ssh ${HOST} "touch /tmp/df_snap_trigger"`);
    await page.waitForTimeout(600);

    // 2. Capture client canvas
    const clientDataUrl = await page.evaluate(() => {
        const c = document.getElementById("gameCanvas");
        return c.toDataURL("image/png");
    });
    const clientPngPath = path.join(ARTIFACTS_DIR, `delta_client_${stepName}.png`);
    fs.writeFileSync(clientPngPath, Buffer.from(clientDataUrl.replace(/^data:image\/png;base64,/, ""), "base64"));

    // 3. Fetch host raw frame
    runCmd(`scp ${HOST}:/tmp/df_snap_host.raw /tmp/df_snap_host.raw`);
    const hostPngPath = path.join(ARTIFACTS_DIR, `delta_host_${stepName}.png`);
    const diffPngPath = path.join(ARTIFACTS_DIR, `delta_diff_${stepName}.png`);

    runCmd(`python3 -c "
from PIL import Image
import numpy as np
with open('/tmp/df_snap_host.raw', 'rb') as f:
    arr = np.frombuffer(f.read(), dtype=np.uint8).reshape((720, 1280, 4))
Image.fromarray(arr, 'RGBA').save('${hostPngPath}')
"`);

    // 4. Compare with 0 tolerance
    const compScript = "./tests/qa_pixel_comparator.py";
    const out = runCmd(`python3 ${compScript} ${hostPngPath} ${clientPngPath} ${diffPngPath} 0`);
    const res = JSON.parse(out.trim());
    console.log(`[Parity: ${stepName}] Exact match: ${res.exact_match_pct}% (mismatches: ${res.exact_mismatch_count})`);
    return res;
}

async function main() {
    console.log("=== Testing Delta Stream Parity and Interactivity ===");

    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });

    console.log("Connecting to live stream...");
    await page.goto(URL);
    await page.waitForTimeout(3000);

    const canvas = page.locator("#gameCanvas");
    await canvas.waitFor({ state: "visible" });
    const box = await canvas.boundingBox();

    // Test 1: Title Screen after consuming 60+ delta frames
    console.log("\n--- Step 1: Stationary Delta Streaming ---");
    await page.waitForTimeout(2000);
    const res1 = await verifyParity("stationary_title", page);
    if (res1.exact_mismatch_count !== 0) throw new Error("Step 1 failed bit-exact parity!");

    // Test 2: Mouse Hover over "Settings" (triggers delta updates for button highlight)
    console.log("\n--- Step 2: Mouse Hover Delta Streaming ---");
    await page.mouse.move(box.x + 640, box.y + 475);
    await page.waitForTimeout(1000);
    const res2 = await verifyParity("hover_settings", page);
    if (res2.exact_mismatch_count !== 0) throw new Error("Step 2 failed bit-exact parity!");

    // Test 3: Click Settings
    console.log("\n--- Step 3: Click Settings & Transition to Settings Submenu ---");
    await page.mouse.down();
    await page.waitForTimeout(150);
    await page.mouse.up();
    await page.waitForTimeout(2000);
    const res3 = await verifyParity("in_settings", page);
    if (res3.exact_mismatch_count !== 0) throw new Error("Step 3 failed bit-exact parity!");

    // Test 4: Escape back to title
    console.log("\n--- Step 4: Escape back to title ---");
    await page.keyboard.press("Escape");
    await page.waitForTimeout(2000);
    const res4 = await verifyParity("back_to_title", page);
    if (res4.exact_mismatch_count !== 0) throw new Error("Step 4 failed bit-exact parity!");

    console.log("\n>>> ALL DELTA PARITY CHECKS PASSED WITH 100.000% EXACT MATCH (0 PIXELS TOLERANCE) <<<");
    await browser.close();
}

main().catch(err => {
    console.error("Test failed:", err);
    process.exit(1);
});
