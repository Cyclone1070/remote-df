import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { MouseWheelClassifier } from '../src/core/mouse_wheel_classifier.js';
import normalizeWheel from 'normalize-wheel-es';

const nw = normalizeWheel.default || normalizeWheel;

describe('MouseWheelClassifier (VS Code implementation)', () => {
    it('classifies native macOS physical mouse events as physical', () => {
        const classifier = new MouseWheelClassifier();
        const norm = nw({ deltaX: 0, deltaY: 1, wheelDeltaX: 0, wheelDeltaY: -120, deltaMode: 0 });
        classifier.accept(0, norm.spinX, norm.spinY);

        assert.equal(classifier.isPhysicalMouseWheel(), true, 'Native macOS notch must be physical');
    });

    it('classifies Windows/Linux standard mouse events as physical', () => {
        const classifier = new MouseWheelClassifier();
        const norm = nw({ deltaX: 0, deltaY: 100, wheelDeltaX: 0, wheelDeltaY: -120, deltaMode: 0 });
        classifier.accept(0, norm.spinX, norm.spinY);

        assert.equal(classifier.isPhysicalMouseWheel(), true, 'Windows/Linux notch must be physical');
    });

    it('classifies Mac Mouse Fix / trackpad smooth streams as non-physical', () => {
        const classifier = new MouseWheelClassifier();
        // Fractional spin values from Mac Mouse Fix
        const norm1 = nw({ deltaX: 0, deltaY: 7, wheelDeltaX: 0, wheelDeltaY: -28, deltaMode: 0 });
        const norm2 = nw({ deltaX: 0, deltaY: 7, wheelDeltaX: 0, wheelDeltaY: -28, deltaMode: 0 });
        classifier.accept(0, norm1.spinX, norm1.spinY);
        classifier.accept(16, norm2.spinX, norm2.spinY);

        assert.equal(classifier.isPhysicalMouseWheel(), false, 'Smooth stream must not be physical');
    });

    it('classifies dual-axis trackpad movement as non-physical', () => {
        const classifier = new MouseWheelClassifier();
        classifier.accept(0, 1.0, 1.0);

        assert.equal(classifier.isPhysicalMouseWheel(), false, 'Dual-axis must be trackpad');
    });
});
