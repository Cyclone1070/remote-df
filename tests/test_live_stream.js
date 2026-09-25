const WebSocket = globalThis.WebSocket;

async function testStream() {
    console.log('Connecting to ws://localhost:48600/ws ...');
    const ws = new WebSocket('ws://localhost:48600/ws');
    ws.binaryType = 'arraybuffer';

    let initReceived = false;
    let frameCount = 0;
    let totalBytes = 0;
    const packetSizes = [];
    let fullFrames = 0;
    let deltaFrames = 0;

    const startTime = Date.now();

    await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
            reject(new Error('Test timed out waiting for frames'));
        }, 8000);

        ws.onopen = () => {
            console.log('✓ WebSocket connected successfully!');
        };

        ws.onmessage = (event) => {
            if (typeof event.data === 'string') {
                const msg = JSON.parse(event.data);
                if (msg.type === 'init') {
                    initReceived = true;
                    console.log(`✓ Init received: grid=${msg.grid_w}x${msg.grid_h}, font=${msg.font_w}x${msg.font_h}, textures=${msg.textures.length}`);
                }
            } else if (event.data instanceof ArrayBuffer) {
                frameCount++;
                const sz = event.data.byteLength;
                totalBytes += sz;
                packetSizes.push(sz);

                const view = new DataView(event.data);
                const magic = String.fromCharCode(view.getUint8(0), view.getUint8(1));
                const seq = view.getUint32(2, true);
                const flags = view.getUint16(6, true);
                const count = view.getUint16(8, true);

                if ((flags & 0x01) !== 0) fullFrames++;
                if ((flags & 0x02) !== 0) deltaFrames++;

                if (frameCount === 1) {
                    console.log(`✓ First frame #${seq}: magic=${magic}, flags=0x${flags.toString(16)}, count=${count}, size=${sz} B`);
                }

                // Send a test mouse move at frame 10
                if (frameCount === 10) {
                    const inputBuf = new ArrayBuffer(16);
                    const inView = new DataView(inputBuf);
                    inView.setUint8(0, 1); // Mouse move
                    inView.setInt16(1, 640, true);
                    inView.setInt16(3, 360, true);
                    ws.send(inputBuf);
                    console.log('✓ Sent test mouse motion event (x=640, y=360) to host');
                }

                if (frameCount >= 60) {
                    clearTimeout(timeout);
                    ws.close();
                    resolve();
                }
            }
        };

        ws.onerror = (err) => {
            reject(err);
        };
    });

    const elapsedSec = (Date.now() - startTime) / 1000;
    const fps = frameCount / elapsedSec;
    const avgSizeBytes = totalBytes / frameCount;
    const kbps = (totalBytes * 8) / elapsedSec / 1000;

    console.log('\n=== LIVE WAN STREAM BENCHMARK RESULTS ===');
    console.log(`Frames Received:   ${frameCount} (${fullFrames} full keyframes, ${deltaFrames} deltas)`);
    console.log(`Delivered FPS:     ${fps.toFixed(1)} fps`);
    console.log(`Avg Frame Size:    ${avgSizeBytes.toFixed(1)} bytes`);
    console.log(`Total Bandwidth:   ${kbps.toFixed(2)} kbps (${(kbps/1000).toFixed(3)} Mbps)`);
    console.log(`Min Packet:        ${Math.min(...packetSizes)} bytes`);
    console.log(`Max Packet:        ${Math.max(...packetSizes)} bytes`);
    console.log(`Savings vs Video:  ${((1 - (kbps/2200))*100).toFixed(1)}% lower than 2.2 Mbps video!`);
}

testStream().catch(err => {
    console.error('Test failed:', err);
    process.exit(1);
});
