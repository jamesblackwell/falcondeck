import { memo, useCallback, useState } from "react";
import { Download } from "lucide-react";

import {
  conversationExportFilename,
  conversationItemsToMarkdown,
  type ConversationItem,
} from "@falcondeck/client-core";

export const ConversationExportButton = memo(function ConversationExportButton({
  items,
  title,
  partial,
}: {
  items: readonly ConversationItem[];
  title?: string | null;
  partial: boolean;
}) {
  const [error, setError] = useState<string | null>(null);
  const download = useCallback(() => {
    setError(null);
    let objectUrl: string | null = null;
    let anchor: HTMLAnchorElement | null = null;
    try {
      const markdown = conversationItemsToMarkdown(items, { title, partial });
      objectUrl = URL.createObjectURL(
        new Blob([markdown], { type: "text/markdown;charset=utf-8" }),
      );
      anchor = document.createElement("a");
      anchor.href = objectUrl;
      anchor.download = conversationExportFilename(title);
      anchor.rel = "noopener";
      document.body.appendChild(anchor);
      anchor.click();
    } catch {
      setError("Could not prepare this conversation download.");
    } finally {
      anchor?.remove();
      if (objectUrl) {
        const completedUrl = objectUrl;
        window.setTimeout(() => URL.revokeObjectURL(completedUrl), 0);
      }
    }
  }, [items, partial, title]);

  const label = partial
    ? "Download loaded conversation as Markdown. Earlier messages are not loaded."
    : "Download conversation as Markdown";
  return (
    <div className="flex items-center gap-2">
      <button
        type="button"
        onClick={download}
        aria-label={label}
        title={label}
        className="fd-focus inline-flex min-h-8 items-center gap-1.5 rounded-[var(--fd-radius-sm)] px-1.5 text-[length:var(--fd-text-xs)] text-fg-muted transition-colors hover:bg-surface-2 hover:text-fg-primary"
      >
        <Download aria-hidden="true" className="h-3.5 w-3.5" />
        Download
      </button>
      {error ? (
        <span
          role="alert"
          className="text-[length:var(--fd-text-xs)] text-danger"
        >
          {error}
        </span>
      ) : null}
    </div>
  );
});
