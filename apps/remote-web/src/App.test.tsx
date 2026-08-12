import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  generateBoxKeyPair,
  REMOTE_SESSION_STORAGE_VERSION,
  secretKeyToBase64,
} from "@falcondeck/client-core";

import App from "./App";
import { persistRemoteSession } from "./lib/remoteAppUtils";

afterEach(() => {
  window.localStorage.clear();
  vi.restoreAllMocks();
  document.title = "";
});

describe("App", () => {
  it("mounts on the pairing screen when nothing is stored", () => {
    render(<App />);
    expect(
      screen.getByRole("heading", { name: "FalconDeck Remote" }),
    ).toBeInTheDocument();
    expect(screen.getByLabelText("Pairing code")).toHaveValue("");
  });

  it("prefills the code from a pairing link", () => {
    window.history.replaceState({}, "", "/?code=ABCD1234");
    render(<App />);
    expect(screen.getByLabelText("Pairing code")).toHaveValue("ABCD1234");
    window.history.replaceState({}, "", "/");
  });

  it("discards a stored session written by an older storage version", () => {
    window.localStorage.setItem(
      "falcondeck.remote.session.v1",
      JSON.stringify({ version: 0, sessionId: "stale" }),
    );
    render(<App />);
    expect(screen.getByRole("button", { name: "Connect" })).toBeInTheDocument();
    expect(
      window.localStorage.getItem("falcondeck.remote.session.v1"),
    ).toBeNull();
  });

  it("loads the command palette on the first shortcut without losing that request", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(
      () => new Promise<Response>(() => {}),
    );
    Element.prototype.scrollIntoView = vi.fn();
    persistRemoteSession({
      version: REMOTE_SESSION_STORAGE_VERSION,
      relayUrl: "https://connect.example.com",
      pairingCode: "ABCD1234",
      sessionId: "session-command-palette",
      clientToken: "client-token",
      clientSecretKey: secretKeyToBase64(generateBoxKeyPair()),
    });

    render(<App />);
    expect(
      screen.queryByRole("dialog", { name: "Command palette" }),
    ).not.toBeInTheDocument();

    fireEvent.keyDown(window, { key: "k", metaKey: true });

    expect(
      await screen.findByRole("dialog", { name: "Command palette" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("combobox", { name: "Search threads and commands" }),
    ).toHaveFocus();
  });
});
