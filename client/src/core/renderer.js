// High-performance WebGL2 Instanced Sprite Renderer with 2D Canvas Fallback
export class DFRenderer {
    constructor(canvas) {
        this.canvas = canvas;
        this.commands = [];
        this.dirty = true;
        this.textures = new Map(); // id -> { x, y, w, h, u0, v0, u1, v1, rawData, offscreen }

        this.gl = canvas.getContext('webgl2', {
            alpha: false,
            antialias: false,
            depth: false,
            stencil: false,
            preserveDrawingBuffer: true // Required for pixel parity screenshot capture
        });

        this.lastDrawCalls = 0;
        this.lastSprites = 0;

        if (this.gl) {
            console.log('[DFRenderer] Initialized WebGL2 Instanced Renderer');
            this.initWebGL();
        } else {
            console.warn('[DFRenderer] WebGL2 not available, falling back to 2D Canvas');
            this.ctx = canvas.getContext('2d', { alpha: false });
            this.ctx.imageSmoothingEnabled = false;
        }
    }

    initWebGL() {
        const gl = this.gl;
        gl.disable(gl.DEPTH_TEST);
        gl.enable(gl.BLEND);
        gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
        gl.viewport(0, 0, this.canvas.width, this.canvas.height);

        // Atlas configuration (4096x4096 handles thousands of font tiles and sprites)
        this.atlasWidth = 4096;
        this.atlasHeight = 4096;
        this.atlasX = 1;
        this.atlasY = 1;
        this.atlasRowHeight = 0;

        this.atlasTexture = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_2D, this.atlasTexture);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
        // Initialize empty black atlas
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, this.atlasWidth, this.atlasHeight, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);

        // Shaders
        const vsSource = `#version 300 es
        precision highp float;
        layout(location = 0) in vec2 a_pos; // Unit quad: (0,0), (1,0), (0,1), (1,1)

        layout(location = 1) in vec4 a_dst; // dstX, dstY, dstW, dstH
        layout(location = 2) in vec4 a_src; // srcX, srcY, srcW, srcH
        layout(location = 3) in vec4 a_tex; // atlasX, atlasY, texW, texH

        uniform vec2 u_resolution;
        uniform vec2 u_atlas_size;

        out vec2 v_uv;

        void main() {
            vec2 screen_pos = a_dst.xy + a_pos * a_dst.zw;
            vec2 clip_pos = (screen_pos / u_resolution) * 2.0 - 1.0;
            gl_Position = vec4(clip_pos.x, -clip_pos.y, 0.0, 1.0);

            vec2 src_xy = (a_src.z > 0.0 && a_src.w > 0.0) ? a_src.xy : vec2(0.0);
            vec2 src_wh = (a_src.z > 0.0 && a_src.w > 0.0) ? a_src.zw : a_tex.zw;

            vec2 pixel_in_atlas = a_tex.xy + src_xy + a_pos * src_wh;
            v_uv = pixel_in_atlas / u_atlas_size;
        }`;

        const fsSource = `#version 300 es
        precision mediump float;
        in vec2 v_uv;
        uniform sampler2D u_atlas;
        out vec4 fragColor;

        void main() {
            fragColor = texture(u_atlas, v_uv);
        }`;

        const compileShader = (type, source) => {
            const shader = gl.createShader(type);
            gl.shaderSource(shader, source);
            gl.compileShader(shader);
            if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
                console.error(gl.getShaderInfoLog(shader));
                gl.deleteShader(shader);
                return null;
            }
            return shader;
        };

        const vs = compileShader(gl.VERTEX_SHADER, vsSource);
        const fs = compileShader(gl.FRAGMENT_SHADER, fsSource);
        this.program = gl.createProgram();
        gl.attachShader(this.program, vs);
        gl.attachShader(this.program, fs);
        gl.linkProgram(this.program);

        this.uResolution = gl.getUniformLocation(this.program, 'u_resolution');
        this.uAtlasSize = gl.getUniformLocation(this.program, 'u_atlas_size');
        this.uAtlas = gl.getUniformLocation(this.program, 'u_atlas');

        // Quad VAO
        this.vao = gl.createVertexArray();
        gl.bindVertexArray(this.vao);

        // Quad VBO (Unit quad: 2 triangles strip: (0,0), (1,0), (0,1), (1,1))
        const quadData = new Float32Array([
            0.0, 0.0,
            1.0, 0.0,
            0.0, 1.0,
            1.0, 1.0
        ]);
        const quadVbo = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, quadVbo);
        gl.bufferData(gl.ARRAY_BUFFER, quadData, gl.STATIC_DRAW);
        gl.enableVertexAttribArray(0);
        gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

        // Instance VBO: 12 floats per quad
        // 1: dst (4 floats)
        // 2: src (4 floats)
        // 3: tex (4 floats)
        this.maxInstances = 32768;
        this.instanceData = new Float32Array(this.maxInstances * 12);
        this.instanceVbo = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, this.instanceVbo);
        gl.bufferData(gl.ARRAY_BUFFER, this.instanceData.byteLength, gl.DYNAMIC_DRAW);

        const stride = 12 * 4;
        gl.enableVertexAttribArray(1);
        gl.vertexAttribPointer(1, 4, gl.FLOAT, false, stride, 0);
        gl.vertexAttribDivisor(1, 1);

        gl.enableVertexAttribArray(2);
        gl.vertexAttribPointer(2, 4, gl.FLOAT, false, stride, 4 * 4);
        gl.vertexAttribDivisor(2, 1);

        gl.enableVertexAttribArray(3);
        gl.vertexAttribPointer(3, 4, gl.FLOAT, false, stride, 8 * 4);
        gl.vertexAttribDivisor(3, 1);

        gl.bindVertexArray(null);
    }

    setTexture(id, imageOrData) {
        if (!this.gl) {
            this.textures.set(id, imageOrData);
            this.dirty = true;
            return;
        }

        // WebGL2 Atlas Allocation
        let w = 0, h = 0, rgba = null;
        if (imageOrData instanceof ImageData) {
            w = imageOrData.width;
            h = imageOrData.height;
            rgba = imageOrData.data;
        } else if (imageOrData && imageOrData.rgba) {
            w = imageOrData.w;
            h = imageOrData.h;
            rgba = imageOrData.rgba;
        } else if (imageOrData && imageOrData.width && imageOrData.height) {
            w = imageOrData.width;
            h = imageOrData.height;
            // Draw into offscreen to get raw pixels
            const off = (typeof OffscreenCanvas !== 'undefined')
                ? new OffscreenCanvas(w, h)
                : document.createElement('canvas');
            off.width = w;
            off.height = h;
            const ctx = off.getContext('2d');
            ctx.drawImage(imageOrData, 0, 0);
            rgba = ctx.getImageData(0, 0, w, h).data;
        }

        if (w <= 0 || h <= 0 || !rgba) return;

        // Shelf packing in atlas
        if (this.atlasX + w + 1 >= this.atlasWidth) {
            this.atlasX = 1;
            this.atlasY += this.atlasRowHeight + 1;
            this.atlasRowHeight = 0;
        }

        if (this.atlasY + h + 1 >= this.atlasHeight) {
            console.error('[DFRenderer] Texture atlas overflow!');
            return;
        }

        const ax = this.atlasX;
        const ay = this.atlasY;
        this.atlasX += w + 1;
        if (h > this.atlasRowHeight) this.atlasRowHeight = h;

        const gl = this.gl;
        gl.bindTexture(gl.TEXTURE_2D, this.atlasTexture);
        const u8 = (rgba instanceof Uint8Array) ? rgba : new Uint8Array(rgba.buffer, rgba.byteOffset, rgba.byteLength);
        gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
        gl.texSubImage2D(gl.TEXTURE_2D, 0, ax, ay, w, h, gl.RGBA, gl.UNSIGNED_BYTE, u8);

        this.textures.set(id, {
            ax: ax,
            ay: ay,
            w: w,
            h: h,
            offscreen: imageOrData
        });
    }

    applyFullFrame(cmds) {
        this.commands = cmds;
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

    resize(width, height) {
        this.canvas.width = width;
        this.canvas.height = height;
        if (this.gl) {
            this.gl.viewport(0, 0, width, height);
        }
        this.dirty = true;
    }

    render() {
        if (!this.dirty) return false;

        if (this.gl) {
            this.renderWebGL();
        } else {
            this.renderCanvas2D();
        }
        return true;
    }

    renderWebGL() {
        const gl = this.gl;
        gl.viewport(0, 0, this.canvas.width, this.canvas.height);
        gl.clearColor(0.0, 0.0, 0.0, 1.0);
        gl.clear(gl.COLOR_BUFFER_BIT);

        const count = this.commands.length;
        if (count === 0) {
            this.lastDrawCalls = 0;
            this.lastSprites = 0;
            this.dirty = false;
            return;
        }

        const data = this.instanceData;
        let validInstances = 0;

        for (let i = 0; i < count; i++) {
            const cmd = this.commands[i];
            if (!cmd || cmd.texId === 0) continue;

            const tex = this.textures.get(cmd.texId);
            if (!tex) continue;

            const dw = (cmd.dstW !== 0 && cmd.dstW !== undefined) ? cmd.dstW : tex.w;
            const dh = (cmd.dstH !== 0 && cmd.dstH !== undefined) ? cmd.dstH : tex.h;
            if (dw <= 0 || dh <= 0) continue;

            const off = validInstances * 12;

            // a_dst: dstX, dstY, dstW, dstH
            data[off + 0] = cmd.dstX;
            data[off + 1] = cmd.dstY;
            data[off + 2] = dw;
            data[off + 3] = dh;

            // a_src: srcX, srcY, srcW, srcH
            data[off + 4] = cmd.srcX;
            data[off + 5] = cmd.srcY;
            data[off + 6] = cmd.srcW;
            data[off + 7] = cmd.srcH;

            // a_tex: atlasX, atlasY, texW, texH
            data[off + 8] = tex.ax;
            data[off + 9] = tex.ay;
            data[off + 10] = tex.w;
            data[off + 11] = tex.h;

            validInstances++;
            if (validInstances >= this.maxInstances) break;
        }

        if (validInstances > 0) {
            gl.useProgram(this.program);
            gl.uniform2f(this.uResolution, this.canvas.width, this.canvas.height);
            gl.uniform2f(this.uAtlasSize, this.atlasWidth, this.atlasHeight);

            gl.activeTexture(gl.TEXTURE0);
            gl.bindTexture(gl.TEXTURE_2D, this.atlasTexture);
            gl.uniform1i(this.uAtlas, 0);

            gl.bindVertexArray(this.vao);

            gl.bindBuffer(gl.ARRAY_BUFFER, this.instanceVbo);
            gl.bufferSubData(gl.ARRAY_BUFFER, 0, data.subarray(0, validInstances * 12));

            // 1 SINGLE INSTANCED DRAW CALL FOR THE ENTIRE FRAME
            gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, validInstances);
            gl.bindVertexArray(null);
        }

        this.lastDrawCalls = validInstances > 0 ? 1 : 0;
        this.lastSprites = validInstances;
        this.dirty = false;
    }

    renderCanvas2D() {
        const ctx = this.ctx;
        ctx.fillStyle = '#000';
        ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);

        const len = this.commands.length;
        for (let i = 0; i < len; i++) {
            const cmd = this.commands[i];
            if (!cmd || cmd.texId === 0) continue;

            const texInfo = this.textures.get(cmd.texId);
            if (!texInfo) continue;
            const tex = texInfo.offscreen || texInfo;

            const dw = (cmd.dstW !== 0 && cmd.dstW !== undefined) ? cmd.dstW : (tex.width || tex.w);
            const dh = (cmd.dstH !== 0 && cmd.dstH !== undefined) ? cmd.dstH : (tex.height || tex.h);
            if (dw <= 0 || dh <= 0) continue;

            if (cmd.srcW > 0 && cmd.srcH > 0) {
                ctx.drawImage(tex, cmd.srcX, cmd.srcY, cmd.srcW, cmd.srcH, cmd.dstX, cmd.dstY, dw, dh);
            } else {
                ctx.drawImage(tex, cmd.dstX, cmd.dstY, dw, dh);
            }
        }
        this.lastDrawCalls = len > 0 ? len : 0;
        this.lastSprites = len;
        this.dirty = false;
    }
}
