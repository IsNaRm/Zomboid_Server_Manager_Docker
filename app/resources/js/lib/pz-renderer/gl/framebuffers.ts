/**
 * Offscreen render-to-texture helpers.
 *
 * The tile renderer draws into a 256×256 offscreen canvas whose WebGL2 context
 * is the shared rendering context.  No FBO is strictly required for this
 * use-case — we render directly to the canvas default framebuffer and call
 * readPixels (or use drawImage) to hand the result back to Leaflet.
 *
 * However, framebuffer objects are provided here for future multi-pass work
 * (e.g. save-game overlay in M7, visual regression screenshots in M6).
 */

export interface OffscreenFBO {
    fbo: WebGLFramebuffer;
    colorTex: WebGLTexture;
    width: number;
    height: number;
}

/**
 * Create a framebuffer with an attached RGBA8 colour texture.
 *
 * @param width  - Framebuffer width in pixels.
 * @param height - Framebuffer height in pixels.
 */
export function createOffscreenFBO(
    gl: WebGL2RenderingContext,
    width: number,
    height: number,
): OffscreenFBO {
    const fbo = gl.createFramebuffer();
    if (!fbo) { throw new Error('[pz-renderer] Failed to create FBO'); }

    const colorTex = gl.createTexture();
    if (!colorTex) { throw new Error('[pz-renderer] Failed to create FBO colour texture'); }

    gl.bindTexture(gl.TEXTURE_2D, colorTex);
    gl.texImage2D(
        gl.TEXTURE_2D,
        0,
        gl.RGBA8,
        width,
        height,
        0,
        gl.RGBA,
        gl.UNSIGNED_BYTE,
        null,
    );
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.bindTexture(gl.TEXTURE_2D, null);

    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, colorTex, 0);

    const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
    if (status !== gl.FRAMEBUFFER_COMPLETE) {
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        gl.deleteFramebuffer(fbo);
        gl.deleteTexture(colorTex);
        throw new Error(`[pz-renderer] FBO incomplete: 0x${status.toString(16)}`);
    }

    gl.bindFramebuffer(gl.FRAMEBUFFER, null);

    return { fbo, colorTex, width, height };
}

/**
 * Bind an FBO for rendering, or pass null to restore the default framebuffer.
 */
export function bindFBO(gl: WebGL2RenderingContext, fbo: OffscreenFBO | null): void {
    if (fbo) {
        gl.bindFramebuffer(gl.FRAMEBUFFER, fbo.fbo);
        gl.viewport(0, 0, fbo.width, fbo.height);
    } else {
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    }
}

/**
 * Read pixels from an FBO into a Uint8Array.
 * The FBO must be bound before calling this.
 */
export function readFBOPixels(
    gl: WebGL2RenderingContext,
    fbo: OffscreenFBO,
): Uint8Array {
    const pixels = new Uint8Array(fbo.width * fbo.height * 4);
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo.fbo);
    gl.readPixels(0, 0, fbo.width, fbo.height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return pixels;
}

/**
 * Destroy the FBO and its attached texture.
 */
export function destroyFBO(gl: WebGL2RenderingContext, fbo: OffscreenFBO): void {
    gl.deleteFramebuffer(fbo.fbo);
    gl.deleteTexture(fbo.colorTex);
}
