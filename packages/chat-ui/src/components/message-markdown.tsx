import { Fragment, memo, useDeferredValue, useMemo, useRef } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import { unified } from "unified";
import { GitCommitHorizontal, Terminal, Upload } from "lucide-react";

import {
  agentDirectiveLabel,
  safeExternalUrl,
  splitAgentMessageSegments,
  type AgentDirectiveAttribute,
} from "@falcondeck/client-core";

import { CodeBlock } from "./code-block";

const remarkPlugins = [remarkGfm];
const markdownProcessor = unified().use(remarkParse).use(remarkGfm);

type MarkdownDefinitionNode = {
  type: string;
  identifier?: string;
  url?: string;
  title?: string | null;
};

function markdownDefinitionFooter(text: string) {
  const root = markdownProcessor.parse(text) as {
    children: MarkdownDefinitionNode[];
  };
  return root.children
    .filter(
      (node) =>
        node.type === "definition" &&
        Boolean(node.identifier) &&
        Boolean(node.url),
    )
    .map((node) => {
      const title = node.title?.replace(/[\r\n]+/g, " ").replace(/"/g, '\\"');
      return `[${node.identifier}]: ${node.url}${title ? ` "${title}"` : ""}`;
    })
    .join("\n");
}

type StreamingMarkdownBlocks = {
  completed: string[];
  tail: string;
};

/**
 * Splits streamed Markdown only at blank lines outside fenced code blocks.
 * The scan is intentionally cheaper than parsing a Markdown AST: completed
 * blocks can then keep stable React props while only the growing tail parses
 * again for each streamed update.
 */
export function splitStreamingMarkdownBlocks(
  text: string,
): StreamingMarkdownBlocks {
  const completed: string[] = [];
  let blockStart = 0;
  let cursor = 0;
  let fence: { marker: "`" | "~"; length: number } | null = null;

  while (cursor < text.length) {
    const newline = text.indexOf("\n", cursor);
    const lineEnd = newline === -1 ? text.length : newline;
    const nextLine = newline === -1 ? text.length : newline + 1;
    const line = text.slice(cursor, lineEnd).replace(/\r$/, "");

    if (fence) {
      const closingFence = new RegExp(
        `^ {0,3}\\${fence.marker}{${fence.length},}[\\t ]*$`,
      );
      if (closingFence.test(line)) fence = null;
    } else {
      const openingFence = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
      if (openingFence) {
        const marker = openingFence[1][0] as "`" | "~";
        // Backtick fence info strings cannot themselves contain backticks.
        if (marker === "~" || !openingFence[2].includes("`")) {
          fence = { marker, length: openingFence[1].length };
        }
      } else if (line.trim().length === 0) {
        const block = text.slice(blockStart, nextLine);
        if (block.trim()) completed.push(block);
        blockStart = nextLine;
      }
    }

    cursor = nextLine;
  }

  return { completed, tail: text.slice(blockStart) };
}

/**
 * Close a half-streamed markdown link so incomplete tokens like
 * `[label](https://example.com` still render as a clickable link while the
 * model is mid-token. Mirrors the mobile MarkdownRenderer behaviour.
 */
export function normalizeMarkdownForStreaming(text: string): string {
  const normalized = text.replace(/\r\n?/g, "\n");
  const linkOpenerIndex = normalized.lastIndexOf("](");

  if (linkOpenerIndex === -1 || normalized.includes(")", linkOpenerIndex + 2)) {
    return normalized;
  }

  const labelStartIndex = normalized.lastIndexOf("[", linkOpenerIndex);
  const destination = normalized.slice(linkOpenerIndex + 2);

  if (
    labelStartIndex === -1 ||
    destination.length === 0 ||
    /^\s/.test(destination)
  ) {
    return normalized;
  }

  return `${normalized})`;
}

const linkClassName =
  "[overflow-wrap:anywhere] text-accent underline decoration-accent/40 underline-offset-2 hover:decoration-accent";

function hasControlOrWhitespace(value: string) {
  return Array.from(value).some((character) => {
    const code = character.charCodeAt(0);
    return code <= 0x20 || code === 0x7f;
  });
}

function safeMarkdownLinkUrl(url: string | undefined) {
  const normalized = url?.trim() ?? "";
  if (/^https?:/i.test(normalized)) return safeExternalUrl(normalized);
  if (/^(?:mailto|tel):/i.test(normalized)) {
    return hasControlOrWhitespace(normalized) ? null : normalized;
  }
  return null;
}

function markdownCodeComponent(highlight: boolean) {
  return function MarkdownCode(props: {
    children?: React.ReactNode;
    className?: string;
  }) {
    const { children, className } = props;
    const match = /language-(\w+)/.exec(className ?? "");
    // A streamed fence can have a language header before its first content
    // token. react-markdown represents that legitimate empty body with no
    // children; coercing it directly would expose the word "undefined" in the
    // transcript until the next delta arrives.
    const rawCode = children == null ? "" : String(children);
    // react-markdown retains a trailing newline for fenced blocks, including
    // an unlabeled fence containing only one line. Inline code never has it.
    const isBlock = Boolean(match) || rawCode.includes("\n");
    const code = rawCode.replace(/\n$/, "");
    if (isBlock) {
      return (
        <CodeBlock
          code={code}
          language={match?.[1] ?? null}
          highlight={highlight}
        />
      );
    }
    return (
      <code className="break-all rounded-[var(--fd-radius-sm)] bg-surface-4 px-1.5 py-0.5 font-mono text-[0.9em]">
        {children}
      </code>
    );
  };
}

const markdownComponents = {
  code: markdownCodeComponent(true),
  pre({ children }: { children?: React.ReactNode }) {
    return (
      <div data-markdown-block="code" className="my-8 first:mt-0 last:mb-0">
        {children}
      </div>
    );
  },
  p({ children }: { children?: React.ReactNode }) {
    return <p className="mb-3 last:mb-0 leading-relaxed">{children}</p>;
  },
  ul({ children }: { children?: React.ReactNode }) {
    return (
      <ul className="mb-3 list-disc space-y-1 pl-5 last:mb-0">{children}</ul>
    );
  },
  ol({ children }: { children?: React.ReactNode }) {
    return (
      <ol className="mb-3 list-decimal space-y-1 pl-5 last:mb-0">{children}</ol>
    );
  },
  li({ children }: { children?: React.ReactNode }) {
    return <li className="leading-relaxed">{children}</li>;
  },
  h1({ children }: { children?: React.ReactNode }) {
    return (
      <h1 className="mb-3 mt-5 first:mt-0 text-[1.4em] font-semibold text-fg-primary">
        {children}
      </h1>
    );
  },
  h2({ children }: { children?: React.ReactNode }) {
    return (
      <h2 className="mb-2 mt-4 first:mt-0 text-[1.2em] font-semibold text-fg-primary">
        {children}
      </h2>
    );
  },
  h3({ children }: { children?: React.ReactNode }) {
    return (
      <h3 className="mb-2 mt-3 first:mt-0 text-[1.1em] font-semibold text-fg-primary">
        {children}
      </h3>
    );
  },
  h4({ children }: { children?: React.ReactNode }) {
    return (
      <h4 className="mb-2 mt-3 first:mt-0 text-[1em] font-semibold text-fg-primary">
        {children}
      </h4>
    );
  },
  h5({ children }: { children?: React.ReactNode }) {
    return (
      <h5 className="mb-2 mt-3 first:mt-0 text-[0.95em] font-semibold text-fg-secondary">
        {children}
      </h5>
    );
  },
  h6({ children }: { children?: React.ReactNode }) {
    return (
      <h6 className="mb-2 mt-3 first:mt-0 text-[0.9em] font-semibold text-fg-secondary">
        {children}
      </h6>
    );
  },
  blockquote({ children }: { children?: React.ReactNode }) {
    return (
      <blockquote className="mb-3 border-l-2 border-border-emphasis pl-4 text-fg-secondary italic last:mb-0">
        {children}
      </blockquote>
    );
  },
  strong({ children }: { children?: React.ReactNode }) {
    return (
      <strong className="font-semibold text-fg-primary">{children}</strong>
    );
  },
  a({ href, children }: { href?: string; children?: React.ReactNode }) {
    // react-markdown's defaultUrlTransform already strips javascript: etc.
    // Empty href means the URL was rejected — render plain text, not a dead link.
    // Desktop installs a capture-phase click handler that opens safe absolute
    // URLs in the system browser (Tauri/WKWebView ignores target="_blank").
    // Remote web relies on target="_blank" + rel for a real browser tab.
    // [overflow-wrap:anywhere] lets bare URLs break mid-token instead of
    // stretching the message bubble past the column edge.
    const safeHref = safeMarkdownLinkUrl(href);
    if (!safeHref) {
      return <span className="[overflow-wrap:anywhere]">{children}</span>;
    }
    return (
      <a
        href={safeHref}
        className={linkClassName}
        target="_blank"
        rel="noopener noreferrer"
      >
        {children}
      </a>
    );
  },
  img({ src, alt }: { src?: string; alt?: string }) {
    const externalUrl = safeExternalUrl(src);
    const label = alt?.trim() ? `Image: ${alt.trim()}` : "Linked image";
    if (!externalUrl)
      return <span className="text-fg-secondary">[{label}]</span>;
    // Markdown may be provider-authored. Keep remote images inert until the
    // user explicitly chooses the external handoff; typed image outputs own
    // in-app loading and preview behavior.
    return (
      <a
        href={externalUrl}
        className={linkClassName}
        target="_blank"
        rel="noopener noreferrer"
      >
        [{label}]
      </a>
    );
  },
  table({ children }: { children?: React.ReactNode }) {
    return (
      <div className="mb-3 max-w-full overflow-x-auto last:mb-0">
        <table className="w-full min-w-48 border-collapse text-[length:var(--fd-text-sm)]">
          {children}
        </table>
      </div>
    );
  },
  thead({ children }: { children?: React.ReactNode }) {
    return (
      <thead className="border-b border-border-subtle text-left text-fg-secondary">
        {children}
      </thead>
    );
  },
  th({ children }: { children?: React.ReactNode }) {
    return (
      <th className="px-2 py-1.5 text-left font-medium align-top">
        {children}
      </th>
    );
  },
  td({ children }: { children?: React.ReactNode }) {
    return (
      <td className="border-t border-border-subtle px-2 py-1.5 align-top text-fg-primary">
        {children}
      </td>
    );
  },
  tr({ children }: { children?: React.ReactNode }) {
    return <tr>{children}</tr>;
  },
  hr() {
    return <hr className="my-4 border-border-subtle" />;
  },
} as const;

const streamingMarkdownComponents = {
  ...markdownComponents,
  code: markdownCodeComponent(false),
} as const;

export function renderMarkdown(text: string, highlightCode = true) {
  return (
    <ReactMarkdown
      remarkPlugins={remarkPlugins}
      components={
        highlightCode ? markdownComponents : streamingMarkdownComponents
      }
    >
      {normalizeMarkdownForStreaming(text)}
    </ReactMarkdown>
  );
}

/* --- Inline agent directives ---------------------------------------- */
/* Codex emits machine-readable action markers like
   `::git-push{cwd="/path" branch="master"}` on their own lines. Render
   them as compact chips instead of leaking raw syntax into the chat. */

const DIRECTIVE_ICONS: Record<string, typeof Terminal> = {
  "git-commit": GitCommitHorizontal,
  "git-push": Upload,
};

function directiveAttrLabel(key: string, value: string) {
  // Paths compress to their basename; the full value stays in the tooltip.
  if (key === "cwd" || key === "path")
    return value.split("/").filter(Boolean).pop() ?? value;
  return value;
}

function DirectiveChip({
  name,
  attrs,
  unparsed,
}: {
  name: string;
  attrs: AgentDirectiveAttribute[];
  unparsed: string | null;
}) {
  const Icon = DIRECTIVE_ICONS[name] ?? Terminal;
  // Styled like the compact tool rows (bare icon + muted mono text) so it
  // reads as an activity annotation, not a pressable button.
  return (
    <div className="my-1.5 flex max-w-full items-center gap-2 px-1 text-fg-muted">
      <Icon aria-hidden="true" className="h-3.5 w-3.5 shrink-0" />
      <span className="shrink-0 text-[length:var(--fd-text-xs)] font-medium">
        {agentDirectiveLabel(name)}
      </span>
      {attrs.map(([key, value], index) => (
        <span
          key={`${key}-${index}`}
          title={`${key}=${value}`}
          className="max-w-56 truncate font-mono text-[length:var(--fd-text-xs)] text-fg-faint"
        >
          {directiveAttrLabel(key, value)}
        </span>
      ))}
      {unparsed ? (
        <span
          title={`detail=${unparsed}`}
          className="max-w-56 truncate font-mono text-[length:var(--fd-text-xs)] text-fg-faint"
        >
          {unparsed}
        </span>
      ) : null}
    </div>
  );
}

const StreamingMarkdownBlock = memo(function StreamingMarkdownBlock({
  text,
  definitionFooter,
}: {
  text: string;
  definitionFooter: string;
}) {
  return renderMarkdown(
    definitionFooter ? `${text}\n\n${definitionFooter}` : text,
    false,
  );
});

type StreamingContentSegment =
  | {
      kind: "markdown";
      blocks: Array<{ text: string; complete: boolean; key: string }>;
      key: string;
    }
  | {
      kind: "directive";
      name: string;
      attrs: AgentDirectiveAttribute[];
      unparsed: string | null;
      key: string;
    };

function streamingContentSegments(
  text: string,
  interpretDirectives: boolean,
): StreamingContentSegment[] {
  const sourceSegments = interpretDirectives
    ? splitAgentMessageSegments(text, true)
    : ([{ kind: "markdown", text }] as const);
  const result: StreamingContentSegment[] = [];

  sourceSegments.forEach((segment, segmentIndex) => {
    if (segment.kind === "directive") {
      result.push({ ...segment, key: `directive-${segmentIndex}` });
      return;
    }

    const blocks = splitStreamingMarkdownBlocks(segment.text);
    const renderedBlocks = blocks.completed.map((block, blockIndex) => ({
      text: block,
      complete: true,
      key: `markdown-${segmentIndex}-${blockIndex}`,
    }));
    if (blocks.tail.trim()) {
      renderedBlocks.push({
        text: blocks.tail,
        // A directive closes the Markdown segment before it, so that segment
        // can no longer grow during an append-only stream.
        complete: segmentIndex < sourceSegments.length - 1,
        key: `markdown-${segmentIndex}-tail`,
      });
    }
    if (renderedBlocks.length > 0) {
      result.push({
        kind: "markdown",
        blocks: renderedBlocks,
        key: `markdown-${segmentIndex}`,
      });
    }
  });

  return result;
}

function StreamingMessageContent({
  text,
  interpretDirectives,
}: {
  text: string;
  interpretDirectives: boolean;
}) {
  const segments = useMemo(
    () => streamingContentSegments(text, interpretDirectives),
    [interpretDirectives, text],
  );
  const completedDefinitionCache = useRef<
    Map<string, { text: string; footer: string }>
  >(new Map());

  const definitionFooter = useMemo(() => {
    // Reference definitions are uncommon. Avoid a second parser entirely for
    // the normal streaming path while preserving references across blocks and
    // directive boundaries when definitions are present.
    if (!text.includes("]:")) return "";

    const definitions: string[] = [];
    const liveKeys = new Set<string>();
    for (const segment of segments) {
      if (segment.kind !== "markdown") continue;
      for (const block of segment.blocks) {
        if (!block.text.includes("]:")) continue;

        let footer: string;
        if (block.complete) {
          liveKeys.add(block.key);
          const cached = completedDefinitionCache.current.get(block.key);
          if (cached?.text === block.text) {
            footer = cached.footer;
          } else {
            footer = markdownDefinitionFooter(block.text);
            completedDefinitionCache.current.set(block.key, {
              text: block.text,
              footer,
            });
          }
        } else {
          footer = markdownDefinitionFooter(block.text);
        }
        if (footer) definitions.push(footer);
      }
    }

    for (const key of completedDefinitionCache.current.keys()) {
      if (!liveKeys.has(key)) completedDefinitionCache.current.delete(key);
    }
    return definitions.join("\n");
  }, [segments, text]);
  const hasDirectives = segments.some(
    (segment) => segment.kind === "directive",
  );

  return (
    <>
      {segments.map((segment) =>
        segment.kind === "markdown" ? (
          // Keep the wrapper that directive-bearing messages historically use
          // so first/last block spacing remains unchanged.
          hasDirectives ? (
            <div key={segment.key}>
              {segment.blocks.map((block) => (
                <StreamingMarkdownBlock
                  key={block.key}
                  text={block.text}
                  definitionFooter={definitionFooter}
                />
              ))}
            </div>
          ) : (
            <Fragment key={segment.key}>
              {segment.blocks.map((block) => (
                <StreamingMarkdownBlock
                  key={block.key}
                  text={block.text}
                  definitionFooter={definitionFooter}
                />
              ))}
            </Fragment>
          )
        ) : (
          <DirectiveChip
            key={segment.key}
            name={segment.name}
            attrs={segment.attrs}
            unparsed={segment.unparsed}
          />
        ),
      )}
    </>
  );
}

export function renderMessageContent(
  text: string,
  highlightCode = true,
  streaming = false,
) {
  const segments = splitAgentMessageSegments(text, streaming);
  if (segments.length === 1 && segments[0].kind === "markdown") {
    return renderMarkdown(segments[0].text, highlightCode);
  }
  const definitionFooter = markdownDefinitionFooter(text);
  return (
    <>
      {segments.map((segment, index) =>
        segment.kind === "markdown" ? (
          <div key={index}>
            {renderMarkdown(
              definitionFooter
                ? `${segment.text}\n\n${definitionFooter}`
                : segment.text,
              highlightCode,
            )}
          </div>
        ) : (
          <DirectiveChip
            key={index}
            name={segment.name}
            attrs={segment.attrs}
            unparsed={segment.unparsed}
          />
        ),
      )}
    </>
  );
}

/**
 * Keeps token-by-token Markdown parsing out of React's urgent input lane. The
 * content remains complete and ordered, but a burst may coalesce into fewer
 * parses while typing, scrolling, and selection stay responsive.
 */
export const MessageMarkdown = memo(function MessageMarkdown({
  text,
  defer = true,
  streaming = false,
  interpretDirectives = true,
}: {
  text: string;
  defer?: boolean;
  /** Keep streamed code plain until its containing message is stable. */
  streaming?: boolean;
  /** Only trusted agent messages may turn machine directives into annotations. */
  interpretDirectives?: boolean;
}) {
  const deferredText = useDeferredValue(text);
  const visibleText = defer ? deferredText : text;
  return useMemo(() => {
    if (streaming) {
      return (
        <StreamingMessageContent
          text={visibleText}
          interpretDirectives={interpretDirectives}
        />
      );
    }
    return interpretDirectives
      ? renderMessageContent(visibleText, true, false)
      : renderMarkdown(visibleText, true);
  }, [interpretDirectives, streaming, visibleText]);
});
