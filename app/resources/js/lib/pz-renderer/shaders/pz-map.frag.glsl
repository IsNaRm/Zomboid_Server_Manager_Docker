#version 300 es
precision highp float;
precision highp sampler2DArray;

uniform sampler2DArray uAtlasArray;  // bound to active LOD's array texture
uniform int uDebugMode;              // 0 = normal, 1 = solid magenta, 2 = UV viz

flat in int vAtlasPage;
in vec2 vUv;
in float vAlpha;

out vec4 fragColor;

void main() {
    // Debug fallbacks для диагностики проекции/UV/texture:
    if (uDebugMode == 1) {
        // Solid magenta — показывает где quads рисуются.
        fragColor = vec4(1.0, 0.0, 1.0, 1.0);
        return;
    }
    if (uDebugMode == 2) {
        // UV visualization — gradient по vUv. Если все спрайты выглядят
        // одинаково раскрашенные → UV корректные. Иначе UV сломаны.
        fragColor = vec4(vUv.x, vUv.y, 0.5, 1.0);
        return;
    }

    vec4 c = texture(uAtlasArray, vec3(vUv, float(vAtlasPage)));
    if (c.a < 0.01) discard;
    // Чёрная обводка fix: LINEAR фильтр смешивает edge sprite pixel с
    // соседним transparent pixel (RGB=0). Sampled.rgb получается затемнённым
    // относительно sampled.alpha → halo при straight-alpha blend.
    // Recovery: rgb / alpha восстанавливает "исходный" цвет — работает и
    // для premultiplied и для straight-alpha atlas storage.
    vec3 unbleed = clamp(c.rgb / c.a, 0.0, 1.0);
    fragColor = vec4(unbleed, c.a * vAlpha);
}
