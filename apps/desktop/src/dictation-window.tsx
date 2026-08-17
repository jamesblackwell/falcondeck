import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { initAppearance } from "@falcondeck/ui";

import { DictationOverlay } from "./components/DictationOverlay";

import "./index.css";

initAppearance();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <DictationOverlay />
  </StrictMode>,
);
