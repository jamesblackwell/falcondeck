import {
  defineExtension,
  defineExtensionUi,
  type ExtensionThreadSummary,
} from "@falcondeck/extension-sdk";

type PendingAttention = {
  workspaceId: string;
  threadId?: string;
  requestId: string;
};

const MAX_PENDING_ATTENTION = 256;

function attentionPanel(
  pending: readonly PendingAttention[],
  threads: readonly ExtensionThreadSummary[],
) {
  const count = pending.length;
  const current = pending[0];
  const currentThread = current?.threadId
    ? threads.find(
        (thread) =>
          thread.id === current.threadId &&
          thread.workspaceId === current.workspaceId,
      )
    : undefined;
  return defineExtensionUi({
    version: 1,
    root: {
      type: "stack",
      gap: "large",
      children: [
        { type: "text", text: "Mini Zen", style: "heading" },
        {
          type: "text",
          text: "One attention item at a time, without losing the rest of your work.",
          tone: "muted",
        },
        { type: "divider" },
        ...(count === 0
          ? [
              {
                type: "state" as const,
                state: "empty" as const,
                title: "Nothing needs attention",
                description:
                  "Mini Zen is listening for new approvals and questions.",
              },
            ]
          : [
              {
                type: "row" as const,
                gap: "small" as const,
                children: [
                  {
                    type: "badge" as const,
                    text: `${count} pending`,
                    tone: "warning" as const,
                  },
                  {
                    type: "text" as const,
                    text:
                      count === 1
                        ? "One item needs attention."
                        : `${count} items need attention.`,
                  },
                ],
              },
              {
                type: "text" as const,
                text: currentThread?.title ?? "A thread needs attention",
                style: "heading" as const,
              },
              ...(count > 1
                ? [
                    {
                      type: "text" as const,
                      text: `${count - 1} more waiting`,
                      tone: "muted" as const,
                    },
                  ]
                : []),
            ]),
      ],
    },
  });
}

export default defineExtension({
  activate(context) {
    context.log.info("Mini Zen activated");

    const publish = async (pending: readonly PendingAttention[]) => {
      let threads: ExtensionThreadSummary[] = [];
      try {
        threads = await context.threads.list();
      } catch {
        // Permission denial is expected until the user grants threads:read.
        // The identifier-only attention count remains useful and safe.
      }
      await context.storage.set("pendingAttention", pending);
      await context.views.publish({
        viewId: "attention-panel",
        value: attentionPanel(pending, threads),
      });
    };

    context.events.on("attention.opened", async (event) => {
      const current = await context.storage.get<PendingAttention[]>(
        "pendingAttention",
        [],
      );
      const next = current.some(
        (item) =>
          item.workspaceId === event.workspaceId &&
          item.requestId === event.requestId,
      )
        ? current
        : [
            ...current,
            {
              workspaceId: event.workspaceId,
              ...(event.threadId ? { threadId: event.threadId } : {}),
              requestId: event.requestId,
            },
          ].slice(-MAX_PENDING_ATTENTION);
      await publish(next);
    });

    context.events.on("attention.resolved", async (event) => {
      const current = await context.storage.get<PendingAttention[]>(
        "pendingAttention",
        [],
      );
      await publish(
        current.filter(
          (item) =>
            item.workspaceId !== event.workspaceId ||
            item.requestId !== event.requestId,
        ),
      );
    });

    context.events.on("thread.updated", async (event) => {
      const current = await context.storage.get<PendingAttention[]>(
        "pendingAttention",
        [],
      );
      if (
        current.some(
          (item) =>
            item.workspaceId === event.workspaceId &&
            item.threadId === event.threadId,
        )
      ) {
        await publish(current);
      }
    });
  },
});
