import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  markdownToSpeechText,
  prepareReadAloudText,
  splitReadAloudText,
} from "@falcondeck/client-core";

export { markdownToSpeechText, prepareReadAloudText, splitReadAloudText };

export type ReadAloudController = {
  activeMessageId: string | null;
  loadingMessageId: string | null;
  awaitingGestureMessageId: string | null;
  play: (messageId: string, markdown: string) => void;
  resume: () => void;
  stop: () => void;
};

function isAutoplayBlocked(error: unknown) {
  return error instanceof DOMException && error.name === "NotAllowedError";
}

type ActivePlayback = {
  request: number;
  resume: () => void;
  cancel: () => void;
};

/** Keeps a single response playing at a time and releases generated audio URLs. */
export function useReadAloud(
  synthesize: (text: string) => Promise<Blob>,
  onError?: (error: Error) => void,
): ReadAloudController {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const urlRef = useRef<string | null>(null);
  const requestRef = useRef(0);
  const playbackRef = useRef<ActivePlayback | null>(null);
  const [activeMessageId, setActiveMessageId] = useState<string | null>(null);
  const [loadingMessageId, setLoadingMessageId] = useState<string | null>(null);
  const [awaitingGestureMessageId, setAwaitingGestureMessageId] = useState<
    string | null
  >(null);

  const releaseAudio = useCallback(() => {
    audioRef.current?.pause();
    audioRef.current = null;
    if (urlRef.current) URL.revokeObjectURL(urlRef.current);
    urlRef.current = null;
  }, []);

  const clearPlayback = useCallback(() => {
    setActiveMessageId(null);
    setLoadingMessageId(null);
    setAwaitingGestureMessageId(null);
  }, []);

  const stop = useCallback(() => {
    requestRef.current += 1;
    playbackRef.current?.cancel();
    playbackRef.current = null;
    releaseAudio();
    clearPlayback();
  }, [clearPlayback, releaseAudio]);

  const playBlob = useCallback(
    (blob: Blob, messageId: string, request: number) => {
      releaseAudio();
      const url = URL.createObjectURL(blob);
      urlRef.current = url;
      const audio = new Audio(url);
      audioRef.current = audio;

      return new Promise<void>((resolve, reject) => {
        let settled = false;
        const finish = (error?: Error) => {
          if (settled) return;
          settled = true;
          playbackRef.current = null;
          releaseAudio();
          if (error) reject(error);
          else resolve();
        };
        const start = () => {
          void audio.play().then(
            () => {
              if (request !== requestRef.current) return finish();
              setAwaitingGestureMessageId(null);
              setActiveMessageId(messageId);
            },
            (error: unknown) => {
              if (request !== requestRef.current) return finish();
              if (isAutoplayBlocked(error)) {
                setActiveMessageId(null);
                setAwaitingGestureMessageId(messageId);
                return;
              }
              finish(
                error instanceof Error ? error : new Error("Unable to play speech"),
              );
            },
          );
        };
        audio.addEventListener("ended", () => finish(), { once: true });
        audio.addEventListener(
          "error",
          () => finish(new Error("Unable to decode Read Aloud audio")),
          { once: true },
        );
        playbackRef.current = { request, resume: start, cancel: () => finish() };
        setLoadingMessageId(null);
        setActiveMessageId(messageId);
        start();
      });
    },
    [releaseAudio],
  );

  const play = useCallback(
    (messageId: string, markdown: string) => {
      const chunks = splitReadAloudText(prepareReadAloudText(markdown));
      if (chunks.length === 0) return;
      stop();
      const request = requestRef.current;
      setLoadingMessageId(messageId);
      void (async () => {
        try {
          const prefetch = (chunk: string) => {
            const pending = synthesize(chunk);
            // A later chunk can be abandoned when the user stops playback.
            // Observe its rejection now; awaiting it below still propagates a
            // failure when the playback remains active.
            void pending.catch(() => undefined);
            return pending;
          };
          let next: Promise<Blob> | null = prefetch(chunks[0]!);
          for (let index = 0; index < chunks.length; index += 1) {
            const pending = next;
            if (!pending) return;
            const blob = await pending;
            if (request !== requestRef.current) return;
            next =
              index + 1 < chunks.length
                ? prefetch(chunks[index + 1]!)
                : null;
            await playBlob(blob, messageId, request);
            if (request !== requestRef.current) return;
          }
          clearPlayback();
        } catch (error) {
          if (request !== requestRef.current) return;
          releaseAudio();
          clearPlayback();
          onError?.(
            error instanceof Error ? error : new Error("Unable to play speech"),
          );
        }
      })();
    },
    [clearPlayback, onError, playBlob, releaseAudio, stop, synthesize],
  );

  const resume = useCallback(() => {
    const playback = playbackRef.current;
    if (playback?.request === requestRef.current) playback.resume();
  }, []);

  useEffect(() => stop, [stop]);
  return useMemo(
    () => ({ activeMessageId, loadingMessageId, awaitingGestureMessageId, play, resume, stop }),
    [activeMessageId, awaitingGestureMessageId, loadingMessageId, play, resume, stop],
  );
}
