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
    const remoteCmd = `ssh ${HOST} "xwd -root -display :99 -out /tmp/qa_host.xwd && python3 /tmp/decode_xwd.py /tmp/qa_host.xwd /tmp/qa_host.png"`;
    runCmd(remoteCmd);
    const hostLocalPath = `/tmp/qa_host_${stepName}.png`;
    runCmd(`scp ${HOST}:/tmp/qa_host.png ${hostLocalPath}`);
    return hostLocalPath;
}

function compareFrames(hostPath, clientPath, diffPath) {
    const compScript = path.join(__dirname, "qa_pixel_comparator.py");
    const output = runCmd(`python3 ${compScript} ${hostPath} ${clientPath} ${diffPath} 2`);
    return JSON.parse(output.trim());
}

async function main() {
    console.log("=== Starting Automated QA Parity Suite ===");

    // 1. Restart streamer and dwarfort on host
    console.log("Restarting DF streamer on host...");
    runCmd(`ssh ${HOST} "bash /tmp/restart_stream.sh"`);
    console.log("Waiting 4s for game and bridge to initialize...");
    await new Promise(r => setTimeout(r, 4000));

    // 2. Launch browser
    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
    const page = await context.newPage();

    console.log(`Connecting to ${URL}...`);
    await page.goto(URL);
    await page.waitForTimeout(3000);

    const canvas = page.locator("#gameCanvas");
    await canvas.waitFor({ state: "visible" });

    // Viewport overflow checks under small screens
    console.log("Verifying responsive viewport containment (1024x600)...");
    await page.setViewportSize({ width: 1024, height: 600 });
    await page.waitForTimeout(500);
    const overflowCheck = await page.evaluate(() => {
        const docW = document.documentElement.scrollWidth;
        const docH = document.documentElement.scrollHeight;
        const winW = window.innerWidth;
        const winH = window.innerHeight;
        return { docW, docH, winW, winH, noOverflow: docW <= winW && docH <= winH };
    });
    console.log("Responsive check (1024x600):", JSON.stringify(overflowCheck));
    if (!overflowCheck.noOverflow) {
        throw new Error(`Viewport overflow detected at 1024x600: ${JSON.stringify(overflowCheck)}`);
    }

    // Reset viewport to standard 1280x720 for pixel-for-pixel parity tests
    await page.setViewportSize({ width: 1280, height: 720 });
    await page.waitForTimeout(1000);

    const results = [];

    const steps = [
        {
            name: "1_title_idle",
            action: async () => {
                await page.waitForTimeout(1500);
            }
        },
        {
            name: "2_hover_settings",
            action: async () => {
                const box = await canvas.boundingBox();
                await page.mouse.move(box.x + 640, box.y + 475);
                await page.waitForTimeout(1200);
            }
        },
        {
            name: "3_click_settings",
            action: async () => {
                const box = await canvas.boundingBox();
                await page.mouse.move(box.x + 640, box.y + 475);
                await page.mouse.down();
                await page.waitForTimeout(150);
                await page.mouse.up();
                await page.waitForTimeout(2000);
            }
        },
        {
            name: "4_escape_to_title",
            action: async () => {
                await page.keyboard.press("Escape");
                await page.waitForTimeout(2000);
            }
        },
        {
            name: "5_click_about",
            action: async () => {
                const box = await canvas.boundingBox();
                await page.mouse.move(box.x + 640, box.y + 510);
                await page.mouse.down();
                await page.waitForTimeout(150);
                await page.mouse.up();
                await page.waitForTimeout(2000);
            }
        }
    ];

    for (const step of steps) {
        console.log(`\n--- Running Step: ${step.name} ---`);
        await step.action();

        const clientPath = `/tmp/qa_client_${step.name}.png`;
        const diffPath = `/tmp/qa_diff_${step.name}.png`;

        const dataUrl = await page.evaluate(() => {
            const c = document.getElementById("gameCanvas");
            return c.toDataURL("image/png");
        });
        const base64Data = dataUrl.replace(/^data:image\/png;base64,/, "");
        fs.writeFileSync(clientPath, Buffer.from(base64Data, "base64"));
        const hostPath = captureHost(step.name);

        const metrics = compareFrames(hostPath, clientPath, diffPath);
        metrics.step = step.name;
        metrics.clientPath = clientPath;
        metrics.hostPath = hostPath;
        results.push(metrics);

        console.log(`Exact Match: ${metrics.exact_match_pct}% | Tol Match: ${metrics.tol_match_pct}% | Max Delta: ${metrics.max_delta} | Mean Delta: ${metrics.mean_delta}`);
    }

    await browser.close();

    console.log("\n========================================================");
    console.log("                AUTOMATED QA SCORECARD                  ");
    console.log("========================================================");
    console.table(results.map(r => ({
        Step: r.step,
        "Exact Match %": r.exact_match_pct + "%",
        "Tol Match %": r.tol_match_pct + "%",
        "Mismatch Pixels": r.tol_mismatch_count,
        "Max Delta": r.max_delta,
        "Mean Delta": r.mean_delta
    })));

    fs.writeFileSync("/tmp/qa_results.json", JSON.stringify(results, null, 2));
    console.log("Saved /tmp/qa_results.json");
}

main().catch(err => {
    console.error("QA Test Failed:", err);
    process.exit(1);
});
