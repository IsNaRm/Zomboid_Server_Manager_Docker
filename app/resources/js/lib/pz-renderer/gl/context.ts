/**
 * WebGL2 context initialisation and capability detection.
 *
 * Returns null when WebGL2 is unavailable so callers can show a graceful
 * degradation message rather than crashing.
 */

export interface GL2Capabilities {
    /** True when EXT_disjoint_timer_query_webgl2 is present (GPU timing). */
    hasTimerQuery: boolean;
    /** True when OES_texture_float_linear is present. */
    hasFloatLinear: boolean;
    /** Max texture size (usually 4096–16384). */
    maxTextureSize: number;
    /** Max texture units available in fragment shader. */
    maxTextureImageUnits: number;
    /** Renderer string from WEBGL_debug_renderer_info (empty if unavailable). */
    renderer: string;
    /** Vendor string from WEBGL_debug_renderer_info (empty if unavailable). */
    vendor: string;
}

export interface GL2Context {
    gl: WebGL2RenderingContext;
    canvas: HTMLCanvasElement;
    capabilities: GL2Capabilities;
}

/**
 * Attempt to create a WebGL2 context on the given canvas.
 *
 * @param canvas - The canvas element to create the context on.
 * @param options - Optional WebGL context attributes.
 * @returns A GL2Context or null if WebGL2 is not supported.
 */
export function createGL2Context(
    canvas: HTMLCanvasElement,
    options?: WebGLContextAttributes,
): GL2Context | null {
    const defaultOptions: WebGLContextAttributes = {
        alpha: true,
        premultipliedAlpha: false,
        antialias: false,       // not needed for tile blit
        depth: false,           // we do 2D compositing only
        stencil: false,
        preserveDrawingBuffer: true,  // needed for readPixels after frame
        powerPreference: 'high-performance',
        failIfMajorPerformanceCaveat: false,
    };

    const gl = canvas.getContext('webgl2', { ...defaultOptions, ...options });
    if (!gl) {
        return null;
    }

    // Verify context is not lost immediately
    if (gl.isContextLost()) {
        return null;
    }

    const capabilities = detectCapabilities(gl);

    return { gl, canvas, capabilities };
}

function detectCapabilities(gl: WebGL2RenderingContext): GL2Capabilities {
    const hasTimerQuery = !!gl.getExtension('EXT_disjoint_timer_query_webgl2');
    const hasFloatLinear = !!gl.getExtension('OES_texture_float_linear');
    const maxTextureSize = gl.getParameter(gl.MAX_TEXTURE_SIZE) as number;
    const maxTextureImageUnits = gl.getParameter(gl.MAX_TEXTURE_IMAGE_UNITS) as number;

    let renderer = '';
    let vendor = '';
    const debugInfo = gl.getExtension('WEBGL_debug_renderer_info');
    if (debugInfo) {
        renderer = (gl.getParameter(debugInfo.UNMASKED_RENDERER_WEBGL) as string) ?? '';
        vendor = (gl.getParameter(debugInfo.UNMASKED_VENDOR_WEBGL) as string) ?? '';
    }

    return { hasTimerQuery, hasFloatLinear, maxTextureSize, maxTextureImageUnits, renderer, vendor };
}

/**
 * Quick static check whether WebGL2 is likely available in this browser
 * without actually creating a full rendering context.
 */
export function isWebGL2Available(): boolean {
    try {
        const probe = document.createElement('canvas');
        const gl = probe.getContext('webgl2');
        if (!gl) { return false; }
        // Trigger any lazy init; check error state
        const err = gl.getError();
        return err === gl.NO_ERROR || err === gl.CONTEXT_LOST_WEBGL;
    } catch {
        return false;
    }
}
