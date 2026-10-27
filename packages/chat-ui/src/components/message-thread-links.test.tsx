import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { ThreadLinkProvider } from "../lib/thread-link-context";
import { MessageMarkdown } from "./message-markdown";

describe("task links in messages", () => {
  it("opens an ID-based destination for both inline and reference links", () => {
    const openThread = vi.fn();
    render(<ThreadLinkProvider onOpenThread={openThread}>
      <MessageMarkdown text={"See [Release work](falcondeck://thread/task-123) and [Renamed task][task].\n\n[task]: falcondeck://thread/task-123"} />
    </ThreadLinkProvider>);
    fireEvent.click(screen.getByRole("link", { name: "Release work" }));
    fireEvent.click(screen.getByRole("link", { name: "Renamed task" }));
    expect(openThread.mock.calls).toEqual([["task-123"], ["task-123"]]);
    expect(screen.getByRole("link", { name: "Release work" })).not.toHaveAttribute("target");
  });

  it("leaves malformed links inert and preserves web links", () => {
    render(<ThreadLinkProvider onOpenThread={vi.fn()}>
      <MessageMarkdown text={"[Invalid](falcondeck://thread/task-123?delete=true) [Unsafe](javascript:alert(1)) [Docs](https://falcondeck.com)"} />
    </ThreadLinkProvider>);
    expect(screen.getAllByRole("link")).toHaveLength(1);
    expect(screen.getByRole("link", { name: "Docs" })).toHaveAttribute("href", "https://falcondeck.com");
    expect(screen.getByText("Invalid")).toBeInTheDocument();
  });
});
