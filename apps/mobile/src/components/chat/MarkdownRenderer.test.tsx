import React from "react";
import { Linking, View } from "react-native";
import { act } from "react-test-renderer";
import { afterEach, describe, expect, it, vi } from "vitest";

import { cleanup, renderComponent, textOf } from "@/test/render";

import {
  buildMarkdownDefinitions,
  MarkdownRenderer,
  normalizeMarkdownForStreaming,
  renderMarkdownBlocks,
  splitMessageSegments,
} from "./MarkdownRenderer";
import { setMermaidAssetLoader } from "./mermaidEngine";

afterEach(() => {
  cleanup();
  setMermaidAssetLoader(null);
  vi.restoreAllMocks();
});

describe("normalizeMarkdownForStreaming", () => {
  it("closes a trailing inline link destination during streaming", () => {
    expect(normalizeMarkdownForStreaming("[OpenAI](https://openai.com")).toBe(
      "[OpenAI](https://openai.com)",
    );
  });

  it("leaves plain text, complete links, and empty destinations alone", () => {
    expect(normalizeMarkdownForStreaming("plain text")).toBe("plain text");
    expect(normalizeMarkdownForStreaming("](https://openai.com")).toBe(
      "](https://openai.com",
    );
    expect(normalizeMarkdownForStreaming("[OpenAI](https://openai.com)")).toBe(
      "[OpenAI](https://openai.com)",
    );
    expect(normalizeMarkdownForStreaming("[OpenAI](")).toBe("[OpenAI](");
    expect(normalizeMarkdownForStreaming("[OpenAI]( https://openai.com")).toBe(
      "[OpenAI]( https://openai.com",
    );
  });
});

describe("agent directives", () => {
  it("segments valid directives while preserving malformed protocol-like text", () => {
    expect(
      splitMessageSegments(
        [
          "Finished the release.",
          '::git-push{cwd="/Users/qa/falcondeck" branch=main}',
          "Still readable.",
          "::git-push{missing brace",
        ].join("\n"),
      ),
    ).toEqual([
      { kind: "markdown", text: "Finished the release." },
      {
        kind: "directive",
        name: "git-push",
        attrs: [
          ["cwd", "/Users/qa/falcondeck"],
          ["branch", "main"],
        ],
        unparsed: null,
      },
      { kind: "markdown", text: "Still readable.\n::git-push{missing brace" },
    ]);
  });
});

describe("buildMarkdownDefinitions", () => {
  it("collects markdown definitions keyed by identifier", () => {
    expect(
      buildMarkdownDefinitions({
        type: "root",
        children: [
          {
            type: "definition",
            identifier: "Docs",
            title: "Reference",
            url: "https://falcondeck.com/docs",
          },
        ],
      }),
    ).toEqual({
      docs: {
        title: "Reference",
        url: "https://falcondeck.com/docs",
      },
    });
  });
});

describe("MarkdownRenderer", () => {
  it("makes transcript content selectable without changing global labels", () => {
    const renderer = renderComponent(
      <MarkdownRenderer
        text={[
          "# Selectable heading",
          "",
          "Selectable paragraph with **rich text**.",
          "",
          "| Name | Value |",
          "| --- | --- |",
          "| FalconDeck | native |",
          "",
          "<kbd>raw content</kbd>",
          "",
          "[^1]: Selectable footnote",
        ].join("\n")}
      />,
    );

    const selectableText = renderer.root
      .findAllByType("Text" as any)
      .filter((node) => node.props.selectable === true);

    expect(selectableText.length).toBeGreaterThanOrEqual(8);
    expect(
      selectableText.every((node) => node.props.uiTextView === true),
    ).toBe(true);
    expect(textOf(renderer)).toContain("Selectable heading");
    expect(textOf(renderer)).toContain("Selectable paragraph with rich text.");
    expect(textOf(renderer)).toContain("FalconDecknative");
    expect(textOf(renderer)).toContain("Selectable footnote");
  });

  it("gives every cell in a table column the same explicit width", () => {
    const renderer = renderComponent(
      <MarkdownRenderer
        text={[
          "| Buyer type | Fit |",
          "| --- | --- |",
          "| Indie / operator | High |",
          "| Edtech strategic (Quizlet, Pearson, UWorld, etc.) | Medium |",
        ].join("\n")}
      />,
    );

    const cellWidths = renderer.root
      .findAllByType(View)
      .map((node) =>
        (Array.isArray(node.props.style) ? node.props.style : [])
          .filter(Boolean)
          .reduce(
            (width: number | undefined, style: { width?: number }) =>
              style?.width ?? width,
            undefined,
          ),
      )
      .filter((width): width is number => typeof width === "number");

    // 3 rows x 2 columns, laid out row by row.
    expect(cellWidths).toHaveLength(6);
    const [headerA, headerB] = cellWidths;
    for (let row = 1; row < 3; row += 1) {
      expect(cellWidths[row * 2]).toBe(headerA);
      expect(cellWidths[row * 2 + 1]).toBe(headerB);
    }
    // The long first column caps at the max width instead of forcing one
    // enormous column, and the short second column stays at the minimum.
    expect(headerA).toBe(248);
    expect(headerB).toBe(88);
  });

  it("gives fenced code extra breathing room from surrounding prose", () => {
    const renderer = renderComponent(
      <MarkdownRenderer
        text={"Before.\n\n```bash\nmake mobile-dev\n```\n\nAfter."}
      />,
    );

    const spacedCodeBlocks = renderer.root.findAll(
      (node) =>
        Array.isArray(node.props.style) &&
        node.props.style.some((style) => style?.marginVertical === 20),
    );
    expect(spacedCodeBlocks).toHaveLength(1);
    expect(textOf(renderer)).toContain("Before.");
    expect(textOf(renderer)).toContain("After.");
  });

  it("does not add outer margin when fenced code is the only block", () => {
    const renderer = renderComponent(
      <MarkdownRenderer text={"```bash\nmake mobile-dev\n```"} />,
    );

    const codeWrapper = renderer.root.find(
      (node) =>
        Array.isArray(node.props.style) &&
        node.props.style.some((style) => style?.marginVertical === 20),
    );
    const flattenedStyle = Object.assign(
      {},
      ...codeWrapper.props.style.filter(Boolean),
    );

    expect(flattenedStyle).toMatchObject({
      marginVertical: 20,
      marginTop: 0,
      marginBottom: 0,
    });
  });

  it("does not double both margins between consecutive fenced code blocks", () => {
    const renderer = renderComponent(
      <MarkdownRenderer
        text={"```bash\nmake mobile-dev\n```\n\n```bash\nnpm test\n```"}
      />,
    );

    const codeWrappers = renderer.root.findAll(
      (node) =>
        Array.isArray(node.props.style) &&
        node.props.style.some((style) => style?.marginVertical === 20),
    );
    expect(codeWrappers).toHaveLength(2);

    const firstStyle = Object.assign(
      {},
      ...codeWrappers[0]!.props.style.filter(Boolean),
    );
    const secondStyle = Object.assign(
      {},
      ...codeWrappers[1]!.props.style.filter(Boolean),
    );
    expect(firstStyle).toMatchObject({ marginVertical: 20, marginTop: 0 });
    expect(secondStyle).toMatchObject({
      marginVertical: 20,
      marginTop: 0,
      marginBottom: 0,
    });
  });

  it("preserves all six heading levels with token-derived native metrics", () => {
    const renderer = renderComponent(
      <MarkdownRenderer
        text={[
          "# Level one",
          "## Level two",
          "### Level three",
          "#### Level four",
          "##### Level five",
          "###### Level six",
        ].join("\n\n")}
      />,
    );

    const headingStyles = renderer.root
      .findAllByType("Text" as any)
      .filter(
        (node) =>
          node.props.selectable === true &&
          typeof node.props.children?.[0] === "string" &&
          node.props.children[0].startsWith("Level "),
      )
      .map((node) =>
        Object.assign({}, ...node.props.style.flat().filter(Boolean)),
      );

    expect(headingStyles).toHaveLength(6);
    // h1–h4 walk down the size ramp; h5/h6 change voice to a mono microlabel
    // because below h4 the ramp has nowhere left to go.
    expect(headingStyles.map((style) => style.fontSize)).toEqual([
      26, 22, 19, 17, 12, 10,
    ]);
    expect(headingStyles.map((style) => style.lineHeight)).toEqual([
      32.5, 27.5, 23.75, 21.25, 18, 15,
    ]);
    expect(headingStyles.slice(4).map((style) => style.textTransform)).toEqual([
      "uppercase",
      "uppercase",
    ]);
    expect(headingStyles.slice(4).map((style) => style.fontFamily)).toEqual([
      "Geist Mono",
      "Geist Mono",
    ]);
    // Every heading after the first opens with more space above than the 12px
    // block gap that closes it, so the break reads as a new section.
    expect(headingStyles.map((style) => style.marginTop)).toEqual([
      undefined,
      20,
      12,
      8,
      8,
      8,
    ]);
  });

  it("renders directives as accessible native activity annotations in message order", async () => {
    const openUrl = vi.spyOn(Linking, "openURL").mockResolvedValue(undefined);
    const renderer = renderComponent(
      <MarkdownRenderer
        text={[
          "Committed the change. See [docs][reference].",
          '::git-commit{cwd="/Users/qa/falcondeck" commit="abc123"}',
          "::future-action{state=ready provider-fragment}",
          "",
          "[reference]: https://falcondeck.com/docs",
        ].join("\n")}
      />,
    );

    const renderedText = textOf(renderer);
    expect(renderedText).toContain("Committed the change.");
    expect(renderedText).toContain("git commit");
    expect(renderedText).toContain("cwd: falcondeck · commit: abc123");
    expect(renderedText).toContain("future action");
    expect(renderedText).toContain("detail: provider-fragment");
    expect(renderedText).not.toContain("::git-commit");
    expect(
      renderer.root.findByProps({
        accessibilityLabel:
          "Agent action: git commit, cwd /Users/qa/falcondeck, commit abc123",
      }),
    ).toBeDefined();
    expect(
      renderer.root.findByProps({
        accessibilityLabel:
          "Agent action: future action, state ready, detail provider-fragment",
      }),
    ).toBeDefined();

    const docs = renderer.root.findAll(
      (node) => typeof node.props?.onPress === "function",
    );
    expect(docs.length).toBeGreaterThan(0);
    await act(async () => {
      docs[0].props.onPress();
      await Promise.resolve();
    });
    expect(openUrl).toHaveBeenCalledWith("https://falcondeck.com/docs");
  });

  it("does not flash an unfinished trailing directive while streaming", () => {
    const text = 'Saved.\n::git-commit{cwd="/Users/qa/falcondeck"';
    const streaming = renderComponent(
      <MarkdownRenderer text={text} streaming />,
    );
    const terminal = renderComponent(
      <MarkdownRenderer text={text} streaming={false} />,
    );

    expect(textOf(streaming)).toContain("Saved.");
    expect(textOf(streaming)).not.toContain("::git-commit");
    expect(textOf(terminal)).toContain("::git-commit");
  });

  it("keeps directives literal for untrusted provider markdown", () => {
    const renderer = renderComponent(
      <MarkdownRenderer
        text={
          'Provider evidence:\n\n::git-commit{cwd="/tmp/provider" commit="fake"}'
        }
        interpretDirectives={false}
      />,
    );

    expect(textOf(renderer)).toContain("::git-commit");
    expect(textOf(renderer)).not.toContain("cwd: provider");
  });

  it("renders rich markdown blocks and inline styles", () => {
    const renderer = renderComponent(
      <MarkdownRenderer
        text={[
          "# Heading",
          "## Section",
          "### Subsection",
          "#### Detail",
          "",
          "Paragraph with **strong**, *emphasis*, ~~strike~~, `inline`, [docs](https://falcondeck.com), [ref link][fd], [Missing][missing], ![direct](https://example.com/direct.png), ![logo][img], and a hard break  ",
          "next line with inline <kbd>cmd</kbd>.",
          "",
          "1. First step",
          "- Bullet",
          "- [x] Done",
          "- [ ] Pending",
          "",
          "> Quoted text",
          "",
          "---",
          "",
          "```ts",
          "const value = 1",
          "```",
          "",
          "| Name | Value |",
          "| --- | --- |",
          "| foo |",
          "",
          "<div>raw html</div>",
          "",
          "[^1]",
          "",
          "[fd]: https://falcondeck.com/docs",
          "[img]: https://example.com/logo.png",
          "[^1]: Footnote body",
        ].join("\n")}
      />,
    );

    const renderedText = textOf(renderer);
    expect(renderedText).toContain("Heading");
    expect(renderedText).toContain("Section");
    expect(renderedText).toContain("Subsection");
    expect(renderedText).toContain("Detail");
    expect(renderedText).toContain("strong");
    expect(renderedText).toContain("emphasis");
    expect(renderedText).toContain("strike");
    expect(renderedText).toContain("inline");
    expect(renderedText).toContain("docs");
    expect(renderedText).toContain("ref link");
    expect(renderedText).toContain("Missing");
    expect(renderedText).toContain("[Image: direct]");
    expect(renderedText).toContain("[Image: logo]");
    expect(renderedText).toContain("next line");
    expect(renderedText).toContain("First step");
    expect(renderedText).toContain("Bullet");
    expect(renderedText).toContain("Done");
    expect(renderedText).toContain("Pending");
    expect(renderedText).toContain("Quoted text");
    expect(renderedText).toContain("Copy");
    expect(renderedText).toContain("Name");
    expect(renderedText).toContain("foo");
    expect(renderedText).toContain("<div>raw html</div>");
    expect(renderedText).toContain("[1]");
    expect(renderedText).toContain("Footnote body");
  });

  it("renders streamed partial markdown cleanly", () => {
    const codeBlock = renderComponent(
      <MarkdownRenderer text={"```ts\nconst value = 1"} />,
    );
    const emptyCodeBlock = renderComponent(
      <MarkdownRenderer text={"Before.\n\n```bash\n"} />,
    );
    const partialLink = renderComponent(
      <MarkdownRenderer text={"Read [OpenAI](https://openai.com"} />,
    );

    expect(textOf(codeBlock)).toContain("Copy");
    expect(textOf(codeBlock)).toContain("const value = 1");
    expect(textOf(emptyCodeBlock)).toContain("Copy");
    expect(textOf(emptyCodeBlock)).not.toContain("undefined");
    expect(textOf(partialLink)).toContain("OpenAI");
    expect(textOf(partialLink)).not.toContain("[OpenAI](");
  });

  it("renders mermaid fences as diagrams when the message is settled", async () => {
    setMermaidAssetLoader(async () => "window.mermaid={}");
    const renderer = renderComponent(
      <MarkdownRenderer text={"```mermaid\nflowchart TD\n  A-->B\n```"} />,
    );
    await act(async () => {
      await Promise.resolve();
    });
    expect(textOf(renderer)).toContain("Source");
    expect(textOf(renderer)).not.toContain("flowchart TD");
  });

  it("renders a closed mermaid fence while streaming", async () => {
    setMermaidAssetLoader(async () => "window.mermaid={}");
    const renderer = renderComponent(
      <MarkdownRenderer
        streaming
        text={"```mermaid\nflowchart TD\n  A-->B\n```"}
      />,
    );
    await act(async () => {
      await Promise.resolve();
    });
    expect(textOf(renderer)).toContain("Source");
    expect(textOf(renderer)).not.toContain("flowchart TD");
  });

  it("opens only safe markdown links", async () => {
    const openUrl = vi.spyOn(Linking, "openURL").mockResolvedValue(undefined);
    const safe = renderComponent(
      <MarkdownRenderer
        text={[
          "[Safe](https://falcondeck.com)",
          "[Ref][docs]",
          "![Direct](https://example.com/direct.png)",
          "![Ref image][img]",
          "",
          "[docs]: https://falcondeck.com/docs",
          "[img]: https://example.com/ref.png",
        ].join("\n")}
      />,
    );
    const unsafe = renderComponent(
      <MarkdownRenderer text="[Unsafe](javascript:alert(1))" />,
    );

    await act(async () => {
      safe.root
        .findAll((node) => typeof node.props?.onPress === "function")
        .forEach((node) => node.props.onPress());
      await Promise.resolve();
    });

    expect(openUrl).toHaveBeenCalledWith("https://falcondeck.com");
    expect(openUrl).toHaveBeenCalledWith("https://falcondeck.com/docs");
    expect(openUrl).toHaveBeenCalledWith("https://example.com/direct.png");
    expect(openUrl).toHaveBeenCalledWith("https://example.com/ref.png");
    expect(
      unsafe.root.findAll((node) => typeof node.props?.onPress === "function"),
    ).toHaveLength(0);
  });

  it("keeps credential-bearing HTTP links inert", () => {
    const renderer = renderComponent(
      <MarkdownRenderer text="[Report](https://user:secret@example.com/report)" />,
    );

    expect(textOf(renderer)).toContain("Report");
    expect(
      renderer.root.findAll(
        (node) =>
          node.props.accessibilityRole === "link" &&
          node.props.accessibilityLabel?.includes("user:secret"),
      ),
    ).toHaveLength(0);
  });

  it("keeps mail and phone image placeholders inert", () => {
    const renderer = renderComponent(
      <MarkdownRenderer
        text={"![Call](tel:+44123456789)\n\n![Mail](mailto:test@example.com)"}
      />,
    );

    expect(textOf(renderer)).toContain("[Image: Call]");
    expect(textOf(renderer)).toContain("[Image: Mail]");
    expect(
      renderer.root.findAll((node) =>
        node.props.accessibilityLabel?.startsWith("Open linked image:"),
      ),
    ).toHaveLength(0);
  });

  it("keeps a failed markdown handoff visible and retryable", async () => {
    const openUrl = vi
      .spyOn(Linking, "openURL")
      .mockRejectedValueOnce(new Error("No handler available"))
      .mockResolvedValue(undefined);
    const renderer = renderComponent(
      <MarkdownRenderer text="Read [the docs](https://falcondeck.com/docs)." />,
    );
    const link = renderer.root.find(
      (node) =>
        node.props.accessibilityLabel ===
          "Open link: https://falcondeck.com/docs" &&
        typeof node.props.onPress === "function",
    );

    await act(async () => {
      await link.props.onPress();
    });
    expect(textOf(renderer)).toContain("Could not open. Tap to retry.");
    expect(link.props.accessibilityHint).toBe(
      "Retries opening this link outside FalconDeck",
    );
    expect(link.props.accessibilityLiveRegion).toBe("polite");
    expect(link.props.accessibilityLabel).toBe(
      "Open link: https://falcondeck.com/docs. Could not open. Tap to retry.",
    );

    await act(async () => {
      await link.props.onPress();
    });
    expect(openUrl).toHaveBeenCalledTimes(2);
    expect(textOf(renderer)).not.toContain("Could not open. Tap to retry.");
    expect(link.props.accessibilityLiveRegion).toBe("none");
  });

  it("falls back for unsupported block and inline nodes", () => {
    const renderer = renderComponent(
      <View>
        {renderMarkdownBlocks(undefined, {})}
        {renderMarkdownBlocks(
          [
            { type: "code" },
            {
              type: "paragraph",
              children: [
                { type: "inlineCode" },
                { type: "text", value: " " },
                { type: "link", url: "https://example.com" },
                { type: "text", value: " " },
                {
                  type: "linkReference",
                  children: [{ type: "text", value: "No identifier" }],
                },
                { type: "text", value: " " },
                { type: "linkReference", label: "Label fallback" },
                { type: "text", value: " " },
                { type: "linkReference", identifier: "idOnly" },
              ],
            },
            {
              type: "list",
              ordered: true,
              start: null,
              children: [
                {
                  type: "listItem",
                  children: [
                    {
                      type: "paragraph",
                      children: [{ type: "text", value: "Ordered fallback" }],
                    },
                  ],
                },
              ],
            },
            {
              type: "footnoteDefinition",
              identifier: "custom",
              children: [
                {
                  type: "paragraph",
                  children: [{ type: "text", value: "Identifier footnote" }],
                },
              ],
            },
            {
              type: "footnoteDefinition",
              children: [
                {
                  type: "paragraph",
                  children: [{ type: "text", value: "Anonymous footnote" }],
                },
              ],
            },
            {
              type: "table",
              children: [{ type: "tableRow" }],
            },
            { type: "table" },
            { type: "html" },
            { type: "list" },
            { type: "mysteryValue", value: "Raw fallback value" },
            {
              type: "mysteryBlock",
              children: [
                {
                  type: "paragraph",
                  children: [
                    {
                      type: "mysteryInline",
                      children: [{ type: "text", value: "Fallback text" }],
                    },
                  ],
                },
              ],
            },
          ],
          {},
        )}
        {renderMarkdownBlocks(
          [
            {
              type: "paragraph",
              children: [
                { type: "link" },
                { type: "text", value: " " },
                { type: "linkReference" },
                { type: "text", value: " " },
                { type: "imageReference", identifier: "imgOnly" },
                { type: "text", value: " " },
                { type: "imageReference" },
              ],
            },
          ],
          {
            imgonly: { url: "https://example.com/only.png" },
          },
        )}
      </View>,
    );

    expect(textOf(renderer)).toContain("No identifier");
    expect(textOf(renderer)).toContain("https://example.com");
    expect(textOf(renderer)).toContain("Label fallback");
    expect(textOf(renderer)).toContain("idOnly");
    expect(textOf(renderer)).toContain("Ordered fallback");
    expect(textOf(renderer)).toContain("[custom]");
    expect(textOf(renderer)).toContain("[]");
    expect(textOf(renderer)).toContain("Identifier footnote");
    expect(textOf(renderer)).toContain("Anonymous footnote");
    expect(textOf(renderer)).toContain("Copy");
    expect(textOf(renderer)).toContain("Raw fallback value");
    expect(textOf(renderer)).toContain("Fallback text");
    expect(textOf(renderer)).toContain("https://example.com/only.png");
  });
});

describe("streaming parse throttling", () => {
  it(
    "coalesces rapid stream deltas into a trailing parse and never leaves" +
      " the settled message stale",
    () => {
      vi.useFakeTimers();
      try {
        const renderer = renderComponent(
          <MarkdownRenderer text={"alpha paragraph"} streaming />,
        );
        expect(textOf(renderer)).toContain("alpha paragraph");

        // Two more deltas land immediately inside the 120ms window.
        act(() => {
          renderer.update(
            <MarkdownRenderer
              text={"alpha paragraph\n\nbeta paragraph"}
              streaming
            />,
          );
        });
        act(() => {
          renderer.update(
            <MarkdownRenderer
              text={"alpha paragraph\n\nbeta paragraph\ngamma"}
              streaming
            />,
          );
        });
        // Coalesced: intermediate content is not parsed mid-burst.
        expect(textOf(renderer)).not.toContain("beta paragraph");
        expect(textOf(renderer)).not.toContain("gamma");

        // The always-scheduled trailing parse picks up the settled text.
        act(() => {
          vi.advanceTimersByTime(130);
        });
        expect(textOf(renderer)).toContain("beta paragraph");
        expect(textOf(renderer)).toContain("gamma");

        // Outside the throttle window, the next delta paints immediately —
        // the streaming tail stays prompt after each tick.
        act(() => {
          vi.advanceTimersByTime(130);
        });
        act(() => {
          renderer.update(
            <MarkdownRenderer
              text={
                "alpha paragraph\n\nbeta paragraph\ngamma\ndelta paragraph"
              }
              streaming
            />,
          );
        });
        expect(textOf(renderer)).toContain("delta paragraph");
      } finally {
        vi.useRealTimers();
      }
    },
  );
});

describe("slash-command highlighting", () => {
  const accentTexts = (renderer: ReturnType<typeof renderComponent>) =>
    renderer.root.findAll(
      (node) => typeof node.type !== "string" && node.props.color === "accent",
    );

  it("tints a user-typed command mention in the accent colour", () => {
    const renderer = renderComponent(
      <MarkdownRenderer
        text={"Any usage evidence?\n\n/db-query"}
        interpretDirectives={false}
        highlightCommands
      />,
    );

    const commands = accentTexts(renderer);
    expect(commands).toHaveLength(1);
    expect(textOf(renderer)).toContain("/db-query");
    expect(textOf(renderer)).toContain("Any usage evidence?");
  });

  it("leaves path segments untinted and requires the opt-in", () => {
    const paths = renderComponent(
      <MarkdownRenderer
        text={"look at /api/provider and either/or"}
        interpretDirectives={false}
        highlightCommands
      />,
    );
    expect(accentTexts(paths)).toHaveLength(0);
    expect(textOf(paths)).toContain("look at /api/provider and either/or");

    const optOut = renderComponent(
      <MarkdownRenderer text={"Run /db-query"} interpretDirectives={false} />,
    );
    expect(accentTexts(optOut)).toHaveLength(0);
  });
});
