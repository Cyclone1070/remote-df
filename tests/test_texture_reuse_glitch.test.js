const test = require('node:test');
const assert = require('node:assert/strict');

// Model of texture slot allocator
class TextureManagerEagerReuse {
    constructor(maxTextures = 4096) {
        this.max = maxTextures;
        this.textures = new Array(maxTextures).fill(null);
        this.count = 0;
    }

    getTextureId(ptr) {
        if (!ptr) return 0;
        for (let i = 0; i < this.count; i++) {
            if (this.textures[i] === ptr) return i + 1;
        }
        for (let i = 0; i < this.count; i++) {
            if (this.textures[i] === null) {
                this.textures[i] = ptr;
                return i + 1;
            }
        }
        if (this.count < this.max) {
            this.textures[this.count++] = ptr;
            return this.count;
        }
        return 0;
    }

    destroyTexture(ptr) {
        for (let i = 0; i < this.count; i++) {
            if (this.textures[i] === ptr) {
                this.textures[i] = null;
                break;
            }
        }
    }
}

// Monotonic Texture Slot Allocator
class TextureManagerMonotonic {
    constructor(maxTextures = 4096) {
        this.max = maxTextures;
        this.textureToId = new Map(); // ptr -> id
        this.idToTexture = new Map(); // id -> ptr
        this.nextId = 1;
    }

    getTextureId(ptr) {
        if (!ptr) return 0;
        if (this.textureToId.has(ptr)) {
            return this.textureToId.get(ptr);
        }
        if (this.nextId >= this.max) {
            // Only recycle if truly exhausted
            this.nextId = 1;
        }
        const id = this.nextId++;
        this.textureToId.set(ptr, id);
        this.idToTexture.set(id, ptr);
        return id;
    }

    destroyTexture(ptr) {
        if (this.textureToId.has(ptr)) {
            const id = this.textureToId.get(ptr);
            this.textureToId.delete(ptr);
            this.idToTexture.delete(id);
        }
    }
}

test('Replication: Eager texture ID reuse causes texture clobbering across frame transitions', () => {
    const mgr = new TextureManagerEagerReuse();

    const menuTextPtr = { name: 'Letter A' };
    const menuTexId = mgr.getTextureId(menuTextPtr);
    assert.equal(menuTexId, 1, 'First texture is assigned ID 1');

    // Menu closes: texture is destroyed
    mgr.destroyTexture(menuTextPtr);

    // Game screen opens: new tile texture created
    const grassTilePtr = { name: 'Grass Tile' };
    const newTexId = mgr.getTextureId(grassTilePtr);

    // BUG: The new texture clobbered ID 1! Any frame still holding commands referencing ID 1 will render grass instead of text!
    assert.equal(newTexId, 1, 'Eager reuse re-assigned slot 1 immediately to a different texture');
    assert.notEqual(grassTilePtr.name, menuTextPtr.name);
});

test('Fix Verification: Monotonic texture allocator prevents texture ID collision on close', () => {
    const mgr = new TextureManagerMonotonic();

    const menuTextPtr = { name: 'Letter A' };
    const menuTexId = mgr.getTextureId(menuTextPtr);
    assert.equal(menuTexId, 1);

    // Menu closes: texture is destroyed
    mgr.destroyTexture(menuTextPtr);

    // Game screen opens: new tile texture created
    const grassTilePtr = { name: 'Grass Tile' };
    const newTexId = mgr.getTextureId(grassTilePtr);

    // Monotonic ID guarantees ID 1 is NEVER clobbered by grass tile!
    assert.notEqual(newTexId, menuTexId, 'New texture MUST have a distinct ID from destroyed texture');
    assert.equal(newTexId, 2, 'New texture is assigned next monotonic ID');
});
