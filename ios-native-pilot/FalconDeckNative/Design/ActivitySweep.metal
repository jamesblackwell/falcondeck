#include <metal_stdlib>
using namespace metal;

// A narrow, quiet highlight that follows the palette's readable foreground.
[[ stitchable ]] half4 activitySweep(float2 position, half4 ink, float2 size,
                                    float time, half4 highlight) {
    float x = position.x / max(size.x, 1.0f);
    float center = fract(time / 2.4f) * 1.8f - 0.4f;
    float distance = (x - center) * 5.0f;
    half amount = half(exp(-distance * distance) * 0.55f);
    return half4(mix(ink.rgb, highlight.rgb * ink.a, amount), ink.a);
}

// A finite touch response: a soft ring and a fine diagonal highlight, clipped
// to a single control. Both endpoints are transparent; nothing runs at rest.
[[ stitchable ]] half4 composerResponse(float2 position, half4 ink, float2 size,
                                       float phase, half4 highlight) {
    float progress = clamp(phase, 0.0f, 1.0f);
    float envelope = sin(progress * M_PI_F);
    float2 uv = (position - size * 0.5f) / max(min(size.x, size.y), 1.0f);
    float radius = progress * 0.95f;
    float ring = exp(-pow((length(uv) - radius) * 12.0f, 2.0f));
    float diagonal = position.x / max(size.x, 1.0f) + position.y / max(size.y, 1.0f) * 0.25f;
    float sheen = exp(-pow((diagonal - progress * 1.7f + 0.2f) * 8.0f, 2.0f));
    half alpha = half(max(0.0f, envelope) * (ring * 0.22f + sheen * 0.3f)) * ink.a;
    return half4(highlight.rgb * alpha, alpha);
}
