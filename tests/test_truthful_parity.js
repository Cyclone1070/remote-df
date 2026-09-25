const { chromium } = require("playwright");
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

// Hard 240s watchdog timer to prevent hangs
const watchdog = setTimeout(() => {
    console.error('WATCHDOG TIMEOUT: Gating test execution exceeded 240s limit.');
    process.exit(1);
}, 240000);

const HOST = process.env.TARGET_HOST || "localhost";
const URL = `http://localhost:48600/?nohud=1`;
const OUT_DIR = path.join(__dirname, "output");
const REF_DIR = path.join(__dirname, 'reference');
const SSH_OPTS = '-o ConnectTimeout=10 -o BatchMode=yes -o StrictHostKeyChecking=no';

function captureHost(name) {
    const remoteXwd = `/tmp/gating_${name}.xwd`;
    const remotePng = `/tmp/gating_${name}.png`;
    const localPng = path.join(OUT_DIR, `host_${name}.png`);
    console.log(`[HOST] Capturing X11 display :99 for ${name}...`);
    execSync(`ssh ${SSH_OPTS} ${HOST} "xwd -root -display :99 -out ${remoteXwd} && python3 /tmp/decode_xwd.py ${remoteXwd} ${remotePng}"`, { timeout: 20000 });
    execSync(`scp ${SSH_OPTS} ${HOST}:${remotePng} "${localPng}"`, { timeout: 20000 });
    return localPng;
}

function compareFiles(label, fileA, fileB, diffPng) {
    const cmd = `python3 tests/qa_pixel_comparator.py "${fileA}" "${fileB}" "${diffPng}" 5`;
    const out = execSync(cmd, { encoding: 'utf8', timeout: 20000 });
    const res = JSON.parse(out);
    console.log(`[PARITY ${label}] exact=${res.exact_match_pct}% tol=${res.tol_match_pct}% mismatches=${res.tol_mismatch_count}/${res.total_pixels} (max_delta=${res.max_delta})`);
    return res;
}

async function main() {
    console.log('=== Truthful Ground Truth Parity Gating Test ===');
    
    // Step 0: Clean restart to ensure Title screen baseline
    console.log('Restarting Dwarf Fortress on host for clean gating test baseline...');
    execSync('bash scripts/restart_stream.sh 0', { stdio: 'inherit' });
    console.log('Waiting for streamer on port 48600 to be ready...');
    for (let i = 0; i < 30; i++) {
        try {
            execSync('curl -s -f -I http://localhost:48600/', { stdio: 'ignore' });
            break;
        } catch {
            execSync('sleep 0.5');
        }
    }
    
    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
    const page = await context.newPage();

    page.on('console', msg => {
        const txt = msg.text();
        if (txt.includes('error') || txt.includes('overflow')) {
            console.log(`[PAGE LOG] ${txt}`);
        }
    });

    console.log(`Navigating to ${URL}...`);
    await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 15000 });
    await page.waitForTimeout(2500);

    // ==========================================
    // 1. Title Screen Verification
    // ==========================================
    console.log('\n--- 1. Title Screen Verification ---');
    const clientTitlePng = path.join(OUT_DIR, 'client_title.png');
    const diffTitleLive = path.join(OUT_DIR, 'diff_title_live.png');
    const diffTitleRef = path.join(OUT_DIR, 'diff_title_ref.png');

    const titleDataUrl = await page.evaluate(() => {
        const c = document.getElementById('gameCanvas');
        return c ? c.toDataURL('image/png') : null;
    });
    fs.writeFileSync(clientTitlePng, Buffer.from(titleDataUrl.replace(/^data:image\/png;base64,/, ''), 'base64'));

    const hostTitlePng = captureHost('title');
    const titleLiveRes = compareFiles('Title vs Live Host', hostTitlePng, clientTitlePng, diffTitleLive);
    const titleRefRes = compareFiles('Title vs Reference', path.join(REF_DIR, 'truth_title.png'), clientTitlePng, diffTitleRef);

async function waitForScreen(page, name, conditionFn, timeoutMs = 30000) {
    const start = Date.now();
    console.log(`Waiting for screen: ${name}...`);
    let lastLog = 0;
    while (Date.now() - start < timeoutMs) {
        const ok = await page.evaluate(conditionFn);
        if (ok) {
            console.log(`[SCREEN DETECTED] ${name} after ${Date.now() - start}ms`);
            return true;
        }
        const elapsedSec = Math.floor((Date.now() - start) / 1000);
        if (elapsedSec > 0 && elapsedSec % 5 === 0 && elapsedSec !== lastLog) {
            console.log(`... still waiting for ${name} (${elapsedSec}s elapsed)`);
            lastLog = elapsedSec;
        }
        await page.waitForTimeout(500);
    }
    throw new Error(`Timeout waiting for screen: ${name}`);
}

    // ==========================================
    // 2. Arena Navigation & World Generation
    // ==========================================
    // Visual gate: wait for Setup Menu ("Create arena" button green border loaded)
    let arenaSetupLoaded = false;
    for (let attempt = 0; attempt < 3; attempt++) {
        console.log(`Clicking "Object testing arena" at (631, 437) (attempt ${attempt + 1})...`);
        await page.mouse.move(631, 437);
        await page.waitForTimeout(100);
        await page.mouse.down();
        await page.waitForTimeout(100);
        await page.mouse.up();
        try {
            await waitForScreen(page, 'Arena Setup Menu', () => {
                if (window.renderer) window.renderer.render();
                const c = document.getElementById('gameCanvas');
                const gl = c ? c.getContext('webgl2') : null;
                if (!gl) return false;
                const px = new Uint8Array(30 * 20 * 4);
                gl.readPixels(930, 720 - 690, 30, 20, gl.RGBA, gl.UNSIGNED_BYTE, px);
                let greenCount = 0;
                for (let i = 0; i < px.length; i += 4) {
                    if (px[i+1] > 150 && px[i] < 50) greenCount++;
                }
                return greenCount > 5;
            }, 8000);
            arenaSetupLoaded = true;
            break;
        } catch (e) {
            console.warn(`Attempt ${attempt + 1} to enter Arena Setup Menu timed out, retrying...`);
        }
    }
    if (!arenaSetupLoaded) throw new Error('Failed to enter Arena Setup Menu after 3 attempts');

    console.log('Clicking "Create arena" at (1000, 685)...');
    await page.mouse.move(1000, 685);
    await page.waitForTimeout(100);
    await page.mouse.down();
    await page.waitForTimeout(100);
    await page.mouse.up();

    // Visual gate: wait for Arena Playfield ("Elevation 1" text loaded)
    await waitForScreen(page, 'In-Game Arena Playfield', () => {
        if (window.renderer) window.renderer.render();
        const c = document.getElementById('gameCanvas');
        const gl = c ? c.getContext('webgl2') : null;
        if (!gl) return false;
        const w = 20, h = 10;
        const px = new Uint8Array(w * h * 4);
        gl.readPixels(1100, 450, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);
        let count = 0;
        for (let i = 0; i < px.length; i += 4) {
            if (px[i] > 200 && px[i+1] > 200 && px[i+2] > 200) count++;
        }
        return count > 15;
    }, 120000);
    await page.waitForTimeout(1500);

    // ==========================================
    // 3. In-Game Arena Verification
    // ==========================================
    console.log('\n--- 3. Arena Playfield Verification ---');
    const clientArenaPng = path.join(OUT_DIR, 'client_arena.png');
    const diffArenaLive = path.join(OUT_DIR, 'diff_arena_live.png');
    const diffArenaRef = path.join(OUT_DIR, 'diff_arena_ref.png');

    const arenaDataUrl = await page.evaluate(() => {
        if (window.renderer) window.renderer.render();
        const c = document.getElementById('gameCanvas');
        return c ? c.toDataURL('image/png') : null;
    });
    fs.writeFileSync(clientArenaPng, Buffer.from(arenaDataUrl.replace(/^data:image\/png;base64,/, ''), 'base64'));

    const hostArenaPng = captureHost('arena');
    const arenaLiveRes = compareFiles('Arena vs Live Host', hostArenaPng, clientArenaPng, diffArenaLive);
    const arenaRefRes = compareFiles('Arena vs Reference', path.join(REF_DIR, 'truth_arena.png'), clientArenaPng, diffArenaRef);

    // ==========================================
    // 4. Escape Menu Verification
    // ==========================================
    console.log('\n--- 4. Escape Menu Verification ---');
    let escDetected = false;
    for (let attempt = 0; attempt < 3; attempt++) {
        console.log(`Attempt ${attempt + 1}: Pressing Escape via host X11...`);
        execSync(`ssh ${SSH_OPTS} ${HOST} "python3 /tmp/press_escape.py"`, { timeout: 20000 });
        for (let i = 0; i < 10; i++) {
            await page.waitForTimeout(500);
            const hasMenu = await page.evaluate(() => {
                if (window.renderer) window.renderer.render();
                const c = document.getElementById('gameCanvas');
                const gl = c ? c.getContext('webgl2') : null;
                if (!gl) return false;
                const px = new Uint8Array(20 * 10 * 4);
                gl.readPixels(630, 720 - 250, 20, 10, gl.RGBA, gl.UNSIGNED_BYTE, px);
                let yellowCount = 0;
                for (let j = 0; j < px.length; j += 4) {
                    if (px[j] > 200 && px[j+1] > 180 && px[j+2] < 50) yellowCount++;
                }
                return yellowCount > 5;
            });
            if (hasMenu) {
                console.log(`Escape menu verified on client canvas after ${(i + 1) * 0.5}s!`);
                escDetected = true;
                break;
            }
        }
        if (escDetected) break;
    }
    if (!escDetected) throw new Error('Escape menu verification failed: yellow menu border not detected.');
    await page.waitForTimeout(1000);

    const clientEscPng = path.join(OUT_DIR, 'client_esc.png');
    const diffEscLive = path.join(OUT_DIR, 'diff_esc_live.png');
    const diffEscRef = path.join(OUT_DIR, 'diff_esc_ref.png');

    const escDataUrl = await page.evaluate(() => {
        if (window.renderer) window.renderer.render();
        const c = document.getElementById('gameCanvas');
        return c ? c.toDataURL('image/png') : null;
    });
    fs.writeFileSync(clientEscPng, Buffer.from(escDataUrl.replace(/^data:image\/png;base64,/, ''), 'base64'));

    const hostEscPng = captureHost('esc');
    const escLiveRes = compareFiles('Esc vs Live Host', hostEscPng, clientEscPng, diffEscLive);
    const escRefRes = compareFiles('Esc vs Reference', path.join(REF_DIR, 'truth_esc.png'), clientEscPng, diffEscRef);

    await browser.close();
    clearTimeout(watchdog);

    console.log('\n======================================================');
    console.log('=== Truthful Ground Truth Parity Gating Summary ===');
    console.log('======================================================');
    console.log(`[Screen 1: Title Screen]`);
    console.log(`  Live Host Parity: ${titleLiveRes.exact_match_pct}% (Mismatches: ${titleLiveRes.exact_mismatch_count})`);
    console.log(`  Reference Parity: ${titleRefRes.tol_match_pct}% (Mismatches: ${titleRefRes.tol_mismatch_count})`);
    console.log(`[Screen 2: Arena Playfield]`);
    console.log(`  Live Host Parity: ${arenaLiveRes.exact_match_pct}% (Mismatches: ${arenaLiveRes.exact_mismatch_count})`);
    console.log(`  Reference Parity: ${arenaRefRes.tol_match_pct}% (Mismatches: ${arenaRefRes.tol_mismatch_count})`);
    console.log(`[Screen 3: Escape Menu]`);
    console.log(`  Live Host Parity: ${escLiveRes.exact_match_pct}% (Mismatches: ${escLiveRes.exact_mismatch_count})`);
    console.log(`  Reference Parity: ${escRefRes.tol_match_pct}% (Mismatches: ${escRefRes.tol_mismatch_count})`);
    console.log('======================================================');

    // Strict assertions:
    // 1. Live streaming MUST achieve 100.0% exact bit match (0 mismatches) on all screens
    const livePass = (titleLiveRes.exact_match_pct === 100.0) &&
                     (arenaLiveRes.exact_match_pct === 100.0) &&
                     (escLiveRes.exact_match_pct === 100.0);

    // 2. Reference ground truth baselines:
    // - Title >= 99.8% (random motto tagline)
    // - Arena >= 93.0% (procedural grass placement)
    // - Esc >= 93.0% (procedural background grass)
    const refPass = (titleRefRes.tol_match_pct >= 99.8) &&
                    (arenaRefRes.tol_match_pct >= 93.0) &&
                    (escRefRes.tol_match_pct >= 93.0);

    if (!livePass || !refPass) {
        console.error('FAIL: Parity gating check failed!');
        process.exit(1);
    }

    console.log('PASS: All screens achieved 100.0% bit-exact parity with live host X11 and passed ground truth baselines!');
}

main().catch(err => {
    console.error('Test execution error:', err);
    clearTimeout(watchdog);
    process.exit(1);
});
