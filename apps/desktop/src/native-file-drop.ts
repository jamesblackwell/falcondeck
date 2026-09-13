import { useEffect, useRef, useState } from "react";
import { mediaTypeForFileName } from "@falcondeck/client-core";

import { isTauriDesktop } from "./api";

export type DroppedAttachment = {
  path: string;
  name: string;
  mimeType: string | null;
  dataBase64: string;
};

/**
 * The webview never sees a native drag: Tauri consumes it and reports the
 * dropped paths instead, so the composer's DOM drop handlers stay dead in the
 * packaged app. These helpers rebuild browser `File`s from those paths so the
 * shared attachment pipeline (prepare, budget, send) handles a Finder drop
 * exactly like a paste.
 */
type DroppedAttachmentsResponse = {
  attachments: DroppedAttachment[];
  skipped: string[];
};

export async function readDroppedAttachments(
  paths: readonly string[],
): Promise<DroppedAttachmentsResponse> {
  if (!isTauriDesktop() || paths.length === 0) {
    return { attachments: [], skipped: [] };
  }
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<DroppedAttachmentsResponse>("read_dropped_attachments", {
    paths: [...paths],
  });
}

export function droppedAttachmentToFile(attachment: DroppedAttachment): File {
  const binary = atob(attachment.dataBase64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  const type =
    attachment.mimeType?.trim() || mediaTypeForFileName(attachment.name) || "";
  return new File([bytes], attachment.name, { type });
}

export async function readDroppedFiles(
  paths: readonly string[],
): Promise<{ files: File[]; skipped: string[] }> {
  const { attachments, skipped } = await readDroppedAttachments(paths);
  return { files: attachments.map(droppedAttachmentToFile), skipped };
}

type NativeFileDropOptions = {
  /** Called with the dropped files, already typed for the shared pipeline. */
  onFiles: (files: File[]) => void;
  onError?: (message: string) => void;
  /** Ignore drops while the composer cannot accept attachments. */
  enabled?: boolean;
};

/**
 * Subscribe to the platform drag-drop events for this webview.
 *
 * Returns whether a drag is currently over the window so the composer can show
 * its drop affordance; the DOM would otherwise never report one.
 */
export function useNativeFileDrop({
  onFiles,
  onError,
  enabled = true,
}: NativeFileDropOptions): boolean {
  const [dragActive, setDragActive] = useState(false);
  const onFilesRef = useLatest(onFiles);
  const onErrorRef = useLatest(onError);
  const enabledRef = useLatest(enabled);

  useEffect(() => {
    if (!isTauriDesktop()) return;
    let disposed = false;
    let unlisten: (() => void) | null = null;

    void (async () => {
      const { getCurrentWebview } = await import("@tauri-apps/api/webview");
      const stop = await getCurrentWebview().onDragDropEvent((event) => {
        // `enter` also carries the paths, so only `drop` may read them —
        // otherwise a drag merely passing over the window would attach them.
        if (event.payload.type !== "drop") {
          setDragActive(event.payload.type !== "leave");
          return;
        }
        setDragActive(false);
        const paths = event.payload.paths ?? [];
        if (paths.length === 0) return;
        if (!enabledRef.current) return;
        void readDroppedFiles(paths)
          .then(({ files, skipped }) => {
            if (skipped.length > 0) onErrorRef.current?.(skipped.join(" "));
            if (files.length > 0) onFilesRef.current(files);
          })
          .catch((error: unknown) => {
            onErrorRef.current?.(
              error instanceof Error ? error.message : String(error),
            );
          });
      });
      if (disposed) stop();
      else unlisten = stop;
    })();

    return () => {
      disposed = true;
      unlisten?.();
    };
    // Handlers are read through refs so a changing callback identity never
    // tears down the platform listener mid-drag.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return dragActive;
}

/** Keeps the newest callback reachable from a listener registered once. */
function useLatest<T>(value: T) {
  const ref = useRef(value);
  useEffect(() => {
    ref.current = value;
  }, [value]);
  return ref;
}
