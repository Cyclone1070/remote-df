const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const DFInput = require('../client/js/input.js');

const canonicalPath = path.join(__dirname, 'sdl2_canonical_scancodes.json');
const canonicalScancodes = JSON.parse(fs.readFileSync(canonicalPath, 'utf8'));

// Helper to create a dummy instance for testing translateKey
const dummyInput = new DFInput({
    addEventListener: () => {},
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 1280, height: 720 }),
    width: 1280,
    height: 720
}, () => {});

test('Alphabet KeyA - KeyZ maps to exact SDL2 scancodes 4..29 and syms 97..122', () => {
    for (let i = 0; i < 26; i++) {
        const letter = String.fromCharCode(65 + i);
        const code = `Key${letter}`;
        const res = dummyInput.translateKey(code, letter.toLowerCase());
        assert.ok(res, `Missing mapping for ${code}`);
        assert.equal(res.scancode, 4 + i, `Scancode mismatch for ${code}`);
        assert.equal(res.sym, 97 + i, `Sym mismatch for ${code}`);
    }
});

test('Digits Digit0 - Digit9 map to exact SDL2 scancodes and syms', () => {
    const res0 = dummyInput.translateKey('Digit0', '0');
    assert.deepEqual(res0, { scancode: 39, sym: 48 });

    for (let d = 1; d <= 9; d++) {
        const res = dummyInput.translateKey(`Digit${d}`, String(d));
        assert.deepEqual(res, { scancode: 30 + (d - 1), sym: 48 + d });
    }
});

test('Numpad 0-9 and operators map to exact SDL2 keypad scancodes and syms', () => {
    const numpadMap = {
        'Numpad0': { scancode: 98, sym: 1073741922 },
        'Numpad1': { scancode: 89, sym: 1073741913 },
        'Numpad2': { scancode: 90, sym: 1073741914 },
        'Numpad3': { scancode: 91, sym: 1073741915 },
        'Numpad4': { scancode: 92, sym: 1073741916 },
        'Numpad5': { scancode: 93, sym: 1073741917 },
        'Numpad6': { scancode: 94, sym: 1073741918 },
        'Numpad7': { scancode: 95, sym: 1073741919 },
        'Numpad8': { scancode: 96, sym: 1073741920 },
        'Numpad9': { scancode: 97, sym: 1073741921 },
        'NumpadDecimal': { scancode: 99, sym: 1073741923 },
        'NumpadDivide': { scancode: 84, sym: 1073741908 },
        'NumpadMultiply': { scancode: 85, sym: 1073741909 },
        'NumpadSubtract': { scancode: 86, sym: 1073741910 },
        'NumpadAdd': { scancode: 87, sym: 1073741911 },
        'NumpadEnter': { scancode: 88, sym: 1073741912 },
        'NumpadEqual': { scancode: 103, sym: 1073741927 }
    };

    for (const [code, expected] of Object.entries(numpadMap)) {
        const res = dummyInput.translateKey(code, '');
        assert.deepEqual(res, expected, `Mismatch for ${code}`);
    }
});

test('Function keys F1 - F24 map to exact SDL2 scancodes and syms', () => {
    for (let f = 1; f <= 12; f++) {
        const code = `F${f}`;
        const res = dummyInput.translateKey(code, code);
        assert.deepEqual(res, {
            scancode: 58 + (f - 1),
            sym: 1073741882 + (f - 1)
        }, `Mismatch for ${code}`);
    }
    for (let f = 13; f <= 24; f++) {
        const code = `F${f}`;
        const res = dummyInput.translateKey(code, code);
        assert.deepEqual(res, {
            scancode: 104 + (f - 13),
            sym: 1073741928 + (f - 13)
        }, `Mismatch for ${code}`);
    }
});

test('Navigation, editing, and lock keys map to exact SDL2 scancodes', () => {
    const navMap = {
        'Escape': { scancode: 41, sym: 27 },
        'Enter': { scancode: 40, sym: 13 },
        'Tab': { scancode: 43, sym: 9 },
        'Backspace': { scancode: 42, sym: 8 },
        'Space': { scancode: 44, sym: 32 },
        'Insert': { scancode: 73, sym: 1073741897 },
        'Delete': { scancode: 76, sym: 127 },
        'Home': { scancode: 74, sym: 1073741898 },
        'End': { scancode: 77, sym: 1073741901 },
        'PageUp': { scancode: 75, sym: 1073741899 },
        'PageDown': { scancode: 78, sym: 1073741902 },
        'ArrowRight': { scancode: 79, sym: 1073741903 },
        'ArrowLeft': { scancode: 80, sym: 1073741904 },
        'ArrowDown': { scancode: 81, sym: 1073741905 },
        'ArrowUp': { scancode: 82, sym: 1073741906 },
        'CapsLock': { scancode: 57, sym: 1073741881 },
        'ScrollLock': { scancode: 71, sym: 1073741895 },
        'NumLock': { scancode: 83, sym: 1073741907 },
        'PrintScreen': { scancode: 70, sym: 1073741894 },
        'Pause': { scancode: 72, sym: 1073741896 },
        'ContextMenu': { scancode: 101, sym: 1073741925 }
    };

    for (const [code, expected] of Object.entries(navMap)) {
        const res = dummyInput.translateKey(code, '');
        assert.deepEqual(res, expected, `Mismatch for ${code}`);
    }
});

test('Symbols and punctuation map to exact SDL2 scancodes and ASCII syms', () => {
    const symbolMap = {
        'Minus': { scancode: 45, sym: 45 },
        'Equal': { scancode: 46, sym: 61 },
        'BracketLeft': { scancode: 47, sym: 91 },
        'BracketRight': { scancode: 48, sym: 93 },
        'Backslash': { scancode: 49, sym: 92 },
        'Semicolon': { scancode: 51, sym: 59 },
        'Quote': { scancode: 52, sym: 39 },
        'Backquote': { scancode: 53, sym: 96 },
        'Comma': { scancode: 54, sym: 44 },
        'Period': { scancode: 55, sym: 46 },
        'Slash': { scancode: 56, sym: 47 }
    };

    for (const [code, expected] of Object.entries(symbolMap)) {
        const res = dummyInput.translateKey(code, '');
        assert.deepEqual(res, expected, `Mismatch for ${code}`);
    }
});

test('Modifiers map to exact SDL2 modifier scancodes', () => {
    const modMap = {
        'ShiftLeft': { scancode: 225, sym: 1073742049 },
        'ShiftRight': { scancode: 229, sym: 1073742053 },
        'ControlLeft': { scancode: 224, sym: 1073742048 },
        'ControlRight': { scancode: 228, sym: 1073742052 },
        'AltLeft': { scancode: 226, sym: 1073742050 },
        'AltRight': { scancode: 230, sym: 1073742054 }
    };

    for (const [code, expected] of Object.entries(modMap)) {
        const res = dummyInput.translateKey(code, '');
        assert.deepEqual(res, expected, `Mismatch for ${code}`);
    }
});

test('getModMask accurately creates bitmask for Shift, Ctrl, Alt', () => {
    assert.equal(dummyInput.getModMask({ shiftKey: false, ctrlKey: false, altKey: false }), 0);
    assert.equal(dummyInput.getModMask({ shiftKey: true, ctrlKey: false, altKey: false }), 1); // 1 = Shift
    assert.equal(dummyInput.getModMask({ shiftKey: false, ctrlKey: true, altKey: false }), 2); // 2 = Ctrl
    assert.equal(dummyInput.getModMask({ shiftKey: false, ctrlKey: false, altKey: true }), 4); // 4 = Alt
    assert.equal(dummyInput.getModMask({ shiftKey: true, ctrlKey: true, altKey: false }), 3);
    assert.equal(dummyInput.getModMask({ shiftKey: true, ctrlKey: true, altKey: true }), 7);
});

const DFProtocol = require('../client/js/protocol.js');

test('DFProtocol.encodeInput correctly serializes binary input packet', () => {
    // 16-byte packet without stamp
    const buf1 = DFProtocol.encodeInput(16, 120, 340, 1, 97, 4, 3, 0);
    assert.equal(buf1.byteLength, 16);
    const view1 = new DataView(buf1);
    assert.equal(view1.getUint8(0), 16); // type
    assert.equal(view1.getInt16(1, true), 120); // x
    assert.equal(view1.getInt16(3, true), 340); // y
    assert.equal(view1.getUint8(5), 1); // button
    assert.equal(view1.getUint32(6, true), 97); // sym
    assert.equal(view1.getUint32(10, true), 4); // scancode
    assert.equal(view1.getUint16(14, true), 3); // mod

    // 17-byte packet with stamp
    const buf2 = DFProtocol.encodeInput(16, 0, 0, 0, 13, 40, 0, 42);
    assert.equal(buf2.byteLength, 17);
    const view2 = new DataView(buf2);
    assert.equal(view2.getUint8(16), 42); // stamp
});

test('All 80 distinct SYM names in DF interface.txt are coverable by input mapping', () => {
    const lines = fs.readFileSync(path.join(__dirname, 'interface.txt'), 'latin1').split('\n');
    const dfSyms = new Set();
    for (const line of lines) {
        const m = line.match(/^\[SYM:\d+:([^\]]+)\]/);
        if (m) dfSyms.add(m[1]);
    }
    assert.equal(dfSyms.size, 80, 'Expected 80 distinct SYM entries in interface.txt');

    // Verify each SYM name maps to an SDL2 key that our client can generate
    const unmapped = [];
    for (const sym of dfSyms) {
        // Test if dummyInput can produce this sym
        let found = false;
        // Check standard code directly
        let testCodes = [
            sym, `Key${sym.toUpperCase()}`, `Digit${sym}`, `Numpad${sym}`,
            `F${sym.replace('F', '')}`, `Arrow${sym}`
        ];
        if (sym === 'ESC') testCodes.push('Escape');
        if (sym === 'Return') testCodes.push('Enter');
        if (sym === 'Equals') testCodes.push('Equal');
        if (sym === 'Plus') testCodes.push('Equal');
        if (sym === 'Minus') testCodes.push('Minus');
        if (sym === 'Comma' || sym === ',') testCodes.push('Comma');
        if (sym === 'Period' || sym === '.') testCodes.push('Period');
        if (sym === '/') testCodes.push('Slash');
        if (sym.startsWith('Numpad ')) testCodes.push(`Numpad${sym.replace('Numpad ', '')}`);
        if (sym === 'Page Down') testCodes.push('PageDown');
        if (sym === 'Page Up') testCodes.push('PageUp');
        if (sym === 'Numpad Plus') testCodes.push('NumpadAdd');
        if (sym === 'Numpad Minus') testCodes.push('NumpadSubtract');
        if (sym === 'Numpad Enter') testCodes.push('NumpadEnter');

        for (const c of testCodes) {
            const res = dummyInput.translateKey(c, sym);
            if (res && res.sym !== undefined && res.scancode !== undefined) {
                found = true;
                break;
            }
        }
        if (!found) unmapped.push(sym);
    }
    assert.equal(unmapped.length, 0, `Unmapped DF interface.txt SYMs: ${unmapped.join(', ')}`);
});

