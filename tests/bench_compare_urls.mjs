import { chromium } from 'playwright';

const TARGETS = [
    { name: 'Direct IP', url: 'http://100.73.151.90:8484/df?debug=1' },
    { name: 'Cloudflare', url: 'https://gmc-bond-strategies-vocals.trycloudflare.com/df?debug=1' }
];

async function benchmark(target) {
    console.log(`\n========================================`);
    console.log(`Testing: ${target.name} (${target.url})`);
    console.log(`========================================`);

    const browser = await chromium.launch({
        headless: true,
        args: ['--use-gl=angle', '--use-angle=gl', '--no-sandbox']
    });

    const context = await browser.newContext({ viewport: { width: 1544, height: 928 } });
    const page = await context.newPage();

    // Intercept RTCPeerConnection to expose instance for getStats()
    await page.addInitScript(() => {
        const OrigPC = window.RTCPeerConnection;
        window.__pcs = [];
        window.RTCPeerConnection = function(...args) {
            const pc = new OrigPC(...args);
            window.__pcs.push(pc);
            return pc;
        };
        window.RTCPeerConnection.prototype = OrigPC.prototype;
    });

    let webrtcOpenTime = null;
    const t0 = Date.now();

    page.on('console', msg => {
        const text = msg.text();
        if (text.includes('True UDP DataChannel OPENED!')) {
            webrtcOpenTime = Date.now() - t0;
        }
    });

    await page.goto(target.url, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => (window.__dfFrameCount || 0) >= 30, { timeout: 20000 });

    // Collect stats over 5 seconds
    const stats0 = await page.evaluate(async () => {
        return {
            frames: window.__dfFrameCount || 0,
            time: performance.now()
        };
    });

    await page.waitForTimeout(5000);

    const streamMetrics = await page.evaluate(async (s0) => {
        const frames = (window.__dfFrameCount || 0) - s0.frames;
        const elapsed = (performance.now() - s0.time) / 1000;
        const fps = Math.round((frames / elapsed) * 10) / 10;

        // Query WebRTC getStats()
        let rtt = null;
        let localCandidateType = null;
        let remoteCandidateType = null;
        let packetsLost = 0;
        let packetsReceived = 0;
        let bytesReceived = 0;

        if (window.__pcs && window.__pcs.length > 0) {
            const pc = window.__pcs[0];
            const stats = await pc.getStats();
            for (const report of stats.values()) {
                if (report.type === 'candidate-pair' && report.state === 'succeeded') {
                    rtt = report.currentRoundTripTime ? Math.round(report.currentRoundTripTime * 1000 * 10) / 10 : null;
                    const localCand = stats.get(report.localCandidateId);
                    const remoteCand = stats.get(report.remoteCandidateId);
                    if (localCand) localCandidateType = localCand.candidateType;
                    if (remoteCand) remoteCandidateType = remoteCand.candidateType;
                }
                if (report.type === 'data-channel') {
                    bytesReceived += report.bytesReceived || 0;
                }
                if (report.type === 'transport') {
                    packetsReceived += report.packetsReceived || 0;
                    packetsLost += report.packetsLost || 0;
                }
            }
        }

        return {
            fps,
            totalFrames: window.__dfFrameCount,
            rttMs: rtt,
            localCandidateType,
            remoteCandidateType,
            packetsLost
        };
    }, stats0);

    // Measure click-to-render latency
    const latencies = [];
    const box = await page.locator('#gameCanvas').boundingBox();
    for (let i = 0; i < 10; i++) {
        const fBefore = await page.evaluate(() => window.__dfFrameCount || 0);
        const clickT0 = performance.now();
        await page.mouse.click(box.x + 768, box.y + 579);
        await page.waitForTimeout(25);
        await page.mouse.click(box.x + 768, box.y + 600, { button: 'right' });
        
        let waited = 0;
        while (waited < 1000) {
            const fNow = await page.evaluate(() => window.__dfFrameCount || 0);
            if (fNow > fBefore) break;
            await new Promise(r => setTimeout(r, 5));
            waited += 5;
        }
        latencies.push(Math.round(performance.now() - clickT0));
        await page.waitForTimeout(40);
    }

    const avgLatency = Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length);

    console.log(`  Connection Setup Time: ${webrtcOpenTime}ms`);
    console.log(`  Stream FPS: ${streamMetrics.fps}`);
    console.log(`  WebRTC RTT: ${streamMetrics.rttMs ?? 'n/a'}ms`);
    console.log(`  ICE Candidate Pair: local=${streamMetrics.localCandidateType}, remote=${streamMetrics.remoteCandidateType}`);
    console.log(`  Avg Input-to-Frame Response: ${avgLatency}ms`);

    await browser.close();

    return {
        setupTimeMs: webrtcOpenTime,
        fps: streamMetrics.fps,
        rttMs: streamMetrics.rttMs,
        candidatePair: `${streamMetrics.localCandidateType || 'host'} -> ${streamMetrics.remoteCandidateType || 'host'}`,
        avgLatencyMs: avgLatency
    };
}

(async () => {
    const results = {};
    for (const t of TARGETS) {
        results[t.name] = await benchmark(t);
    }

    console.log(`\n================ SUMMARY ================`);
    console.table(results);
})();
