import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { initAppearance, ToastProvider, TooltipProvider } from "@falcondeck/ui";

import { ActivityWindow } from "./ActivityWindow";
import { ExternalLinkHandler } from "./external-links";
import { initNativeWindowChrome } from "./native-window-chrome";

import "./index.css";

initAppearance();
initNativeWindowChrome();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ToastProvider>
      <ExternalLinkHandler />
      <div className="h-screen w-screen">
        <TooltipProvider>
          <ActivityWindow />
        </TooltipProvider>
      </div>
    </ToastProvider>
  </StrictMode>,
);
