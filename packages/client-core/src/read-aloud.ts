import { unified } from "unified";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";

const CODE_PLACEHOLDER = "You can view the relevant code in the conversation.";
const TABLE_PLACEHOLDER = "You can view the relevant table in the conversation.";
const MAX_SPEECH_TEXT_CHARS = 8_000;
const SPEECH_CHUNK_CHARS = 600;
const TRUNCATION_NOTICE = " This response was shortened for Read Aloud.";

type MarkdownNode = {
  type?: string;
  value?: string;
  alt?: string;
  children?: MarkdownNode[];
};

/** Produces a concise, deterministic spoken version of a Markdown response. */
export function markdownToSpeechText(markdown: string): string {
  const tree = unified().use(remarkParse).use(remarkGfm).parse(markdown) as MarkdownNode;
  const parts: string[] = [];
  const append = (value: string | undefined) => {
    const normalized = value?.replace(/\s+/g, " ").trim();
    if (normalized) parts.push(normalized);
  };
  const visit = (node: MarkdownNode) => {
    switch (node.type) {
      case "code":
        append(CODE_PLACEHOLDER);
        return;
      case "table":
        append(TABLE_PLACEHOLDER);
        return;
      case "break":
        append(".");
        return;
      case "inlineCode":
      case "text":
        append(node.value);
        return;
      case "image":
        append(node.alt ? `Image: ${node.alt}.` : "Image in the conversation.");
        return;
      default:
        node.children?.forEach(visit);
    }
  };
  visit(tree);
  return parts.join(" ").replace(/\s+([,.;:!?])/g, "$1").trim();
}

export function prepareReadAloudText(markdown: string): string {
  const text = markdownToSpeechText(markdown);
  const characters = Array.from(text);
  if (characters.length <= MAX_SPEECH_TEXT_CHARS) return text;
  const notice = Array.from(TRUNCATION_NOTICE);
  return characters
    .slice(0, MAX_SPEECH_TEXT_CHARS - notice.length)
    .join("")
    .concat(TRUNCATION_NOTICE);
}

/** Keeps first-audio latency low while leaving enough speech time to prefetch. */
export function splitReadAloudText(text: string): string[] {
  const characters = Array.from(text);
  const chunks: string[] = [];
  let start = 0;
  while (start < characters.length) {
    const maximum = Math.min(start + SPEECH_CHUNK_CHARS, characters.length);
    let end = maximum;
    if (maximum < characters.length) {
      for (let index = maximum; index > start; index -= 1) {
        if (/\s/.test(characters[index - 1]!)) {
          end = index;
          break;
        }
      }
    }
    const chunk = characters.slice(start, end).join("").trim();
    if (chunk) chunks.push(chunk);
    start = end;
  }
  return chunks;
}
