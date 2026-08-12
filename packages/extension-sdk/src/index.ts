export type ExtensionViewScope = { kind: string; id: string }

export type ExtensionActionInvocation<TInput = unknown> = {
  target?: ExtensionViewScope
  input: TInput
}

export type PublishedExtensionView<TValue = unknown> = {
  viewId: string
  scope?: ExtensionViewScope
  value: TValue
}

export type ExtensionContext = {
  extension: { id: string }
  actions: {
    register<TInput = unknown, TResult = unknown>(
      id: string,
      handler: (invocation: ExtensionActionInvocation<TInput>) => TResult | Promise<TResult>,
    ): void
  }
  storage: {
    get<T>(key: string, fallback: T): Promise<T>
    set(key: string, value: unknown): Promise<void>
    delete(key: string): Promise<void>
  }
  views: { publish<T>(view: PublishedExtensionView<T>): Promise<void> }
  log: {
    info(message: string, fields?: Record<string, unknown>): void
    error(message: string, fields?: Record<string, unknown>): void
  }
}

export type ExtensionDefinition = {
  activate(context: ExtensionContext): void | Promise<void>
}

export function defineExtension(definition: ExtensionDefinition): ExtensionDefinition {
  return definition
}
