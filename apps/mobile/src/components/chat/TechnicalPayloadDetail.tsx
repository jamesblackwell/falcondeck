import { memo, useMemo } from "react";

import { formatInspectableValue } from "@falcondeck/client-core";

import { Text } from "@/components/ui";
import { CodeBlock } from "./CodeBlock";

export const TechnicalPayloadDetail = memo(function TechnicalPayloadDetail({
  payload,
}: {
  payload: unknown;
}) {
  const inspection = useMemo(() => formatInspectableValue(payload), [payload]);

  return (
    <>
      <CodeBlock code={inspection.text} language="json" previewLines={8} />
      {inspection.truncated ? (
        <Text variant="meta" size="2xs">
          Display limited for performance and safety.
        </Text>
      ) : null}
    </>
  );
});
