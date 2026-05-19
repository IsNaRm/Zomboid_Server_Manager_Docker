#version 300 es
precision highp float;

// Per-vertex unit quad in [0,1]^2 — the four corners of the sprite rect.
in vec2 a_quadCoord;

// Per-instance attributes (one instance = one sprite on one square)
in float a_squareX;
in float a_squareY;
in float a_cellX;
in float a_cellY;
in vec4  a_spriteUV;      // (u0, v0, du, dv) — normalised atlas UV rect
in float a_atlasLayer;    // TEXTURE_2D_ARRAY layer (= sprite.atlas)
in float a_halfWater;     // 1.0 → 0.5 alpha
in float a_spriteW;       // native sprite width  (atlas pixels)
in float a_spriteH;       // native sprite height (atlas pixels)
in float a_offsetX;       // offset from square bottom-center to sprite top-left (native px)
in float a_offsetY;

// Uniforms
uniform vec2  u_tileOriginSq;     // world-square (sx, sy) of tile top-left
uniform vec2  u_tileSize;         // tile size in PZ squares
uniform vec2  u_canvasSize;       // canvas pixels (256, 256)
uniform float u_sqr;              // pixels-per-square-edge at native zoom (effective)
uniform bool  u_isometric;
uniform vec2  u_worldOriginPx;    // image-pixel value of world square (0,0)
uniform float u_pixelsPerSquare;  // canvas pixels per PZ square at current zoom
uniform float u_cellSizeInSquares;
uniform float u_nativeToEffective; // = 1/2^skip; converts native px → effective DZI px
uniform float u_cellStride;       // ≥1; sample spacing in cells (also sprite scale at zoom-out)

// Outputs to fragment
out vec2  v_squareCoord;  // (0..1) — sample uv within sprite UV rect
out vec4  v_spriteUV;
out float v_atlasLayer;
out float v_halfWater;
out float v_mipLOD;

vec2 squareToDZIPixel(float sx, float sy) {
    if (u_isometric) {
        float halfSqr = u_sqr * 0.5;
        float quarterSqr = u_sqr * 0.25;
        float px = (sx - sy) * halfSqr + u_worldOriginPx.x;
        float py = (sx + sy) * quarterSqr + u_worldOriginPx.y + quarterSqr;
        return vec2(px, py);
    } else {
        return vec2(sx * u_sqr + u_worldOriginPx.x,
                    sy * u_sqr + u_worldOriginPx.y);
    }
}

void main() {
    // World-square integer position of this sprite's anchor square.
    float worldSX = a_cellX * u_cellSizeInSquares + a_squareX;
    float worldSY = a_cellY * u_cellSizeInSquares + a_squareY;

    // pzmap2dzi anchor: square CENTER, then shift +sqr_height/2 to BOTTOM CENTER.
    // (base.py:39: oy += dzi.sqr_height >> 1). Center is (sx+0.5, sy+0.5).
    vec2 bottomCenterPx = squareToDZIPixel(worldSX + 0.5, worldSY + 0.5);
    bottomCenterPx.y += 0.25 * u_sqr;

    // Sprite top-left in effective DZI pixel-space:
    //   topLeft = bottomCenter + (offset_x, offset_y) — offsets are native px,
    //   so convert via u_nativeToEffective. Both axes are AXIS-ALIGNED in
    //   pixel-space — sprite is a native-sized rect, not an iso romb.
    //
    // When cell-stride > 1 we render 1 cell out of every N×N block; to
    // visually cover the skipped neighbours we scale BOTH the sprite
    // size and its anchor offset by `u_cellStride`. Each rendered sprite
    // then visually represents a stride²-cell area.
    vec2 spriteSizePx = vec2(a_spriteW, a_spriteH) * u_nativeToEffective * u_cellStride;
    vec2 offsetPx     = vec2(a_offsetX, a_offsetY) * u_nativeToEffective * u_cellStride;
    vec2 topLeftPx    = bottomCenterPx + offsetPx;
    vec2 cornerPx     = topLeftPx + a_quadCoord * spriteSizePx;

    // Tile origin in effective DZI pixel-space; subtract to get local px.
    vec2 tileOriginDziPx = squareToDZIPixel(u_tileOriginSq.x, u_tileOriginSq.y);
    vec2 localPx = (cornerPx - tileOriginDziPx) * u_pixelsPerSquare / u_sqr;

    // NDC [-1, 1] (Y-flipped for WebGL).
    vec2 ndc = (localPx / u_canvasSize) * 2.0 - 1.0;
    ndc.y = -ndc.y;
    gl_Position = vec4(ndc, 0.0, 1.0);

    v_squareCoord = a_quadCoord;
    v_spriteUV    = a_spriteUV;
    v_atlasLayer  = a_atlasLayer;
    v_halfWater   = a_halfWater;

    // LOD heuristic — coarse, fragment refines via dFdx/dFdy.
    float coverage = max(u_pixelsPerSquare, 0.001);
    v_mipLOD = clamp(log2(128.0 / coverage), 0.0, 10.0);
}
