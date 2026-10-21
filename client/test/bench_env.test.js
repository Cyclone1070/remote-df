import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { pressIntervalMs, extraChromeArgs, defaultChromeArgs, isHardwareGL } from '../src/core/measure.js';

// The bench drives an input every PRESS_EVERY_MS. It was a constant, which made
// the input rate impossible to vary, and the input rate is the variable the
// Wi-Fi power-save question is asked about. It is now read from the
// environment, with the old constant as the value an unset variable produces -
// a run that does not ask for a rate has to keep measuring what it measured
// before.
describe('pressIntervalMs', () => {
    it('keeps the old constant when nothing is asked for', () => {
        assert.equal(pressIntervalMs(undefined), 25);
        assert.equal(pressIntervalMs(''), 25);
    });

    it('takes a rate that was asked for, and refuses one that would break the run', () => {
        assert.equal(pressIntervalMs('100'), 100);
        assert.equal(pressIntervalMs(' 10 '), 10);
        // Zero or a negative interval would drive inputs in a tight loop and a
        // non-number would silently become one, so both fall back rather than
        // measuring something nobody asked for.
        assert.equal(pressIntervalMs('0'), 25);
        assert.equal(pressIntervalMs('-5'), 25);
        assert.equal(pressIntervalMs('fast'), 25);
    });
});

// The browser is launched with one argument the bench needs everywhere
// (--no-sandbox) and, on a host that has a GPU, arguments that get hardware
// rendering instead of SwiftShader. Which ones those are is a property of the
// machine, not of the measurement, so they come from the environment; the
// default is the launch the earlier runs used, byte for byte.
describe('extraChromeArgs', () => {
    it('adds nothing when nothing is asked for', () => {
        assert.deepEqual(extraChromeArgs(undefined), []);
        assert.deepEqual(extraChromeArgs(''), []);
        assert.deepEqual(extraChromeArgs('   '), []);
    });

    it('splits a list on whitespace and drops the empties', () => {
        assert.deepEqual(extraChromeArgs(' --use-angle=gl-egl  --enable-gpu '),
            ['--use-angle=gl-egl', '--enable-gpu']);
        assert.deepEqual(extraChromeArgs('--use-gl=angle'), ['--use-gl=angle']);
    });
});

// Headless Chromium on a host with a GPU still falls back to SwiftShader unless
// it is told which GL implementation to use. That fallback is not a slower
// version of the same measurement, it is a different one: it blocks the page's
// main thread for seconds per run, and every latency and freeze number taken
// through it is the software rasteriser's, not the path's. Measured on the same
// Mac and the same Wi-Fi: p95 84-149 ms through SwiftShader against 51-52 ms
// through Metal. A run therefore gets hardware GL unless it says otherwise, and
// a run that ends up on SwiftShader is thrown away rather than reported.
describe('defaultChromeArgs', () => {
    it('asks for hardware GL on the platforms whose answer is known', () => {
        assert.deepEqual(defaultChromeArgs('darwin'), ['--use-angle=metal']);
        assert.deepEqual(defaultChromeArgs('linux'), ['--use-angle=gl-egl']);
    });

    it('adds nothing where no answer has been measured, rather than guessing', () => {
        assert.deepEqual(defaultChromeArgs('win32'), []);
        assert.deepEqual(defaultChromeArgs(''), []);
        assert.deepEqual(defaultChromeArgs(undefined), []);
    });
});

describe('isHardwareGL', () => {
    it('rejects the software rasteriser by name, however it is spelled', () => {
        const swiftshader = 'ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero)), SwiftShader driver)';
        assert.equal(isHardwareGL(swiftshader), false);
        assert.equal(isHardwareGL('Google SwiftShader'), false);
        assert.equal(isHardwareGL('  swiftshader  '), false);
        assert.equal(isHardwareGL('llvmpipe (LLVM 15.0.7, 256 bits)'), false);
    });

    // A denylist of rasteriser names accepts anything the author did not think
    // of, which is everything: lavapipe, softpipe, a bare 'Mesa', and arbitrary
    // junk all passed it, and the document claimed an allowlist. It is one now -
    // the string has to name a GPU - and Mesa is deliberately NOT a rejection
    // token, because the Linux hardware string for this host is Mesa's:
    // "ANGLE (Intel, Mesa Intel(R) UHD Graphics 630 (CFL GT2), OpenGL ES 3.2)".
    it('rejects the software rasterisers a denylist let through', () => {
        assert.equal(isHardwareGL('lavapipe'), false);
        assert.equal(isHardwareGL('softpipe'), false);
        assert.equal(isHardwareGL('Mesa'), false);
        assert.equal(isHardwareGL('Mesa/X.org'), false);
        assert.equal(isHardwareGL('ANGLE (Mesa, Mesa/X.org, OpenGL 4.5)'), false);
        assert.equal(isHardwareGL('some future rasteriser'), false, 'a name nobody listed is not a GPU');
        assert.equal(isHardwareGL('42'), false);
    });

    it('accepts a real driver, and refuses to call an unknown renderer hardware', () => {
        assert.equal(isHardwareGL('ANGLE (Intel, Mesa Intel(R) UHD Graphics 630 (CML GT2), OpenGL 4.6)'), true);
        // The exact string this host's headless Chromium reports through
        // --use-angle=gl-egl, kept as a regression case: it is Mesa's, and it is
        // a real GPU.
        assert.equal(isHardwareGL('ANGLE (Intel, Mesa Intel(R) UHD Graphics 630 (CFL GT2), OpenGL ES 3.2)'), true);
        assert.equal(isHardwareGL('ANGLE (NVIDIA, NVIDIA GeForce RTX 3080 Direct3D11 vs_5_0 ps_5_0, D3D11)'), true);
        assert.equal(isHardwareGL('Adreno (TM) 640'), true);
        assert.equal(isHardwareGL('ANGLE (Apple, ANGLE Metal Renderer: Apple M1 Pro, Unspecified Version)'), true);
        // A page that could not report a renderer at all is not evidence of
        // hardware GL, and a gate that passed on 'unknown' would pass on nothing.
        assert.equal(isHardwareGL('unknown'), false);
        assert.equal(isHardwareGL(null), false);
        assert.equal(isHardwareGL(undefined), false);
    });
});
