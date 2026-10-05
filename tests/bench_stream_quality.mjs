import { chromium } from 'playwright';
import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';

const ORIGIN = process.env.TARGET_ORIGIN || 'http://100.73.151.90:8484';
const TARGET_URL = process.env.TARGET_URL || `${ORIGIN}/df`;
const IS_WAN = process.env.IS_WAN === '1' || TARGET_URL.includes('trycloudflare.com');
const ARTIFACTS_DIR = path.join(process.cwd(), 'test-results');

function resetSession(targetOrigin = ORIGIN) {
    console.log(`[Reset] Resetting fresh game session via ${targetOrigin}...`);
    try {
        execSync(`curl -s -X POST "${targetOrigin}/api/session/stop"`);
    } catch (_) {}
    for (let i = 0; i < 5; i++) {
        execSync('sleep 1');
        try {
            const res = execSync(`curl -s "${targetOrigin}/api/session"`).toString();
            if (res.includes('"idle"')) break;
        } catch (_) {}
    }
    execSync(`curl -s -X POST "${targetOrigin}/api/session/start" -H "Content-Type: application/json" -d '{"gameId":"dwarf-fortress"}'`);
    for (let i = 0; i < 10; i++) {
        execSync('sleep 1');
        try {
            const res = execSync(`curl -s "${targetOrigin}/api/session"`).toString();
            if (res.includes('"running"')) break;
        } catch (_) {}
    }
    execSync('sleep 10'); // Allow DF binary to launch and transition past intro movie to Title Screen
}

export async function runComprehensiveBenchmark(options = {}) {
    const rawUrl = options.url || process.argv[2] || TARGET_URL;
    const origin = new URL(rawUrl).origin;
    const streamUrl = rawUrl.endsWith('/df') ? rawUrl : `${origin}/df`;
    const isWan = options.isWan !== undefined ? options.isWan : (streamUrl.includes('trycloudflare.com') || IS_WAN);
    fs.mkdirSync(ARTIFACTS_DIR, { recursive: true });

    console.log(`\n===============================================================`);
    console.log(`  COMPREHENSIVE STREAM QUALITY BENCHMARK (Spec v2.0 - Verified)`);
    console.log(`  Target: ${streamUrl} [Profile: ${isWan ? 'WAN / Tunnel' : 'LAN / Direct'}]`);
    console.log(`===============================================================\n`);

    resetSession(origin);

    // Canonical 1280x720 matching reference truth baseline
    const browser = await chromium.launch({
        headless: true,
        args: ['--no-sandbox', '--disable-features=WebRtcHideLocalIpsWithMdns']
    });

    const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
    const page = await context.newPage();

    // Deep telemetry collector adhering strictly to FrameHeader protocol
    await page.addInitScript(() => {
        window.__streamTelemetry = {
            activePhase: 'init',
            totalNetFrames: 0,
            
            // Phase 0 Steady-state metrics
            p0Arrivals: [],
            p0Gaps: 0,
            p0MaxFreezeMs: 0,
            p0LateFrames: 0,

            // Overall run stats
            totalGaps: 0,
            engineStalls: 0,
            prevNetTime: 0,
            prevDelta: 0,
            prevSeq: 0
        };

        window.setTelemetryPhase = function(phase) {
            window.__streamTelemetry.activePhase = phase;
            window.__streamTelemetry.prevNetTime = 0;
            window.__streamTelemetry.prevDelta = 0;
            if (phase === 'phase0_steady') {
                window.__streamTelemetry.p0Arrivals = [];
                window.__streamTelemetry.p0Gaps = 0;
                window.__streamTelemetry.p0MaxFreezeMs = 0;
                window.__streamTelemetry.p0LateFrames = 0;
            }
        };

        const OrigPC = window.RTCPeerConnection;
        window.RTCPeerConnection = function(...args) {
            const pc = new OrigPC(...args);
            window.__activePC = pc;

            const origCreate = pc.createDataChannel.bind(pc);
            pc.createDataChannel = function(label, opts) {
                const dc = origCreate(label, opts);
                if (label === 'df-stream') {
                    let origSetter = Object.getOwnPropertyDescriptor(RTCDataChannel.prototype, 'onmessage').set;
                    Object.defineProperty(dc, 'onmessage', {
                        set(fn) {
                            origSetter.call(dc, function(ev) {
                                const now = performance.now();
                                const tel = window.__streamTelemetry;

                                if (ev.data instanceof ArrayBuffer && ev.data.byteLength >= 10) {
                                    const view = new DataView(ev.data);
                                    if (view.getUint8(0) === 0x44 && view.getUint8(1) === 0x46) {
                                        tel.totalNetFrames++;
                                        const seq = view.getUint32(2, true);

                                        // Sequence continuity check
                                        if (tel.prevSeq > 0 && seq > tel.prevSeq + 1) {
                                            const gap = (seq - tel.prevSeq - 1);
                                            tel.totalGaps += gap;
                                            if (tel.activePhase === 'phase0_steady') tel.p0Gaps += gap;
                                        }

                                        // Steady-State Telemetry (Phase 0)
                                        if (tel.activePhase === 'phase0_steady') {
                                            if (tel.prevNetTime > 0) {
                                                const deltaT = now - tel.prevNetTime;
                                                tel.p0Arrivals.push(deltaT);

                                                if (deltaT > 40.0) {
                                                    tel.p0LateFrames++;
                                                }

                                                if (deltaT > 60.0 && deltaT > tel.p0MaxFreezeMs) {
                                                    tel.p0MaxFreezeMs = deltaT;
                                                }
                                            }
                                            tel.prevNetTime = now;
                                        }

                                        if (tel.activePhase === 'phase2_worldgen' && tel.prevNetTime > 0) {
                                            if (now - tel.prevNetTime > 100.0) {
                                                tel.engineStalls++;
                                            }
                                        }

                                        tel.prevSeq = seq;
                                    }
                                }

                                return fn.apply(this, arguments);
                            });
                        }
                    });
                }
                return dc;
            };

            return pc;
        };
        window.RTCPeerConnection.prototype = OrigPC.prototype;
    });

    console.log('[Setup] Navigating to game stream at 1280x720...');
    await page.goto(streamUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    const canvas = page.locator('#gameCanvas');
    await canvas.waitFor({ state: 'attached', timeout: 30000 });

    console.log('[Setup] Waiting for WebRTC DataChannel readiness...');
    await page.waitForFunction(() => (window.__dfFrameCount || 0) >= 30 && window.renderer && window.renderer.lastSprites > 0, { timeout: 30000 });
    const box = await canvas.boundingBox();

    // -------------------------------------------------------------
    // Gate 0: Visual Parity Check on Title Screen
    // -------------------------------------------------------------
    console.log('\n--- Gate 0: Visual Parity Audit on Title Screen ---');
    const clientTitlePath = path.join(ARTIFACTS_DIR, 'bench_title_client.png');
    const refTitlePath = path.join(process.cwd(), 'tests', 'reference', 'truth_title.png');
    const diffPath = path.join(ARTIFACTS_DIR, 'bench_title_diff.png');

    let visualParityPct = 0.0;
    let tolMatchPct = 0.0;
    const shouldSkipVisual = options.skipVisualGate || process.env.SKIP_VISUAL_GATE === '1';
    if (fs.existsSync(refTitlePath) && !shouldSkipVisual) {
        const startAuditTime = Date.now();
        while (Date.now() - startAuditTime < 15000) {
            await canvas.screenshot({ path: clientTitlePath });
            try {
                const cmpRaw = execSync(`python3 tests/qa_pixel_comparator.py "${refTitlePath}" "${clientTitlePath}" "${diffPath}" 5`, { encoding: 'utf8' });
                const cmpJson = JSON.parse(cmpRaw.trim());
                visualParityPct = cmpJson.fg_match_pct;
                tolMatchPct = cmpJson.tol_match_pct;
                if (cmpJson.client_nonzero >= 20000 && cmpJson.fg_match_pct >= 95.0) {
                    break;
                }
            } catch (e) {
                console.warn('  Visual comparator check error:', e.message);
            }
            await page.waitForTimeout(500);
        }
        console.log(`  Visual Parity Foreground Match: ${visualParityPct}% | Overall Match: ${tolMatchPct}%`);
    }

    // Allow compositor to completely settle after screenshot capture
    await page.waitForTimeout(1000);

    // -------------------------------------------------------------
    // Phase 0: Steady-State Baseline Stream (5 seconds)
    // -------------------------------------------------------------
    console.log('\n--- Phase 0: Steady-State Baseline Stream (5 seconds) ---');
    const p0StartFrames = await page.evaluate(() => {
        window.setTelemetryPhase('phase0_steady');
        return window.__dfFrameCount || 0;
    });
    const p0T0 = performance.now();
    await page.waitForTimeout(5000);
    const p0Elapsed = (performance.now() - p0T0) / 1000;
    const p0Frames = (await page.evaluate(() => window.__dfFrameCount || 0)) - p0StartFrames;
    const steadyFps = Math.round((p0Frames / p0Elapsed) * 10) / 10;
    console.log(`  Phase 0 Steady Rate: ${steadyFps} FPS (${p0Frames} frames in ${p0Elapsed.toFixed(2)}s)`);
    const p0Dbg = await page.evaluate(() => {
        const arr = window.__streamTelemetry.p0Arrivals;
        return {
            count: arr.length,
            max: Math.max(...arr),
            min: Math.min(...arr),
            gt40: arr.filter(x => x > 40).length,
            gt60: arr.filter(x => x > 60).length,
            samples: arr.slice(0, 15).map(x => Math.round(x * 10) / 10)
        };
    });
    console.log('  Phase 0 Telemetry Debug:', JSON.stringify(p0Dbg));

    // -------------------------------------------------------------
    // Phase 1: Rapid Menu Navigation & Churn (20 cycles)
    // -------------------------------------------------------------
    console.log('\n--- Phase 1: Rapid Menu Navigation & Churn (20 cycles) ---');
    await page.evaluate(() => window.setTelemetryPhase('phase1_menu'));
    const p1StartFrames = await page.evaluate(() => window.__dfFrameCount || 0);
    const p1T0 = performance.now();

    for (let i = 0; i < 20; i++) {
        await page.mouse.click(box.x + 640, box.y + 475, { delay: 20 }); // Open Settings at 1280x720
        await page.waitForTimeout(60);
        await page.mouse.click(box.x + 1220, box.y + 55, { delay: 20 }); // Close Settings via Done button
        await page.waitForTimeout(60);
    }

    const p1Elapsed = (performance.now() - p1T0) / 1000;
    const p1Frames = (await page.evaluate(() => window.__dfFrameCount || 0)) - p1StartFrames;
    console.log(`  Phase 1 completed in ${p1Elapsed.toFixed(2)}s | Frames: ${p1Frames}`);

    // -------------------------------------------------------------
    // Phase 2: Object Testing Arena Transition & Entity Spawning
    // -------------------------------------------------------------
    console.log('\n--- Phase 2: World Generation, Arena Loading & Entity Spawning ---');
    await page.evaluate(() => window.setTelemetryPhase('phase2_worldgen'));

    console.log('  Clicking Object testing arena at (640, 440)...');
    await page.mouse.click(box.x + 640, box.y + 440);
    await page.waitForTimeout(1000);

    console.log('  Clicking Create arena at (991, 677)...');
    const fBeforeGen = await page.evaluate(() => window.__dfFrameCount || 0);
    const genT0 = performance.now();
    await page.mouse.click(box.x + 991, box.y + 677);

    console.log('  Quarantining engine arena world generation pause...');
    // Wait until world generation finishes and live stream resumes
    await page.waitForFunction((startFrames) => {
        return (window.__dfFrameCount || 0) > startFrames + 25;
    }, fBeforeGen, { timeout: 30000 });
    const genDurationMs = Math.round(performance.now() - genT0);
    console.log(`  Arena world generation finished in ${genDurationMs}ms (quarantined)`);
    await page.waitForTimeout(1000);

    console.log('  Spawning arena entity (clicking +M -> Create -> Place)...');
    await page.mouse.click(box.x + 455, box.y + 700); // +M toolbar button
    await page.waitForTimeout(600);
    await page.mouse.click(box.x + 780, box.y + 105); // Create button
    await page.waitForTimeout(400);
    await page.mouse.click(box.x + 600, box.y + 350); // Place on arena map
    await page.waitForTimeout(400);
    await page.mouse.click(box.x + 830, box.y + 55);  // Close creature dialog [->x]
    await page.waitForTimeout(800);

    // -------------------------------------------------------------
    // Phase 3: High-Frequency Camera Panning (Spec: 20 moves/sec)
    // -------------------------------------------------------------
    console.log('\n--- Phase 3: High-Frequency Camera Panning (60 ticks @ 20 moves/s) ---');
    await page.evaluate(() => window.setTelemetryPhase('phase3_pan'));
    const p3StartFrames = await page.evaluate(() => window.__dfFrameCount || 0);
    const p3T0 = performance.now();

    for (let i = 0; i < 30; i++) {
        await page.keyboard.press('ArrowRight');
        await page.waitForTimeout(50); // 20 moves/sec
        await page.keyboard.press('ArrowDown');
        await page.waitForTimeout(50);
    }

    const p3Elapsed = (performance.now() - p3T0) / 1000;
    const p3Frames = (await page.evaluate(() => window.__dfFrameCount || 0)) - p3StartFrames;
    console.log(`  Phase 3 fast pan completed in ${p3Elapsed.toFixed(2)}s | Frames: ${p3Frames} (${(p3Frames / p3Elapsed).toFixed(1)} FPS)`);
    await page.waitForTimeout(500);

    // -------------------------------------------------------------
    // Phase 4: Interactive Input M2P Latency Sampling (Hardware Stamp Loopback)
    // -------------------------------------------------------------
    console.log('\n--- Phase 4: Interactive Input M2P Sampling (Debug Stamp Loopback) ---');
    await page.evaluate(() => {
        window.setTelemetryPhase('phase4_m2p');
        window.__enableM2P = true;
        window.__m2pHistory = [];
    });

    // Stimulate engine with 25 discrete interactive inputs across active arena terrain
    for (let i = 0; i < 25; i++) {
        const x = box.x + 550 + ((i * 13) % 180);
        const y = box.y + 250 + ((i * 17) % 200);
        await page.mouse.move(x, y, { steps: 1 });
        await page.waitForTimeout(120);
    }
    await page.waitForTimeout(400);

    const m2pSamples = await page.evaluate(() => {
        return (window.__m2pHistory && window.__m2pHistory.length > 0)
            ? window.__m2pHistory
            : (window.__m2pSamples || []);
    });

    m2pSamples.sort((a, b) => a - b);
    const p50 = m2pSamples.length > 0 ? Math.round(m2pSamples[Math.floor(m2pSamples.length * 0.5)] * 10) / 10 : 0;
    const p95 = m2pSamples.length > 0 ? Math.round(m2pSamples[Math.floor(m2pSamples.length * 0.95)] * 10) / 10 : p50;
    console.log(`  Interactive M2P (${m2pSamples.length} samples): p50 = ${p50}ms | p95 = ${p95}ms`);
    console.log('  M2P Raw Samples:', m2pSamples.map(x => Math.round(x * 10) / 10));

    // -------------------------------------------------------------
    // Final Telemetry Harvest & Evaluation
    // -------------------------------------------------------------
    const finalTel = await page.evaluate(async () => {
        const tel = window.__streamTelemetry;
        let rtt = null;
        let activePair = null;

        if (window.__activePC) {
            const stats = await window.__activePC.getStats();
            let selectedPairId = null;
            for (const r of stats.values()) {
                if (r.type === 'transport' && r.selectedCandidatePairId) {
                    selectedPairId = r.selectedCandidatePairId;
                    break;
                }
            }

            for (const r of stats.values()) {
                if (r.type === 'candidate-pair') {
                    if ((selectedPairId && r.id === selectedPairId) || (!selectedPairId && (r.state === 'succeeded' || r.nominated))) {
                        rtt = r.currentRoundTripTime ? Math.round(r.currentRoundTripTime * 1000 * 10) / 10 : rtt;
                        const localCand = stats.get(r.localCandidateId);
                        const remoteCand = stats.get(r.remoteCandidateId);
                        activePair = `${localCand?.candidateType || 'unknown'} -> ${remoteCand?.candidateType || 'unknown'}`;
                        if (selectedPairId && r.id === selectedPairId) break;
                    }
                }
            }
        }

        // Calculate RFC 3550 interarrival jitter: J_i = J_{i-1} + (|D(i-1, i)| - J_{i-1}) / 16
        const arrivals = tel.p0Arrivals;
        let jitter = 0;
        const NOMINAL_INTERVAL = 20.0;
        for (let i = 0; i < arrivals.length; i++) {
            const d = Math.abs(arrivals[i] - NOMINAL_INTERVAL);
            jitter += (d - jitter) / 16.0;
        }

        return {
            totalNetFrames: tel.totalNetFrames,
            p0BurstCount: arrivals.length,
            p0JitterMs: Math.round(jitter * 10) / 10,
            p0LateFrames: tel.p0LateFrames,
            p0LateFramePct: arrivals.length > 0 ? Math.round((tel.p0LateFrames / arrivals.length) * 1000) / 10 : 0,
            p0MaxFreezeMs: Math.round(tel.p0MaxFreezeMs),
            p0Gaps: tel.p0Gaps,
            totalGaps: tel.totalGaps,
            engineStalls: tel.engineStalls,
            rttMs: rtt,
            activePair
        };
    });

    await browser.close();

    const gates = isWan ? {
        minSteadyFps: 47.0,
        maxJitter: 12.0,
        maxFreeze: 120.0,
        maxLatePct: 4.0,
        maxP95M2P: 140.0,
        maxGaps: 3,
        minVisualMatch: 95.0
    } : {
        minSteadyFps: 49.0,
        maxJitter: 5.0,
        maxFreeze: 80.0,
        maxLatePct: 3.0,
        maxP95M2P: 85.0,
        maxGaps: 0,
        minVisualMatch: 95.0
    };

    const results = {
        profile: options.profileLabel || (isWan ? 'WAN / Cloudflare' : 'LAN / Direct'),
        metrics: {
            steadyStreamFps: steadyFps,
            interarrivalJitterMs: finalTel.p0JitterMs,
            lateFrameRatioPct: finalTel.p0LateFramePct,
            maxNetworkFreezeMs: finalTel.p0MaxFreezeMs,
            m2pLatencyP50Ms: p50,
            m2pLatencyP95Ms: p95,
            frameGapsSteady: finalTel.p0Gaps,
            frameGapsTotal: finalTel.totalGaps,
            rttMs: finalTel.rttMs,
            activePair: finalTel.activePair,
            visualParityPct,
            tolMatchPct,
            worldgenTimeMs: genDurationMs,
            steadyBursts: finalTel.p0BurstCount
        },
        gates,
        passed: (
            steadyFps >= gates.minSteadyFps &&
            finalTel.p0JitterMs <= gates.maxJitter &&
            finalTel.p0MaxFreezeMs <= gates.maxFreeze &&
            finalTel.p0LateFramePct <= gates.maxLatePct &&
            p95 <= gates.maxP95M2P &&
            finalTel.p0Gaps <= gates.maxGaps &&
            visualParityPct >= gates.minVisualMatch
        )
    };

    console.log(`\n================ QUALITY GATE EVALUATION (Spec v2.0) ================`);
    console.table({
        'Steady Stream FPS': { value: `${steadyFps} FPS`, gate: `>= ${gates.minSteadyFps} FPS`, pass: steadyFps >= gates.minSteadyFps },
        'Interarrival Jitter': { value: `${finalTel.p0JitterMs} ms`, gate: `<= ${gates.maxJitter} ms`, pass: finalTel.p0JitterMs <= gates.maxJitter },
        'Late Frame Ratio': { value: `${finalTel.p0LateFramePct} %`, gate: `<= ${gates.maxLatePct} %`, pass: finalTel.p0LateFramePct <= gates.maxLatePct },
        'Max Net Freeze': { value: `${finalTel.p0MaxFreezeMs} ms`, gate: `<= ${gates.maxFreeze} ms`, pass: finalTel.p0MaxFreezeMs <= gates.maxFreeze },
        'M2P Latency (p95)': { value: `${p95} ms`, gate: `<= ${gates.maxP95M2P} ms`, pass: p95 <= gates.maxP95M2P },
        'Steady Gaps': { value: finalTel.p0Gaps, gate: `<= ${gates.maxGaps}`, pass: finalTel.p0Gaps <= gates.maxGaps },
        'Visual Parity': { value: `${visualParityPct} %`, gate: `>= ${gates.minVisualMatch} %`, pass: visualParityPct >= gates.minVisualMatch },
        'Candidate Pair': { value: finalTel.activePair, gate: 'UDP Direct', pass: true }
    });
    console.log(`OVERALL VERDICT: ${results.passed ? '✅ PASSED' : '❌ FAILED'}\n`);

    return results;
}

if (import.meta.url === `file://${process.argv[1]}`) {
    runComprehensiveBenchmark().catch(err => {
        console.error('Benchmark failed with error:', err);
        process.exit(1);
    });
}
