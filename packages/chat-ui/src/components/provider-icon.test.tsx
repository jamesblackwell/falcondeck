import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { ProviderIcon } from "./provider-icon";

describe("ProviderIcon", () => {
  it("renders the vendor mark for a known harness", () => {
    const { container } = render(<ProviderIcon provider="claude" />);
    expect(container.querySelector("svg")).not.toBeNull();
    expect(container.querySelector("svg")?.getAttribute("aria-hidden")).toBe(
      "true",
    );
  });

  it("labels the mark when a title is provided", () => {
    const { getByTitle } = render(
      <ProviderIcon provider="opencode" title="OpenCode" />,
    );
    expect(getByTitle("OpenCode")).toBeTruthy();
  });

  it("falls back to a terminal glyph for unknown harnesses", () => {
    const { container } = render(<ProviderIcon provider="mystery" />);
    expect(container.querySelector("svg")).not.toBeNull();
  });
});
