import type { ComponentProps } from "react";
import { Blocks } from "lucide-react";

import { MainView, MainViewBody } from "@falcondeck/ui";

import { ExtensionsPanel } from "./settings/ExtensionsPanel";

type ExtensionsPanelProps = ComponentProps<typeof ExtensionsPanel>;

export function ExtensionsView({
  extensions,
  onSetEnabled,
  onSetPermission,
}: Pick<
  ExtensionsPanelProps,
  "extensions" | "onSetEnabled" | "onSetPermission"
>) {
  return (
    <MainView
      icon={<Blocks aria-hidden="true" className="h-4 w-4" />}
      title="Extensions"
    >
      <MainViewBody>
        <ExtensionsPanel
          chrome="host"
          extensions={extensions}
          onSetEnabled={onSetEnabled}
          onSetPermission={onSetPermission}
        />
      </MainViewBody>
    </MainView>
  );
}
