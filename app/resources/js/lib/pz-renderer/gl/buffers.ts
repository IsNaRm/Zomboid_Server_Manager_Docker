/**
 * Vertex buffer and VAO helpers for the tile renderer.
 *
 * Buffers:
 *  1. quadVBO     — static, 6 vertices of a unit quad (two triangles).
 *  2. instanceVBO — dynamic, per-sprite-instance data uploaded each tile render.
 *
 * Instance layout (14 floats = 56 bytes):
 *   offset  0 : a_squareX     (float — square x within cell)
 *   offset  4 : a_squareY     (float — square y within cell)
 *   offset  8 : a_cellX       (float — cell column in world)
 *   offset 12 : a_cellY       (float — cell row in world)
 *   offset 16 : a_spriteUV    (vec4: u0, v0, du, dv, normalised)
 *   offset 32 : a_atlasLayer  (float — TEXTURE_2D_ARRAY layer)
 *   offset 36 : a_halfWater   (float — 0.0 or 1.0)
 *   offset 40 : a_spriteW     (float — native sprite width in atlas pixels)
 *   offset 44 : a_spriteH     (float — native sprite height in atlas pixels)
 *   offset 48 : a_offsetX     (float — sprite anchor X in native pixels)
 *   offset 52 : a_offsetY     (float — sprite anchor Y in native pixels)
 *
 * One instance = one sprite on one square. Stacks of sprites on the same
 * square emit several instances (kept in paint order so blending is correct).
 */

export interface AttribLocations {
    a_quadCoord: number;
    a_squareX: number;
    a_squareY: number;
    a_cellX: number;
    a_cellY: number;
    a_spriteUV: number;
    a_atlasLayer: number;
    a_halfWater: number;
    a_spriteW: number;
    a_spriteH: number;
    a_offsetX: number;
    a_offsetY: number;
}

export interface TileBuffers {
    vao: WebGLVertexArrayObject;
    quadVBO: WebGLBuffer;
    instanceVBO: WebGLBuffer;
    /** Maximum number of instances the instanceVBO was last allocated for. */
    instanceCapacity: number;
}

// Unit quad: two triangles (6 vertices) covering [0,1]×[0,1]
const QUAD_VERTICES = new Float32Array([
    0, 0,
    1, 0,
    0, 1,
    0, 1,
    1, 0,
    1, 1,
]);

/** Floats per instance in the instance buffer. */
export const INSTANCE_STRIDE_F32 = 14;
const INSTANCE_STRIDE_BYTES = INSTANCE_STRIDE_F32 * 4;

export function createTileBuffers(
    gl: WebGL2RenderingContext,
    attribs: AttribLocations,
    initialInstanceCapacity = 8192,
): TileBuffers {
    const vao = gl.createVertexArray();
    if (!vao) { throw new Error('[pz-renderer] Failed to create VAO'); }
    gl.bindVertexArray(vao);

    // --- Quad geometry VBO (static) ---
    const quadVBO = gl.createBuffer();
    if (!quadVBO) { throw new Error('[pz-renderer] Failed to create quad VBO'); }
    gl.bindBuffer(gl.ARRAY_BUFFER, quadVBO);
    gl.bufferData(gl.ARRAY_BUFFER, QUAD_VERTICES, gl.STATIC_DRAW);

    gl.enableVertexAttribArray(attribs.a_quadCoord);
    gl.vertexAttribPointer(attribs.a_quadCoord, 2, gl.FLOAT, false, 0, 0);
    gl.vertexAttribDivisor(attribs.a_quadCoord, 0);

    // --- Instance VBO (dynamic) ---
    const instanceVBO = gl.createBuffer();
    if (!instanceVBO) { throw new Error('[pz-renderer] Failed to create instance VBO'); }
    gl.bindBuffer(gl.ARRAY_BUFFER, instanceVBO);
    gl.bufferData(
        gl.ARRAY_BUFFER,
        initialInstanceCapacity * INSTANCE_STRIDE_BYTES,
        gl.DYNAMIC_DRAW,
    );

    let offset = 0;
    const bind = (loc: number, size: number) => {
        if (loc >= 0) {
            gl.enableVertexAttribArray(loc);
            gl.vertexAttribPointer(loc, size, gl.FLOAT, false, INSTANCE_STRIDE_BYTES, offset);
            gl.vertexAttribDivisor(loc, 1);
        }
        offset += size * 4;
    };

    bind(attribs.a_squareX,    1);
    bind(attribs.a_squareY,    1);
    bind(attribs.a_cellX,      1);
    bind(attribs.a_cellY,      1);
    bind(attribs.a_spriteUV,   4);
    bind(attribs.a_atlasLayer, 1);
    bind(attribs.a_halfWater,  1);
    bind(attribs.a_spriteW,    1);
    bind(attribs.a_spriteH,    1);
    bind(attribs.a_offsetX,    1);
    bind(attribs.a_offsetY,    1);

    gl.bindVertexArray(null);
    gl.bindBuffer(gl.ARRAY_BUFFER, null);

    return { vao, quadVBO, instanceVBO, instanceCapacity: initialInstanceCapacity };
}

/** Buffer never shrinks below this many instances. */
const MIN_INSTANCE_CAPACITY = 8192;
/** Number of consecutive low-occupancy uploads before we reallocate smaller. */
const SHRINK_HYSTERESIS = 64;

/** Internal counter — how many uploads in a row stayed under capacity/4. */
let lowOccupancyStreak = 0;

export function uploadInstanceData(
    gl: WebGL2RenderingContext,
    buffers: TileBuffers,
    data: Float32Array,
    instanceCount: number,
): void {
    gl.bindBuffer(gl.ARRAY_BUFFER, buffers.instanceVBO);

    if (instanceCount > buffers.instanceCapacity) {
        const newCapacity = Math.max(instanceCount, buffers.instanceCapacity * 2);
        gl.bufferData(gl.ARRAY_BUFFER, newCapacity * INSTANCE_STRIDE_BYTES, gl.DYNAMIC_DRAW);
        buffers.instanceCapacity = newCapacity;
        lowOccupancyStreak = 0;
    } else if (
        buffers.instanceCapacity > MIN_INSTANCE_CAPACITY
        && instanceCount < (buffers.instanceCapacity >> 2)
    ) {
        // GPU VBO is at least 4× larger than current need. Wait for a
        // sustained low-occupancy streak before shrinking — pan-zoom across
        // a dense block back to an empty one shouldn't trigger a realloc
        // every render. After SHRINK_HYSTERESIS small uploads in a row,
        // reallocate down to 2× the most recent count (keep headroom).
        lowOccupancyStreak++;
        if (lowOccupancyStreak >= SHRINK_HYSTERESIS) {
            const target = Math.max(MIN_INSTANCE_CAPACITY, instanceCount * 2);
            if (target < buffers.instanceCapacity) {
                gl.bufferData(gl.ARRAY_BUFFER, target * INSTANCE_STRIDE_BYTES, gl.DYNAMIC_DRAW);
                buffers.instanceCapacity = target;
            }
            lowOccupancyStreak = 0;
        }
    } else {
        lowOccupancyStreak = 0;
    }

    gl.bufferSubData(
        gl.ARRAY_BUFFER,
        0,
        data.subarray(0, instanceCount * INSTANCE_STRIDE_F32),
    );

    gl.bindBuffer(gl.ARRAY_BUFFER, null);
}

export function destroyTileBuffers(gl: WebGL2RenderingContext, buffers: TileBuffers): void {
    gl.deleteVertexArray(buffers.vao);
    gl.deleteBuffer(buffers.quadVBO);
    gl.deleteBuffer(buffers.instanceVBO);
}
