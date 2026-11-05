import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { SavedStateErrorBanner } from "./SavedStateErrorBanner";

describe("SavedStateErrorBanner", () => {
  it("names the failure and promises not to overwrite it", () => {
    render(<SavedStateErrorBanner error="/state/falcondeck.json: bad json" />);
    expect(screen.getByRole("alert")).toHaveTextContent("won't overwrite");
    expect(screen.getByRole("alert")).toHaveTextContent(
      "/state/falcondeck.json: bad json",
    );
  });
});
