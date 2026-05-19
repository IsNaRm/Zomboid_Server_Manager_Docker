/**
 * Atlas texture management for the WebGL2 tile renderer.
 *
 * The sprite atlas produced by M1 (BuildAtlasCommand) stores pre-built mip
 * levels packed adjacent to each sprite inside the atlas image.  We do NOT
 * call gl.generateMipmap() — instead we upload the atlas WebP as a single
 * texture (mip 0) and rely on the pre-baked UV rects in sprites.json to
 * sample the correct mip tier via textureLod() in the fragment shader.
 *
 * Filtering is set to LINEAR_MIPMAP_LINEAR so trilinear blending works when
 * the atlas itself contains explicit mip chain data.
 */

export interface AtlasTextureOptions {
    /**
     * If true, call gl.generateMipmap() after upload.
     * Only use this for test / demo purposes — production uses pre-built mips.
     */
    generateMipmaps?: boolean;
    /** Wrap mode, defaults to CLAMP_TO_EDGE. */
    wrapMode?: number;
}

/**
 * Upload an ImageBitmap or HTMLImageElement to a WebGL2 texture.
 *
 * @returns The created WebGLTexture, bound to TEXTURE_2D unit 0.
 */
export function uploadAtlasTexture(
    gl: WebGL2RenderingContext,
    source: ImageBitmap | HTMLImageElement | HTMLCanvasElement,
    options: AtlasTextureOptions = {},
): WebGLTexture {
    const tex = gl.createTexture();
    if (!tex) { throw new Error('[pz-renderer] Failed to create atlas texture'); }

    gl.bindTexture(gl.TEXTURE_2D, tex);

    // Upload mip level 0
    gl.texImage2D(
        gl.TEXTURE_2D,
        0,               // mip level
        gl.RGBA,
        gl.RGBA,
        gl.UNSIGNED_BYTE,
        source,
    );

    if (options.generateMipmaps) {
        gl.generateMipmap(gl.TEXTURE_2D);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    } else {
        // Pre-built mip data in the atlas; use LINEAR for single-level sampling.
        // The fragment shader picks the correct mip rect via u_spriteUVs + textureLod.
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    }

    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);

    const wrap = options.wrapMode ?? gl.CLAMP_TO_EDGE;
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, wrap);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, wrap);

    gl.bindTexture(gl.TEXTURE_2D, null);

    return tex;
}

/**
 * Upload an ImageBitmap fetched from a URL.
 *
 * Convenience wrapper used in tests and the demo.
 */
export async function uploadAtlasFromUrl(
    gl: WebGL2RenderingContext,
    url: string,
    options: AtlasTextureOptions = {},
): Promise<WebGLTexture> {
    const response = await fetch(url);
    if (!response.ok) {
        throw new Error(`[pz-renderer] Failed to fetch atlas: ${response.status} ${url}`);
    }
    const blob = await response.blob();
    const bitmap = await createImageBitmap(blob, { premultiplyAlpha: 'none', colorSpaceConversion: 'none' });
    const tex = uploadAtlasTexture(gl, bitmap, options);
    bitmap.close(); // free CPU copy
    return tex;
}

/**
 * Bind the atlas texture to a given texture unit and set the sampler uniform.
 */
export function bindAtlas(
    gl: WebGL2RenderingContext,
    texture: WebGLTexture,
    unit = 0,
): void {
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, texture);
}

/**
 * Delete a texture object and free GPU memory.
 */
export function destroyTexture(gl: WebGL2RenderingContext, texture: WebGLTexture): void {
    gl.deleteTexture(texture);
}

// ---------------------------------------------------------------------------
// TEXTURE_2D_ARRAY support — needed because the PZ atlas spans 51 pages of
// 4096² and a single 2D texture can only hold one. Layer index inside the
// array texture matches the sprite's `atlas` field in sprites.json, so the
// shader samples via texture(u_atlas, vec3(uv, atlasLayer)).
// ---------------------------------------------------------------------------

/**
 * Allocate an empty TEXTURE_2D_ARRAY large enough to hold `layerCount`
 * pages of `size`×`size` RGBA8 texels. Layers stay zeroed until
 * uploadAtlasArrayLayer() writes into them.
 */
export function createAtlasArray(
    gl: WebGL2RenderingContext,
    size: number,
    layerCount: number,
): WebGLTexture {
    const tex = gl.createTexture();
    if (!tex) { throw new Error('[pz-renderer] Failed to create atlas array texture'); }

    gl.bindTexture(gl.TEXTURE_2D_ARRAY, tex);
    gl.texStorage3D(gl.TEXTURE_2D_ARRAY, 1, gl.RGBA8, size, size, layerCount);

    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

    gl.bindTexture(gl.TEXTURE_2D_ARRAY, null);
    return tex;
}

/**
 * Upload an ImageBitmap into one layer of a TEXTURE_2D_ARRAY.
 *
 * Layer index must be < layerCount the array was created with. The source's
 * dimensions must match the array's per-layer size.
 */
export function uploadAtlasArrayLayer(
    gl: WebGL2RenderingContext,
    texture: WebGLTexture,
    layer: number,
    source: ImageBitmap | HTMLImageElement | HTMLCanvasElement,
): void {
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, texture);
    // 11-argument overload required for TexImageSource:
    // (target, level, xoff, yoff, zoff, width, height, depth, format, type, source).
    const w = (source as { width: number }).width;
    const h = (source as { height: number }).height;
    gl.texSubImage3D(
        gl.TEXTURE_2D_ARRAY,
        0,           // mip level
        0, 0, layer, // x, y, z offsets
        w, h, 1,     // width, height, depth (1 layer at a time)
        gl.RGBA,
        gl.UNSIGNED_BYTE,
        source as TexImageSource,
    );
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, null);
}

/**
 * Bind a TEXTURE_2D_ARRAY to a texture unit (typically 0).
 */
export function bindAtlasArray(
    gl: WebGL2RenderingContext,
    texture: WebGLTexture,
    unit = 0,
): void {
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, texture);
}
