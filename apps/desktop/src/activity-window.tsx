import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { initAppearance, TooltipProvider } from "@falcondeck/ui";

import { ActivityWindow } from "./ActivityWindow";
import { installExternalLinkHandler } from "./external-links";
import { initNativeWindowChrome } from "./native-window-chrome";

import "./index.css";

initAppearance();
initNativeWindowChrome();
installExternalLinkHandler();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <div className="h-screen w-screen">
      <TooltipProvider>
        <ActivityWindow />
      </TooltipProvider>
    </div>
  </StrictMode>,
);
