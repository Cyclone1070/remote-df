const { chromium } = require("playwright");
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ARTIFACTS_DIR = path.join(__dirname, "output");

async function main() {
    console.log('[PROVE] 1. Cleanly restarting stream stack on host...');
    execSync('bash scripts/restart_stream.sh 0', { stdio: 'ignore', timeout: 25000 });
    
    // Wait for HTTP server
    for (let i = 0; i < 20; i++) {
        try {
            execSync('curl -s -f -I http://localhost:48600/', { stdio: 'ignore', timeout: 2000 });
            break;
        } catch {
            execSync('sleep 0.5');
        }
    }
    execSync('sleep 2');

    console.log('[PROVE] 2. Launching browser client at 1280x720 (native DF baseline)...');
    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
    const page = await context.newPage();

    await page.goto('http://localhost:48600/?nohud=1', { timeout: 15000 });
    await page.waitForTimeout(3000);

    const canvas = page.locator('#gameCanvas');
    const box = await canvas.boundingBox();

    const findGreenBoxCenter = async (scanXMin, scanXMax, scanYMin, scanYMax) => {
        return await page.evaluate(({ scanXMin, scanXMax, scanYMin, scanYMax }) => {
            if (window.renderer) window.renderer.render();
            const gl = window.renderer.gl;
            const h = window.renderer.canvas.height;
            const px = new Uint8Array(4);
            const pts = [];
            for (let y = scanYMin; y < scanYMax; y += 2) {
                for (let x = scanXMin; x < scanXMax; x += 4) {
                    gl.readPixels(x, h - 1 - y, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
                    if (px[1] > 180 && px[0] < 50 && px[2] < 120) {
                        pts.push([x, y]);
                    }
                }
            }
            if (pts.length === 0) return null;
            const xs = pts.map(p => p[0]);
            const ys = pts.map(p => p[1]);
            return {
                x: Math.floor((Math.min(...xs) + Math.max(...xs)) / 2),
                y: Math.floor((Math.min(...ys) + Math.max(...ys)) / 2)
            };
        }, { scanXMin, scanXMax, scanYMin, scanYMax });
    };

    const waitForPlayfield = async (label) => {
        console.log(`[PROVE] Waiting for ${label} (center terrain yellow/orange)...`);
        await page.waitForFunction(() => {
            if (window.renderer) window.renderer.render();
            const gl = window.renderer.gl;
            const w = window.renderer.canvas.width;
            const h = window.renderer.canvas.height;
            const px = new Uint8Array(4);
            gl.readPixels(Math.floor(w / 2), Math.floor(h / 2), 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
            return px[0] > 100 || px[1] > 100;
        }, { timeout: 45000, polling: 1000 });
        console.log(`[PROVE] ${label} ready!`);
        await page.waitForTimeout(1000);
    };

    // 1st entry to Arena
    console.log('[PROVE] 3. Entering Arena 1st time...');
    // Find "Create new world" green button on Title menu
    let titleGreen = null;
    for (let i = 0; i < 20; i++) {
        titleGreen = await findGreenBoxCenter(400, 880, 250, 550);
        if (titleGreen) break;
        await page.waitForTimeout(500);
    }
    console.log('[PROVE] Found Title green button at:', titleGreen);
    // "Object testing arena" is ~36px below "Create new world"
    await page.mouse.click(box.x + titleGreen.x, box.y + titleGreen.y + 36);
    await page.waitForTimeout(2000);

    // Find "Create arena" green button on Setup screen
    let setupGreen = null;
    for (let i = 0; i < 20; i++) {
        setupGreen = await findGreenBoxCenter(850, 1150, 600, 710);
        if (setupGreen) break;
        await page.waitForTimeout(500);
    }
    console.log('[PROVE] Found Setup green button at:', setupGreen);
    await page.mouse.click(box.x + setupGreen.x, box.y + setupGreen.y);
    await waitForPlayfield('1st Arena');

    // Zoom in 3 times
    console.log('[PROVE] 4. Zooming in 3 times with BracketLeft...');
    for (let i = 0; i < 3; i++) {
        await page.keyboard.press('BracketLeft');
        await page.waitForTimeout(500);
    }
    await page.waitForTimeout(1000);

    // Escape menu -> Quit without saving -> Confirm
    console.log('[PROVE] 5. Pressing Escape, clicking Quit without saving at (635, 378)...');
    await page.keyboard.press('Escape');
    await page.waitForTimeout(1500);
    await page.mouse.click(box.x + 635, box.y + 378);
    await page.waitForTimeout(1500);
    console.log('[PROVE] Clicking Quit confirmation at (431, 401)...');
    await page.mouse.click(box.x + 431, box.y + 401);
    await page.waitForTimeout(3000);

    // 2nd entry to Arena from Title screen
    console.log('[PROVE] 6. Re-entering Arena 2nd time...');
    let titleGreen2 = null;
    for (let i = 0; i < 30; i++) {
        titleGreen2 = await findGreenBoxCenter(400, 880, 200, 550);
        if (titleGreen2) break;
        await page.waitForTimeout(500);
    }
    console.log('[PROVE] Dynamically found Title green button after zoom at:', titleGreen2);
    // Click "Object testing arena" (36px below green button)
    await page.mouse.click(box.x + titleGreen2.x, box.y + titleGreen2.y + 36);
    await page.waitForTimeout(2000);

    // Find "Create arena" on setup screen
    let setupGreen2 = null;
    for (let i = 0; i < 20; i++) {
        setupGreen2 = await findGreenBoxCenter(850, 1150, 600, 710);
        if (setupGreen2) break;
        await page.waitForTimeout(500);
    }
    console.log('[PROVE] Found Setup green button 2nd time at:', setupGreen2);
    await page.mouse.click(box.x + setupGreen2.x, box.y + setupGreen2.y);
    await waitForPlayfield('2nd Arena');

    // Capture canvas
    console.log('[PROVE] 7. Capturing canvas and inspecting toolbar pixels...');
    const dataUrl = await page.evaluate(() => {
        if (window.renderer) window.renderer.render();
        const c = document.getElementById('gameCanvas');
        return c ? c.toDataURL('image/png') : null;
    });

    const clientPngPath = path.join(ARTIFACTS_DIR, 'proven_client_repro.png');
    fs.writeFileSync(clientPngPath, Buffer.from(dataUrl.split(',')[1], 'base64'));
    console.log(`[PROVE] Saved screenshot to ${clientPngPath}`);

    // Audit toolbar pixels and draw commands
    const auditResult = await page.evaluate(() => {
        const cmds = window.renderer.commands || [];
        const textures = window.renderer.textures;
        const gl = window.renderer.gl;

        const w = window.renderer.canvas.width;
        const h = window.renderer.canvas.height;
        const px = new Uint8Array(w * 4);
        gl.readPixels(0, 20, w, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);

        const greyXs = [];
        for (let x = 0; x < w; x++) {
            const r = px[x * 4];
            const g = px[x * 4 + 1];
            const b = px[x * 4 + 2];
            if (Math.abs(r - 192) < 5 && Math.abs(g - 192) < 5 && Math.abs(b - 192) < 5) {
                greyXs.push(x);
            }
        }

        const overlappingCmds = [];
        for (let i = 0; i < cmds.length; i++) {
            const c = cmds[i];
            if (!c || c.texId === 0) continue;
            if (c.dstY >= h - 45) {
                const tex = textures.get(c.texId);
                overlappingCmds.push({
                    idx: i,
                    dst: [c.dstX, c.dstY, c.dstW, c.dstH],
                    src: [c.srcX, c.srcY, c.srcW, c.srcH],
                    texId: c.texId,
                    texDim: tex ? [tex.w, tex.h, tex.ax, tex.ay] : null
                });
            }
        }

        return {
            canvasSize: [w, h],
            greyColumnsCount: greyXs.length,
            greyColumnsSample: greyXs.slice(0, 30),
            totalToolbarCmds: overlappingCmds.length,
            sampleCmds: overlappingCmds.slice(0, 20)
        };
    });

    await browser.close();

    console.log('\n--- AUDIT PROOF RESULT ---');
    console.log('Canvas Size:', auditResult.canvasSize);
    console.log('Grey Bar Pixels Detected (192,192,192):', auditResult.greyColumnsCount);
    console.log('Grey Column Positions:', auditResult.greyColumnsSample);
    console.log('Total Draw Commands in Toolbar:', auditResult.totalToolbarCmds);
    console.log('Sample Toolbar Commands:');
    for (const c of auditResult.sampleCmds) {
        console.log(`  Cmd #${c.idx}: dst=(${c.dst.join(',')}) src=(${c.src.join(',')}) texId=${c.texId} texDim=(${c.texDim ? c.texDim.join(',') : 'null'})`);
    }
}

main().catch(err => {
    console.error('[PROVE FAILED]', err.message);
    process.exit(1);
});
