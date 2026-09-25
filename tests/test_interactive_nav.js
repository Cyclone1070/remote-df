const WebSocket = globalThis.WebSocket;

async function testInteractive() {
    console.log('Connecting to live DF stream...');
    const ws = new WebSocket('ws://localhost:48600/ws');
    ws.binaryType = 'arraybuffer';

    let frameCount = 0;
    let deltasWithChanges = 0;

    await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => resolve(), 6000);

        ws.onopen = () => {
            console.log('✓ Connected!');
        };

        ws.onmessage = (event) => {
            if (event.data instanceof ArrayBuffer) {
                frameCount++;
                const view = new DataView(event.data);
                const flags = view.getUint16(6, true);
                const count = view.getUint16(8, true);

                if ((flags & 0x02) !== 0 && count > 0) {
                    deltasWithChanges++;
                    console.log(`[Frame #${frameCount}] Delta received with ${count} changed tiles! (Size: ${event.data.byteLength} B)`);
                }

                // Send mouse hover at frame 15 over "Settings" button
                if (frameCount === 15) {
                    console.log('--> Sending mouse hover over menu (x=640, y=410)');
                    const buf = new ArrayBuffer(16);
                    const v = new DataView(buf);
                    v.setUint8(0, 1); // Move
                    v.setInt16(1, 640, true);
                    v.setInt16(3, 410, true);
                    ws.send(buf);
                }

                // Send mouse click at frame 30
                if (frameCount === 30) {
                    console.log('--> Sending mouse click on menu');
                    const buf = new ArrayBuffer(16);
                    const v = new DataView(buf);
                    v.setUint8(0, 2); // MouseDown
                    v.setInt16(1, 640, true);
                    v.setInt16(3, 410, true);
                    v.setUint8(5, 1); // Left click
                    ws.send(buf);

                    setTimeout(() => {
                        v.setUint8(0, 3); // MouseUp
                        ws.send(buf);
                    }, 50);
                }

                if (frameCount >= 100) {
                    clearTimeout(timeout);
                    ws.close();
                    resolve();
                }
            }
        };

        ws.onerror = reject;
    });

    console.log(`\nTest completed: ${frameCount} frames, ${deltasWithChanges} active delta updates.`);
}

testInteractive().catch(console.error);
