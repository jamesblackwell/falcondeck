import {
  createContext,
  useCallback,
  useContext,
  useLayoutEffect,
  useRef,
  type ReactNode,
} from "react";

const ThreadLinkContext = createContext<((threadId: string) => void) | null>(null);

export function ThreadLinkProvider({
  onOpenThread,
  children,
}: {
  onOpenThread: (threadId: string) => void;
  children: ReactNode;
}) {
  const opener = useRef(onOpenThread);
  useLayoutEffect(() => {
    opener.current = onOpenThread;
  }, [onOpenThread]);
  // Snapshot/token updates must not invalidate every historical Markdown row.
  const openThread = useCallback((id: string) => opener.current(id), []);
  return (
    <ThreadLinkContext.Provider value={openThread}>
      {children}
    </ThreadLinkContext.Provider>
  );
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
