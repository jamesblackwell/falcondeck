import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DictationDictionary, DICTIONARY_REQUEST_KEY } from "./DictationDictionary";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...args: unknown[]) => invoke(...args) }));
vi.mock("../api", () => ({ isTauriDesktop: () => true }));

beforeEach(() => {
  sessionStorage.clear(); invoke.mockReset();
  invoke.mockImplementation((command: string) => Promise.resolve(command === "dictation_dictionary" ? [{ find: "Larab", replace: "Laravel" }] : undefined));
});

describe("DictationDictionary", () => {
  it("shows the latest transcript and updates a saved spelling ignoring case", async () => {
    sessionStorage.setItem(DICTIONARY_REQUEST_KEY, "I use Larab.");
    await act(async () => { render(<DictationDictionary />); });
    expect(screen.getByText("I use Larab.")).toBeInTheDocument();
    expect(sessionStorage.getItem(DICTIONARY_REQUEST_KEY)).toBeNull();
    expect(screen.getByLabelText("Heard as")).toHaveFocus();
    fireEvent.change(screen.getByLabelText("Heard as"), { target: { value: "larab" } });
    fireEvent.change(screen.getByLabelText("Replace with"), { target: { value: "Laravel framework" } });
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Save correction" })); });
    expect(invoke).toHaveBeenLastCalledWith("save_dictation_dictionary", { entries: [{ find: "larab", replace: "Laravel framework" }] });
    expect(screen.getByText("larab → Laravel framework")).toBeInTheDocument();
  });

  it("saves and edits a word removal with a blank replacement", async () => {
    await act(async () => { render(<DictationDictionary />); });
    expect(screen.getByText("Leave blank to remove the word or phrase.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save correction" })).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Heard as"), { target: { value: "um" } });
    expect(screen.getByRole("button", { name: "Save correction" })).toBeEnabled();
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Save correction" })); });
    expect(invoke).toHaveBeenLastCalledWith("save_dictation_dictionary", {
      entries: [{ find: "Larab", replace: "Laravel" }, { find: "um", replace: "" }],
    });
    const row = screen.getByText("um → (remove)").closest("li")!;
    await act(async () => { fireEvent.click(within(row).getByRole("button", { name: "Edit" })); });
    expect(screen.getByLabelText("Heard as")).toHaveValue("um");
    expect(screen.getByLabelText("Replace with")).toHaveValue("");
    expect(screen.getByRole("button", { name: "Save correction" })).toBeEnabled();
  });

  it("keeps saved corrections and the draft when storage fails", async () => {
    await act(async () => { render(<DictationDictionary />); });
    invoke.mockRejectedValueOnce("Disk full");
    fireEvent.change(screen.getByLabelText("Heard as"), { target: { value: "Jayms" } });
    fireEvent.change(screen.getByLabelText("Replace with"), { target: { value: "James" } });
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Save correction" })); });
    expect(screen.getByRole("alert")).toHaveTextContent("Disk full");
    expect(screen.getByText("Larab → Laravel")).toBeInTheDocument();
    expect(screen.getByLabelText("Heard as")).toHaveValue("Jayms");
  });

  it("does not allow overwriting the dictionary after a failed load", async () => {
    invoke.mockRejectedValueOnce("Could not read dictionary");
    await act(async () => { render(<DictationDictionary />); });
    expect(screen.getByRole("alert")).toHaveTextContent("Could not read dictionary");
    expect(screen.getByRole("button", { name: "Save correction" })).toBeDisabled();
  });

  it("removes a correction only after saving succeeds", async () => {
    await act(async () => { render(<DictationDictionary />); });
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Remove correction for Larab" })); });
    expect(invoke).toHaveBeenLastCalledWith("save_dictation_dictionary", { entries: [] });
    expect(screen.getByText("No saved corrections yet.")).toBeInTheDocument();
  });
});
