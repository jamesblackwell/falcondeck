import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { initAppearance } from "@falcondeck/ui";

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
      <ActivityWindow />
    </div>
  </StrictMode>,
);
