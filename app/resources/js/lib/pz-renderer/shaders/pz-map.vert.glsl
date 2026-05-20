#version 300 es
precision highp float;
precision highp int;
precision highp usampler2D;
precision highp sampler2D;

// Camera / view matrix maps PZ native pixels → NDC.
uniform mat4 uViewProj;

// Origin cell в world-square coords (для текущего drawcall).
uniform vec2  uCellOriginSq;     // (cellX * cellSize, cellY * cellSize)
uniform uint  uCellOffsetInAtlas; // prefix-sum offset в cellAtlas (× 2 = u32)
uniform float uSqr;               // px per square edge при current debug view
uniform float uNativeSqr;         // px per square edge для которого был built atlas
                                  // (B42 = 64, B41 = 32). Spriteразмеры в atlas
                                  // соответствуют этому значению; sprite растёт
                                  // пропорционально (uSqr / uNativeSqr).
uniform int   uIsometric;         // 0 = top-down, 1 = isometric
uniform int   uLod;               // 0..3, выбирает row band в spriteInfo
uniform int   uNLods;             // = 4 (для расчёта sprite info row)
uniform float uAtlasNativeSize;   // px-размер LOD0 атласа (4096). Нужен
                                  // чтобы из нормализованного uvSize
                                  // получить native pixel width/height
                                  // спрайта (sprites НЕ квадратные —
                                  // ground tile примерно 128×64).
uniform int   uMaxFloor;          // прятать sprites с layer > uMaxFloor.
                                  // UI slider даёт значения 0..3.
uniform float uFloorHeightPx;     // вертикальный offset между этажами
                                  // в native pixels (для B42 = 192).
                                  // Sprite анкер сдвигается вверх по
                                  // экрану на layer * uFloorHeightPx.
uniform float uMaxWorldDepth;     // нормализатор для multi-cell depth.
                                  // = (maxWorldSx + maxWorldSy + buffer).
                                  // Все cells вместе должны попадать в
                                  // [-1..1] NDC.z без конфликтов.
uniform int   uSquareStride;      // decimation factor (= effective stride).
                                  // Entries уже pre-sorted в worker pack:
                                  // CPU pass'ит ровно нужный instanceCount,
                                  // vertex shader не выполняется для skipped.
                                  // Здесь используется ТОЛЬКО для spriteScale
                                  // (sprite × stride чтобы покрыть gaps).

// Cell atlas (R32UI): packed sprite stream всех cells.
uniform highp usampler2D uCellAtlas;
uniform int uCellAtlasWidth;     // ширина для index → ivec2 decode

// Sprite metadata (RGBA32F).
uniform sampler2D uSpriteInfo;
uniform int uSpriteInfoWidth;    // ширина для 2D decode lookup

// Outputs to fragment.
flat out int vAtlasPage;
out vec2 vUv;
out float vAlpha;

// Unit quad corners. Sprite в native px рисуется в bottom-left anchored
// прямоугольником размера (spriteW, spriteH).
const vec2 QUAD_CORNERS[4] = vec2[4](
    vec2(0.0, 0.0),
    vec2(1.0, 0.0),
    vec2(0.0, 1.0),
    vec2(1.0, 1.0)
);

// ivec2 decode для 1D index в 2D texture.
ivec2 atlasCoord(uint absIdx) {
    int w = uCellAtlasWidth;
    int x = int(absIdx) % w;
    int y = int(absIdx) / w;
    return ivec2(x, y);
}

void main() {
    // 1. Fetch sprite entry для этого instance.
    //    Каждая entry = 2 u32 texela: e0 (sprite_id + layer), e1 (sx, sy, z, flags).
    uint absIdx = uCellOffsetInAtlas + uint(gl_InstanceID) * 2u;
    uvec4 e0 = texelFetch(uCellAtlas, atlasCoord(absIdx),     0);
    uvec4 e1 = texelFetch(uCellAtlas, atlasCoord(absIdx + 1u), 0);

    uint spriteId = e0.r & 0x00FFFFFFu;
    int  layer    = int(e0.r >> 24) - 32;  // signed: PZ basement = -1, floors 0..7
    uint sx = e1.r & 0xFFu;
    uint sy = (e1.r >> 8) & 0xFFu;
    uint zStack = (e1.r >> 16) & 0xFFu;
    uint flags = (e1.r >> 24) & 0x7Fu;

    // Filter floors через UI slider: всё что выше uMaxFloor — скрыть.
    // Делаем degenerate triangle через clip-space z=2 (вне [-1..1]).
    if (layer > uMaxFloor) {
        gl_Position = vec4(0.0, 0.0, 2.0, 1.0);
        return;
    }

    // Square stride decimation: фильтрация не нужна — worker pre-sorted
    // entries в stride buckets, CPU подаёт правильный instanceCount через
    // strideOffsets[K]. Vertex shader получает ТОЛЬКО stride-aligned
    // sprites. uSquareStride остаётся для spriteScale (sprite size).

    // 2. Sprite metadata из uSpriteInfo (2D layout, 2 texela на (spriteId, lod)).
    int linearIdx = int(spriteId) * uNLods + uLod;
    int texelA = linearIdx * 2;
    int texelB = texelA + 1;
    int infoW = uSpriteInfoWidth;
    vec4 sa = texelFetch(uSpriteInfo, ivec2(texelA % infoW, texelA / infoW), 0);
    vec4 sb = texelFetch(uSpriteInfo, ivec2(texelB % infoW, texelB / infoW), 0);

    vec2 uv0       = sa.xy;
    vec2 uvSize    = sa.zw;
    int  atlasPage = int(sb.x);
    vec2 offsetPx  = sb.zw;

    // Native pixel size спрайта: width и height РАЗНЫЕ для iso art.
    // Например ground tile B42 ≈ 128×64 (2:1 iso). Раньше мы хранили
    // только width и применяли его и к X и к Y — sprite растягивался
    // по вертикали и diamond выглядел как axis-aligned квадрат.
    vec2 nativePx = uvSize * uAtlasNativeSize;

    // 3. World-square coord этого спрайта.
    float worldSX = uCellOriginSq.x + float(sx);
    float worldSY = uCellOriginSq.y + float(sy);

    // 4. Projection: world-square → world-pixel (PZ canonical, см.
    //    pzmap2dzi/pzdzi.py:get_sqr_center).
    //    Top corner of square (sx, sy):
    //      top.x = (sx - sy) * uSqr
    //      top.y = (sx + sy) * (uSqr / 2)
    //    Diamond center (anchor для sprite offset, как в PZ):
    //      center = top + (0, uSqr/2)
    //    Раньше использовались halfSqr/quarterSqr (sqr/2 и sqr/4) — в 2×
    //    меньше — squares оказывались ближе → sprites накладывались.
    vec2 squareCenter;
    if (uIsometric == 1) {
        float halfSqr = uSqr * 0.5;
        squareCenter = vec2(
            (worldSX - worldSY) * uSqr,
            (worldSX + worldSY) * halfSqr + halfSqr
        );
    } else {
        squareCenter = vec2(
            (worldSX + 0.5) * uSqr,
            (worldSY + 0.5) * uSqr
        );
    }

    // 5. Sprite quad: anchor = diamond center + sprite offset (PZ
    //    convention). Sprite stored с native size относительно nativeSqr.
    //    Pixel-scale = uSqr / uNativeSqr.
    //    Top-left of sprite quad = anchor + offset. Sprite extends RIGHT
    //    и DOWN (screen Y-down convention).
    //
    //    Multi-floor: каждый этаж смещён ВВЕРХ по экрану (= -Y) на
    //    uFloorHeightPx × layer. PZ B42 standard = 192 px.
    //
    //    Square stride с tall/wide differentiation:
    //    - WIDTH всегда растёт линейно (× N) — нужно покрыть iso ширину
    //      N world squares.
    //    - HEIGHT: для wide sprites (ground tiles 128×32, height ≤ width)
    //      растёт ТАК ЖЕ как width (× N) — нормальное iso tiling.
    //      Для TALL sprites (деревья/стены 128×500, height > width) —
    //      ДЕЛИТСЯ на N, чтобы они не превращались в вертикальные
    //      колонны при zoom-out (collapse to flat ground-level).
    //    floorShiftY использует strideY чтобы этажи collapsed consistent.
    float ppsScale = uSqr / uNativeSqr;
    float strideXMul = float(uSquareStride);
    bool isTallSprite = nativePx.y > nativePx.x;
    float strideYMul = isTallSprite
        ? (1.0 / float(uSquareStride))
        : float(uSquareStride);
    vec2 spriteScale = vec2(ppsScale * strideXMul, ppsScale * strideYMul);
    float floorShiftY = float(layer) * uFloorHeightPx * ppsScale * strideYMul;
    vec2 spriteTopLeft = squareCenter + offsetPx * spriteScale;
    spriteTopLeft.y -= floorShiftY;
    vec2 corner = QUAD_CORNERS[gl_VertexID];
    vec2 cornerPx = spriteTopLeft + corner * nativePx * spriteScale;

    // 6. UV: corner.y=0 = top of sprite quad = top of UV rect в atlas
    //    (PIL Y-down convention). Standard mapping без flip.
    vUv = uv0 + corner * uvSize;
    vAtlasPage = atlasPage;
    vAlpha = (flags & 0x40u) != 0u ? 0.5 : 1.0;  // halfWater flag

    // 7. Depth для isometric painter's algorithm (multi-cell).
    //    Используем GLOBAL world coords (включают cellOrigin): дальние
    //    squares (малый worldSx+worldSy) → z=+1 (back), ближние → z=-1
    //    (front). Нормализатор uMaxWorldDepth подбирается так чтобы
    //    весь map fit в [-1..1] NDC.z.
    //
    //    Внутри одной square: higher zStack → меньше z → поверх.
    //    Floor ordering: верхние этажи (layer больше) → z меньше →
    //    рисуются поверх нижних. stackPunch < floorPunch < cellStep.
    float worldDepth = (worldSX + worldSY) / uMaxWorldDepth;  // [0..1]
    float stackPunch = float(zStack) * 0.00002;   // ε для внутри-square
    float floorPunch = float(layer) * 0.0005;     // больше чем stack max
    gl_Position = uViewProj * vec4(cornerPx, 0.0, 1.0);
    gl_Position.z = (1.0 - 2.0 * worldDepth) - stackPunch - floorPunch;
}
