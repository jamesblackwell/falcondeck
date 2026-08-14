import { useCallback, useEffect, useRef, useState } from "react";
import { emit, listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { Pin, PinOff, X } from "lucide-react";

import { ActivityView } from "@falcondeck/chat-ui/activity-view";
import { PromptInput } from "@falcondeck/chat-ui";
import type {
  InteractiveRequest,
  InteractiveResponsePayload,
} from "@falcondeck/client-core";
import { Button, EmptyState, cn } from "@falcondeck/ui";

import {
  ACTIVITY_WINDOW_EVENTS,
  type ActivityRespondResult,
  type ActivityStartTaskResult,
  type ActivityWindowState,
} from "./activity-window-bridge";

/* ================================================================
   Detached Activity window.

   Renders the same view as the in-app takeover, but owns no data: the
   main window pushes state and performs every write. See
   activity-window-bridge.ts for why.
   ================================================================ */

/** Long enough to cover a busy main window, short enough to not hang a card. */
const RESPOND_TIMEOUT_MS = 20_000;
const START_TASK_TIMEOUT_MS = 30_000;

/** Survives closing and re-opening the window — it is a workspace habit. */
const ALWAYS_ON_TOP_KEY = "falcondeck.activity.always-on-top";

function readAlwaysOnTop() {
  try {
    return window.localStorage.getItem(ALWAYS_ON_TOP_KEY) === "true";
  } catch {
    return false;
  }
}

/** Pin the queue above other apps — the reason to have it on a second screen. */
function AlwaysOnTopToggle({
  pinned,
  onToggle,
}: {
  pinned: boolean;
  onToggle: () => void;
}) {
  return (
    <Button
      type="button"
      size="sm"
      variant="ghost"
      aria-pressed={pinned}
      title={
        pinned
          ? "Activity stays above other windows"
          : "Keep Activity above other windows"
      }
      className={cn("gap-2", pinned ? "text-accent" : "text-fg-muted")}
      onClick={onToggle}
    >
      {pinned ? (
        <Pin aria-hidden="true" className="h-4 w-4" />
      ) : (
        <PinOff aria-hidden="true" className="h-4 w-4" />
      )}
      {pinned ? "On top" : "Stay on top"}
    </Button>
  );
}

export function ActivityWindow() {
  const [state, setState] = useState<ActivityWindowState | null>(null);
  const [pinned, setPinned] = useState(readAlwaysOnTop);
  const [focused, setFocused] = useState(true);
  const callSeqRef = useRef(0);
  const [composerOpen, setComposerOpen] = useState(false);
  const [composerDraft, setComposerDraft] = useState("");
  const [composerWorkspaceId, setComposerWorkspaceId] = useState("");
  const [composerError, setComposerError] = useState<string | null>(null);
  const [composerSending, setComposerSending] = useState(false);

  // Applied from the window, not the button: the choice has to survive a
  // reload, and it holds while the queue is still waiting for its first push.
  useEffect(() => {
    void getCurrentWindow()
      .setAlwaysOnTop(pinned)
      .catch(() => {});
    try {
      window.localStorage.setItem(ALWAYS_ON_TOP_KEY, String(pinned));
    } catch {
      // A locked-down store is no reason to lose the toggle this session.
    }
  }, [pinned]);

  useEffect(() => {
    const unlisten = listen<ActivityWindowState>(
      ACTIVITY_WINDOW_EVENTS.state,
      (event) => setState(event.payload),
    );
    // Announce after subscribing, so the reply cannot land in the gap. Also
    // re-syncs on reload, when the main window has no idea we restarted.
    void emit(ACTIVITY_WINDOW_EVENTS.ready);

    // Tell the main window to stop pushing once this one is gone.
    const closing = getCurrentWindow().onCloseRequested(() => {
      void emit(ACTIVITY_WINDOW_EVENTS.closed);
    });

    // Which window the keyboard is talking to is invisible across two
    // screens, so the view says so — it needs the frame to tell it.
    const focus = getCurrentWindow().onFocusChanged(({ payload }) =>
      setFocused(payload),
    );

    return () => {
      void unlisten.then((off) => off());
      void closing.then((off) => off());
      void focus.then((off) => off());
    };
  }, []);

  useEffect(() => {
    if (!composerOpen) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopImmediatePropagation();
      setComposerOpen(false);
    };
    window.addEventListener("keydown", closeOnEscape, true);
    return () => window.removeEventListener("keydown", closeOnEscape, true);
  }, [composerOpen]);

  const handleOpenThread = useCallback(
    (workspaceId: string, threadId: string) => {
      void emit(ACTIVITY_WINDOW_EVENTS.openThread, { workspaceId, threadId });
      // The thread opens in the main window, so bring it forward. This window
      // deliberately stays as it is — that is the point of detaching it.
      void invoke("focus_main_window").catch(() => {});
    },
    [],
  );

  const handleMarkThreadRead = useCallback(
    (workspaceId: string, threadId: string) => {
      void emit(ACTIVITY_WINDOW_EVENTS.markRead, { workspaceId, threadId });
    },
    [],
  );

  const handleNewThread = useCallback(() => {
    setComposerError(null);
    setComposerOpen(true);
  }, []);

  useEffect(() => {
    if (!state || composerWorkspaceId) return;
    setComposerWorkspaceId(
      state.selectedWorkspaceId ?? state.composerWorkspaces[0]?.id ?? "",
    );
  }, [composerWorkspaceId, state]);

  useEffect(() => {
    const handleShortcut = (event: KeyboardEvent) => {
      if (
        !(event.metaKey || event.ctrlKey) ||
        event.key.toLowerCase() !== "n"
      ) {
        return;
      }
      event.preventDefault();
      setComposerError(null);
      setComposerOpen(true);
    };
    window.addEventListener("keydown", handleShortcut);
    return () => window.removeEventListener("keydown", handleShortcut);
  }, []);

  const handleStartTask = useCallback(async () => {
    const prompt = composerDraft.trim();
    if (!prompt || !composerWorkspaceId || composerSending) return;
    callSeqRef.current += 1;
    const callId = `task:${callSeqRef.current}`;
    setComposerSending(true);
    setComposerError(null);
    try {
      await new Promise<void>((resolve, reject) => {
        let settled = false;
        let timeout = 0;
        const unlisten = listen<ActivityStartTaskResult>(
          ACTIVITY_WINDOW_EVENTS.startTaskResult,
          (event) => {
            if (event.payload.callId !== callId || settled) return;
            settled = true;
            window.clearTimeout(timeout);
            void unlisten.then((off) => off());
            if (event.payload.error) reject(new Error(event.payload.error));
            else resolve();
          },
        );
        timeout = window.setTimeout(() => {
          if (settled) return;
          settled = true;
          void unlisten.then((off) => off());
          reject(new Error("FalconDeck did not confirm the new task."));
        }, START_TASK_TIMEOUT_MS);
        void unlisten.then(() =>
          emit(ACTIVITY_WINDOW_EVENTS.startTask, {
            callId,
            workspaceId: composerWorkspaceId,
            prompt,
          }),
        );
      });
      setComposerDraft("");
      setComposerOpen(false);
    } catch (error) {
      setComposerError(
        error instanceof Error ? error.message : "Failed to start task",
      );
    } finally {
      setComposerSending(false);
    }
  }, [composerDraft, composerSending, composerWorkspaceId]);

  const handleReturnFocus = useCallback(() => {
    void invoke("focus_main_window").catch(() => {});
  }, []);

  /** Round-trips the answer so the card can still report its own failure. */
  const handleInteractiveResponse = useCallback(
    async (
      request: InteractiveRequest,
      response: InteractiveResponsePayload,
    ) => {
      callSeqRef.current += 1;
      const callId = `${request.request_id}:${callSeqRef.current}`;

      await new Promise<void>((resolve, reject) => {
        let settled = false;
        let timeout = 0;
        const unlisten = listen<ActivityRespondResult>(
          ACTIVITY_WINDOW_EVENTS.respondResult,
          (event) => {
            if (event.payload.callId !== callId || settled) return;
            settled = true;
            window.clearTimeout(timeout);
            void unlisten.then((off) => off());
            if (event.payload.error) reject(new Error(event.payload.error));
            else resolve();
          },
        );

        timeout = window.setTimeout(() => {
          if (settled) return;
          settled = true;
          void unlisten.then((off) => off());
          reject(
            new Error("FalconDeck's main window did not answer. Is it open?"),
          );
        }, RESPOND_TIMEOUT_MS);

        void unlisten.then(() =>
          emit(ACTIVITY_WINDOW_EVENTS.respond, { callId, request, response }),
        );
      });
    },
    [],
  );

  if (!state) {
    return (
      <div className="flex h-full items-center justify-center bg-surface-0 px-8">
        <EmptyState
          title="Waiting for FalconDeck"
          description="This window mirrors the main app. Open FalconDeck to see what needs attention."
        />
      </div>
    );
  }

  const composerWorkspace = state.composerWorkspaces.find(
    (workspace) => workspace.id === composerWorkspaceId,
  );

  return (
    <div className="relative h-full">
      <ActivityView
        groups={state.groups}
        interactiveRequests={state.interactiveRequests}
        workspaceHosts={state.workspaceHosts}
        onOpenThread={handleOpenThread}
        onInteractiveResponse={handleInteractiveResponse}
        onMarkThreadRead={handleMarkThreadRead}
        onNewThread={state.canStartThread ? handleNewThread : undefined}
        trafficLightInset
        onReturnFocus={handleReturnFocus}
        windowFocused={focused}
        headerActions={
          <AlwaysOnTopToggle
            pinned={pinned}
            onToggle={() => setPinned((current) => !current)}
          />
        }
      />
      {composerOpen ? (
        <div className="absolute inset-0 z-50 flex items-center justify-center bg-surface-0/70 p-6 backdrop-blur-sm">
          <section className="w-full max-w-2xl rounded-[var(--fd-radius-lg)] border border-border-strong bg-surface-1 p-4">
            <div className="mb-3 flex items-start justify-between gap-4">
              <div>
                <p className="fd-microlabel text-accent">Quick launch</p>
                <h2 className="mt-1 text-[length:var(--fd-text-lg)] font-semibold text-fg-primary">
                  Start a task without leaving Activity
                </h2>
              </div>
              <Button
                type="button"
                size="icon"
                variant="ghost"
                aria-label="Close quick composer"
                onClick={() => setComposerOpen(false)}
              >
                <X aria-hidden="true" className="h-4 w-4" />
              </Button>
            </div>
            <label className="mb-3 block">
              <span className="fd-microlabel mb-1.5 block text-fg-muted">
                Project
              </span>
              <select
                className="h-9 w-full rounded-[var(--fd-radius-sm)] border border-border-subtle bg-surface-0 px-3 text-sm text-fg-primary"
                value={composerWorkspaceId}
                onChange={(event) => setComposerWorkspaceId(event.target.value)}
              >
                {state.composerWorkspaces.map((workspace) => (
                  <option key={workspace.id} value={workspace.id}>
                    {workspace.path.split(/[\\/]/).filter(Boolean).at(-1) ??
                      workspace.path}
                  </option>
                ))}
              </select>
            </label>
            <PromptInput
              value={composerDraft}
              onValueChange={setComposerDraft}
              onSubmit={() => void handleStartTask()}
              attachments={[]}
              selectedProvider={composerWorkspace?.default_provider ?? "codex"}
              onProviderChange={() => {}}
              showProviderSelector={false}
              models={[]}
              selectedModelId={null}
              onModelChange={() => {}}
              reasoningOptions={[]}
              selectedEffort={null}
              onEffortChange={() => {}}
              autoFocusKey={composerOpen ? "activity-quick-task" : null}
              compact
              sendDisabled={composerSending || !composerWorkspaceId}
            />
            {composerError ? (
              <p role="alert" className="mt-2 text-sm text-danger">
                {composerError}
              </p>
            ) : null}
            <p className="mt-2 text-xs text-fg-muted">
              Starts in the background using this project's remembered agent
              settings. ⌘N opens this composer.
            </p>
          </section>
        </div>
      ) : null}
    </div>
  );
}
