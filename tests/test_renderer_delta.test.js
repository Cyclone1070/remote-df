const test = require('node:test');
const assert = require('node:assert/strict');

// Simplified DFRenderer mock for testing applyDelta logic
class MockRenderer {
    constructor() {
        this.commands = [];
        this.dirty = false;
    }

    applyFullFrame(cmds) {
        this.commands = cmds.slice();
        this.dirty = true;
    }

    applyDelta(totalCmdCount, updates) {
        if (totalCmdCount !== undefined && totalCmdCount >= 0) {
            this.commands.length = totalCmdCount;
        }
        if (updates && updates.length > 0) {
            for (let i = 0; i < updates.length; i++) {
                const up = updates[i];
                if (up.index < this.commands.length) {
                    this.commands[up.index] = up.cmd;
                }
            }
        }
        this.dirty = true;
    }
}

test('Renderer Delta: handles sparse update, zero update, and truncation', (t) => {
    const r = new MockRenderer();
    
    // Initial 5 commands
    r.applyFullFrame([
        { id: 0 }, { id: 1 }, { id: 2 }, { id: 3 }, { id: 4 }
    ]);
    assert.equal(r.commands.length, 5);

    // Delta 1: modify index 2
    r.applyDelta(5, [{ index: 2, cmd: { id: 99 } }]);
    assert.equal(r.commands.length, 5);
    assert.equal(r.commands[2].id, 99);
    assert.equal(r.commands[0].id, 0);

    // Delta 2: zero updates (stationary screen)
    r.applyDelta(5, []);
    assert.equal(r.commands.length, 5);
    assert.equal(r.commands[2].id, 99);

    // Delta 3: truncate command count from 5 to 3
    r.applyDelta(3, []);
    assert.equal(r.commands.length, 3);
    assert.equal(r.commands[0].id, 0);
    assert.equal(r.commands[1].id, 1);
    assert.equal(r.commands[2].id, 99);
});
