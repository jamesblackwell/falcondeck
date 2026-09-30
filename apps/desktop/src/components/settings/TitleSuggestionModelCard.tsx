import { useEffect, useState } from 'react'

import type { FalconDeckPreferences, UpdatePreferencesPayload } from '@falcondeck/client-core'
import { DEFAULT_TITLE_SUGGESTION_MODEL } from '@falcondeck/client-core'
import { Button, Input, SettingsSection } from '@falcondeck/ui'

type TitleSuggestionModelCardProps = {
  preferences: FalconDeckPreferences
  onUpdatePreferences: (payload: UpdatePreferencesPayload) => void
}

export function TitleSuggestionModelCard({
  preferences,
  onUpdatePreferences,
}: TitleSuggestionModelCardProps) {
  const model = preferences.title_suggestion_model ?? DEFAULT_TITLE_SUGGESTION_MODEL
  const [draft, setDraft] = useState(model)
  useEffect(() => setDraft(model), [model])

  const candidate = draft.trim()
  const valid = candidate.length > 0 && candidate.length <= 200 && !/\s/.test(candidate)
  const save = () => {
    if (valid && candidate !== model) {
      onUpdatePreferences({ title_suggestion_model: candidate })
    }
  }

  return (
    <SettingsSection
      title="Rename suggestions"
      description="Model used when you choose Suggest title while renaming a task. FalconDeck sends a short conversation excerpt to OpenRouter using the key in Speech settings."
      contentClassName="space-y-3"
    >
      <div className="flex flex-wrap items-end gap-3">
        <label className="min-w-64 flex-1 space-y-1.5">
          <span className="block text-[length:var(--fd-text-sm)] font-medium text-fg-secondary">
            OpenRouter model
          </span>
          <Input
            aria-label="Rename suggestion model"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            maxLength={200}
            spellCheck={false}
            autoComplete="off"
            list="rename-suggestion-models"
          />
          <datalist id="rename-suggestion-models">
            <option value={DEFAULT_TITLE_SUGGESTION_MODEL}>GPT-6 Luna</option>
          </datalist>
        </label>
        <Button type="button" disabled={!valid || candidate === model} onClick={save}>
          Save model
        </Button>
        <Button
          type="button"
          variant="ghost"
          disabled={model === DEFAULT_TITLE_SUGGESTION_MODEL && draft === model}
          onClick={() => {
            setDraft(DEFAULT_TITLE_SUGGESTION_MODEL)
            onUpdatePreferences({ title_suggestion_model: DEFAULT_TITLE_SUGGESTION_MODEL })
          }}
        >
          Reset
        </Button>
      </div>
      {!valid ? (
        <p className="text-[length:var(--fd-text-xs)] text-danger">
          Enter an OpenRouter model ID without spaces.
        </p>
      ) : null}
    </SettingsSection>
  )
}
