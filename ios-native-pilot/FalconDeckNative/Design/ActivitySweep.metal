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
