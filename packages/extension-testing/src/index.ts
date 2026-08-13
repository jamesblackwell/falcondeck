import type {
  ExtensionActionInvocation,
  ExtensionContext,
  ExtensionDefinition,
  PublishedExtensionView,
} from "@falcondeck/extension-sdk";

const MAX_ACTION_INPUT_BYTES = 64 * 1024;
const MAX_EXTENSION_STORAGE_BYTES = 512 * 1024;
const MAX_VIEW_BYTES = 16 * 1024;
const MAX_PUBLISHED_VIEWS_PER_ACTION = 256;
const MAX_EXTENSION_VIEW_STATE_BYTES = 4 * 1024 * 1024;
const MAX_HOST_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_SCOPE_KIND_CHARS = 64;
const MAX_SCOPE_ID_CHARS = 512;

type JsonRecord = Record<string, unknown>;
type ActionHandler = (
  invocation: ExtensionActionInvocation,
) => unknown | Promise<unknown>;

export type ExtensionTestHostOptions = {
  extensionId?: string;
  storage?: JsonRecord;
  declaredActions?: readonly string[];
  declaredViews?: readonly string[];
};

export type ExtensionTestInvocation = {
  target?: ExtensionActionInvocation["target"];
  input?: unknown;
};

export type ExtensionTestActionResult = {
  result: unknown;
  storage: JsonRecord;
  publishedViews: PublishedExtensionView[];
};

function cloneJson<T>(value: T): T {
  const encoded = JSON.stringify(value);
  if (encoded === undefined) {
    throw new Error("extension values must be JSON-serializable");
  }
  return JSON.parse(encoded) as T;
}

function encodedBytes(value: unknown): number {
  const encoded = JSON.stringify(value);
  if (encoded === undefined) {
    throw new Error("extension values must be JSON-serializable");
  }
  return new TextEncoder().encode(encoded).byteLength;
}

function validateScope(scope: ExtensionActionInvocation["target"]): void {
  if (!scope) return;
  if (
    scope.kind.length === 0 ||
    scope.kind.length > MAX_SCOPE_KIND_CHARS ||
    scope.id.length === 0 ||
    scope.id.length > MAX_SCOPE_ID_CHARS
  ) {
    throw new Error("extension scope is empty or exceeds its size limit");
  }
}

/** In-memory public-SDK host for extension unit and contract tests. */
export class ExtensionTestHost {
  readonly extensionId: string;

  private readonly definition: ExtensionDefinition;
  private readonly declaredActions: ReadonlySet<string> | null;
  private readonly declaredViews: ReadonlySet<string> | null;
  private readonly actions = new Map<string, ActionHandler>();
  private readonly storage = new Map<string, unknown>();
  private readonly diagnostics: Array<{
    level: "info" | "error";
    message: string;
    fields?: JsonRecord;
  }> = [];
  private readonly retainedViews = new Map<string, PublishedExtensionView>();
  private publishedViews: PublishedExtensionView[] = [];
  private activated = false;
  private nextFailure: Error | null = null;

  constructor(
    definition: ExtensionDefinition,
    options: ExtensionTestHostOptions = {},
  ) {
    this.definition = definition;
    this.extensionId = options.extensionId ?? "test.extension";
    this.declaredActions = options.declaredActions
      ? new Set(options.declaredActions)
      : null;
    this.declaredViews = options.declaredViews
      ? new Set(options.declaredViews)
      : null;
    for (const [key, value] of Object.entries(options.storage ?? {})) {
      this.storage.set(key, cloneJson(value));
    }
  }

  private context(): ExtensionContext {
    return {
      extension: { id: this.extensionId },
      actions: {
        register: (id, handler) => {
          if (this.declaredActions && !this.declaredActions.has(id)) {
            throw new Error(`extension registered undeclared action: ${id}`);
          }
          if (this.actions.has(id))
            throw new Error(`action already registered: ${id}`);
          this.actions.set(id, handler as ActionHandler);
        },
      },
      storage: {
        get: async <T>(key: string, fallback: T): Promise<T> =>
          this.storage.has(key)
            ? cloneJson(this.storage.get(key) as T)
            : cloneJson(fallback),
        set: async (key, value) => {
          this.storage.set(key, cloneJson(value));
        },
        delete: async (key) => {
          this.storage.delete(key);
        },
      },
      views: {
        publish: async (view) => {
          if (this.declaredViews && !this.declaredViews.has(view.viewId)) {
            throw new Error(
              `extension published undeclared view: ${view.viewId}`,
            );
          }
          this.publishedViews.push(cloneJson(view));
        },
      },
      log: {
        info: (message, fields) => {
          this.diagnostics.push({
            level: "info",
            message,
            ...(fields ? { fields: cloneJson(fields) } : {}),
          });
        },
        error: (message, fields) => {
          this.diagnostics.push({
            level: "error",
            message,
            ...(fields ? { fields: cloneJson(fields) } : {}),
          });
        },
      },
    };
  }

  async activate(): Promise<void> {
    if (this.activated) return;
    await this.definition.activate(this.context());
    this.activated = true;
  }

  /** Makes the next action fail before extension code runs. */
  failNextAction(error: Error | string): void {
    this.nextFailure = typeof error === "string" ? new Error(error) : error;
  }

  async invokeAction(
    actionId: string,
    invocation: ExtensionTestInvocation = {},
  ): Promise<ExtensionTestActionResult> {
    this.publishedViews = [];
    if (this.nextFailure) {
      const error = this.nextFailure;
      this.nextFailure = null;
      throw error;
    }
    if (this.declaredActions && !this.declaredActions.has(actionId)) {
      throw new Error("extension action is not declared by the manifest");
    }
    const input = cloneJson(invocation.input ?? null);
    if (encodedBytes(input) > MAX_ACTION_INPUT_BYTES) {
      throw new Error(
        `extension action input exceeds ${MAX_ACTION_INPUT_BYTES} bytes`,
      );
    }
    validateScope(invocation.target);
    const previousStorage = this.storageSnapshot();
    const wasActivated = this.activated;
    const previousActions = new Map(this.actions);
    try {
      await this.activate();
      const handler = this.actions.get(actionId);
      if (!handler)
        throw new Error(`extension did not register action: ${actionId}`);
      const result = await handler({ target: invocation.target, input });
      const storage = this.storageSnapshot();
      if (encodedBytes(storage) > MAX_EXTENSION_STORAGE_BYTES) {
        throw new Error(
          `extension storage exceeds ${MAX_EXTENSION_STORAGE_BYTES} bytes`,
        );
      }
      if (this.publishedViews.length > MAX_PUBLISHED_VIEWS_PER_ACTION) {
        throw new Error(
          `extension action published more than ${MAX_PUBLISHED_VIEWS_PER_ACTION} views`,
        );
      }
      for (const view of this.publishedViews) {
        if (this.declaredViews && !this.declaredViews.has(view.viewId)) {
          throw new Error(
            `extension published undeclared view: ${view.viewId}`,
          );
        }
        validateScope(view.scope);
        if (encodedBytes(view.value) > MAX_VIEW_BYTES) {
          throw new Error(`extension view exceeds ${MAX_VIEW_BYTES} bytes`);
        }
      }
      const nextRetainedViews = new Map(this.retainedViews);
      for (const view of this.publishedViews) {
        nextRetainedViews.set(viewKey(view), cloneJson(view));
      }
      const retainedViewBytes = Array.from(nextRetainedViews.values()).reduce(
        (total, view) =>
          total +
          encodedBytes({
            extension_id: this.extensionId,
            view_id: view.viewId,
            scope: view.scope ?? null,
            value: view.value,
            updated_at: "1970-01-01T00:00:00.000Z",
          }),
        0,
      );
      if (retainedViewBytes > MAX_EXTENSION_VIEW_STATE_BYTES) {
        throw new Error(
          `extension view state exceeds ${MAX_EXTENSION_VIEW_STATE_BYTES} bytes`,
        );
      }
      const response = {
        result: cloneJson(result ?? null),
        storage,
        publishedViews: cloneJson(this.publishedViews),
      };
      if (
        encodedBytes({ jsonrpc: "2.0", id: 1, result: response }) >
        MAX_HOST_RESPONSE_BYTES
      ) {
        throw new Error(
          `extension host response exceeds ${MAX_HOST_RESPONSE_BYTES} bytes`,
        );
      }
      this.retainedViews.clear();
      for (const [key, view] of nextRetainedViews) {
        this.retainedViews.set(key, view);
      }
      return response;
    } catch (error) {
      this.storage.clear();
      for (const [key, value] of Object.entries(previousStorage)) {
        this.storage.set(key, cloneJson(value));
      }
      if (!wasActivated) {
        this.actions.clear();
        for (const [id, handler] of previousActions) {
          this.actions.set(id, handler);
        }
        this.activated = false;
      }
      this.publishedViews = [];
      throw error;
    }
  }

  /** Alias matching the concise invocation API used in extension examples. */
  invoke(
    actionId: string,
    invocation?: ExtensionTestInvocation,
  ): Promise<ExtensionTestActionResult> {
    return this.invokeAction(actionId, invocation);
  }

  storageSnapshot(): JsonRecord {
    return cloneJson(Object.fromEntries(this.storage));
  }

  publishedViewSnapshot(): PublishedExtensionView[] {
    return cloneJson(Array.from(this.retainedViews.values()));
  }

  diagnosticSnapshot(): ReadonlyArray<{
    level: "info" | "error";
    message: string;
    fields?: JsonRecord;
  }> {
    return cloneJson(this.diagnostics);
  }
}

function viewKey(view: PublishedExtensionView): string {
  return JSON.stringify([
    view.viewId,
    view.scope?.kind ?? null,
    view.scope?.id ?? null,
  ]);
}

export function createExtensionTestHost(
  definition: ExtensionDefinition,
  options?: ExtensionTestHostOptions,
): ExtensionTestHost {
  return new ExtensionTestHost(definition, options);
}
