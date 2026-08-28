import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { StrictMode } from "react";
import { describe, expect, it, vi } from "vitest";

vi.mock("mermaid", () => ({
  default: {
    initialize: vi.fn(),
    render: vi.fn(async () => ({
      svg: '<svg data-testid="mermaid-svg"></svg>',
    })),
  },
}));

import {
  LocalPathProvider,
  MessageMarkdown,
  WebLinkProvider,
  normalizeMarkdownForStreaming,
  renderMarkdown,
  splitStreamingMarkdownBlocks,
} from "@falcondeck/chat-ui";

describe("normalizeMarkdownForStreaming", () => {
  it("closes a half-streamed link destination", () => {
    expect(normalizeMarkdownForStreaming("[OpenAI](https://openai.com")).toBe(
      "[OpenAI](https://openai.com)",
    );
  });

  it("leaves complete or non-link text alone", () => {
    expect(normalizeMarkdownForStreaming("plain text")).toBe("plain text");
    expect(normalizeMarkdownForStreaming("[OpenAI](https://openai.com)")).toBe(
      "[OpenAI](https://openai.com)",
    );
    expect(normalizeMarkdownForStreaming("[OpenAI](")).toBe("[OpenAI](");
  });
});

describe("splitStreamingMarkdownBlocks", () => {
  it("stabilizes completed top-level blocks and leaves the growing tail", () => {
    expect(
      splitStreamingMarkdownBlocks("First paragraph.\n\nSecond paragraph"),
    ).toEqual({
      completed: ["First paragraph.\n\n"],
      tail: "Second paragraph",
    });
  });

  it("does not split on blank lines inside fenced code", () => {
    expect(
      splitStreamingMarkdownBlocks(
        "Before.\n\n```ts\nconst first = 1;\n\nconst second = 2;\n```\n\nAfter",
      ),
    ).toEqual({
      completed: [
        "Before.\n\n",
        "```ts\nconst first = 1;\n\nconst second = 2;\n```\n\n",
      ],
      tail: "After",
    });
  });

  it("accepts CommonMark closing-fence indentation and trailing whitespace", () => {
    expect(
      splitStreamingMarkdownBlocks(
        "Before.\n\n~~~~lang\nbody\n   ~~~~~ \t\n\nAfter",
      ),
    ).toEqual({
      completed: ["Before.\n\n", "~~~~lang\nbody\n   ~~~~~ \t\n\n"],
      tail: "After",
    });
  });

  it("does not close a fence with excess indentation or trailing content", () => {
    const text =
      "```ts\nbody\n    ```\n\nstill fenced\n``` suffix\n\nstill fenced";
    expect(splitStreamingMarkdownBlocks(text)).toEqual({
      completed: [],
      tail: text,
    });
  });
});

describe("renderMarkdown links", () => {
  it("renders markdown links as external anchors", () => {
    render(
      <>
        {renderMarkdown("See [docs](https://falcondeck.com/docs) for more.")}
      </>,
    );

    const link = screen.getByRole("link", { name: "docs" });
    expect(link).toHaveAttribute("href", "https://falcondeck.com/docs");
    expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveAttribute("rel", expect.stringContaining("noopener"));
  });

  it("does not create an anchor for javascript: URLs", () => {
    const { container } = render(
      <>{renderMarkdown("[Unsafe](javascript:alert(1))")}</>,
    );

    expect(container.querySelector("a")).toBeNull();
    expect(container.textContent).toContain("Unsafe");
  });

  it("keeps credential-bearing links and remote images inert", () => {
    const { container } = render(
      <>
        {renderMarkdown(
          "[Report](https://user:secret@example.com/report)\n\n![Tracker](https://attacker.example/pixel.png)",
        )}
      </>,
    );

    expect(
      screen.queryByRole("link", { name: "Report" }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: "[Image: Tracker]" }),
    ).toHaveAttribute("href", "https://attacker.example/pixel.png");
    expect(container.querySelector("img")).toBeNull();
  });

  it("renders GFM tables without overflowing the column", () => {
    const { container } = render(
      <>{renderMarkdown("| A | B |\n| --- | --- |\n| 1 | 2 |")}</>,
    );

    expect(container.querySelector("table")).not.toBeNull();
    expect(container.querySelector(".overflow-x-auto")).not.toBeNull();
  });
});

describe("streaming code highlighting", () => {
  it("gives fenced code breathing room from surrounding prose", () => {
    const { container } = render(
      <MessageMarkdown
        text={"Before.\n\n```bash\nmake desktop-dev\n```\n\nAfter."}
        defer={false}
      />,
    );

    const codeBlock = container.querySelector('[data-markdown-block="code"]');
    expect(codeBlock).toHaveClass("my-8");
    expect(codeBlock?.previousElementSibling).toHaveTextContent("Before.");
    expect(codeBlock?.nextElementSibling).toHaveTextContent("After.");
  });

  it("removes outer margin when fenced code is the only block", () => {
    const { container } = render(
      <MessageMarkdown text={"```bash\nmake desktop-dev\n```"} defer={false} />,
    );

    const codeBlock = container.querySelector('[data-markdown-block="code"]');
    expect(codeBlock).toHaveClass("my-8", "first:mt-0", "last:mb-0");
  });

  it("keeps one shared rhythm between consecutive fenced code blocks", () => {
    const { container } = render(
      <MessageMarkdown
        text={"```bash\nmake desktop-dev\n```\n\n```bash\nnpm test\n```"}
        defer={false}
      />,
    );

    const codeBlocks = container.querySelectorAll(
      '[data-markdown-block="code"]',
    );
    expect(codeBlocks).toHaveLength(2);
    expect(codeBlocks[0]).toHaveClass("my-8", "first:mt-0");
    expect(codeBlocks[1]).toHaveClass("my-8", "last:mb-0");
  });

  it("keeps an unlabeled one-line fence as a copyable code block", () => {
    const { container } = render(
      <MessageMarkdown
        text={"Before.\n\n```\nnpm test\n```\n\nAfter."}
        defer={false}
      />,
    );

    expect(
      container.querySelector('[data-markdown-block="code"]'),
    ).not.toBeNull();
    expect(screen.getByRole("button", { name: "Copy" })).toBeVisible();
    expect(screen.getByText("npm test").closest("pre")).not.toBeNull();
  });

  it("preserves a distinct hierarchy for all six CommonMark heading levels", () => {
    render(
      <MessageMarkdown
        text={[
          "# Level one",
          "## Level two",
          "### Level three",
          "#### Level four",
          "##### Level five",
          "###### Level six",
        ].join("\n\n")}
        defer={false}
      />,
    );

    expect(screen.getByRole("heading", { level: 4 })).toHaveClass(
      "text-[1em]",
      "text-fg-primary",
    );
    // Below h4 the size ramp is exhausted, so the last two levels change voice
    // instead: a mono microlabel, one step apart in size and foreground.
    expect(screen.getByRole("heading", { level: 5 })).toHaveClass(
      "fd-type-microlabel",
      "fd-type-microlabel--md",
      "text-fg-tertiary",
    );
    expect(screen.getByRole("heading", { level: 6 })).toHaveClass(
      "fd-type-microlabel",
      "text-fg-muted",
    );
    expect(screen.getByRole("heading", { level: 6 })).not.toHaveClass(
      "fd-type-microlabel--md",
    );
  });

  it("gives headings more space above than below so sections read as breaks", () => {
    render(
      <MessageMarkdown
        text={"Intro.\n\n## Section\n\nBody."}
        defer={false}
      />,
    );

    expect(screen.getByRole("heading", { level: 2 })).toHaveClass(
      "mt-8",
      "mb-3",
    );
  });

  it("scopes rendered markdown so the prose measure and checkbox styling apply", () => {
    const { container } = render(
      <MessageMarkdown text={"- [x] Done\n- [ ] Pending"} defer={false} />,
    );

    const scope = container.querySelector(".fd-markdown");
    expect(scope).not.toBeNull();
    expect(scope?.querySelectorAll('input[type="checkbox"]')).toHaveLength(2);
  });

  it("keeps fenced code plain while streaming and enables highlighting when settled", () => {
    const markdown = "```tsx\nconst value = 1\n```";
    const view = render(<MessageMarkdown text={markdown} streaming />);

    expect(screen.getByText("const value = 1").closest("pre")).toHaveAttribute(
      "data-syntax-highlighting",
      "deferred",
    );

    view.rerender(<MessageMarkdown text={markdown} streaming={false} />);

    expect(screen.getByText("const value = 1").closest("pre")).toHaveAttribute(
      "data-syntax-highlighting",
      "enabled",
    );
  });

  it("renders settled mermaid fences as diagrams", async () => {
    render(
      <MessageMarkdown
        text={"```mermaid\nflowchart TD\n  A-->B\n```"}
        defer={false}
      />,
    );

    expect(
      await screen.findByRole("img", { name: "Mermaid diagram" }),
    ).toBeInTheDocument();
  });

  it("renders a closed mermaid fence while the message is still streaming", async () => {
    render(
      <MessageMarkdown
        text={"```mermaid\nflowchart TD\n  A-->B\n```"}
        defer={false}
        streaming
      />,
    );

    expect(
      await screen.findByRole("img", { name: "Mermaid diagram" }),
    ).toBeInTheDocument();
  });

  it("keeps a newly streamed fenced block empty until its first code token arrives", () => {
    const { container } = render(
      <MessageMarkdown text={"Before.\n\n```bash\n"} defer={false} streaming />,
    );

    const codeBlock = container.querySelector('[data-markdown-block="code"]');
    expect(codeBlock).not.toBeNull();
    expect(codeBlock).not.toHaveTextContent("undefined");
    expect(codeBlock?.querySelector("code")?.textContent).toBe("");
  });

  it.each([
    ["tsx", "const Card = ({ title }: { title: string }) => <h2>{title}</h2>"],
    ["cpp", "std::vector<int> values = {1, 2, 3};"],
    ["bash", "for file in *.tsx; do printf '%s\\n' \"$file\"; done"],
  ])(
    "tokenizes settled %s fences with the browser RegExp engine",
    async (language, code) => {
      const { container } = render(
        <MessageMarkdown
          text={`\`\`\`${language}\n${code}\n\`\`\``}
          defer={false}
          streaming={false}
        />,
      );

      await waitFor(() => {
        expect(container.querySelector("code span span[style]")).not.toBeNull();
      });
      expect(container.querySelector("code")?.textContent).toBe(code);
    },
  );

  it("never shows tokens from the previous fence while new highlighting loads", async () => {
    const view = render(
      <MessageMarkdown
        text={'```json\n{"status": "old-token-content"}\n```'}
        defer={false}
      />,
    );
    await waitFor(() => {
      expect(
        view.container.querySelector("code span span[style]"),
      ).not.toBeNull();
    });

    view.rerender(
      <MessageMarkdown
        text={"```python\nprint('new plain-text fallback')\n```"}
        defer={false}
      />,
    );

    expect(view.container.querySelector("code")?.textContent).toBe(
      "print('new plain-text fallback')",
    );
    expect(view.container.querySelector("code")).not.toHaveTextContent(
      "old-token-content",
    );
    await waitFor(() => {
      expect(
        view.container.querySelector("code span span[style]"),
      ).not.toBeNull();
    });
  });

  it("finishes highlighting after the Strict Mode effect restart", async () => {
    const { container } = render(
      <StrictMode>
        <MessageMarkdown
          text={"```typescript\nconst strict: boolean = true\n```"}
          defer={false}
        />
      </StrictMode>,
    );

    await waitFor(() => {
      expect(container.querySelector("code span span[style]")).not.toBeNull();
    });
    expect(container.querySelector("code")?.textContent).toBe(
      "const strict: boolean = true",
    );
  });
});

describe("streaming agent directives", () => {
  it("preserves reference definitions across completed streaming blocks", () => {
    render(
      <MessageMarkdown
        text={
          "Read [the docs][reference].\n\nStill streaming.\n\n[reference]: https://falcondeck.com/docs"
        }
        defer={false}
        streaming
      />,
    );

    expect(screen.getByRole("link", { name: "the docs" })).toHaveAttribute(
      "href",
      "https://falcondeck.com/docs",
    );
  });

  it("preserves reference definitions across directive boundaries", () => {
    render(
      <MessageMarkdown
        text={
          'Read [the docs][reference].\n::git-commit{commit="abc123"}\n\n[reference]: https://falcondeck.com/docs'
        }
        defer={false}
      />,
    );

    expect(screen.getByRole("link", { name: "the docs" })).toHaveAttribute(
      "href",
      "https://falcondeck.com/docs",
    );
    expect(screen.getByText("git commit")).toBeVisible();
  });

  it("does not harvest reference definitions from fenced code", () => {
    render(
      <MessageMarkdown
        text={
          '[the docs][reference]\n::git-commit{commit="abc123"}\n\n```text\n[reference]: https://attacker.example/docs\n```'
        }
        defer={false}
      />,
    );

    expect(
      screen.queryByRole("link", { name: "the docs" }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByText("[reference]: https://attacker.example/docs"),
    ).toBeVisible();
  });

  it("renders future actions and opaque provider fragments without raw syntax or data loss", () => {
    const view = render(
      <MessageMarkdown
        text={"Done.\n::future-action{state=ready provider-fragment}"}
        defer={false}
      />,
    );

    expect(view.container).toHaveTextContent("future action");
    expect(view.container).toHaveTextContent("ready");
    expect(view.container).toHaveTextContent("provider-fragment");
    expect(view.container).not.toHaveTextContent("::future-action");
  });

  it("does not flash an unfinished trailing directive but restores malformed terminal text", () => {
    const text = 'Saved.\n::git-commit{cwd="/Users/qa/falcondeck"';
    const view = render(
      <MessageMarkdown text={text} defer={false} streaming />,
    );

    expect(view.container).toHaveTextContent("Saved.");
    expect(view.container).not.toHaveTextContent("::git-commit");

    view.rerender(
      <MessageMarkdown text={text} defer={false} streaming={false} />,
    );
    expect(view.container).toHaveTextContent("::git-commit");
  });
});

describe("slash-command highlighting", () => {
  it("tints a user-typed command mention", () => {
    const view = render(
      <MessageMarkdown
        text={"Any usage evidence?\n\n/db-query"}
        defer={false}
        interpretDirectives={false}
        highlightCommands
      />,
    );

    const command = screen.getByText("/db-query");
    expect(command.tagName).toBe("SPAN");
    expect(command.className).toContain("text-accent");
    expect(view.container).toHaveTextContent("Any usage evidence?");
  });

  it("leaves path segments and mid-word slashes untinted", () => {
    const view = render(
      <MessageMarkdown
        text={"look at /api/provider and either/or in /Users/qa/notes.md"}
        defer={false}
        interpretDirectives={false}
        highlightCommands
      />,
    );

    expect(view.container.querySelector(".text-accent")).toBeNull();
    expect(view.container).toHaveTextContent(
      "look at /api/provider and either/or in /Users/qa/notes.md",
    );
  });

  it("keeps command mentions plain without the opt-in", () => {
    const view = render(<MessageMarkdown text={"Run /db-query"} defer={false} />);

    expect(view.container.querySelector(".text-accent")).toBeNull();
    expect(view.container).toHaveTextContent("Run /db-query");
  });
});

describe("local file paths", () => {
  const directory =
    "/Users/James/www/sites/lucidpic/storage/app/training-artifacts/dani-wan-t2v-poc-20260822/tailscale/v2/";

  it("leaves absolute paths inert when the host cannot open them", () => {
    render(
      <MessageMarkdown text={`Saved at \`${directory}\``} defer={false} />,
    );

    expect(screen.queryByRole("link", { name: `Open ${directory}` })).toBeNull();
    expect(screen.getByText(directory).tagName).toBe("CODE");
  });

  it("opens an inline-code path on click", () => {
    const onLocalPath = vi.fn();
    render(
      <LocalPathProvider onLocalPath={onLocalPath}>
        <MessageMarkdown text={`Saved at \`${directory}\``} defer={false} />
      </LocalPathProvider>,
    );

    fireEvent.click(screen.getByRole("link", { name: `Open ${directory}` }));
    expect(onLocalPath).toHaveBeenCalledWith("open", directory);
  });

  it("offers Finder actions from the path context menu", () => {
    const onLocalPath = vi.fn();
    render(
      <LocalPathProvider onLocalPath={onLocalPath}>
        <MessageMarkdown
          text={`Clips are in ${directory}kitchen.mp4`}
          defer={false}
        />
      </LocalPathProvider>,
    );

    fireEvent.contextMenu(
      screen.getByRole("link", { name: `Open ${directory}kitchen.mp4` }),
    );
    fireEvent.click(
      screen.getByRole("menuitem", {
        name: /Reveal in Finder|Show in Explorer|Show in folder/,
      }),
    );
    expect(onLocalPath).toHaveBeenCalledWith("reveal", `${directory}kitchen.mp4`);
  });

  it("copies the filesystem path from the context menu", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    render(
      <LocalPathProvider onLocalPath={vi.fn()}>
        <MessageMarkdown text={`\`${directory}\``} defer={false} />
      </LocalPathProvider>,
    );

    fireEvent.contextMenu(screen.getByRole("link", { name: `Open ${directory}` }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Copy Path" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(directory));
  });

  it("does not turn web routes into path links", () => {
    const onLocalPath = vi.fn();
    render(
      <LocalPathProvider onLocalPath={onLocalPath}>
        <MessageMarkdown text="See `/api/provider` and src/App.tsx" defer={false} />
      </LocalPathProvider>,
    );

    expect(screen.queryByRole("link")).toBeNull();
    expect(screen.getByText("/api/provider").tagName).toBe("CODE");
  });

  it("opens markdown file:// links locally", () => {
    const onLocalPath = vi.fn();
    render(
      <LocalPathProvider onLocalPath={onLocalPath}>
        <MessageMarkdown
          text="Open [the clip](file:///Users/James/clip.mp4)"
          defer={false}
        />
      </LocalPathProvider>,
    );

    fireEvent.click(screen.getByRole("link", { name: "Open /Users/James/clip.mp4" }));
    expect(onLocalPath).toHaveBeenCalledWith("open", "/Users/James/clip.mp4");
  });
});

describe("external link context menu", () => {
  it("offers open and copy actions for markdown links", async () => {
    const onOpenLink = vi.fn();
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    render(
      <WebLinkProvider onOpenLink={onOpenLink}>
        <MessageMarkdown
          text="See [the guide](https://example.com/guide) for details"
          defer={false}
        />
      </WebLinkProvider>,
    );

    fireEvent.contextMenu(screen.getByRole("link", { name: "the guide" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Open Link" }));
    expect(onOpenLink).toHaveBeenCalledWith("https://example.com/guide");

    fireEvent.contextMenu(screen.getByRole("link", { name: "the guide" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Copy Link" }));
    await waitFor(() =>
      expect(writeText).toHaveBeenCalledWith("https://example.com/guide"),
    );
  });

  it("keeps markdown links plain without a link host", () => {
    render(
      <MessageMarkdown
        text="See [the guide](https://example.com/guide) for details"
        defer={false}
      />,
    );

    const anchor = screen.getByRole("link", { name: "the guide" });
    expect(anchor.getAttribute("target")).toBe("_blank");
    fireEvent.contextMenu(anchor);
    expect(screen.queryByRole("menu")).toBeNull();
  });
});
