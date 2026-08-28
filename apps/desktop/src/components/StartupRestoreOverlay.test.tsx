import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { StartupRestoreOverlay } from "./StartupRestoreOverlay";

describe("StartupRestoreOverlay", () => {
  it("announces that persisted sessions are being checked", () => {
    render(<StartupRestoreOverlay />);

    expect(
      screen.getByRole("status", { name: "Restoring FalconDeck sessions" }),
    ).toHaveTextContent("Restoring your sessions");
  });
});
