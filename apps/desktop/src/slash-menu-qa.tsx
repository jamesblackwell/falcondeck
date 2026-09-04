/* Standalone slash-menu fixture: `npm run dev` → /slash-menu-qa.html.
   Seeds the composer with `/fresh` so ranking, highlight, and selection
   chrome can be checked without a daemon. `?theme=light|dark` and
   `?palette=<name>` force an appearance. */
import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";

import { PromptInput } from "@falcondeck/chat-ui";
import type { SkillSummary } from "@falcondeck/client-core";
import { initAppearance, updateAppearance } from "@falcondeck/ui";

import "./index.css";

initAppearance();
const params = new URLSearchParams(window.location.search);
const theme = params.get("theme");
if (theme === "light" || theme === "dark") {
  updateAppearance({ theme });
}
const palette = params.get("palette");
if (palette) document.documentElement.dataset.palette = palette;

const SKILLS: SkillSummary[] = [
  {
    id: "skill:copy-editing",
    label: "Copy editing",
    alias: "/copy-editing",
    availability: "both",
    providers: ["codex", "claude", "grok"],
    source_kind: "project_file",
    description:
      "Edit, review, proofread, polish, tighten, or refresh existing marketing copy while preserving the core message.",
  },
  {
    id: "skill:fresh-eyes-review",
    label: "Fresh eyes review",
    alias: "/fresh-eyes-review",
    availability: "both",
    providers: ["codex", "claude", "grok"],
    source_kind: "project_file",
    description:
      "Reread recent code, catch obvious bugs/smells, and make focused cleanup fixes before handoff.",
  },
  {
    id: "skill:lint",
    label: "Lint",
    alias: "/lint",
    availability: "both",
    providers: ["codex", "claude"],
    source_kind: "home_file",
    description: "Run lint fixes across the workspace.",
  },
  {
    id: "skill:deslop",
    label: "Deslop",
    alias: "/deslop",
    availability: "both",
    providers: ["codex", "claude", "grok"],
    source_kind: "provider_native",
    description: "Strip AI-generated slop from the current diff.",
  },
];

const capabilities = {
  supports_review: false,
  supports_goals: true,
  supports_images: true,
  supports_skills: true,
  supports_interrupt: true,
  supports_steering: false,
  supports_forking: false,
  supports_compaction: true,
  supports_compaction_instructions: false,
  sandbox_modes: [] as string[],
  permission_modes: [] as string[],
};

function SlashMenuQa() {
  const [value, setValue] = useState("/fresh");

  useEffect(() => {
    const textarea = document.querySelector<HTMLTextAreaElement>(
      'textarea[aria-label="Message composer"]',
    );
    if (!textarea) return;
    textarea.focus();
    const caret = textarea.value.length;
    textarea.setSelectionRange(caret, caret);
    textarea.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  }, []);

  return (
    <main className="flex min-h-screen items-end justify-center bg-surface-0 p-8">
      <div className="w-full max-w-3xl">
        <PromptInput
          value={value}
          onValueChange={setValue}
          onSubmit={() => undefined}
          onPickImages={() => undefined}
          onRemoveAttachment={() => undefined}
          attachments={[]}
          capabilities={capabilities}
          skills={SKILLS}
          selectedProvider="codex"
          onProviderChange={() => undefined}
          providerLocked
          showProviderSelector={false}
          models={[]}
          selectedModelId={null}
          onModelChange={() => undefined}
          reasoningOptions={[]}
          selectedEffort={null}
          onEffortChange={() => undefined}
          compactCommandAvailable
          missionCommandAvailable
          goal={{
            goal: null,
            provider: "codex",
            onSetGoal: async () => undefined,
            onClearGoal: async () => undefined,
          }}
          autoFocusKey="slash-menu-qa"
        />
      </div>
    </main>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <SlashMenuQa />
  </StrictMode>,
);
