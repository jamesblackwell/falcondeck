import { pathToFileURL } from "node:url";

type JsonObject = Record<string, unknown>;

type ViewScope = { kind: string; id: string };
type PublishedView = { viewId: string; scope?: ViewScope; value: unknown };
type ExtensionEvent = {
  type: string;
  workspaceId: string;
  threadId?: string;
  turnId?: string;
  requestId?: string;
};
type ExtensionThreadSummary = {
  id: string;
  workspaceId: string;
  title: string;
  provider: string;
  status: "idle" | "running" | "waiting_for_input" | "error";
  updatedAt: string;
  pendingApprovalCount: number;
  pendingQuestionCount: number;
};
type OwnedAutomationSummary = {
  id: string;
  resourceId: string;
  revision: number;
  name: string;
  state: string;
  provider: string;
  resolvedSchedule: string;
  nextRunAt?: string;
  latestOutcome?: unknown;
};
type AutomationEffect = { type: string; [key: string]: unknown };
type ActionInvocation = {
  target?: ViewScope;
  input: unknown;
};
type ToolInvocation = {
  input: unknown;
  threadId?: string;
  workspaceId?: string;
  automationOwnerResourceId?: string;
};
type ComposerSuggestion = {
  id: string;
  label: string;
  description?: string;
  prompt: string;
};
type PublishComposerSuggestions = {
  viewId: string;
  threadId: string;
  actions: ComposerSuggestion[];
  preferredActionId?: string;
  turnId?: string;
};
type ExtensionContext = {
  extension: { id: string };
  actions: {
    register(
      id: string,
      handler: (invocation: ActionInvocation) => unknown,
    ): void;
  };
  storage: {
    get<T>(key: string, fallback: T): Promise<T>;
    set(key: string, value: unknown): Promise<void>;
    delete(key: string): Promise<void>;
  };
  views: { publish(view: PublishedView): Promise<void> };
  tools: {
    register(id: string, handler: (invocation: ToolInvocation) => unknown): void;
  };
  composer: {
    publish(suggestions: PublishComposerSuggestions): Promise<void>;
    clear(target: { viewId: string; threadId: string }): Promise<void>;
  };
  events: {
    on(
      type: string,
      handler: (event: ExtensionEvent) => void | Promise<void>,
    ): { dispose(): void };
  };
  threads: { list(): Promise<ExtensionThreadSummary[]> };
  automations: {
    list(): Promise<OwnedAutomationSummary[]>;
    apply(effect: AutomationEffect): Promise<void>;
  };
  log: {
    info(message: string, fields?: JsonObject): void;
    error(message: string, fields?: JsonObject): void;
  };
};
type ExtensionDefinition = {
  activate(context: ExtensionContext): void | Promise<void>;
};
type Runtime = {
  actions: Map<string, (invocation: ActionInvocation) => unknown>;
  tools: Map<string, (invocation: ToolInvocation) => unknown>;
  eventHandlers: Map<
    string,
    Map<number, (event: ExtensionEvent) => void | Promise<void>>
  >;
  nextEventHandlerId: number;
  storage: Map<string, unknown>;
  publishedViews: PublishedView[];
  threadSummaries: ExtensionThreadSummary[] | null;
  ownedAutomations: OwnedAutomationSummary[] | null;
  automationEffects: AutomationEffect[];
  context: ExtensionContext;
};
type RuntimeRequest = {
  requestId: number;
  extensionId: string;
  entrypoint: string;
  storage: Record<string, unknown>;
  threadSummaries?: ExtensionThreadSummary[];
  ownedAutomations?: OwnedAutomationSummary[];
};
type ActionRequest = RuntimeRequest & {
  method: "action.invoke";
  actionId: string;
  target?: ViewScope;
  input: unknown;
};
type EventRequest = RuntimeRequest & {
  method: "event.dispatch";
  event: ExtensionEvent;
};
type ToolRequest = RuntimeRequest & {
  method: "tool.invoke";
  toolId: string;
  arguments: unknown;
  threadId?: string;
  workspaceId?: string;
  automationOwnerResourceId?: string;
};
type HostRequest = ActionRequest | EventRequest | ToolRequest;

const runtimes = new Map<string, Runtime>();
const MAX_EVENT_HANDLERS_PER_TYPE = 32;
const SUPPORTED_EVENT_TYPES = new Set([
  "thread.updated",
  "turn.start",
  "turn.ended",
  "attention.opened",
  "attention.resolved",
  "automations.updated",
]);
const protocolEncoder = new TextEncoder();
const writeDiagnostic = console.error.bind(console);

function writeStructuredDiagnostic(
  level: "info" | "error",
  extensionId: string,
  message: string,
  fields?: JsonObject,
): void {
  try {
    writeDiagnostic(JSON.stringify({ level, extensionId, message, fields }));
  } catch {
    // Logging must never be able to fail an otherwise valid extension action.
    writeDiagnostic(`[${level}] [${extensionId}] ${message}`);
  }
}

// Extension authors naturally reach for console.log. Keep all console output
// off stdout because stdout is the host's framed daemon protocol.
console.log = writeDiagnostic;
console.info = writeDiagnostic;
console.debug = writeDiagnostic;
console.warn = writeDiagnostic;

async function writeProtocol(response: JsonObject): Promise<void> {
  await Deno.stdout.write(
    protocolEncoder.encode(`${JSON.stringify(response)}\n`),
  );
}

async function runtimeFor(request: RuntimeRequest): Promise<Runtime> {
  const existing = runtimes.get(request.extensionId);
  if (existing) {
    existing.storage = new Map(Object.entries(request.storage));
    existing.publishedViews = [];
    existing.threadSummaries = request.threadSummaries ?? null;
    existing.ownedAutomations = request.ownedAutomations ?? null;
    existing.automationEffects = [];
    return existing;
  }

  const runtime = {} as Runtime;
  runtime.actions = new Map();
  runtime.tools = new Map();
  runtime.eventHandlers = new Map();
  runtime.nextEventHandlerId = 1;
  runtime.storage = new Map(Object.entries(request.storage));
  runtime.publishedViews = [];
  runtime.threadSummaries = request.threadSummaries ?? null;
  runtime.ownedAutomations = request.ownedAutomations ?? null;
  runtime.automationEffects = [];
  runtime.context = {
    extension: { id: request.extensionId },
    actions: {
      register(id, handler) {
        if (runtime.actions.has(id)) {
          throw new Error(`action already registered: ${id}`);
        }
        runtime.actions.set(id, handler);
      },
    },
    storage: {
      get<T>(key: string, fallback: T): Promise<T> {
        return Promise.resolve(
          runtime.storage.has(key) ? (runtime.storage.get(key) as T) : fallback,
        );
      },
      set(key, value) {
        runtime.storage.set(key, value);
        return Promise.resolve();
      },
      delete(key) {
        runtime.storage.delete(key);
        return Promise.resolve();
      },
    },
    views: {
      publish(view) {
        runtime.publishedViews.push(view);
        return Promise.resolve();
      },
    },
    tools: {
      register(id, handler) {
        if (runtime.tools.has(id)) {
          throw new Error(`tool already registered: ${id}`);
        }
        runtime.tools.set(id, handler);
      },
    },
    composer: {
      publish({ viewId, threadId, actions, preferredActionId, turnId }) {
        runtime.publishedViews.push({
          viewId,
          scope: { kind: "thread", id: threadId },
          value: { actions, preferredActionId, turnId },
        });
        return Promise.resolve();
      },
      clear({ viewId, threadId }) {
        runtime.publishedViews.push({
          viewId,
          scope: { kind: "thread", id: threadId },
          value: { actions: [] },
        });
        return Promise.resolve();
      },
    },
    events: {
      on(type, handler) {
        if (!SUPPORTED_EVENT_TYPES.has(type)) {
          throw new Error(`unsupported extension event type: ${type}`);
        }
        const handlerId = runtime.nextEventHandlerId++;
        const handlers = runtime.eventHandlers.get(type) ?? new Map();
        if (handlers.size >= MAX_EVENT_HANDLERS_PER_TYPE) {
          throw new Error(
            `extension registered more than ${MAX_EVENT_HANDLERS_PER_TYPE} handlers for ${type}`,
          );
        }
        handlers.set(handlerId, handler);
        runtime.eventHandlers.set(type, handlers);
        let disposed = false;
        return {
          dispose() {
            if (disposed) return;
            disposed = true;
            handlers.delete(handlerId);
            if (handlers.size === 0) runtime.eventHandlers.delete(type);
          },
        };
      },
    },
    threads: {
      list() {
        if (runtime.threadSummaries === null) {
          return Promise.reject(
            new Error("threads:read permission is not granted"),
          );
        }
        return Promise.resolve(
          runtime.threadSummaries.map((summary) => ({ ...summary })),
        );
      },
    },
    automations: {
      list() {
        if (runtime.ownedAutomations === null) {
          return Promise.reject(
            new Error("automations:manage-owned permission is not granted"),
          );
        }
        return Promise.resolve(
          runtime.ownedAutomations.map((automation) =>
            structuredClone(automation)
          ),
        );
      },
      apply(effect) {
        if (runtime.ownedAutomations === null) {
          return Promise.reject(
            new Error("automations:manage-owned permission is not granted"),
          );
        }
        if (
          !effect ||
          typeof effect !== "object" ||
          Array.isArray(effect) ||
          typeof effect.type !== "string"
        ) {
          return Promise.reject(
            new Error("automation effect must be an object with a type"),
          );
        }
        if (runtime.automationEffects.length >= 1) {
          return Promise.reject(
            new Error("only one automation effect is allowed per callback"),
          );
        }
        runtime.automationEffects.push(structuredClone(effect));
        return Promise.resolve();
      },
    },
    log: {
      info(message, fields) {
        writeStructuredDiagnostic("info", request.extensionId, message, fields);
      },
      error(message, fields) {
        writeStructuredDiagnostic(
          "error",
          request.extensionId,
          message,
          fields,
        );
      },
    },
  };

  const loaded = await import(
    `${pathToFileURL(request.entrypoint).href}?loaded=${Date.now()}`
  );
  const definition = loaded.default as ExtensionDefinition | undefined;
  if (!definition || typeof definition.activate !== "function") {
    throw new Error(
      "extension entrypoint must default-export an activate function",
    );
  }
  await definition.activate(runtime.context);
  runtimes.set(request.extensionId, runtime);
  return runtime;
}

async function invoke(request: ActionRequest): Promise<JsonObject> {
  const runtime = await runtimeFor(request);
  const handler = runtime.actions.get(request.actionId);
  if (!handler) {
    throw new Error(`extension did not register action: ${request.actionId}`);
  }
  const result = await handler({
    target: request.target,
    input: request.input,
  });
  return {
    requestId: request.requestId,
    ok: true,
    result: result ?? null,
    storage: Object.fromEntries(runtime.storage),
    publishedViews: runtime.publishedViews,
    automationEffects: runtime.automationEffects,
  };
}

async function invokeTool(request: ToolRequest): Promise<JsonObject> {
  const runtime = await runtimeFor(request);
  const handler = runtime.tools.get(request.toolId);
  if (!handler) {
    throw new Error(`extension did not register tool: ${request.toolId}`);
  }
  const result = await handler({
    input: request.arguments,
    threadId: request.threadId,
    workspaceId: request.workspaceId,
    automationOwnerResourceId: request.automationOwnerResourceId,
  });
  return {
    requestId: request.requestId,
    ok: true,
    result: result ?? null,
    storage: Object.fromEntries(runtime.storage),
    publishedViews: runtime.publishedViews,
    automationEffects: runtime.automationEffects,
  };
}

async function dispatchEvent(request: EventRequest): Promise<JsonObject> {
  const runtime = await runtimeFor(request);
  const handlers = [
    ...(runtime.eventHandlers.get(request.event.type)?.values() ?? []),
  ];
  const handlerErrors: string[] = [];
  for (const handler of handlers) {
    try {
      await handler(request.event);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      handlerErrors.push(message.slice(0, 1_024));
      writeStructuredDiagnostic(
        "error",
        request.extensionId,
        "extension event handler failed",
        { eventType: request.event.type, error: message.slice(0, 1_024) },
      );
    }
  }
  return {
    requestId: request.requestId,
    ok: true,
    result: null,
    storage: Object.fromEntries(runtime.storage),
    publishedViews: runtime.publishedViews,
    automationEffects: runtime.automationEffects,
    handlerErrors,
  };
}

async function handleLine(line: string): Promise<void> {
  if (!line.trim()) return;
  let requestId = 0;
  try {
    const request = JSON.parse(line) as HostRequest;
    requestId = request.requestId;
    if (request.method === "action.invoke") {
      await writeProtocol(await invoke(request));
    } else if (request.method === "event.dispatch") {
      await writeProtocol(await dispatchEvent(request));
    } else if (request.method === "tool.invoke") {
      await writeProtocol(await invokeTool(request));
    } else {
      throw new Error(
        `unsupported host method: ${(request as { method?: unknown }).method}`,
      );
    }
  } catch (error) {
    await writeProtocol({
      requestId,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

const decoder = new TextDecoder();
let inputBuffer = "";
for await (const chunk of Deno.stdin.readable) {
  inputBuffer += decoder.decode(chunk, { stream: true });
  const lines = inputBuffer.split("\n");
  inputBuffer = lines.pop() ?? "";
  for (const line of lines) await handleLine(line);
}
inputBuffer += decoder.decode();
if (inputBuffer.trim()) await handleLine(inputBuffer);
