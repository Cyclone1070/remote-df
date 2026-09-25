const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');

// Load DFInput class
const inputJs = fs.readFileSync('./client/js/input.js', 'utf8');
const DFProtocol = require('./client/js/protocol.js');

function createInputInstance(getDebugStamp = null) {
    const listeners = {};
    const mockCanvas = {
        width: 1280,
        height: 720,
        getBoundingClientRect: () => ({ left: 0, top: 0, width: 1280, height: 720 }),
        addEventListener: (name, cb) => { listeners[name] = cb; }
    };
    const mockWindow = {
        addEventListener: (name, cb) => { listeners['window_' + name] = cb; }
    };
    const packets = [];
    const fn = new Function('window', 'DFProtocol', inputJs + '; return DFInput;');
    const DFInput = fn(mockWindow, DFProtocol);
    const inst = new DFInput(mockCanvas, (buf) => {
        packets.push({ time: performance.now(), buf });
    }, getDebugStamp);
    return { inst, listeners, packets };
}

test('Trackpad tap: sends mouseup immediately (1:1 event transmission, server synchronizes)', () => {
    const { listeners, packets } = createInputInstance();

    // Fire mousedown at t = 0
    listeners['mousedown']({ clientX: 100, clientY: 200, button: 0, preventDefault: () => {} });
    assert.equal(packets.length, 1, 'DOWN packet sent immediately');
    const downView = new DataView(packets[0].buf);
    assert.equal(downView.getUint8(0), 2, 'Type must be MOUSEBUTTONDOWN (2)');
    assert.equal(downView.getUint8(5), 1, 'Button must be Left (1)');

    // Fire mouseup immediately (instantaneous trackpad tap)
    listeners['mouseup']({ clientX: 100, clientY: 200, button: 0, preventDefault: () => {} });
    assert.equal(packets.length, 2, 'UP packet sent immediately with zero client hold delay');
    const upView = new DataView(packets[1].buf);
    assert.equal(upView.getUint8(0), 3, 'Type must be MOUSEBUTTONUP (3)');
    assert.equal(upView.getUint8(5), 1, 'Button must be Left (1)');
});

test('Trackpad two-finger tap: contextmenu fallback triggers immediate right DOWN and UP', () => {
    const { listeners, packets } = createInputInstance();
    let prevented = false;

    // Direct contextmenu without preceding mousedown(button=2)
    listeners['contextmenu']({
        clientX: 300,
        clientY: 400,
        preventDefault: () => { prevented = true; }
    });
    assert.ok(prevented, 'Context menu default should be prevented');
    assert.equal(packets.length, 2, 'Synthesized right DOWN and UP sent immediately');
    const downView = new DataView(packets[0].buf);
    assert.equal(downView.getUint8(0), 2, 'Type must be MOUSEBUTTONDOWN (2)');
    assert.equal(downView.getUint8(5), 3, 'Button must be Right (3)');

    const upView = new DataView(packets[1].buf);
    assert.equal(upView.getUint8(0), 3, 'Type must be MOUSEBUTTONUP (3)');
    assert.equal(upView.getUint8(5), 3, 'Button must be Right (3)');
});

test('macOS Ctrl+Click: maps to SDL right click (btn 3) immediately', () => {
    const { listeners, packets } = createInputInstance();

    listeners['mousedown']({ clientX: 250, clientY: 350, button: 0, ctrlKey: true, preventDefault: () => {} });
    assert.equal(packets.length, 1, 'DOWN packet sent immediately');
    const downView = new DataView(packets[0].buf);
    assert.equal(downView.getUint8(0), 2, 'Type must be MOUSEBUTTONDOWN (2)');
    assert.equal(downView.getUint8(5), 3, 'Button must be mapped to Right (3)');
});

test('DFInput: appends rotating debug stamp when getDebugStamp is provided', () => {
    let currentStamp = 88;
    const { listeners, packets } = createInputInstance(() => currentStamp);

    listeners['mousedown']({ clientX: 50, clientY: 50, button: 0, preventDefault: () => {} });
    assert.equal(packets.length, 1);
    assert.equal(packets[0].buf.byteLength, 17, 'Packet must have 17 bytes in debug mode');
    const view = new DataView(packets[0].buf);
    assert.equal(view.getUint8(16), 88, 'Byte 16 must match debug stamp');
});
