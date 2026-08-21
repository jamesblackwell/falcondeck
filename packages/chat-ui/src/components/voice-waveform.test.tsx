import { render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { formatVoiceDuration, VoiceWaveform } from "./voice-waveform";

describe("VoiceWaveform", () => {
  const originalClientWidth = Object.getOwnPropertyDescriptor(
    HTMLElement.prototype,
    "clientWidth",
  );

  beforeEach(() => {
    Object.defineProperty(HTMLElement.prototype, "clientWidth", {
      configurable: true,
      get() {
        return 63;
      },
    });
  });

  afterEach(() => {
    if (originalClientWidth) {
      Object.defineProperty(
        HTMLElement.prototype,
        "clientWidth",
        originalClientWidth,
      );
    } else {
      delete (HTMLElement.prototype as { clientWidth?: number }).clientWidth;
    }
  });

  it("fills the strip with placeholders, then real bars as levels arrive", () => {
    const { container, rerender } = render(<VoiceWaveform levels={[]} />);
    const bars = () => container.querySelectorAll("span");

    // 63px + 3px gap / 6px per bar = 11 slots.
    expect(bars()).toHaveLength(11);
    expect(bars()[0]).toHaveStyle({ height: "4px" });

    rerender(<VoiceWaveform levels={[0.5, 1]} />);
    expect(bars()[0]).toHaveStyle({ height: "15px" });
    expect(bars()[1]).toHaveStyle({ height: "26px" });
    expect(bars()[2]).toHaveStyle({ height: "4px" });
  });

  it("formats elapsed recording time as m:ss", () => {
    expect(formatVoiceDuration(0)).toBe("0:00");
    expect(formatVoiceDuration(4)).toBe("0:04");
    expect(formatVoiceDuration(75)).toBe("1:15");
  });
});
