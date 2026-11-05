import {
  createContext,
  useCallback,
  useContext,
  useLayoutEffect,
  useRef,
  type ReactNode,
} from "react";

type ThreadTitleLookup = (threadId: string) => string | null | undefined;

const ThreadLinkContext = createContext<((threadId: string) => void) | null>(null);
const ThreadTitleContext = createContext<ThreadTitleLookup | null>(null);

export function ThreadLinkProvider({
  onOpenThread,
  threadTitle,
  children,
}: {
  onOpenThread: (threadId: string) => void;
  /** Current title of a task, for rows that name one. */
  threadTitle?: ThreadTitleLookup;
  children: ReactNode;
}) {
  const opener = useRef(onOpenThread);
  const titles = useRef(threadTitle);
  useLayoutEffect(() => {
    opener.current = onOpenThread;
    titles.current = threadTitle;
  }, [onOpenThread, threadTitle]);
  // Snapshot/token updates must not invalidate every historical Markdown row.
  const openThread = useCallback((id: string) => opener.current(id), []);
  const lookUpTitle = useCallback((id: string) => titles.current?.(id), []);
  return (
    <ThreadLinkContext.Provider value={openThread}>
      <ThreadTitleContext.Provider value={lookUpTitle}>
        {children}
      </ThreadTitleContext.Provider>
    </ThreadLinkContext.Provider>
  );
}

/** Titles are read when a row renders, so a rename shows on its next render. */
export function useThreadTitleLookup() {
  return useContext(ThreadTitleContext);
}

export function useThreadLinksAvailable() {
  return useContext(ThreadLinkContext) !== null;
}

export function ThreadLinkAnchor({
  threadId,
  href,
  className,
  children,
}: {
  threadId: string;
  href: string;
  className?: string;
  children?: ReactNode;
}) {
  const openThread = useContext(ThreadLinkContext);
  if (!openThread) return <span className={className}>{children}</span>;
  return (
    <a
      href={href}
      className={className}
      onClick={(event) => {
        event.preventDefault();
        openThread(threadId);
      }}
    >
      {children}
    </a>
  );
}
