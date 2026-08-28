import {
  Fragment,
  memo,
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { ScrollView, View } from "react-native";
import { Check, GitCommitHorizontal, Split, Terminal, Upload } from "lucide-react-native";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import { unified } from "unified";

import {
  agentDirectiveLabel,
  isMermaidLanguage,
  safeExternalUrl,
  splitAgentMessageSegments,
  splitSlashCommandSegments,
  stripAgentDirectiveLines,
  type AgentDirectiveAttribute,
} from "@falcondeck/client-core";

import { Text } from "@/components/ui";
import { CodeBlock } from "./CodeBlock";
import { MermaidBlock } from "./MermaidBlock";
import { useExternalUrl } from "./useExternalUrl";

interface MarkdownRendererProps {
  text: string;
  /** Suppresses only an unfinished trailing machine directive. */
  streaming?: boolean;
  /** Only trusted agent messages may turn machine directives into annotations. */
  interpretDirectives?: boolean;
  /** Tint slash-command mentions; only user-authored messages opt in. */
  highlightCommands?: boolean;
}

type MarkdownNode = {
  type: string;
  alt?: string | null;
  checked?: boolean | null;
  children?: MarkdownNode[];
  depth?: number;
  identifier?: string;
  label?: string | null;
  lang?: string | null;
  ordered?: boolean;
  start?: number | null;
  title?: string | null;
  url?: string;
  value?: string;
};

type MarkdownRoot = {
  type: "root";
  children: MarkdownNode[];
};

type MarkdownDefinitions = Record<
  string,
  { title?: string | null; url: string }
>;

const markdownProcessor = unified().use(remarkParse).use(remarkGfm);

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

export const splitMessageSegments = splitAgentMessageSegments;
export const stripDirectiveLines = stripAgentDirectiveLines;

function parseMarkdown(text: string): MarkdownRoot {
  return markdownProcessor.parse(
    normalizeMarkdownForStreaming(text),
  ) as MarkdownRoot;
}

function markdownDefinitionFooter(root: MarkdownRoot) {
  return root.children
    .filter(
      (node): node is MarkdownNode & { identifier: string; url: string } =>
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

const DIRECTIVE_ICONS = {
  "git-commit": GitCommitHorizontal,
  "git-push": Upload,
  breakout: Split,
} as const;

function directiveAttrValue(key: string, value: string) {
  if (key === "cwd" || key === "path") {
    return value.split("/").filter(Boolean).at(-1) ?? value;
  }
  return value;
}

function DirectiveAnnotation({
  name,
  attrs,
  unparsed,
}: {
  name: string;
  attrs: AgentDirectiveAttribute[];
  unparsed: string | null;
}) {
  const { theme } = useUnistyles();
  const Icon =
    DIRECTIVE_ICONS[name as keyof typeof DIRECTIVE_ICONS] ?? Terminal;
  const tone =
    name === "git-push"
      ? theme.colors.info.default
      : name === "git-commit" || name === "breakout"
        ? theme.colors.accent.default
        : theme.colors.fg.muted;
  const label = agentDirectiveLabel(name);
  const visibleAttrs = [
    ...attrs.map(([key, value]) => `${key}: ${directiveAttrValue(key, value)}`),
    ...(unparsed ? [`detail: ${unparsed}`] : []),
  ].join(" · ");
  const accessibilityDetail = [
    ...attrs.map(([key, value]) => `${key} ${value}`),
    ...(unparsed ? [`detail ${unparsed}`] : []),
  ].join(", ");

  return (
    <View
      accessible
      accessibilityRole="text"
      accessibilityLabel={`Agent action: ${label}${accessibilityDetail ? `, ${accessibilityDetail}` : ""}`}
      style={styles.directive}
    >
      <Icon
        accessible={false}
        size={theme.iconSize.xs}
        color={tone}
      />
      <Text variant="label" size="xs" color="muted" weight="medium" style={{ color: tone }}>
        {label}
      </Text>
      {visibleAttrs ? (
        <Text
          variant="mono"
          size="xs"
          color="muted"
          numberOfLines={1}
          style={styles.directiveAttrs}
        >
          {visibleAttrs}
        </Text>
      ) : null}
    </View>
  );
}

export function buildMarkdownDefinitions(
  root: MarkdownRoot,
): MarkdownDefinitions {
  return root.children.reduce<MarkdownDefinitions>((definitions, node) => {
    if (node.type === "definition" && node.identifier && node.url) {
      definitions[node.identifier.toLowerCase()] = {
        title: node.title ?? null,
        url: node.url,
      };
    }

    return definitions;
  }, {});
}

function resolveMarkdownDefinition(
  definitions: MarkdownDefinitions,
  identifier: string | undefined,
) {
  if (!identifier) {
    return null;
  }

  return definitions[identifier.toLowerCase()] ?? null;
}

function safeMarkdownUrl(url: string | undefined) {
  const normalized = url?.trim() ?? "";
  if (/^https?:/i.test(normalized)) return safeExternalUrl(normalized);
  if (/^(?:mailto|tel):/i.test(normalized)) {
    const unsafe = Array.from(normalized).some((character) => {
      const code = character.charCodeAt(0);
      return code <= 0x20 || code === 0x7f;
    });
    return unsafe ? null : normalized;
  }
  return null;
}

function MarkdownExternalLink({
  url,
  accessibilityLabel,
  children,
}: {
  url: string;
  accessibilityLabel: string;
  children: ReactNode;
}) {
  const externalUrl = useExternalUrl(url);
  return (
    <Text
      color="accent"
      style={styles.link}
      onPress={() => {
        void externalUrl.open();
      }}
      accessibilityRole="link"
      accessibilityLabel={
        externalUrl.failed
          ? `${accessibilityLabel}. Could not open. Tap to retry.`
          : accessibilityLabel
      }
      accessibilityLiveRegion={externalUrl.failed ? "polite" : "none"}
      accessibilityState={{ busy: externalUrl.opening }}
      accessibilityHint={
        externalUrl.opening
          ? "Opening this link outside FalconDeck"
          : externalUrl.failed
            ? "Retries opening this link outside FalconDeck"
            : "Opens this link outside FalconDeck"
      }
    >
      {children}
      {externalUrl.failed ? (
        <Text color="danger"> (Could not open. Tap to retry.)</Text>
      ) : null}
    </Text>
  );
}

function headingStyle(depth: number | undefined) {
  switch (depth) {
    case 1:
      return styles.heading1;
    case 2:
      return styles.heading2;
    case 3:
      return styles.heading3;
    case 4:
      return styles.heading4;
    case 5:
      return styles.heading5;
    default:
      return styles.heading6;
  }
}

/**
 * Space above a heading, which reads as the section break. Roughly double the
 * 12px block gap below it, so a heading binds to the prose it introduces
 * instead of floating evenly between two paragraphs.
 */
function headingLeadStyle(depth: number | undefined) {
  switch (depth) {
    case 1:
      return styles.headingLead1;
    case 2:
      return styles.headingLead2;
    case 3:
      return styles.headingLead3;
    default:
      return styles.headingLead4;
  }
}

function ListMarker({ node, index }: { node: MarkdownNode; index: number }) {
  const { theme } = useUnistyles();

  if (node.checked != null) {
    return (
      <View
        style={[styles.checkbox, node.checked ? styles.checkboxChecked : undefined]}
      >
        {node.checked ? (
          <Check
            size={12}
            strokeWidth={3}
            color={theme.colors.surface[0]}
            accessible={false}
          />
        ) : null}
      </View>
    );
  }

  // Markers sit a step back from the text they introduce: a bullet or number
  // at body weight and colour competes with the sentence beside it.
  return (
    <Text
      color="muted"
      style={[styles.listMarker, node.ordered ? styles.listMarkerOrdered : undefined]}
    >
      {node.ordered ? `${(node.start ?? 1) + index}.` : "•"}
    </Text>
  );
}

function renderMarkdownInlineNodes(
  nodes: MarkdownNode[] | undefined,
  definitions: MarkdownDefinitions,
  keyPrefix: string,
  highlightCommands = false,
): ReactNode[] {
  return (nodes ?? []).map((node, index) =>
    renderMarkdownInlineNode(
      node,
      definitions,
      `${keyPrefix}-inline-${index}`,
      highlightCommands,
    ),
  );
}

/**
 * Skill invocations the user typed (`/db-query`) take the accent colour so a
 * command reads as an instruction to the agent rather than ordinary prose.
 */
function renderSlashCommandText(value: string, key: string): ReactNode {
  const segments = splitSlashCommandSegments(value);
  if (!segments.some((segment) => segment.kind === "command")) return value;
  return (
    <Fragment key={key}>
      {segments.map((segment, index) =>
        segment.kind === "command" ? (
          <Text key={`${key}-command-${index}`} color="accent" weight="medium">
            {segment.value}
          </Text>
        ) : (
          segment.value
        ),
      )}
    </Fragment>
  );
}

function renderMarkdownInlineNode(
  node: MarkdownNode,
  definitions: MarkdownDefinitions,
  key: string,
  highlightCommands: boolean,
): ReactNode {
  switch (node.type) {
    case "break":
      return "\n";
    case "delete":
      return (
        <Text key={key} style={styles.inlineDelete}>
          {renderMarkdownInlineNodes(
            node.children,
            definitions,
            key,
            highlightCommands,
          )}
        </Text>
      );
    case "emphasis":
      return (
        <Text key={key} style={styles.inlineEmphasis}>
          {renderMarkdownInlineNodes(
            node.children,
            definitions,
            key,
            highlightCommands,
          )}
        </Text>
      );
    case "footnoteReference":
      return (
        <Text key={key} color="tertiary" style={styles.footnoteReference}>
          [{node.label ?? node.identifier ?? ""}]
        </Text>
      );
    case "html":
      return node.value ?? "";
    case "text": {
      const value = node.value ?? "";
      return highlightCommands ? renderSlashCommandText(value, key) : value;
    }
    case "image": {
      const url = safeExternalUrl(node.url);

      return url ? (
        <MarkdownExternalLink
          key={key}
          url={url}
          accessibilityLabel={`Open linked image: ${node.alt || url}`}
        >
          {node.alt ? `[Image: ${node.alt}]` : (node.url ?? "")}
        </MarkdownExternalLink>
      ) : (
        <Text key={key} color="secondary" style={styles.imageFallback}>
          {node.alt ? `[Image: ${node.alt}]` : (node.url ?? "")}
        </Text>
      );
    }
    case "imageReference": {
      const definition = resolveMarkdownDefinition(
        definitions,
        node.identifier,
      );
      const url = safeExternalUrl(definition?.url);

      return url ? (
        <MarkdownExternalLink
          key={key}
          url={url}
          accessibilityLabel={`Open linked image: ${node.alt || url}`}
        >
          {node.alt ? `[Image: ${node.alt}]` : (definition?.url ?? "")}
        </MarkdownExternalLink>
      ) : (
        <Text key={key} color="secondary" style={styles.imageFallback}>
          {node.alt ? `[Image: ${node.alt}]` : (definition?.url ?? "")}
        </Text>
      );
    }
    case "inlineCode":
      return (
        <Text
          key={key}
          variant="mono"
          color="secondary"
          style={styles.inlineCode}
        >
          {node.value ?? ""}
        </Text>
      );
    case "link": {
      const url = safeMarkdownUrl(node.url);
      const children = renderMarkdownInlineNodes(
        node.children,
        definitions,
        key,
      );

      return url ? (
        <MarkdownExternalLink
          key={key}
          url={url}
          accessibilityLabel={`Open link: ${node.url ?? url}`}
        >
          {children.length > 0 ? children : (node.url ?? "")}
        </MarkdownExternalLink>
      ) : (
        <Text key={key} color="primary">
          {children.length > 0 ? children : (node.url ?? "")}
        </Text>
      );
    }
    case "linkReference": {
      const definition = resolveMarkdownDefinition(
        definitions,
        node.identifier,
      );
      const url = safeMarkdownUrl(definition?.url);
      const children = renderMarkdownInlineNodes(
        node.children,
        definitions,
        key,
      );

      return url ? (
        <MarkdownExternalLink
          key={key}
          url={url}
          accessibilityLabel={`Open link: ${definition?.url ?? node.identifier ?? ""}`}
        >
          {children.length > 0
            ? children
            : (node.label ?? node.identifier ?? definition?.url ?? "")}
        </MarkdownExternalLink>
      ) : (
        <Text key={key} color="primary">
          {children.length > 0
            ? children
            : (node.label ?? node.identifier ?? definition?.url ?? "")}
        </Text>
      );
    }
    case "strong":
      return (
        <Text key={key} weight="semibold">
          {renderMarkdownInlineNodes(
            node.children,
            definitions,
            key,
            highlightCommands,
          )}
        </Text>
      );
    default:
      return renderMarkdownInlineNodes(
        node.children,
        definitions,
        key,
        highlightCommands,
      );
  }
}

const TABLE_COLUMN_MIN_WIDTH = 88;
const TABLE_COLUMN_MAX_WIDTH = 248;
const TABLE_CELL_HORIZONTAL_PADDING = 12;
// Rough average glyph width for the cell font; exact measurement is
// impossible before layout in React Native, but any consistent per-column
// estimate keeps every row's cells the same width — which is what makes the
// columns line up. Content wider than the estimate simply wraps in its cell.
const TABLE_CHAR_WIDTH = 8.5;
const TABLE_HEADER_CHAR_WIDTH = 9;

function markdownNodePlainText(node: MarkdownNode): string {
  if (typeof node.value === "string") return node.value;
  return (node.children ?? []).map(markdownNodePlainText).join("");
}

function markdownTableColumnWidths(
  rows: MarkdownNode[],
  columnCount: number,
  cellHorizontalPadding: number,
): number[] {
  return Array.from({ length: columnCount }, (_, columnIndex) => {
    const contentWidth = rows.reduce((widest, row, rowIndex) => {
      const cell = row.children?.[columnIndex];
      if (!cell) return widest;
      const charWidth =
        rowIndex === 0 ? TABLE_HEADER_CHAR_WIDTH : TABLE_CHAR_WIDTH;
      return Math.max(
        widest,
        markdownNodePlainText(cell).trim().length * charWidth,
      );
    }, 0);
    return Math.min(
      TABLE_COLUMN_MAX_WIDTH,
      Math.max(
        TABLE_COLUMN_MIN_WIDTH,
        Math.ceil(contentWidth) + cellHorizontalPadding,
      ),
    );
  });
}

function renderMarkdownTable(
  node: MarkdownNode,
  definitions: MarkdownDefinitions,
  key: string,
) {
  const rows = node.children ?? [];
  const columnCount = rows.reduce(
    (count, row) => Math.max(count, row.children?.length ?? 0),
    0,
  );

  if (rows.length === 0 || columnCount === 0) {
    return null;
  }

  // Every cell in a column gets the same explicit width; rows laid out
  // independently would otherwise each size their own cells, leaving the
  // header dividers misaligned with the body columns.
  const columnWidths = markdownTableColumnWidths(
    rows,
    columnCount,
    2 * TABLE_CELL_HORIZONTAL_PADDING,
  );

  return (
    <ScrollView key={key} horizontal showsHorizontalScrollIndicator={false}>
      <View style={styles.table}>
        {rows.map((row, rowIndex) => (
          <View key={`${key}-row-${rowIndex}`} style={styles.tableRow}>
            {Array.from({ length: columnCount }, (_, columnIndex) => {
              const cell = row.children?.[columnIndex];
              const isHeader = rowIndex === 0;
              const isLastColumn = columnIndex === columnCount - 1;
              const isLastRow = rowIndex === rows.length - 1;

              return (
                <View
                  key={`${key}-cell-${rowIndex}-${columnIndex}`}
                  style={[
                    styles.tableCell,
                    { width: columnWidths[columnIndex] },
                    isHeader ? styles.tableHeaderCell : undefined,
                    isLastColumn ? styles.tableCellLastColumn : undefined,
                    isLastRow ? styles.tableCellLastRow : undefined,
                  ]}
                >
                  <Text
                    selectable
                    style={[
                      styles.tableCellText,
                      isHeader ? styles.tableHeaderText : undefined,
                    ]}
                  >
                    {cell
                      ? renderMarkdownInlineNodes(
                          cell.children,
                          definitions,
                          `${key}-cell-${rowIndex}-${columnIndex}`,
                        )
                      : ""}
                  </Text>
                </View>
              );
            })}
          </View>
        ))}
      </View>
    </ScrollView>
  );
}

export function renderMarkdownBlocks(
  nodes: MarkdownNode[] | undefined,
  definitions: MarkdownDefinitions,
  keyPrefix = "markdown",
  highlightCommands = false,
  mermaidPending = false,
): ReactNode[] {
  const blocks = nodes ?? [];
  const renderedIndexes = blocks.flatMap((node, index) =>
    node.type === "definition" ? [] : [index],
  );
  const firstRenderedIndex = renderedIndexes[0];
  const lastRenderedIndex = renderedIndexes.at(-1);
  const previousRenderedIndexes = new Map<number, number>();
  for (
    let renderedIndex = 1;
    renderedIndex < renderedIndexes.length;
    renderedIndex += 1
  ) {
    previousRenderedIndexes.set(
      renderedIndexes[renderedIndex]!,
      renderedIndexes[renderedIndex - 1]!,
    );
  }

  return blocks.map((node, index) =>
    renderMarkdownBlock(
      node,
      definitions,
      `${keyPrefix}-block-${index}`,
      {
        isFirst: index === firstRenderedIndex,
        isLast: index === lastRenderedIndex,
        previousType:
          blocks[previousRenderedIndexes.get(index) ?? -1]?.type ?? null,
      },
      highlightCommands,
      mermaidPending,
    ),
  );
}

function renderMarkdownBlock(
  node: MarkdownNode,
  definitions: MarkdownDefinitions,
  key: string,
  position: { isFirst: boolean; isLast: boolean; previousType: string | null },
  highlightCommands: boolean,
  mermaidPending: boolean,
): ReactNode {
  switch (node.type) {
    case "blockquote":
      return (
        <View key={key} style={styles.blockquote}>
          <View style={styles.blockquoteContent}>
            {renderMarkdownBlocks(
              node.children,
              definitions,
              key,
              highlightCommands,
              mermaidPending,
            )}
          </View>
        </View>
      );
    case "code":
      return (
        <View
          key={key}
          style={[
            styles.codeBlock,
            position.previousType === "code"
              ? styles.codeBlockAfterCode
              : undefined,
            position.isFirst ? styles.codeBlockFirst : undefined,
            position.isLast ? styles.codeBlockLast : undefined,
          ]}
        >
          {isMermaidLanguage(node.lang) ? (
            <MermaidBlock
              code={node.value ?? ""}
              pending={mermaidPending}
            />
          ) : (
            <CodeBlock
              code={node.value ?? ""}
              language={node.lang ?? undefined}
            />
          )}
        </View>
      );
    case "definition":
      return null;
    case "footnoteDefinition":
      return (
        <View key={key} style={styles.footnote}>
          <Text
            selectable
            variant="caption"
            color="tertiary"
            size="xs"
            style={styles.footnoteLabel}
          >
            [{node.label ?? node.identifier ?? ""}]
          </Text>
          {renderMarkdownBlocks(
            node.children,
            definitions,
            key,
            highlightCommands,
            mermaidPending,
          )}
        </View>
      );
    case "heading":
      return (
        <Text
          key={key}
          selectable
          weight="semibold"
          style={[
            styles.paragraph,
            headingStyle(node.depth),
            position.isFirst ? undefined : headingLeadStyle(node.depth),
          ]}
        >
          {renderMarkdownInlineNodes(
            node.children,
            definitions,
            key,
            highlightCommands,
          )}
        </Text>
      );
    case "html":
      return node.value ? (
        <Text key={key} selectable color="secondary" style={styles.paragraph}>
          {node.value}
        </Text>
      ) : null;
    case "list":
      return node.children?.length ? (
        <View key={key} style={styles.list}>
          {node.children.map((child, index) => (
            <View key={`${key}-item-${index}`} style={styles.listItem}>
              <ListMarker
                node={{ ...child, ordered: node.ordered, start: node.start }}
                index={index}
              />
              <View style={styles.listItemBody}>
                {renderMarkdownBlocks(
                  child.children,
                  definitions,
                  `${key}-item-${index}`,
                  highlightCommands,
                  mermaidPending,
                )}
              </View>
            </View>
          ))}
        </View>
      ) : null;
    case "paragraph":
      return (
        <Text key={key} selectable color="primary" style={styles.paragraph}>
          {renderMarkdownInlineNodes(
            node.children,
            definitions,
            key,
            highlightCommands,
          )}
        </Text>
      );
    case "table":
      return renderMarkdownTable(node, definitions, key);
    case "thematicBreak":
      return <View key={key} style={styles.rule} />;
    default:
      return node.value ? (
        <Text key={key} selectable color="primary" style={styles.paragraph}>
          {node.value}
        </Text>
      ) : (
        <View key={key}>
          {renderMarkdownBlocks(
            node.children,
            definitions,
            key,
            highlightCommands,
            mermaidPending,
          )}
        </View>
      );
  }
}

/**
 * Minimum wall-clock gap between full remark parses of the accumulated
 * message while stream deltas keep arriving.
 */
const PARSE_THROTTLE_MS = 120;

export const MarkdownRenderer = memo(
  function MarkdownRenderer({
    text,
    streaming = false,
    interpretDirectives = true,
    highlightCommands = false,
  }: MarkdownRendererProps) {
    const deferredStreamingText = useDeferredValue(text);
    // Defer parsing only while tokens are arriving. After the turn settles,
    // the deferred tree would paint stale and then grow the row — a height
    // correction the transcript list reads as a yank toward the tail.
    const renderedText = streaming ? deferredStreamingText : text;

    // Full-text remark parsing (definitions pass plus per-segment passes) on
    // every delta costs more than the deltas themselves once messages grow,
    // and the memo comparator intentionally fails on each one. Coalesce
    // re-parses to at most one per PARSE_THROTTLE_MS while chunks arrive
    // rapidly: the first change outside the window flushes immediately, rapid
    // successors share one trailing parse, and that trailing parse ALWAYS
    // fires with the latest settled text — the finished message is never left
    // stale-parsed. The streaming tail still repaints promptly on each tick
    // because the timer picks up whatever text has accumulated by the time it
    // runs. The very first render parses synchronously via `useState` below.
    const [parsedText, setParsedText] = useState(renderedText);
    const latestTextRef = useRef(renderedText);
    const lastParseAtRef = useRef(0);
    const parseTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

    useEffect(() => {
      latestTextRef.current = renderedText;
      if (parseTimerRef.current !== null) {
        // A trailing parse is already scheduled; it will pick up this newer
        // text, so back-to-back deltas need no extra scheduling work.
        return;
      }
      const elapsed = Date.now() - lastParseAtRef.current;
      if (elapsed >= PARSE_THROTTLE_MS) {
        lastParseAtRef.current = Date.now();
        setParsedText(renderedText);
        return;
      }
      parseTimerRef.current = setTimeout(() => {
        parseTimerRef.current = null;
        lastParseAtRef.current = Date.now();
        setParsedText(latestTextRef.current);
      }, PARSE_THROTTLE_MS - elapsed);
    }, [renderedText]);

    useEffect(
      () => () => {
        if (parseTimerRef.current !== null) clearTimeout(parseTimerRef.current);
      },
      [],
    );

    const renderedBlocks = useMemo(() => {
      const segments = interpretDirectives
        ? splitAgentMessageSegments(parsedText, streaming)
        : [{ kind: "markdown" as const, text: parsedText }];
      // Definitions apply across directive boundaries. Parse the clean full
      // message once for the lookup, then render each Markdown segment in
      // order around the native annotations.
      const cleanTree = parseMarkdown(stripAgentDirectiveLines(parsedText));
      const definitions = buildMarkdownDefinitions(cleanTree);
      const definitionFooter = markdownDefinitionFooter(cleanTree);
      const blocks: ReactNode[] = [];
      segments.forEach((segment, index) => {
        if (segment.kind === "directive") {
          blocks.push(
            <DirectiveAnnotation
              key={`directive-${index}`}
              name={segment.name}
              attrs={segment.attrs}
              unparsed={segment.unparsed}
            />,
          );
          return;
        }
        // remark resolves full reference links during parsing, before our
        // render-time definition lookup. Append the message's ordinary
        // definitions to each segment so a directive between `[label][id]`
        // and `[id]: …` cannot turn the link back into literal text.
        const tree = parseMarkdown(
          definitionFooter
            ? `${segment.text}\n\n${definitionFooter}`
            : segment.text,
        );
        blocks.push(
          ...renderMarkdownBlocks(
            tree.children,
            definitions,
            `segment-${index}`,
            highlightCommands,
            streaming,
          ),
        );
      });
      return blocks;
    }, [highlightCommands, interpretDirectives, parsedText, streaming]);

    return <View style={styles.container}>{renderedBlocks}</View>;
  },
  (prev, next) =>
    prev.text === next.text &&
    prev.streaming === next.streaming &&
    prev.interpretDirectives === next.interpretDirectives &&
    prev.highlightCommands === next.highlightCommands,
);

const styles = StyleSheet.create((theme) => ({
  container: {
    gap: theme.spacing[3],
  },
  codeBlock: {
    // Combined with the container's 12px block gap, this creates the same
    // 32px prose-to-code rhythm as the shared desktop/web renderer.
    marginVertical: theme.spacing[5],
  },
  codeBlockFirst: {
    marginTop: 0,
  },
  codeBlockAfterCode: {
    // Yoga adds adjacent margins instead of collapsing them. The previous
    // code block already contributes 20px below, so remove this block's top
    // margin and let the 12px container gap complete the shared 32px rhythm.
    marginTop: 0,
  },
  codeBlockLast: {
    marginBottom: 0,
  },
  directive: {
    alignItems: "center",
    flexDirection: "row",
    gap: theme.spacing[2],
    minHeight: theme.minTouchTarget,
    paddingHorizontal: theme.spacing[1],
  },
  directiveAttrs: {
    flex: 1,
  },
  paragraph: {
    lineHeight: theme.fontSize.base * theme.lineHeight.prose,
  },
  heading1: {
    fontSize: theme.fontSize["2xl"],
    letterSpacing: -0.4,
    lineHeight: theme.fontSize["2xl"] * theme.lineHeight.tight,
  },
  heading2: {
    fontSize: theme.fontSize.xl,
    letterSpacing: -0.3,
    lineHeight: theme.fontSize.xl * theme.lineHeight.tight,
  },
  heading3: {
    fontSize: theme.fontSize.lg,
    letterSpacing: -0.2,
    lineHeight: theme.fontSize.lg * theme.lineHeight.tight,
  },
  heading4: {
    fontSize: theme.fontSize.md,
    lineHeight: theme.fontSize.md * theme.lineHeight.tight,
  },
  // h5/h6 change voice rather than shrinking further: below h4 the size ramp
  // has nowhere left to go, and a mono microlabel reads as a distinct tier
  // instead of "slightly smaller bold text".
  heading5: {
    color: theme.colors.fg.tertiary,
    fontFamily: theme.fontFamily.mono,
    fontSize: theme.fontSize.xs,
    letterSpacing: 1.2,
    lineHeight: theme.fontSize.xs * theme.lineHeight.normal,
    textTransform: "uppercase",
  },
  heading6: {
    color: theme.colors.fg.muted,
    fontFamily: theme.fontFamily.mono,
    fontSize: theme.fontSize["2xs"],
    letterSpacing: 1.2,
    lineHeight: theme.fontSize["2xs"] * theme.lineHeight.normal,
    textTransform: "uppercase",
  },
  headingLead1: {
    marginTop: theme.spacing[6],
  },
  headingLead2: {
    marginTop: theme.spacing[5],
  },
  headingLead3: {
    marginTop: theme.spacing[3],
  },
  headingLead4: {
    marginTop: theme.spacing[2],
  },
  inlineCode: {
    backgroundColor: theme.colors.surface[3],
    borderRadius: theme.radius.sm,
    overflow: "hidden",
    paddingHorizontal: theme.spacing[1.5],
    paddingVertical: theme.spacing[0.5],
  },
  inlineDelete: {
    textDecorationLine: "line-through",
  },
  inlineEmphasis: {
    fontStyle: "italic",
  },
  imageFallback: {
    fontStyle: "italic",
  },
  link: {
    textDecorationLine: "underline",
  },
  blockquote: {
    borderLeftWidth: 2,
    borderLeftColor: theme.colors.accent.default,
    paddingLeft: theme.spacing[3],
  },
  blockquoteContent: {
    gap: theme.spacing[2],
  },
  list: {
    gap: theme.spacing[2],
  },
  listItem: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: theme.spacing[2],
  },
  listItemBody: {
    flex: 1,
    gap: theme.spacing[2],
  },
  listMarker: {
    lineHeight: theme.fontSize.base * theme.lineHeight.prose,
    minWidth: 24,
  },
  listMarkerOrdered: {
    // Right-aligned so 9. and 10. share a baseline edge and the item text
    // starts at the same x regardless of the number's width.
    fontVariant: ["tabular-nums"],
    textAlign: "right",
  },
  checkbox: {
    alignItems: "center",
    borderColor: theme.colors.border.strong,
    borderRadius: theme.radius.sm,
    borderWidth: 1.5,
    height: 18,
    justifyContent: "center",
    // Nudged down to sit optically centred on the first line of item text.
    marginTop: 3,
    width: 18,
  },
  checkboxChecked: {
    backgroundColor: theme.colors.accent.default,
    borderColor: theme.colors.accent.default,
  },
  rule: {
    // A short centred rule reads as a deliberate pause; a full-width hairline
    // reads as a table border that lost its table.
    alignSelf: "center",
    backgroundColor: theme.colors.border.strong,
    borderRadius: theme.radius.full,
    height: 2,
    marginVertical: theme.spacing[2],
    width: 48,
  },
  table: {
    borderColor: theme.colors.border.default,
    borderRadius: theme.radius.lg,
    borderWidth: 1,
    overflow: "hidden",
  },
  tableRow: {
    flexDirection: "row",
  },
  tableCell: {
    borderBottomColor: theme.colors.border.default,
    borderBottomWidth: 1,
    borderRightColor: theme.colors.border.default,
    borderRightWidth: 1,
    paddingHorizontal: TABLE_CELL_HORIZONTAL_PADDING,
    paddingVertical: 10,
  },
  tableCellText: {
    // Tabular figures keep numeric columns aligned down the column even though
    // each cell lays out independently.
    fontVariant: ["tabular-nums"],
    lineHeight: theme.fontSize.base * theme.lineHeight.normal,
  },
  tableHeaderCell: {
    backgroundColor: theme.colors.surface[1],
  },
  tableCellLastColumn: {
    borderRightWidth: 0,
  },
  tableCellLastRow: {
    borderBottomWidth: 0,
  },
  tableHeaderText: {
    color: theme.colors.fg.secondary,
    fontWeight: "600",
    letterSpacing: 0.2,
  },
  footnote: {
    borderTopColor: theme.colors.border.default,
    borderTopWidth: 1,
    gap: theme.spacing[2],
    paddingTop: theme.spacing[2],
  },
  footnoteLabel: {
    textTransform: "uppercase",
  },
  footnoteReference: {
    fontSize: theme.fontSize.xs,
    lineHeight: theme.fontSize.xs * theme.lineHeight.normal,
  },
}));
