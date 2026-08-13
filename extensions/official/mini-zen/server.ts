import { defineExtension, defineExtensionUi } from "@falcondeck/extension-sdk";

type PendingAttention = {
  workspaceId: string;
  threadId?: string;
  requestId: string;
};

const MAX_PENDING_ATTENTION = 256;

function attentionPanel(pending: readonly PendingAttention[]) {
  const count = pending.length;
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
                text: "Thread titles remain hidden until summary access is granted.",
                tone: "muted" as const,
              },
            ]),
      ],
    },
  });
}

export default defineExtension({
  activate(context) {
    context.log.info("Mini Zen activated");

    const publish = async (pending: readonly PendingAttention[]) => {
      await context.storage.set("pendingAttention", pending);
      await context.views.publish({
        viewId: "attention-panel",
        value: attentionPanel(pending),
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
  },
});
