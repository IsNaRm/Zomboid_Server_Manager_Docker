/**
 * WebGL2 shader compilation and program linking helpers.
 *
 * GLSL source files are imported as raw strings via Vite's `?raw` suffix.
 * This module keeps GPU-side compilation errors surfaced clearly in the
 * browser console with the shader type name included.
 */

export type ShaderType = 'vertex' | 'fragment';

/**
 * Compile a single shader stage. Throws on compilation failure.
 */
export function compileShader(
    gl: WebGL2RenderingContext,
    source: string,
    type: ShaderType,
): WebGLShader {
    const glType = type === 'vertex' ? gl.VERTEX_SHADER : gl.FRAGMENT_SHADER;
    const shader = gl.createShader(glType);
    if (!shader) {
        throw new Error(`[pz-renderer] Failed to create ${type} shader object`);
    }

    gl.shaderSource(shader, source);
    gl.compileShader(shader);

    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
        const log = gl.getShaderInfoLog(shader) ?? 'unknown error';
        gl.deleteShader(shader);
        throw new Error(`[pz-renderer] ${type} shader compile error:\n${log}`);
    }

    return shader;
}

/**
 * Link a vertex + fragment shader pair into a program. Throws on failure.
 * Detaches and deletes the shader objects after successful linking —
 * the program retains a reference internally.
 */
export function linkProgram(
    gl: WebGL2RenderingContext,
    vertShader: WebGLShader,
    fragShader: WebGLShader,
): WebGLProgram {
    const program = gl.createProgram();
    if (!program) {
        throw new Error('[pz-renderer] Failed to create WebGL program');
    }

    gl.attachShader(program, vertShader);
    gl.attachShader(program, fragShader);
    gl.linkProgram(program);

    // Detach after linking (good practice; reduces driver memory in some impls)
    gl.detachShader(program, vertShader);
    gl.detachShader(program, fragShader);

    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
        const log = gl.getProgramInfoLog(program) ?? 'unknown error';
        gl.deleteProgram(program);
        throw new Error(`[pz-renderer] Program link error:\n${log}`);
    }

    return program;
}

/**
 * Compile and link a complete shader program from GLSL source strings.
 * The shader objects are freed after linking.
 */
export function createProgram(
    gl: WebGL2RenderingContext,
    vertSrc: string,
    fragSrc: string,
): WebGLProgram {
    const vert = compileShader(gl, vertSrc, 'vertex');
    const frag = compileShader(gl, fragSrc, 'fragment');

    try {
        const program = linkProgram(gl, vert, frag);
        return program;
    } finally {
        // Always clean up shader objects regardless of link success
        gl.deleteShader(vert);
        gl.deleteShader(frag);
    }
}

// ---------------------------------------------------------------------------
// Uniform setters — typed wrappers to keep tile-renderer.ts readable
// ---------------------------------------------------------------------------

export function setUniform1i(gl: WebGL2RenderingContext, program: WebGLProgram, name: string, value: number): void {
    const loc = gl.getUniformLocation(program, name);
    if (loc !== null) { gl.uniform1i(loc, value); }
}

export function setUniform1f(gl: WebGL2RenderingContext, program: WebGLProgram, name: string, value: number): void {
    const loc = gl.getUniformLocation(program, name);
    if (loc !== null) { gl.uniform1f(loc, value); }
}

export function setUniform2f(gl: WebGL2RenderingContext, program: WebGLProgram, name: string, x: number, y: number): void {
    const loc = gl.getUniformLocation(program, name);
    if (loc !== null) { gl.uniform2f(loc, x, y); }
}

export function setUniform1b(gl: WebGL2RenderingContext, program: WebGLProgram, name: string, value: boolean): void {
    const loc = gl.getUniformLocation(program, name);
    if (loc !== null) { gl.uniform1i(loc, value ? 1 : 0); }
}

/**
 * Upload a flat Float32Array as vec4[] uniform array.
 * @param data - Flat array of floats (4 floats per vec4).
 */
export function setUniform4fv(
    gl: WebGL2RenderingContext,
    program: WebGLProgram,
    name: string,
    data: Float32Array,
): void {
    const loc = gl.getUniformLocation(program, name);
    if (loc !== null) { gl.uniform4fv(loc, data); }
}
