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
    // Hard alpha cutoff: atlas filter теперь NEAREST (pixel-perfect),
    // partial alpha бывает только если у самого sprite content soft edges.
    // 0.5 threshold убирает оставшиеся artifacts на границах.
    if (c.a < 0.5) discard;
    fragColor = vec4(c.rgb, c.a * vAlpha);
}
