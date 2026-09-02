/* Standalone dictation-overlay fixture: `npm run dev` → /dictation-qa.html.
   ?theme=light|dark and ?palette=<name> force an appearance for design QA. */
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { initAppearance } from "@falcondeck/ui";

import {
  DictationOverlay,
  type DictationEvent,
} from "./components/DictationOverlay";

import "./index.css";

const params = new URLSearchParams(window.location.search);

initAppearance();
const qaTheme = params.get("theme");
if (qaTheme) document.documentElement.dataset.theme = qaTheme;
const qaPalette = params.get("palette");
if (qaPalette) document.documentElement.dataset.palette = qaPalette;

const event: DictationEvent = {
  state: "failed",
  text: "Small thing, but when you delete in the sort of gallery mode, so if you've clicked on an image and it comes up full screen in the modal, and then you delete, it currently takes you back to the gallery. Can we instead keep you in the gallery and just go to the next image?",
  error:
    "The transcript is ready, but FalconDeck could not paste it. Copy it below or retry.",
  retainedAudio: true,
};

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <main className="flex min-h-screen items-center justify-center bg-surface-0 p-8">
      <div className="h-[252px] w-[720px] shrink-0">
        <DictationOverlay
          initialEvent={event}
          subscribeToEvents={false}
        />
      </div>
    </main>
  </StrictMode>,
);
