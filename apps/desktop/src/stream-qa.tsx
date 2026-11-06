// Streaming scroll/smoothness harness. Renders the real Conversation, feeds it
// text at the daemon's real cadence, scrolls with native wheel input from a
// host (see scripts/stream-qa) and records one sample per frame.
import { useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";

import { Conversation } from "@falcondeck/chat-ui";
import {
  normalizePreferences,
  type ConversationItem,
  type ToolActivityKind,
  type ToolLifecycle,
} from "@falcondeck/client-core";
import { initAppearance, ToastProvider } from "@falcondeck/ui";

import "./index.css";

type Reader = "start" | "mid" | "history" | "near" | "climb" | "none";
type ToolMode = "collapsed" | "expanded" | "auto";
type Sample = {
  t: number;
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
  anchorTop: number | null;
  anchorAlive: boolean;
  paintedChars: number;
  jump: boolean;
  /** Screen movement since last frame of the block at viewport centre. */
  blockStep: number;
};
type Mark = { name: string; t: number };

const search = new URLSearchParams(window.location.search);
const params = {
  reader: (search.get("reader") ?? "start") as Reader,
  tools: (search.get("tools") ?? "collapsed") as ToolMode,
  /** Prior turns; each is about seven blocks. */
  history: Number(search.get("history") ?? 6),
  /** Target wire rate is the fixture's: 12-59 chars per 100 ms batch. */
  speed: Number(search.get("speed") ?? 1),
  seed: Number(search.get("seed") ?? 7),
  /** Late-loading attachment above the reader, in milliseconds. */
  lateImage: Number(search.get("lateImage") ?? 0),
  /** Reader opens a tool row above them while parked. */
  expandAbove: search.get("expandAbove") === "1",
  /** A tool above the reader keeps emitting output while they read. */
  liveToolAbove: search.get("liveToolAbove") === "1",
  /** Stay parked through turn end instead of returning to the tail. */
  parkThroughEnd: search.get("parkThroughEnd") === "1",
  /** Stream a thought that auto-collapses when the work starts. */
  thought: search.get("thought") === "1",
  /** Tools and a commentary update before the replies, as a long turn has. */
  longTurn: search.get("longTurn") === "1",
  /** Live rows and an open thought still on screen when the turn ends. */
  endFold: search.get("endFold") === "1",
  /** A tail refresh after turn end: `same` keeps ids, `new` remounts blocks. */
  endRefresh: search.get("endRefresh"),
  /** Height moves between blocks either side of a parked reader. */
  redistribute: search.get("redistribute") === "1",
  /** Lay out every block eagerly: compares the cost of deferral. */
  eager: search.get("eager") === "1",
};
const scriptStart = performance.now();

const baseTime = Date.parse("2026-11-05T09:00:00Z");
let clock = 0;
const nextAt = () => new Date(baseTime + (clock += 1) * 1_000).toISOString();

function rng(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const WORDS =
  "the daemon keeps a bounded tail of each thread and replays deltas in order while the relay retains encrypted updates for a short window so remote clients can reconnect without losing their place in a long running conversation about scroll anchors layout and paint".split(
    " ",
  );

function sentence(random: () => number, length = 18) {
  const words = Array.from(
    { length },
    () => WORDS[Math.floor(random() * WORDS.length)],
  );
  words[0] = words[0]![0]!.toUpperCase() + words[0]!.slice(1);
  return `${words.join(" ")}.`;
}

function paragraph(random: () => number, sentences = 4) {
  return Array.from({ length: sentences }, () => sentence(random)).join(" ");
}

/** A long reply with everything that reflows while half-parsed. */
function longMarkdown(seed: number, sections = 6) {
  const random = rng(seed);
  const parts: string[] = ["## QA section 0 opening", paragraph(random, 5)];
  for (let section = 1; section <= sections; section += 1) {
    parts.push(`## QA section ${section} heading`, paragraph(random));
    parts.push(
      `- **First point** ${sentence(random, 10)}\n- Second point with \`inline code\` ${sentence(random, 12)}\n  - Nested detail ${sentence(random, 8)}\n- Third point ${sentence(random, 9)}`,
    );
    parts.push(paragraph(random, 3));
    parts.push(
      `\`\`\`ts\n${Array.from(
        { length: 14 },
        (_, line) =>
          `export const value${section}x${line} = compute(${line}, "${WORDS[line % WORDS.length]}");`,
      ).join("\n")}\n\`\`\``,
    );
    parts.push(
      `| Metric | Before | After |\n| --- | --- | --- |\n${Array.from(
        { length: 5 },
        (_, row) => `| row ${row} | ${row * 13} ms | ${row * 2} ms |`,
      ).join("\n")}`,
    );
    parts.push(`> ${sentence(random, 16)}`);
    parts.push(paragraph(random, 3));
  }
  return parts.join("\n\n");
}

function tool(
  id: string,
  title: string,
  activity_kind: ToolActivityKind,
  lifecycle: ToolLifecycle,
  output: string | null,
): Extract<ConversationItem, { kind: "tool_call" }> {
  const active = lifecycle === "running";
  const created_at = nextAt();
  return {
    kind: "tool_call",
    id,
    title,
    tool_kind: activity_kind,
    status: active ? "running" : "completed",
    output,
    exit_code: active ? null : 0,
    display: {
      is_read_only: activity_kind === "read",
      has_side_effect: activity_kind === "command",
      is_error: false,
      lifecycle,
      artifact_kind: activity_kind === "command" ? "command_output" : "none",
      activity_kind,
      history_mode: "full",
      summary_hint: null,
      test_summary: null,
    },
    created_at,
    completed_at: active ? null : created_at,
  };
}

const finished = (
  item: Extract<ConversationItem, { kind: "tool_call" }>,
  output: string,
): ConversationItem => ({
  ...item,
  status: "completed",
  exit_code: 0,
  output,
  completed_at: nextAt(),
  display: { ...item.display, lifecycle: "succeeded" },
});

function priorTurn(index: number): ConversationItem[] {
  const random = rng(1000 + index);
  return [
    {
      kind: "user_message",
      id: `u${index}`,
      text: `Prior question ${index}: ${sentence(random, 12)}`,
      attachments: [],
      created_at: nextAt(),
    },
    {
      kind: "reasoning",
      id: `r${index}`,
      summary: "Checked the relay",
      content: paragraph(random, 2),
      lifecycle: "complete",
      created_at: nextAt(),
    },
    tool(`t${index}a`, `rg "anchor${index}" packages`, "command", "succeeded", "12 matches"),
    tool(`t${index}b`, `Read conversation-${index}.tsx`, "read", "succeeded", "1,256 lines"),
    {
      kind: "assistant_message",
      id: `a${index}`,
      text: `## Prior answer ${index}\n\n${paragraph(random, 3)}\n\n\`\`\`ts\nconst done${index} = true;\n\`\`\`\n\n${paragraph(random, 2)}`,
      lifecycle: "complete",
      created_at: nextAt(),
    },
  ];
}

// Store ------------------------------------------------------------------
type View = {
  items: ConversationItem[];
  isThinking: boolean;
  isSending: boolean;
  composerHeight: number;
};
let view: View = {
  items: Array.from({ length: params.history }, (_, i) => priorTurn(i)).flat(),
  isThinking: false,
  isSending: false,
  composerHeight: 92,
};
if (params.lateImage > 0 && view.items[0]?.kind === "user_message") {
  // Oldest user message: the reader in `history` mode parks below it.
  const target = Math.max(0, params.history - 2) * 5;
  const message = view.items[target];
  if (message?.kind === "user_message") {
    view.items[target] = {
      ...message,
      attachments: [
        {
          type: "image",
          id: "late",
          name: "late.svg",
          mime_type: "image/svg+xml",
          url: `/qa-slow-image.svg?delay=${params.lateImage}`,
        },
      ],
    };
  }
}
const listeners = new Set<() => void>();
function setView(update: Partial<View>) {
  view = { ...view, ...update };
  for (const listener of listeners) listener();
}
const setItem = (id: string, next: ConversationItem) =>
  setView({
    items: view.items.map((item) => (item.id === id ? next : item)),
  });
const pushItem = (item: ConversationItem) =>
  setView({ items: [...view.items, item] });

// Mirrors useDaemonConnection: bursts queue, one batch per animation frame.
let pending: { id: string; text: string }[] = [];
let flushFrame: number | null = null;
function flushDeltas() {
  flushFrame = null;
  const batch = pending;
  pending = [];
  const items = view.items.slice();
  for (const { id, text } of batch) {
    const index = items.findIndex((item) => item.id === id);
    const item = items[index];
    if (item?.kind === "assistant_message") {
      items[index] = { ...item, text: item.text + text };
    }
  }
  setView({ items });
}
function queueDelta(id: string, text: string) {
  pending.push({ id, text });
  flushFrame ??= window.requestAnimationFrame(flushDeltas);
}

const sleep = (ms: number) =>
  new Promise<void>((resolve) => window.setTimeout(resolve, ms));
const nextFrame = () =>
  new Promise<number>((resolve) => window.requestAnimationFrame(resolve));

/** Daemon cadence (same shape as the native fixture): 12-59 characters every
    100 ms, with occasional 30 ms double bursts and 260 ms stalls. */
async function streamText(
  id: string,
  text: string,
  random: () => number,
  until?: () => boolean,
) {
  let offset = 0;
  while (offset < text.length) {
    const size = 12 + Math.floor(random() * 48);
    queueDelta(id, text.slice(offset, offset + size));
    offset += size;
    if (until?.()) return offset;
    const roll = random();
    const wait = roll < 0.06 ? 260 : roll < 0.14 ? 30 : 100;
    await sleep(wait / params.speed);
  }
  return offset;
}

// Recorder ---------------------------------------------------------------
const samples: Sample[] = [];
const marks: Mark[] = [];
let scrollWrites = 0;
let wheelEvents = 0;
let wheelsSent = 0;
const shrinks: { t: number; from: number; to: number; top: number }[] = [];
let anchor: { element: HTMLElement; key: string } | null = null;
let anchorRemounts = 0;
let recording = false;

const scroller = () =>
  document.querySelector<HTMLDivElement>('[role="log"]')!;
const mark = (name: string) =>
  marks.push({ name, t: performance.now() });
const messageArticle = (id: string) =>
  document.querySelector<HTMLElement>(
    `[data-conversation-block-id="assistant_message:${id}"]`,
  );
let paintedMessage = "m1";

function findAnchorByKey(key: string) {
  for (const element of scroller().querySelectorAll<HTMLElement>(
    ".fd-markdown > *, [data-conversation-block-id]",
  )) {
    if ((element.textContent ?? "").slice(0, 60) === key) return element;
  }
  return null;
}

/** First readable element wholly inside the viewport. */
function pickAnchor() {
  const el = scroller();
  const box = el.getBoundingClientRect();
  for (const element of el.querySelectorAll<HTMLElement>(
    ".fd-markdown > *, [data-conversation-block-kind='user_message']",
  )) {
    const rect = element.getBoundingClientRect();
    if (rect.top >= box.top && rect.top < box.bottom && rect.height > 0) {
      anchor = { element, key: (element.textContent ?? "").slice(0, 60) };
      return;
    }
  }
}

let centreBlock: { element: Element; top: number } | null = null;
function trackCentreBlock(el: HTMLElement) {
  const box = el.getBoundingClientRect();
  const step =
    centreBlock?.element.isConnected
      ? centreBlock.element.getBoundingClientRect().top - centreBlock.top
      : 0;
  const element =
    document
      .elementFromPoint(box.left + box.width / 2, box.top + box.height / 2)
      ?.closest("[data-conversation-block-id]") ?? null;
  centreBlock = element
    ? { element, top: element.getBoundingClientRect().top }
    : null;
  return step;
}

function record(t: number) {
  if (!recording) return;
  const el = scroller();
  const previousHeight = samples.at(-1)?.scrollHeight ?? el.scrollHeight;
  if (el.scrollHeight < previousHeight - 8) {
    shrinks.push({ t, from: previousHeight, to: el.scrollHeight, top: el.scrollTop });
  }
  if (anchor && !anchor.element.isConnected) {
    const replacement = findAnchorByKey(anchor.key);
    if (replacement) {
      anchor.element = replacement;
      anchorRemounts += 1;
    }
  }
  const alive = anchor?.element.isConnected ?? false;
  samples.push({
    t,
    scrollTop: el.scrollTop,
    scrollHeight: el.scrollHeight,
    clientHeight: el.clientHeight,
    anchorTop: alive
      ? anchor!.element.getBoundingClientRect().top -
        el.getBoundingClientRect().top
      : null,
    anchorAlive: alive,
    paintedChars: messageArticle(paintedMessage)?.textContent?.length ?? 0,
    jump: Boolean(
      document.querySelector('[aria-label="Jump to latest message"]'),
    ),
    blockStep: trackCentreBlock(el),
  });
}
function recorderLoop(t: number) {
  record(t);
  if (recording) window.requestAnimationFrame(recorderLoop);
}

function countScrollWrites(el: HTMLElement) {
  const descriptor = Object.getOwnPropertyDescriptor(
    Element.prototype,
    "scrollTop",
  )!;
  Object.defineProperty(el, "scrollTop", {
    configurable: true,
    get() {
      return descriptor.get!.call(this);
    },
    set(value: number) {
      scrollWrites += 1;
      descriptor.set!.call(this, value);
    },
  });
}

// Native wheel input ------------------------------------------------------
type WheelMessage = { deltaY: number; phase: string; momentum: string };
declare global {
  interface Window {
    webkit?: {
      messageHandlers: { qa: { postMessage(message: unknown): void } };
    };
    qaHost?: (message: string) => void;
    __streamQAResult?: unknown;
  }
}
function postHost(message: Record<string, unknown>) {
  if (window.webkit?.messageHandlers.qa) {
    window.webkit.messageHandlers.qa.postMessage(message);
  } else if (window.qaHost) {
    window.qaHost(JSON.stringify(message));
  }
}
const postWheel = (message: WheelMessage) => {
  wheelsSent += 1;
  postHost({ cmd: "wheel", ...message });
};

/** A trackpad flick: finger frames then decaying momentum, one event a frame.
    Negative `deltaY` scrolls toward older content. */
async function flick(deltaY: number, fingerFrames = 12, momentumFrames = 24) {
  const perFrame = deltaY / fingerFrames;
  for (let frame = 0; frame < fingerFrames; frame += 1) {
    postWheel({
      deltaY: perFrame,
      phase: frame === 0 ? "began" : "changed",
      momentum: "none",
    });
    await nextFrame();
  }
  postWheel({ deltaY: 0, phase: "ended", momentum: "none" });
  let velocity = perFrame;
  for (let frame = 0; frame < momentumFrames; frame += 1) {
    velocity *= 0.9;
    postWheel({
      deltaY: velocity,
      phase: "none",
      momentum:
        frame === 0
          ? "began"
          : frame === momentumFrames - 1
            ? "ended"
            : "changed",
    });
    await nextFrame();
  }
}

/** Flicks up until `done`, as a reader hunting for the top of a message. */
async function hunt(direction: -1 | 1, done: () => boolean, maxFlicks = 40) {
  for (let i = 0; i < maxFlicks; i += 1) {
    await flick(direction * 260);
    await sleep(60);
    if (done()) return;
  }
}

// Scenario ---------------------------------------------------------------
const M1 = longMarkdown(params.seed, 3);
const M2 = longMarkdown(params.seed + 1, 2);
const distance = () => {
  const el = scroller();
  return el.scrollHeight - el.scrollTop - el.clientHeight;
};

async function readerGoesUp() {
  const el = scroller();
  mark("gesture-start");
  const box = () => el.getBoundingClientRect();
  if (params.reader === "start") {
    await hunt(-1, () => {
      const heading = messageArticle("m1")?.querySelector("h2");
      return Boolean(heading && heading.getBoundingClientRect().top > box().top + 40);
    });
  } else if (params.reader === "mid") {
    await hunt(-1, () => distance() > 1400);
  } else if (params.reader === "history") {
    await hunt(-1, () => {
      const user = el.querySelector(
        '[data-conversation-block-id="user_message:u' +
          Math.max(0, params.history - 1) +
          '"], [data-conversation-block-kind="user_message"]:last-of-type',
      );
      return Boolean(user && user.getBoundingClientRect().top > box().top + 40);
    });
    await flick(-400);
  } else if (params.reader === "near") {
    await flick(-90, 6, 8);
  } else if (params.reader === "climb") {
    // Continuous upward reading through deferred history, never pausing.
    for (let i = 0; i < 30; i += 1) await flick(-240, 8, 14);
  }
  await sleep(350);
  pickAnchor();
  mark("settled");
}

async function run() {
  const el = scroller();
  countScrollWrites(el);
  el.addEventListener("wheel", () => (wheelEvents += 1), { passive: true });
  el.scrollTop = el.scrollHeight;
  await nextFrame();
  await nextFrame();
  recording = true;
  window.requestAnimationFrame(recorderLoop);
  const random = rng(params.seed);
  mark("run-start");

  pushItem({
    kind: "user_message",
    id: "live-user",
    text: "Explain the anchor contract in detail.",
    attachments: [],
    created_at: nextAt(),
  });
  setView({ isSending: true });
  await sleep(120 / params.speed);
  setView({ isSending: false, isThinking: true });

  if (params.thought) {
    pushItem({
      kind: "reasoning",
      id: "live-reason",
      summary: null,
      content: "",
      lifecycle: "streaming",
      created_at: nextAt(),
    });
    for (let i = 0; i < 6; i += 1) {
      const current = view.items.find((item) => item.id === "live-reason");
      if (current?.kind !== "reasoning") break;
      setItem("live-reason", {
        ...current,
        content: `${current.content} ${sentence(random, 8)}`,
      });
      await sleep(120 / params.speed);
    }
    const settled = view.items.find((item) => item.id === "live-reason");
    if (settled?.kind === "reasoning") {
      setItem("live-reason", {
        ...settled,
        lifecycle: "complete",
        duration_ms: 900,
      });
    }
  }

  if (params.longTurn) {
    for (let i = 0; i < 4; i += 1) {
      const running = tool(`work-${i}`, `Read file-${i}.ts`, "read", "running", null);
      pushItem(running);
      await sleep(120 / params.speed);
      setItem(`work-${i}`, finished(running, "ok"));
    }
    pushItem({
      kind: "assistant_message",
      id: "progress",
      phase: "commentary",
      text: paragraph(random, 2),
      lifecycle: "complete",
      created_at: nextAt(),
    });
  }

  const first = tool("live-t1", 'rg "scrollTop" packages', "command", "running", null);
  pushItem(first);
  await sleep(250 / params.speed);
  setItem("live-t1", finished(first, "packages/chat-ui: 41 matches"));
  const lingering = tool(
    "live-t2",
    "npm run test -- --watch",
    "command",
    "running",
    "",
  );
  pushItem(lingering);
  await sleep(250 / params.speed);
  if (!params.liveToolAbove) {
    setItem("live-t2", finished(lingering, "tests passed"));
  }

  const assistant: ConversationItem = {
    kind: "assistant_message",
    id: "m1",
    text: "",
    lifecycle: "streaming",
    created_at: nextAt(),
  };
  pushItem(assistant);
  mark("m1-start");

  // Stream concurrently with the reader, as in the app.
  let m1Done = false;
  const m1Stream = streamText("m1", M1, random).then(() => {
    m1Done = true;
  });

  const liveTool = params.liveToolAbove
    ? (async () => {
        for (let i = 0; i < 40 && !m1Done; i += 1) {
          await sleep(400 / params.speed);
          const current = view.items.find((item) => item.id === "live-t2");
          if (current?.kind !== "tool_call") break;
          setItem("live-t2", {
            ...current,
            output: `${current.output ?? ""}PASS test ${i}\n`,
          });
        }
        const current = view.items.find((item) => item.id === "live-t2");
        if (current?.kind === "tool_call") {
          setItem("live-t2", finished(current, current.output ?? ""));
        }
      })()
    : Promise.resolve();

  // Let the message outgrow the viewport before the reader moves.
  while (
    params.reader !== "none" &&
    (messageArticle("m1")?.offsetHeight ?? 0) < el.clientHeight * 1.6 &&
    !m1Done
  ) {
    await sleep(50);
  }
  if (params.reader !== "none") await readerGoesUp();

  if (params.redistribute) {
    await sleep(800);
    mark("redistribute");
    const above = view.items.find((item) => item.id === "a1");
    const below = view.items.find(
      (item) => item.id === `a${params.history - 1}`,
    );
    const moved = `\n\n${paragraph(rng(5), 3)}`;
    if (above?.kind === "assistant_message" && below?.kind === "assistant_message") {
      setView({
        items: view.items.map((item) =>
          item.id === above.id
            ? { ...above, text: above.text + moved }
            : item.id === below.id
              ? { ...below, text: below.text.slice(0, -moved.length) }
              : item,
        ),
      });
    }
    await sleep(400);
  }

  if (params.expandAbove) {
    await sleep(600);
    mark("expand-above");
    pickAnchor();
    const toggle = el.querySelector<HTMLElement>(
      '[data-conversation-block-kind="work_session"] button, [data-conversation-block-kind="tool_call"] button, [data-conversation-block-kind="tool_summary"] button',
    );
    const all = el.querySelectorAll<HTMLElement>(
      '[data-conversation-block-kind="work_session"] button, [data-conversation-block-kind="tool_summary"] button',
    );
    (all.item(all.length - 1) ?? toggle)?.click();
    await sleep(600);
    mark("expand-done");
  }

  await m1Stream;
  await liveTool;
  // Providers finish an item when its text ends, not at turn end.
  await sleep(160);
  mark("m1-complete");
  const finishedM1 = view.items.find((item) => item.id === "m1");
  if (finishedM1?.kind === "assistant_message") {
    setItem("m1", { ...finishedM1, lifecycle: "complete" });
  }
  mark("m1-end");

  const follow = tool("live-t3", "npm run typecheck", "command", "running", null);
  pushItem(follow);
  await sleep(500 / params.speed);
  setItem("live-t3", finished(follow, "ok"));
  await sleep(300 / params.speed);

  const assistant2: ConversationItem = {
    kind: "assistant_message",
    id: "m2",
    text: "",
    lifecycle: "streaming",
    created_at: nextAt(),
  };
  pushItem(assistant2);
  paintedMessage = "m1";
  mark("m2-start");
  let m2Done = false;
  const m2Stream = streamText("m2", M2, random).then(() => {
    m2Done = true;
  });

  if (!params.parkThroughEnd && params.reader !== "none") {
    await sleep(1500);
    mark("return-start");
    await hunt(1, () => distance() <= 30 || m2Done);
    mark("return-done");
    // Trust only what a follower sees from here on.
    await sleep(900);
    mark("following-check");
  }
  await m2Stream;
  await sleep(200);
  if (params.endFold) {
    for (let i = 0; i < 5; i += 1) {
      pushItem(
        tool(`fold-${i}`, `npm run check-${i}`, "command", "running", "working\n".repeat(6)),
      );
    }
    pushItem({
      kind: "reasoning",
      id: "fold-thought",
      summary: null,
      content: paragraph(random, 8),
      lifecycle: "streaming",
      created_at: nextAt(),
    });
    await sleep(1200);
  }
  mark("turn-end-tail");

  const endItems = view.items.map((item) => {
    if (item.kind === "assistant_message" && item.lifecycle === "streaming") {
      return { ...item, lifecycle: "complete" as const };
    }
    if (item.kind === "reasoning" && item.lifecycle === "streaming") {
      return { ...item, lifecycle: "complete" as const, duration_ms: 1200 };
    }
    if (item.kind === "tool_call" && item.status === "running") {
      return finished(item, item.output ?? "");
    }
    return item;
  });
  setView({ items: endItems, isThinking: false });
  mark("turn-end");
  if (params.endRefresh) {
    await sleep(350);
    setView({
      items: view.items.map((item) => ({
        ...item,
        id:
          params.endRefresh === "new" && item.id.startsWith("m")
            ? `${item.id}-hydrated`
            : item.id,
      })),
    });
  }
  await sleep(1400);
  mark("run-end");
  recording = false;
  await nextFrame();
  return summarize();
}

// Metrics ----------------------------------------------------------------
function percentile(values: number[], p: number) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))]!;
}
const round = (value: number) => Math.round(value * 100) / 100;
const timeOf = (name: string) =>
  marks.find((entry) => entry.name === name)?.t ?? Infinity;

function anchorStats(from: number, to: number) {
  const window = samples.filter((s) => s.t >= from && s.t <= to);
  let moved = 0;
  let total = 0;
  let max = 0;
  let scrollMoves = 0;
  for (let i = 1; i < window.length; i += 1) {
    const a = window[i - 1]!;
    const b = window[i]!;
    if (Math.abs(b.scrollTop - a.scrollTop) > 0.5) scrollMoves += 1;
    if (a.anchorTop === null || b.anchorTop === null) continue;
    const step = Math.abs(b.anchorTop - a.anchorTop);
    if (step > 0.5) {
      moved += 1;
      total += step;
      max = Math.max(max, step);
    }
  }
  return {
    frames: window.length,
    framesMoved: moved,
    totalPx: round(total),
    maxStepPx: round(max),
    scrollMoves,
  };
}

function summarize() {
  const start = timeOf("gesture-start");
  const settled = timeOf("settled");
  const parkEnd = Math.min(
    timeOf("return-start"),
    params.parkThroughEnd ? timeOf("run-end") : Infinity,
  );
  const frameDeltas = samples
    .slice(1)
    .map((s, i) => s.t - samples[i]!.t);
  const gesture = samples.filter((s) => s.t >= start && s.t <= settled);
  let reversals = 0;
  let direction = 0;
  for (let i = 1; i < gesture.length; i += 1) {
    const step = gesture[i]!.scrollTop - gesture[i - 1]!.scrollTop;
    if (Math.abs(step) < 0.5) continue;
    const sign = Math.sign(step);
    if (direction !== 0 && sign !== direction) reversals += 1;
    direction = sign;
  }

  // A flick moves at most ~22 px a frame, so anything larger, or against the
  // direction of travel, is content jumping rather than the reader scrolling.
  const handled = samples.filter(
    (s) => s.t >= start && s.t <= timeOf("return-start"),
  );
  const jumps = handled.filter((s) => Math.abs(s.blockStep) > 40);
  const streamWindow = samples.filter(
    (s) => s.t >= timeOf("m1-start") && s.t <= timeOf("m1-end"),
  );
  const charSteps: number[] = [];
  const heightSteps: number[] = [];
  for (let i = 1; i < streamWindow.length; i += 1) {
    const chars =
      streamWindow[i]!.paintedChars - streamWindow[i - 1]!.paintedChars;
    if (chars > 0) charSteps.push(chars);
    const height = Math.abs(
      streamWindow[i]!.scrollHeight - streamWindow[i - 1]!.scrollHeight,
    );
    if (height > 0) heightSteps.push(height);
  }
  const seconds =
    streamWindow.length > 1
      ? (streamWindow.at(-1)!.t - streamWindow[0]!.t) / 1000
      : 0;
  const after = samples.filter(
    (s) => s.t >= timeOf("following-check") && s.t <= timeOf("turn-end-tail"),
  );

  const endWindow = samples.filter(
    (s) => s.t >= timeOf("turn-end-tail") && s.t <= timeOf("run-end"),
  );
  const endSteps = endWindow.slice(1).map((s, i) => s.scrollTop - endWindow[i]!.scrollTop);
  const last = samples.at(-1);
  const firstMark = Math.min(timeOf("gesture-start"), timeOf("turn-end"));
  const upwardLeaps = samples.filter((s, i) => {
    if (i === 0 || s.t < timeOf("m1-start")) return false;
    const before = samples[i - 1]!;
    const wheelActive = s.t >= start && s.t <= settled;
    return !wheelActive && before.scrollTop - s.scrollTop > 30;
  });
  const unattended = samples.filter(
    (s) => s.t >= timeOf("m1-start") && s.t <= firstMark,
  );
  return {
    params,
    mountMs: round(mountMs),
    engine: navigator.userAgent,
    marks,
    parked: anchorStats(settled, parkEnd),
    expand:
      params.expandAbove
        ? anchorStats(timeOf("expand-above"), timeOf("expand-done"))
        : null,
    gesture: {
      frames: gesture.length,
      scrollDirectionReversals: reversals,
      blockJumps: jumps.length,
      maxBlockJumpPx: round(Math.max(0, ...jumps.map((s) => Math.abs(s.blockStep)))),
    },
    anchorRemounts,
    scrollWrites,
    wheelEvents,
    wheelsSent,
    shrinks,
    hitTest: document.elementFromPoint(520, 400)?.closest("[role=log]") ? "log" : (document.elementFromPoint(520, 400)?.tagName ?? "none"),
    streaming: {
      seconds: round(seconds),
      paintsPerSecond: seconds ? round(charSteps.length / seconds) : 0,
      meanCharsPerPaint: round(
        charSteps.reduce((sum, value) => sum + value, 0) /
          Math.max(1, charSteps.length),
      ),
      maxCharsPerPaint: Math.max(0, ...charSteps),
      p95CharsPerPaint: percentile(charSteps, 0.95),
      maxHeightStepPx: round(Math.max(0, ...heightSteps)),
      p95HeightStepPx: round(percentile(heightSteps, 0.95)),
    },
    /** scrollTop dropping with no upward input. */
    upwardLeaps: upwardLeaps.length,
    maxUpwardLeapPx: round(
      Math.max(
        0,
        ...samples.slice(1).map((s, i) => {
          if (s.t < timeOf("m1-start")) return 0;
          if (s.t >= start && s.t <= settled) return 0;
          return samples[i]!.scrollTop - s.scrollTop;
        }),
      ),
    ),
    /** What the reader sees from the moment the turn ends. */
    end: {
      /** Largest single-frame move of the view, up or down. */
      maxFrameScrollPx: round(Math.max(0, ...endSteps.map(Math.abs))),
      /** Largest single-frame on-screen move of the centre block. */
      maxBlockStepPx: round(Math.max(0, ...endWindow.map((s) => Math.abs(s.blockStep)))),
      shrinkPx: round(
        Math.max(0, (endWindow[0]?.scrollHeight ?? 0) - (last?.scrollHeight ?? 0)),
      ),
      finalDistancePx: round(
        last ? last.scrollHeight - last.scrollTop - last.clientHeight : 0,
      ),
      jumpButtonShown: Boolean(last?.jump),
    },
    following: {
      /** No input yet: any gap here means following stopped by itself. */
      maxDistanceUnattended: round(
        Math.max(0, ...unattended.map((s) => s.scrollHeight - s.scrollTop - s.clientHeight)),
      ),
      maxDistanceAfterReturn: round(
        Math.max(0, ...after.map((s) => s.scrollHeight - s.scrollTop - s.clientHeight)),
      ),
      jumpVisibleAfterReturn: after.some((s) => s.jump),
      samples: after.length,
    },
    frames: {
      count: frameDeltas.length,
      p50: round(percentile(frameDeltas, 0.5)),
      p95: round(percentile(frameDeltas, 0.95)),
      max: round(Math.max(0, ...frameDeltas)),
      over25ms: frameDeltas.filter((value) => value > 25).length,
      over50ms: frameDeltas.filter((value) => value > 50).length,
    },
    samples,
  };
}

// View -------------------------------------------------------------------
function StreamQa() {
  const [state, setState] = useState(view);
  useEffect(() => {
    const listener = () => setState(view);
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }, []);
  const preferences = useMemo(() => {
    const base = normalizePreferences(null);
    return {
      ...base,
      conversation: { ...base.conversation, tool_details_mode: params.tools },
    };
  }, []);
  return (
    <div className="flex h-screen flex-col bg-surface-1">
      <Conversation
        threadKey="stream-qa"
        items={state.items}
        preferences={preferences}
        isThinking={state.isThinking}
        isSending={state.isSending}
      />
      <div
        style={{ height: state.composerHeight, flex: "none" }}
        className="border-t border-border-subtle"
      />
    </div>
  );
}

let mountMs = 0;
if (params.eager) {
  const style = document.createElement("style");
  style.textContent =
    ".fd-conversation-block--deferred{content-visibility:visible!important}";
  document.head.append(style);
}
initAppearance();
createRoot(document.getElementById("root")!).render(
  <ToastProvider>
    <StreamQa />
  </ToastProvider>,
);

async function auto() {
  await nextFrame();
  await nextFrame();
  mountMs = performance.now() - scriptStart;
  await sleep(800);
  try {
    const result = await run();
    window.__streamQAResult = result;
    postHost({ cmd: "done", result: JSON.stringify(result) });
  } catch (cause) {
    postHost({ cmd: "error", message: String(cause) });
  }
}
void auto();
