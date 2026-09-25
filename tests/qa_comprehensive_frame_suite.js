const { chromium } = require("playwright");
const { execSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const HOST = process.env.TARGET_HOST || "localhost";
const URL = process.env.TARGET_URL || \"http://localhost:48600/?nohud=1\";
const LOCAL_FRAMES_DIR = "/tmp/df_qa_frames";

function runCmd(cmd) {
    return execSync(cmd, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

async function main() {
    console.log("=== Starting Comprehensive Frame-by-Frame QA Benchmark ===");

    // 1. Prepare local and remote directories
    if (fs.existsSync(LOCAL_FRAMES_DIR)) {
        fs.rmSync(LOCAL_FRAMES_DIR, { recursive: true, force: true });
    }
    fs.mkdirSync(LOCAL_FRAMES_DIR, { recursive: true });

    // 2. Restart DF stack on host with DF_RECORD_FRAMES=1
    console.log("Restarting DF streamer stack with frame recording enabled on host...");
    runCmd(`bash ${path.join(__dirname, "../scripts/restart_stream.sh")} 1`);
    console.log("Waiting 3s for DF and bridge startup...");
    await new Promise(r => setTimeout(r, 3000));

    // 3. Launch browser
    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
    const page = await context.newPage();

    const clientFrames = new Map();

    // Expose frame recording hook
    await page.exposeFunction("__saveFrame", (seq, dataUrl) => {
        const base64Data = dataUrl.replace(/^data:image\/png;base64,/, "");
        const framePath = path.join(LOCAL_FRAMES_DIR, `client_${String(seq).padStart(6, "0")}.png`);
        fs.writeFileSync(framePath, Buffer.from(base64Data, "base64"));
        clientFrames.set(seq, framePath);
    });

    console.log(`Connecting to client at ${URL}...`);
    await page.goto(URL);
    await page.waitForTimeout(2000);

    // Enable client recording
    await page.evaluate(() => {
        window.__DF_RECORD_FRAMES = true;
    });

    const canvas = page.locator("#gameCanvas");
    await canvas.waitFor({ state: "visible" });
    const box = await canvas.boundingBox();

    console.log("\n--- Executing Stage 1: UI Actions (Title Screen & Menus) ---");

    // Action 1: Title Screen Hover & Settings
    console.log("Hovering Settings button...");
    await page.mouse.move(box.x + 640, box.y + 475);
    await page.waitForTimeout(400);

    console.log("Clicking Settings button...");
    await page.mouse.click(box.x + 640, box.y + 475);
    await page.waitForTimeout(1000);

    // Settings Tabs Navigation
    const tabs = [
        { name: "Audio", x: 100, y: 35 },
        { name: "Game", x: 155, y: 35 },
        { name: "Keybindings", x: 215, y: 35 },
        { name: "Announcements", x: 320, y: 35 },
        { name: "Video", x: 35, y: 35 }
    ];

    for (const tab of tabs) {
        console.log(`Clicking Settings tab: ${tab.name}...`);
        await page.mouse.click(box.x + tab.x, box.y + tab.y);
        await page.waitForTimeout(500);
    }

    // Return to title
    console.log("Pressing Escape to return to Title Screen...");
    await page.keyboard.press("Escape");
    await page.waitForTimeout(800);

    // About DF Menu
    console.log("Hovering About DF button...");
    await page.mouse.move(box.x + 640, box.y + 514);
    await page.waitForTimeout(400);

    console.log("Clicking About DF...");
    await page.mouse.click(box.x + 640, box.y + 514);
    await page.waitForTimeout(800);

    console.log("Pressing Escape to return to Title Screen...");
    await page.keyboard.press("Escape");
    await page.waitForTimeout(800);

    console.log("\n--- Executing Stage 2: In-Game Arena Gameplay Actions ---");
    console.log("Clicking Object Testing Arena...");
    await page.mouse.click(box.x + 640, box.y + 438);
    await page.waitForTimeout(2500);

    // Arena Camera Navigation (Up, Down, Left, Right)
    console.log("Panning camera across map in 4 directions...");
    for (let i = 0; i < 5; i++) {
        await page.keyboard.press("ArrowUp");
        await page.waitForTimeout(50);
    }
    for (let i = 0; i < 5; i++) {
        await page.keyboard.press("ArrowRight");
        await page.waitForTimeout(50);
    }
    for (let i = 0; i < 5; i++) {
        await page.keyboard.press("ArrowDown");
        await page.waitForTimeout(50);
    }
    for (let i = 0; i < 5; i++) {
        await page.keyboard.press("ArrowLeft");
        await page.waitForTimeout(50);
    }

    // Arena Elevation Scroll (Mouse Wheel)
    console.log("Scrolling elevation Z-level with mouse wheel...");
    await page.mouse.move(box.x + 640, box.y + 360);
    await page.mouse.wheel(0, -120);
    await page.waitForTimeout(300);
    await page.mouse.wheel(0, 120);
    await page.waitForTimeout(300);

    // Arena Tile Selection & Mouse Interaction
    console.log("Clicking arena tile...");
    await page.mouse.click(box.x + 500, box.y + 400);
    await page.waitForTimeout(400);
    await page.mouse.click(box.x + 500, box.y + 400, { button: "right" });
    await page.waitForTimeout(400);

    // Let any remaining frames flush
    await page.waitForTimeout(1000);

    console.log(`\nClient recorded ${clientFrames.size} frames.`);
    await browser.close();

    // 4. Fetch host frames from elitedesk
    console.log("\n--- Fetching Host Intercepted Frames from remote host ---");
    runCmd(`scp -r ${HOST}:/tmp/df_frames/host_*.raw ${LOCAL_FRAMES_DIR}/`);

    const hostFiles = fs.readdirSync(LOCAL_FRAMES_DIR).filter(f => f.startsWith("host_") && f.endsWith(".raw"));
    console.log(`Host intercepted ${hostFiles.length} raw frames at SDL_RenderPresent.`);

    // 5. Compare every matching frame sequence
    console.log("\n--- Executing Bit-Exact Frame-by-Frame Comparison ---");
    const compScript = path.join(__dirname, "qa_frame_comparator.py");
    let comparedFrames = 0;
    let perfectMatches = 0;
    let failedFrames = 0;

    const matchedSeqs = [];
    for (const file of hostFiles) {
        const seqMatch = file.match(/host_(\d+)\.raw/);
        if (seqMatch) {
            const seq = parseInt(seqMatch[1], 10);
            if (clientFrames.has(seq)) {
                matchedSeqs.push(seq);
            }
        }
    }
    matchedSeqs.sort((a, b) => a - b);
    console.log(`Found ${matchedSeqs.length} synchronized sequence pairs between Host and Client.`);

    if (matchedSeqs.length === 0) {
        throw new Error("FATAL: Zero matching frame sequences found between host and client!");
    }

    const failedDetails = [];

    for (const seq of matchedSeqs) {
        const hostRaw = path.join(LOCAL_FRAMES_DIR, `host_${String(seq).padStart(6, "0")}.raw`);
        const clientPng = clientFrames.get(seq);
        const diffPng = path.join(LOCAL_FRAMES_DIR, `diff_${String(seq).padStart(6, "0")}.png`);

        try {
            const out = runCmd(`python3 ${compScript} ${hostRaw} ${clientPng} ${diffPng}`);
            const res = JSON.parse(out.trim());

            comparedFrames++;
            if (res.mismatch_count === 0 && res.exact_match_pct === 100) {
                perfectMatches++;
            } else {
                failedFrames++;
                failedDetails.push({ seq, mismatch_count: res.mismatch_count, match_pct: res.exact_match_pct, diff: diffPng });
                console.error(`Frame #${seq} MISMATCH: ${res.mismatch_count} pixels wrong (${res.exact_match_pct}%)`);
            }
        } catch (e) {
            failedFrames++;
            console.error(`Error comparing frame #${seq}:`, e.message);
        }
    }

    console.log("\n==========================================");
    console.log("    FRAME-BY-FRAME BENCHMARK RESULTS      ");
    console.log("==========================================");
    console.log(`Total Sequence Pairs Compared: ${comparedFrames}`);
    console.log(`100.000% Exact Bit-Matched Frames: ${perfectMatches}`);
    console.log(`Mismatched / Corrupt Frames:       ${failedFrames}`);
    console.log(`Bit-Exact Pass Rate:               ${((perfectMatches / comparedFrames) * 100).toFixed(2)}%`);

    if (failedFrames > 0) {
        console.error(`\nFAILED: ${failedFrames} frames failed bit-exact verification!`);
        console.error(JSON.stringify(failedDetails.slice(0, 10), null, 2));
        process.exit(1);
    } else {
        console.log("\n>>> ALL FRAMES PASSED WITH 100.000% EXACT PARITY (0 PIXELS TOLERANCE) <<<");
    }
}

main().catch(err => {
    console.error("QA SUITE FAILURE:", err);
    process.exit(1);
});
