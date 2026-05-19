#version 300 es
precision highp float;
precision highp sampler2DArray;

// Atlas texture array — one layer per page in sprites.json.
uniform sampler2DArray u_atlas;

in vec2  v_squareCoord;
in vec4  v_spriteUV;      // (u0, v0, du, dv) of sprite in its atlas layer
in float v_atlasLayer;    // which array layer to sample from
in float v_halfWater;     // 1.0 → alpha *= 0.5
in float v_mipLOD;

out vec4 fragColor;

void main() {
    // Refine LOD using screen-space derivatives.
    vec2 dSdx = dFdx(v_squareCoord);
    vec2 dSdy = dFdy(v_squareCoord);
    float rho = max(length(dSdx), length(dSdy));
    float derivLOD = log2(max(rho, 1e-6));
    float lod = clamp(max(v_mipLOD, derivLOD), 0.0, 10.0);

    // Sample position inside the sprite's UV rect on its array layer.
    vec2 uv = v_spriteUV.xy + v_squareCoord * v_spriteUV.zw;
    vec4 sprite = textureLod(u_atlas, vec3(uv, v_atlasLayer), lod);

    // Half-water composite: certain blend tiles render at 0.5 alpha.
    float alphaScale = v_halfWater > 0.5 ? 0.5 : 1.0;
    sprite.a *= alphaScale;

    fragColor = sprite;
}
