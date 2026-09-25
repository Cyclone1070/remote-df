const { chromium } = require("playwright");
const { execSync } = require('child_process');
const fs = require('fs');

async function main() {
    console.log('1. Restarting stream...');
    execSync('bash scripts/restart_stream.sh 0', { stdio: 'ignore' });
    execSync('sleep 3');

    console.log('2. Opening client...');
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
    await page.goto('http://localhost:48600/?nohud=1');
    await page.waitForTimeout(3000);

    console.log('3. Entering Arena 1st time...');
    await page.mouse.click(631, 437); // Object testing arena
    await page.waitForTimeout(2000);
    await page.mouse.click(1000, 685); // Create arena
    await page.waitForTimeout(25000); // Wait for map to load

    console.log('4. Zooming in...');
    await page.keyboard.press('BracketLeft');
    await page.waitForTimeout(300);
    await page.keyboard.press('BracketLeft');
    await page.waitForTimeout(300);
    await page.keyboard.press('BracketLeft');
    await page.waitForTimeout(1000);

    console.log('5. Exiting Arena...');
    await page.keyboard.press('Escape');
    await page.waitForTimeout(1500);
    await page.mouse.click(635, 378); // Quit without saving
    await page.waitForTimeout(1500);
    await page.mouse.click(431, 401); // Confirm quit
    await page.waitForTimeout(8000); // Wait for title screen to reload

    console.log('6. Re-entering Arena 2nd time...');
    await page.mouse.click(631, 437); // Object testing arena
    await page.waitForTimeout(2000);
    await page.mouse.click(1000, 685); // Create arena
    await page.waitForTimeout(25000); // Wait for map to load

    console.log('7. Capturing canvas...');
    const dataUrl = await page.evaluate(() => {
        if (window.renderer) window.renderer.render();
        return document.getElementById('gameCanvas').toDataURL('image/png');
    });

    const outPath = path.join(__dirname, "output");
    fs.writeFileSync(outPath, Buffer.from(dataUrl.split(',')[1], 'base64'));
    console.log(`Saved screenshot to ${outPath}`);

    // Check pixels in toolbar
    const result = await page.evaluate(() => {
        const gl = window.renderer.gl;
        const w = window.renderer.canvas.width;
        const px = new Uint8Array(w * 4);
        gl.readPixels(0, 15, w, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
        const bars = [];
        for (let x = 0; x < w; x++) {
            const r = px[x * 4], g = px[x * 4 + 1], b = px[x * 4 + 2];
            if (Math.abs(r - 192) < 5 && Math.abs(g - 192) < 5 && Math.abs(b - 192) < 5) {
                bars.push(x);
            }
        }
        return { greyBarPixels: bars.length, positions: bars.slice(0, 20) };
    });

    await browser.close();
    console.log('\nRESULT:', JSON.stringify(result));
}

main().catch(console.error);
