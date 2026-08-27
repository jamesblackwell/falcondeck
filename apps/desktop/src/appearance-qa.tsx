/* Standalone appearance-settings fixture: `npm run dev` → /appearance-qa.html.
   Renders the full appearance controls beside live samples of each typography
   surface (sidebar, chat, code) so font/size/weight changes can be verified
   visually without launching the app. `?theme=light|dark` picks the mode. */
import { StrictMode, type ReactNode } from "react";
import { createRoot } from "react-dom/client";

import { AppearanceControls, initAppearance, updateAppearance } from "@falcondeck/ui";

import "./index.css";

initAppearance();
const params = new URLSearchParams(window.location.search);
const theme = params.get("theme");
if (theme === "light" || theme === "dark") {
  updateAppearance({ theme });
}
// Drive arbitrary settings from the URL for screenshot QA, e.g.
// ?appearance={"sansFont":"lexend","codeScale":1.15}
const overrides = params.get("appearance");
if (overrides) {
  try {
    updateAppearance(JSON.parse(overrides));
  } catch {
    console.warn("appearance-qa: unparseable ?appearance= value");
  }
}

function SurfaceCard({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="rounded-[var(--fd-radius-lg)] border border-border-subtle bg-surface-1 p-4">
      <p className="mb-3 text-[length:var(--fd-text-2xs)] uppercase tracking-[0.24em] text-fg-muted">
        {title}
      </p>
      {children}
    </section>
  );
}

function Preview() {
  return (
    <div className="space-y-4">
      <SurfaceCard title="Sidebar">
        <div className="fd-type-scope fd-scope-sidebar space-y-1">
          {["Falcondeck core", "Relay hardening", "Mobile demo mode"].map((label, index) => (
            <div
              key={label}
              className={
                index === 0
                  ? "rounded-[var(--fd-radius-md)] bg-surface-3 px-3 py-2 text-[length:var(--fd-text-sm)] text-fg-primary"
                  : "rounded-[var(--fd-radius-md)] px-3 py-2 text-[length:var(--fd-text-sm)] text-fg-secondary"
              }
            >
              {label}
            </div>
          ))}
        </div>
      </SurfaceCard>
      <SurfaceCard title="Chat">
        <div className="fd-type-scope fd-scope-chat space-y-3">
          <p className="text-[length:var(--fd-text-md)] leading-[var(--fd-leading-relaxed)] text-fg-primary">
            The quick brown fox jumps over the lazy dog. Transcripts read in this face, at the
            chat size and weight, including <strong>bold runs</strong> and{" "}
            <code className="rounded-[var(--fd-radius-sm)] bg-surface-4 px-1.5 py-px font-mono text-[length:calc(0.9em*var(--fd-scale-code,1))]">
              inline_code()
            </code>{" "}
            spans.
          </p>
          <pre className="overflow-x-auto rounded-[var(--fd-radius-md)] border border-border-subtle bg-surface-2 p-3 font-mono text-[length:var(--fd-text-sm)] text-fg-secondary">
            <code>{'fn main() {\n    println!("code surface: {}", 42);\n}'}</code>
          </pre>
        </div>
      </SurfaceCard>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <div className="min-h-screen bg-bg-0 p-6">
      <div className="mx-auto grid max-w-5xl grid-cols-[minmax(0,26rem)_minmax(0,1fr)] gap-6">
        <div className="rounded-[var(--fd-radius-lg)] border border-border-subtle bg-surface-1 p-4">
          <AppearanceControls />
        </div>
        <Preview />
      </div>
    </div>
  </StrictMode>,
);
