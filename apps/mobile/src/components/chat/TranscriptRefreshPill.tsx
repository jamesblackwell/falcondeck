import { memo } from "react";

import { LoadingPill } from "@/components/ui";

/**
 * Floats over the top of a transcript that is rendering cached messages while
 * the authoritative page is still on its way, so the reader knows newer
 * messages are coming instead of wondering why the thread looks short.
 */
export const TranscriptRefreshPill = memo(function TranscriptRefreshPill({
  visible,
}: {
  visible: boolean;
}) {
  return (
    <LoadingPill
      visible={visible}
      label="Updating conversation…"
      accessibilityLabel="Updating conversation"
      testID="transcript-refresh-pill"
    />
  );
});
