import { Component, type ErrorInfo, type ReactNode } from 'react'

import { Button } from '@falcondeck/ui'

import { TriangleAlert } from 'lucide-react'

import { clearStoredRemoteState } from '../lib/remoteAppUtils'

type RemoteErrorBoundaryState = {
  error: Error | null
}

/**
 * A browser tab has no menu bar to escape to: an uncaught render error would
 * otherwise leave a blank page, and reloading replays the same persisted
 * state that caused it. Offer both a plain reload and a clean slate.
 */
export class RemoteErrorBoundary extends Component<
  { children: ReactNode },
  RemoteErrorBoundaryState
> {
  state: RemoteErrorBoundaryState = { error: null }

  static getDerivedStateFromError(error: Error): RemoteErrorBoundaryState {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('FalconDeck Remote crashed', error, info.componentStack)
  }

  render() {
    const { error } = this.state
    if (!error) return this.props.children

    return (
      <div className="fd-safe-area-padded flex min-h-[100dvh] flex-col items-center justify-center bg-surface-0">
        <div
          role="alert"
          className="w-full max-w-md space-y-4 rounded-[var(--fd-radius-xl)] border border-danger/25 bg-danger-muted/60 px-5 py-5"
        >
          <div className="flex items-center gap-2">
            <TriangleAlert aria-hidden="true" className="h-5 w-5 text-danger" />
            <h1 className="text-[length:var(--fd-text-lg)] font-semibold text-fg-primary">
              FalconDeck Remote stopped
            </h1>
          </div>
          <p className="text-[length:var(--fd-text-sm)] text-fg-secondary">
            Something in this page failed and it cannot keep rendering. Your desktop session is
            unaffected — nothing here runs on it.
          </p>
          <p className="break-words font-mono text-[length:var(--fd-text-xs)] text-fg-muted">
            {error.message}
          </p>
          <div className="flex flex-wrap gap-2">
            <Button type="button" onClick={() => window.location.reload()}>
              Reload
            </Button>
            <Button
              type="button"
              variant="outline"
              onClick={() => {
                clearStoredRemoteState()
                window.location.reload()
              }}
            >
              Clear saved state and reload
            </Button>
          </div>
          <p className="fd-type-meta text-fg-muted">
            Clearing saved state unpairs this browser; you will need a fresh pairing code.
          </p>
        </div>
      </div>
    )
  }
}
