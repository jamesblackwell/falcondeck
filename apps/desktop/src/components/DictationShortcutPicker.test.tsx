import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { DictationShortcutPicker } from "./DictationShortcutPicker";

describe("DictationShortcutPicker", () => {
  it("keeps Right Command and fn as suggested options", () => {
    const onChange = vi.fn();
    render(
      <DictationShortcutPicker
        id="shortcut"
        value="right_command"
        onChange={onChange}
      />,
    );
    expect(screen.getByRole("button", { name: "Right Command" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    fireEvent.click(screen.getByRole("button", { name: "Left Function (fn)" }));
    expect(onChange).toHaveBeenCalledWith("left_function");
  });

  it("records a custom chord", () => {
    const onChange = vi.fn();
    render(
      <DictationShortcutPicker
        id="shortcut"
        value="right_command"
        onChange={onChange}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Record shortcut" }));
    const recorder = screen.getByLabelText("Record dictation shortcut");
    fireEvent.keyDown(recorder, {
      key: "d",
      metaKey: true,
      shiftKey: true,
      code: "KeyD",
    });
    fireEvent.keyUp(recorder, {
      key: "d",
      metaKey: true,
      shiftKey: true,
      code: "KeyD",
    });
    expect(onChange).toHaveBeenCalledWith("Mod+Shift+D");
  });

  it("records right Command from a lone modifier", () => {
    const onChange = vi.fn();
    render(
      <DictationShortcutPicker
        id="shortcut"
        value="left_function"
        onChange={onChange}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Record shortcut" }));
    const recorder = screen.getByLabelText("Record dictation shortcut");
    fireEvent.keyDown(recorder, {
      key: "Meta",
      location: 2,
      metaKey: true,
      code: "MetaRight",
    });
    fireEvent.keyUp(recorder, {
      key: "Meta",
      location: 2,
      metaKey: false,
      code: "MetaRight",
    });
    expect(onChange).toHaveBeenCalledWith("right_command");
  });
});
