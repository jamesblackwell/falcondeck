import { useMemo, useRef, useState } from 'react'
import { Keyboard, Plus, RotateCcw, Search, X } from 'lucide-react'

import {
  Button,
  SegmentedControl,
  SettingsPage,
  SettingsPageHeader,
  SettingsSection,
} from '@falcondeck/ui'

import {
  SHORTCUT_DEFINITIONS,
  bindingsFor,
  resetAllShortcuts,
  resetShortcutBindings,
  setFollowUpBehavior,
  setShortcutBindings,
  shortcutConflict,
  shortcutFromEvent,
  shortcutTokens,
  shortcutValidation,
  useShortcutSettings,
  type ShortcutCommandId,
} from '../../shortcuts'

const CATEGORIES = ['App', 'Navigation', 'View', 'Conversation', 'Composer'] as const

function Keycaps({ shortcut }: { shortcut: string }) {
  return (
    <span className="inline-flex items-center gap-1" aria-label={shortcut}>
      {shortcutTokens(shortcut).map((token, index) => (
        <kbd
          // Repeated modifier symbols are meaningful and index is stable here.
          key={`${token}-${index}`}
          className="inline-flex min-w-6 items-center justify-center rounded-[var(--fd-radius-sm)] border border-border-default bg-surface-1 px-1.5 py-0.5 font-mono text-[length:var(--fd-text-xs)] font-medium text-fg-secondary shadow-[inset_0_-1px_0_var(--color-border-default)]"
        >
          {token}
        </kbd>
      ))}
    </span>
  )
}

function ShortcutRecorder({
  commandId,
  onDone,
}: {
  commandId: ShortcutCommandId
  onDone: () => void
}) {
  const settings = useShortcutSettings()
  const definition = SHORTCUT_DEFINITIONS.find((item) => item.id === commandId)!
  const [preview, setPreview] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const saveRef = useRef<HTMLButtonElement>(null)
  const cancelRef = useRef<HTMLButtonElement>(null)
  const validation = preview ? shortcutValidation(preview, definition.context) : null
  const conflict = preview ? shortcutConflict(preview, commandId, settings) : null
  const canSave = Boolean(preview) && !validation && !conflict

  return (
    <div className="mt-3 rounded-[var(--fd-radius-lg)] border border-accent/40 bg-accent-muted p-3">
      <div className="flex items-center gap-3">
        <div className="flex min-h-9 flex-1 items-center">
          {preview ? (
            <Keycaps shortcut={preview} />
          ) : (
            <span className="text-[length:var(--fd-text-sm)] text-fg-secondary">
              Press the shortcut you want…
            </span>
          )}
        </div>
        <Button
          ref={saveRef}
          type="button"
          size="sm"
          disabled={!canSave}
          onClick={() => {
            if (!preview) return
            setShortcutBindings(commandId, [...bindingsFor(commandId, settings), preview])
            onDone()
          }}
        >
          Save
        </Button>
        <Button ref={cancelRef} type="button" size="sm" variant="ghost" onClick={onDone}>
          Cancel
        </Button>
      </div>
      <input
        ref={inputRef}
        autoFocus
        aria-label={`Record shortcut for ${definition.label}`}
        className="pointer-events-none absolute h-px w-px opacity-0"
        onKeyDown={(event) => {
          event.stopPropagation()
          if (
            event.key === 'Tab' &&
            !event.metaKey &&
            !event.ctrlKey &&
            !event.altKey &&
            !event.shiftKey
          ) {
            event.preventDefault()
            ;(canSave ? saveRef.current : cancelRef.current)?.focus()
            return
          }
          event.preventDefault()
          if (
            event.key === 'Escape' &&
            !event.metaKey &&
            !event.ctrlKey &&
            !event.altKey &&
            !event.shiftKey
          ) {
            onDone()
            return
          }
          setPreview(shortcutFromEvent(event.nativeEvent))
        }}
      />
      {validation ? (
        <p role="alert" className="mt-2 text-[length:var(--fd-text-xs)] text-danger">
          {validation}
        </p>
      ) : conflict ? (
        <p role="alert" className="mt-2 text-[length:var(--fd-text-xs)] text-danger">
          Already used by {conflict.label}.
        </p>
      ) : (
        <p className="mt-2 text-[length:var(--fd-text-xs)] text-fg-muted">
          Tab moves to Save. Escape cancels. Changes apply immediately.
        </p>
      )}
    </div>
  )
}

export function KeyboardShortcutsPanel() {
  const settings = useShortcutSettings()
  const [query, setQuery] = useState('')
  const [keystrokeQuery, setKeystrokeQuery] = useState<string | null>(null)
  const [recording, setRecording] = useState<ShortcutCommandId | null>(null)
  const searchCaptureRef = useRef<HTMLInputElement>(null)
  const commandSearchRef = useRef<HTMLInputElement>(null)

  const visible = useMemo(() => {
    const text = query.trim().toLowerCase()
    return SHORTCUT_DEFINITIONS.filter((definition) => {
      if (keystrokeQuery) return bindingsFor(definition.id, settings).includes(keystrokeQuery)
      if (!text) return true
      return `${definition.label} ${definition.description} ${definition.category}`
        .toLowerCase()
        .includes(text)
    })
  }, [keystrokeQuery, query, settings])

  return (
    <SettingsPage>
      <SettingsPageHeader
        title="Keyboard shortcuts"
        description="Mac-first defaults, fully yours. Add more than one binding, remove any default, or reset a command whenever you like."
        actions={
          <Button type="button" variant="secondary" onClick={resetAllShortcuts}>
            <RotateCcw className="h-4 w-4" aria-hidden="true" /> Reset all
          </Button>
        }
      />

      <SettingsSection
        title="Running follow-ups"
        description="Choose what Send does while an agent is working. “Invert Queue / Steer” uses the other behavior once."
      >
        <SegmentedControl
          ariaLabel="Default follow-up behavior"
          value={settings.followUpBehavior}
          options={[
            { value: 'queue', label: 'Queue' },
            { value: 'steer', label: 'Steer' },
          ]}
          onChange={setFollowUpBehavior}
        />
      </SettingsSection>

      <div className="sticky top-0 z-10 -mx-2 flex flex-wrap gap-2 bg-surface-1/95 px-2 py-3 backdrop-blur">
        <label className="fd-focus-within flex min-w-64 flex-1 items-center gap-2 rounded-[var(--fd-radius-lg)] border border-border-default bg-surface-2 px-3">
          <Search className="h-4 w-4 text-fg-muted" aria-hidden="true" />
          <input
            ref={commandSearchRef}
            value={query}
            onChange={(event) => {
              setQuery(event.target.value)
              setKeystrokeQuery(null)
            }}
            placeholder="Search commands…"
            aria-label="Search shortcut commands"
            className="h-10 w-full bg-transparent text-[length:var(--fd-text-sm)] text-fg-primary outline-none placeholder:text-fg-muted"
          />
        </label>
        <Button
          type="button"
          variant={keystrokeQuery ? 'default' : 'secondary'}
          onClick={() => searchCaptureRef.current?.focus()}
        >
          <Keyboard className="h-4 w-4" aria-hidden="true" />
          {keystrokeQuery ? <Keycaps shortcut={keystrokeQuery} /> : 'Find by keys'}
        </Button>
        {keystrokeQuery ? (
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label="Clear keystroke search"
            onClick={() => setKeystrokeQuery(null)}
          >
            <X className="h-4 w-4" />
          </Button>
        ) : null}
        <input
          ref={searchCaptureRef}
          aria-label="Capture shortcut to search"
          className="absolute h-px w-px opacity-0"
          onKeyDown={(event) => {
            const unmodified = !event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey
            if (event.key === 'Tab' && unmodified) return
            event.stopPropagation()
            event.preventDefault()
            if (event.key === 'Escape' && unmodified) {
              setKeystrokeQuery(null)
              commandSearchRef.current?.focus()
              return
            }
            const shortcut = shortcutFromEvent(event.nativeEvent)
            if (shortcut) {
              setKeystrokeQuery(shortcut)
              setQuery('')
            }
          }}
        />
      </div>

      {visible.length === 0 ? (
        <div className="rounded-[var(--fd-radius-xl)] border border-dashed border-border-default px-6 py-12 text-center">
          <Keyboard className="mx-auto h-6 w-6 text-fg-muted" aria-hidden="true" />
          <p className="mt-3 text-[length:var(--fd-text-sm)] font-medium text-fg-primary">
            No shortcuts found
          </p>
          <p className="mt-1 text-[length:var(--fd-text-xs)] text-fg-muted">
            Try another command name or key combination.
          </p>
        </div>
      ) : null}

      {CATEGORIES.map((category) => {
        const definitions = visible.filter((definition) => definition.category === category)
        if (definitions.length === 0) return null
        return (
          <section key={category} aria-labelledby={`shortcuts-${category}`}>
            <h2
              id={`shortcuts-${category}`}
              className="mb-2 px-1 text-[length:var(--fd-text-xs)] font-medium uppercase tracking-[0.18em] text-fg-muted"
            >
              {category}
            </h2>
            <div className="divide-y divide-border-subtle overflow-hidden rounded-[var(--fd-radius-xl)] border border-border-subtle bg-surface-2">
              {definitions.map((definition) => {
                const currentBindings = bindingsFor(definition.id, settings)
                const customized = Object.prototype.hasOwnProperty.call(
                  settings.bindings,
                  definition.id,
                )
                return (
                  <div key={definition.id} className="px-4 py-3.5">
                    <div className="flex items-center gap-4">
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <p className="text-[length:var(--fd-text-sm)] font-medium text-fg-primary">
                            {definition.label}
                          </p>
                          {customized ? (
                            <span className="text-[length:var(--fd-text-2xs)] text-accent">
                              Customized
                            </span>
                          ) : null}
                        </div>
                        <p className="mt-1 text-[length:var(--fd-text-xs)] text-fg-muted">
                          {definition.description}
                        </p>
                      </div>
                      <div className="flex max-w-[48%] flex-wrap items-center justify-end gap-2">
                        {currentBindings.length === 0 ? (
                          <span className="text-[length:var(--fd-text-xs)] text-fg-muted">
                            Unassigned
                          </span>
                        ) : null}
                        {currentBindings.map((shortcut) => (
                          <span
                            key={shortcut}
                            className="inline-flex items-center gap-1 rounded-[var(--fd-radius-md)] bg-surface-1 p-1 pl-1.5"
                          >
                            <Keycaps shortcut={shortcut} />
                            <button
                              type="button"
                              className="fd-focus rounded p-1 text-fg-muted hover:bg-surface-3 hover:text-fg-primary"
                              aria-label={`Remove ${shortcut} from ${definition.label}`}
                              onClick={() =>
                                setShortcutBindings(
                                  definition.id,
                                  currentBindings.filter((item) => item !== shortcut),
                                )
                              }
                            >
                              <X className="h-3 w-3" />
                            </button>
                          </span>
                        ))}
                        <button
                          type="button"
                          className="fd-focus rounded-[var(--fd-radius-md)] p-2 text-fg-muted hover:bg-surface-3 hover:text-fg-primary"
                          aria-label={`Add shortcut for ${definition.label}`}
                          onClick={() => setRecording(definition.id)}
                        >
                          <Plus className="h-4 w-4" />
                        </button>
                        {customized ? (
                          <button
                            type="button"
                            className="fd-focus rounded-[var(--fd-radius-md)] p-2 text-fg-muted hover:bg-surface-3 hover:text-fg-primary"
                            aria-label={`Reset ${definition.label}`}
                            onClick={() => resetShortcutBindings(definition.id)}
                          >
                            <RotateCcw className="h-3.5 w-3.5" />
                          </button>
                        ) : null}
                      </div>
                    </div>
                    {recording === definition.id ? (
                      <ShortcutRecorder
                        commandId={definition.id}
                        onDone={() => setRecording(null)}
                      />
                    ) : null}
                  </div>
                )
              })}
            </div>
          </section>
        )
      })}
    </SettingsPage>
  )
}
