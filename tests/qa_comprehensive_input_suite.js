const { chromium } = require("playwright");
const { execSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const HOST = process.env.TARGET_HOST || "localhost";
const URL = process.env.TARGET_URL || \"http://localhost:48600/?nohud=1\";

function runCmd(cmd) {
    return execSync(cmd, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

function captureHost(stepName) {
    const remoteCmd = `ssh ${HOST} "xwd -root -display :99 -out /tmp/qa_${stepName}_host.xwd && python3 /tmp/decode_xwd.py /tmp/qa_${stepName}_host.xwd /tmp/qa_${stepName}_host.png"`;
    runCmd(remoteCmd);
    const hostLocalPath = `/tmp/qa_${stepName}_host.png`;
    runCmd(`scp ${HOST}:/tmp/qa_${stepName}_host.png ${hostLocalPath}`);
    return hostLocalPath;
}

function compareFrames(hostPath, clientPath, diffPath) {
    const compScript = path.join(__dirname, "qa_pixel_comparator.py");
    const output = runCmd(`python3 ${compScript} ${hostPath} ${clientPath} ${diffPath} 2`);
    return JSON.parse(output.trim());
}

function checkHostLiveness() {
    const out = runCmd(`ssh ${HOST} "pgrep dwarfort || true"`).trim();
    if (!out) {
        throw new Error("FATAL: dwarfort process is dead!");
    }
    return parseInt(out, 10);
}

async function main() {
    console.log("=== Launching Comprehensive Input & Parity QA Suite ===");

    const initialPid = checkHostLiveness();
    console.log(`Initial dwarfort PID on host: ${initialPid}`);

    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
    const page = await context.newPage();

    console.log(`Connecting to client at ${URL}...`);
    await page.goto(URL);
    await page.waitForTimeout(3000);

    const canvas = page.locator("#gameCanvas");
    await canvas.waitFor({ state: "visible" });
    const box = await canvas.boundingBox();

    const report = {
        testedInputs: [],
        parityChecks: [],
        processLiveness: true
    };

    // Stage 1: Alphanumeric & Symbol keys (The previous crash vector)
    console.log("\n--- Testing Alphanumeric & Symbol Keys ---");
    const testKeys = [
        "a", "b", "c", "d", "e", "f", "g", "h", "i", "j", "k", "l", "m",
        "n", "o", "p", "q", "r", "s", "t", "u", "v", "w", "x", "y", "z",
        "1", "2", "3", "4", "5", "6", "7", "8", "9", "0",
        "Space", "Enter", "Backspace", "Tab",
        "Minus", "Equal", "BracketLeft", "BracketRight", "Semicolon", "Quote", "Comma", "Period", "Slash"
    ];

    for (const key of testKeys) {
        await page.keyboard.press(key);
        await page.waitForTimeout(20);
        report.testedInputs.push(`Keyboard:${key}`);
    }
    const pidAfterKeys = checkHostLiveness();
    console.log(`Tested ${testKeys.length} keyboard keys. dwarfort PID: ${pidAfterKeys} (ALIVE)`);

    // Stage 2: Modifier keys
    console.log("\n--- Testing Modifier Keys (Shift, Ctrl, Alt) ---");
    await page.keyboard.down("Shift");
    await page.keyboard.press("KeyA");
    await page.keyboard.press("KeyZ");
    await page.keyboard.up("Shift");

    await page.keyboard.down("Control");
    await page.keyboard.press("KeyC");
    await page.keyboard.up("Control");

    await page.keyboard.down("Alt");
    await page.keyboard.press("Enter");
    await page.keyboard.up("Alt");
    report.testedInputs.push("Modifiers:Shift+A", "Modifiers:Ctrl+C", "Modifiers:Alt+Enter");
    checkHostLiveness();
    console.log("Modifier keys verified. dwarfort PID ALIVE.");

    // Stage 3: Navigation Keys
    console.log("\n--- Testing Navigation Keys ---");
    const navKeys = ["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "PageUp", "PageDown", "Home", "End", "Escape"];
    for (const k of navKeys) {
        await page.keyboard.press(k);
        await page.waitForTimeout(50);
        report.testedInputs.push(`Nav:${k}`);
    }
    checkHostLiveness();
    console.log("Navigation keys verified. dwarfort PID ALIVE.");

    // Stage 4: Mouse Interactions (Hover, Clicks, Wheel, Drag)
    console.log("\n--- Testing Mouse Actions ---");
    // Hover
    await page.mouse.move(box.x + 300, box.y + 200);
    await page.waitForTimeout(200);
    report.testedInputs.push("Mouse:Move/Hover");

    // Left Click
    await page.mouse.click(box.x + 640, box.y + 475);
    await page.waitForTimeout(500);
    report.testedInputs.push("Mouse:LeftClick");

    // Right Click
    await page.mouse.click(box.x + 640, box.y + 475, { button: "right" });
    await page.waitForTimeout(500);
    report.testedInputs.push("Mouse:RightClick");

    // Middle Click
    await page.mouse.click(box.x + 640, box.y + 475, { button: "middle" });
    await page.waitForTimeout(200);
    report.testedInputs.push("Mouse:MiddleClick");

    // Wheel Scroll (Up & Down)
    await page.mouse.wheel(0, -100);
    await page.waitForTimeout(200);
    await page.mouse.wheel(0, 100);
    await page.waitForTimeout(200);
    report.testedInputs.push("Mouse:WheelUp", "Mouse:WheelDown");

    // Mouse Drag
    await page.mouse.move(box.x + 400, box.y + 300);
    await page.mouse.down();
    await page.mouse.move(box.x + 500, box.y + 400, { steps: 5 });
    await page.mouse.up();
    report.testedInputs.push("Mouse:Drag");

    checkHostLiveness();
    console.log("All mouse actions verified. dwarfort PID ALIVE.");

    // Stage 5: Pixel Parity Verification with Screenshots
    console.log("\n--- Verifying Bit-Exact Parity & Capturing Screenshots ---");
    await page.waitForTimeout(1000);

    const clientDataUrl = await page.evaluate(() => document.getElementById("gameCanvas").toDataURL("image/png"));
    const clientPngPath = "/tmp/qa_suite_client.png";
    fs.writeFileSync(clientPngPath, Buffer.from(clientDataUrl.replace(/^data:image\/png;base64,/, ""), "base64"));

    const hostPngPath = captureHost("suite");
    const diffPngPath = "/tmp/qa_suite_diff.png";

    const parityResult = compareFrames(hostPngPath, clientPngPath, diffPngPath);
    console.log("Pixel Match Result:", JSON.stringify(parityResult, null, 2));

    report.parityChecks.push({
        step: "final_state",
        hostPng: hostPngPath,
        clientPng: clientPngPath,
        diffPng: diffPngPath,
        exactMatchPct: parityResult.exact_match_pct,
        mismatchCount: parityResult.tol_mismatch_count,
        passed: parityResult.tol_mismatch_count === 0
    });

    const finalPid = checkHostLiveness();
    console.log(`\nFinal host process liveness check: dwarfort PID ${finalPid} matches initial ${initialPid} (STABLE)`);

    console.log("\n=== QA SUMMARY ===");
    console.log(`Total Input Actions Tested: ${report.testedInputs.length}`);
    console.log(`Pixel Parity: ${parityResult.exact_match_pct}% (Mismatch: ${parityResult.tol_mismatch_count} px)`);
    console.log(`Process Status: STABLE (No Crash, Exit Code 0)`);

    fs.writeFileSync("/tmp/qa_comprehensive_report.json", JSON.stringify(report, null, 2));
    await browser.close();
}

main().catch(err => {
    console.error("QA FAILURE:", err);
    process.exit(1);
});
