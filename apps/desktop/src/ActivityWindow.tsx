import { useCallback, useEffect, useRef, useState } from "react";
import { emit, listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { Pin, PinOff } from "lucide-react";

import { ActivityView } from "@falcondeck/chat-ui/activity-view";
import type {
  InteractiveRequest,
  InteractiveResponsePayload,
} from "@falcondeck/client-core";
import { Button, EmptyState, cn } from "@falcondeck/ui";

import {
  ACTIVITY_WINDOW_EVENTS,
  type ActivityRespondResult,
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
  const callSeqRef = useRef(0);

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

    return () => {
      void unlisten.then((off) => off());
      void closing.then((off) => off());
    };
  }, []);

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
    void emit(ACTIVITY_WINDOW_EVENTS.newThread);
    void invoke("focus_main_window").catch(() => {});
  }, []);

  /** Round-trips the answer so the card can still report its own failure. */
  const handleInteractiveResponse = useCallback(
    async (request: InteractiveRequest, response: InteractiveResponsePayload) => {
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

  return (
    <ActivityView
      groups={state.groups}
      interactiveRequests={state.interactiveRequests}
      workspaceHosts={state.workspaceHosts}
      onOpenThread={handleOpenThread}
      onInteractiveResponse={handleInteractiveResponse}
      onMarkThreadRead={handleMarkThreadRead}
      onNewThread={state.canStartThread ? handleNewThread : undefined}
      trafficLightInset
      headerActions={
        <AlwaysOnTopToggle
          pinned={pinned}
          onToggle={() => setPinned((current) => !current)}
        />
      }
    />
  );
}
