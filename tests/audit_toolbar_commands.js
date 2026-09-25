const { chromium } = require("playwright");
const { execSync } = require('child_process');

async function main() {
    console.log('Restarting clean stream stack on host...');
    execSync('bash scripts/restart_stream.sh 0', { stdio: 'ignore', timeout: 15000 });
    execSync('sleep 3');

    console.log('Launching browser at 1544x928...');
    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ viewport: { width: 1544, height: 928 } });
    const page = await context.newPage();

    console.log('Navigating to game stream...');
    await page.goto('http://localhost:48600/?nohud=1', { timeout: 15000 });
    await page.waitForTimeout(3000);

    const canvas = page.locator('#gameCanvas');
    const box = await canvas.boundingBox();

    console.log('Clicking Object testing arena at (767, 540)...');
    await page.mouse.click(box.x + 767, box.y + 540);
    await page.waitForTimeout(2000);

    console.log('Clicking Create arena at (1255, 878)...');
    await page.mouse.click(box.x + 1255, box.y + 878);
    console.log('Waiting 6s for arena map generation...');
    await page.waitForTimeout(6000);

    console.log('Extracting toolbar draw commands...');
    const report = await page.evaluate(() => {
        const cmds = window.renderer.commands || [];
        const textures = window.renderer.textures;
        const results = [];

        for (let i = 0; i < cmds.length; i++) {
            const c = cmds[i];
            if (c && c.dstY >= 880) {
                const tex = textures ? textures.get(c.texId) : null;
                let sampleR = 0, sampleG = 0, sampleB = 0, sampleA = 0;
                if (tex && tex.offscreen) {
                    if (tex.offscreen.data) {
                        const d = tex.offscreen.data;
                        const midIdx = (Math.floor(tex.h / 2) * tex.w + Math.floor(tex.w / 2)) * 4;
                        sampleR = d[midIdx];
                        sampleG = d[midIdx + 1];
                        sampleB = d[midIdx + 2];
                        sampleA = d[midIdx + 3];
                    } else if (tex.offscreen instanceof Uint8Array) {
                        const d = tex.offscreen;
                        const midIdx = (Math.floor(tex.h / 2) * tex.w + Math.floor(tex.w / 2)) * 4;
                        sampleR = d[midIdx];
                        sampleG = d[midIdx + 1];
                        sampleB = d[midIdx + 2];
                        sampleA = d[midIdx + 3];
                    }
                }
                results.push({
                    cmdIdx: i,
                    x: c.dstX,
                    y: c.dstY,
                    w: c.dstW,
                    h: c.dstH,
                    texId: c.texId,
                    color: `(${sampleR},${sampleG},${sampleB},${sampleA})`
                });
            }
        }
        return results;
    });

    await browser.close();

    console.log('\n--- TOOLBAR DRAW COMMANDS (y >= 880) ---');
    console.log('Cmd# | DstRect (x, y, w, h) | TexID | Center Pixel RGBA | Classification');
    console.log('-----------------------------------------------------------------------------');
    if (report.length === 0) {
        console.log('NO_COMMANDS_IN_TOOLBAR_ROW');
    } else {
        for (const r of report) {
            const isGrey = r.color.startsWith('(192,192,192') || r.color.startsWith('(192, 192, 192');
            console.log(`${String(r.cmdIdx).padEnd(4)} | (${String(r.x).padStart(4)}, ${String(r.y).padStart(3)}, ${String(r.w).padStart(2)}, ${String(r.h).padStart(2)}) | ${String(r.texId).padEnd(5)} | ${r.color.padEnd(17)} | ${isGrey ? 'YES (GREY BAR)' : 'Other (Icon/Border)'}`);
        }
    }
}

main().catch(err => {
    console.error('FAILED:', err.message);
    process.exit(1);
});
