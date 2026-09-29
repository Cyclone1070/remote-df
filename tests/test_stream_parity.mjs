import { chromium } from 'playwright';

const TARGETS = [
    { name: 'Direct IP', url: 'http://100.73.151.90:8484/df' },
    { name: 'Cloudflare', url: 'https://gmc-bond-strategies-vocals.trycloudflare.com/df' }
];

async function measureActiveStreaming(target) {
    const browser = await chromium.launch({
        headless: true,
        args: ['--use-gl=angle', '--use-angle=gl', '--no-sandbox']
    });

    const context = await browser.newContext({ viewport: { width: 1544, height: 928 } });
    const page = await context.newPage();

    let gapCount = 0;
    page.on('console', msg => {
        const text = msg.text();
        if (text.includes('Frame gap detected')) {
            gapCount++;
        }
    });

    await page.addInitScript(() => {
        const OrigPC = window.RTCPeerConnection;
        window.__activePC = null;
        window.RTCPeerConnection = function(...args) {
            const pc = new OrigPC(...args);
            window.__activePC = pc;
            return pc;
        };
        window.RTCPeerConnection.prototype = OrigPC.prototype;
    });

    await page.goto(target.url, { waitUntil: 'domcontentloaded' });

    // Wait until stream is fully open and active (at least 30 frames rendered)
    await page.waitForFunction(() => (window.__dfFrameCount || 0) >= 30, { timeout: 30000 });
    
    // Stabilize for 2 seconds
    await page.waitForTimeout(2000);

    gapCount = 0; // reset gap count for the steady-state measurement window

    const startData = await page.evaluate(async () => {
        return {
            frames: window.__dfFrameCount || 0,
            time: performance.now()
        };
    });

    // Steady-state measurement window: 10 seconds
    const MEASURE_MS = 10000;
    await page.waitForTimeout(MEASURE_MS);

    const endMetrics = await page.evaluate(async (s0) => {
        const frames = (window.__dfFrameCount || 0) - s0.frames;
        const elapsedSec = (performance.now() - s0.time) / 1000;
        const fps = Math.round((frames / elapsedSec) * 10) / 10;

        let activePair = null;
        let rttMs = null;
        let transportType = null;

        if (window.__activePC) {
            const stats = await window.__activePC.getStats();
            for (const report of stats.values()) {
                if (report.type === 'candidate-pair' && (report.state === 'succeeded' || report.nominated)) {
                    rttMs = report.currentRoundTripTime ? Math.round(report.currentRoundTripTime * 1000 * 10) / 10 : null;
                    const localCand = stats.get(report.localCandidateId);
                    const remoteCand = stats.get(report.remoteCandidateId);
                    activePair = {
                        local: localCand ? `${localCand.candidateType} (${localCand.ip || localCand.address}:${localCand.port})` : 'unknown',
                        remote: remoteCand ? `${remoteCand.candidateType} (${remoteCand.ip || remoteCand.address}:${remoteCand.port})` : 'unknown',
                        protocol: report.protocol || 'udp'
                    };
                }
            }
        }

        return {
            fps,
            framesReceived: frames,
            elapsedSec: Math.round(elapsedSec * 10) / 10,
            activePair,
            rttMs
        };
    }, startData);

    await browser.close();

    return {
        ...endMetrics,
        gapRecoveryEvents: gapCount
    };
}

(async () => {
    const results = {};
    for (const t of TARGETS) {
        console.log(`Measuring steady-state streaming on ${t.name}...`);
        results[t.name] = await measureActiveStreaming(t);
    }
    console.log('\n=== STEADY-STATE WEBRTC STREAMING RESULTS (10-SECOND WINDOW) ===');
    console.log(JSON.stringify(results, null, 2));
})();
