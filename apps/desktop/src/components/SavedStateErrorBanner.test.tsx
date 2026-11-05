import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { SavedStateErrorBanner } from "./SavedStateErrorBanner";

describe("SavedStateErrorBanner", () => {
  it("names the failure and says the data is safe", () => {
    render(<SavedStateErrorBanner error="/state/falcondeck.json: bad json" />);
    expect(screen.getByRole("alert")).toHaveTextContent("Your data is safe");
    expect(screen.getByRole("alert")).toHaveTextContent(
      "/state/falcondeck.json: bad json",
    );
  });
});
