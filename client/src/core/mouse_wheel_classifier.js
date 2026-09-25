/**
 * MouseWheelClassifier from Microsoft VS Code (Monaco Editor).
 * Reference: https://github.com/microsoft/vscode/blob/main/src/vs/base/browser/ui/scrollbar/scrollableElement.ts
 * 
 * Accurately classifies whether incoming wheel events originate from a physical
 * notched mouse wheel vs a touchpad / smooth-scrolling software (Mac Mouse Fix).
 */

class MouseWheelClassifierItem {
    constructor(timestamp, deltaX, deltaY) {
        this.timestamp = timestamp;
        this.deltaX = deltaX;
        this.deltaY = deltaY;
        this.score = 0;
    }
}

export class MouseWheelClassifier {
    constructor() {
        this._capacity = 5;
        this._memory = [];
        this._front = -1;
        this._rear = -1;
    }

    /**
     * @returns {boolean} True if the source appears to be a physical mouse wheel
     */
    isPhysicalMouseWheel() {
        if (this._front === -1 && this._rear === -1) {
            return false;
        }

        let remainingInfluence = 1;
        let score = 0;
        let iteration = 1;

        let index = this._rear;
        do {
            const influence = (index === this._front ? remainingInfluence : Math.pow(2, -iteration));
            remainingInfluence -= influence;
            score += this._memory[index].score * influence;

            if (index === this._front) {
                break;
            }

            index = (this._capacity + index - 1) % this._capacity;
            iteration++;
        } while (true);

        return (score <= 0.5);
    }

    /**
     * Accept a normalized wheel event (spinX, spinY from normalizeWheel)
     * @param {number} timestamp 
     * @param {number} deltaX 
     * @param {number} deltaY 
     */
    accept(timestamp, deltaX, deltaY) {
        let previousItem = null;
        const item = new MouseWheelClassifierItem(timestamp, deltaX, deltaY);

        if (this._front === -1 && this._rear === -1) {
            this._memory[0] = item;
            this._front = 0;
            this._rear = 0;
        } else {
            previousItem = this._memory[this._rear];

            this._rear = (this._rear + 1) % this._capacity;
            if (this._rear === this._front) {
                this._front = (this._front + 1) % this._capacity;
            }
            this._memory[this._rear] = item;
        }

        item.score = this._computeScore(item, previousItem);
    }

    _computeScore(item, previousItem) {
        if (Math.abs(item.deltaX) > 0 && Math.abs(item.deltaY) > 0) {
            // Both axes exercised => touchpad
            return 1;
        }

        let score = 0.5;

        if (!this._isAlmostInt(item.deltaX) || !this._isAlmostInt(item.deltaY)) {
            // Non-integer spin => touchpad / smooth-scrolling software
            score += 0.25;
        }

        if (previousItem) {
            const absDeltaX = Math.abs(item.deltaX);
            const absDeltaY = Math.abs(item.deltaY);

            const absPreviousDeltaX = Math.abs(previousItem.deltaX);
            const absPreviousDeltaY = Math.abs(previousItem.deltaY);

            const minDeltaX = Math.max(Math.min(absDeltaX, absPreviousDeltaX), 1);
            const minDeltaY = Math.max(Math.min(absDeltaY, absPreviousDeltaY), 1);

            const maxDeltaX = Math.max(absDeltaX, absPreviousDeltaX);
            const maxDeltaY = Math.max(absDeltaY, absPreviousDeltaY);

            const isSameModulo = (maxDeltaX % minDeltaX === 0 && maxDeltaY % minDeltaY === 0);
            if (isSameModulo) {
                score -= 0.5;
            }
        }

        return Math.min(Math.max(score, 0), 1);
    }

    _isAlmostInt(value) {
        const delta = Math.abs(Math.round(value) - value);
        return (delta < 0.01);
    }
}
