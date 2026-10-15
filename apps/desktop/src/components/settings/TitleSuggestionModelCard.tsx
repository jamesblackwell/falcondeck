import { useEffect, useState } from 'react'

import type { FalconDeckPreferences, UpdatePreferencesPayload } from '@falcondeck/client-core'
import { DEFAULT_TITLE_SUGGESTION_MODEL, DEFAULT_TITLE_SUGGESTION_PROMPT } from '@falcondeck/client-core'
import { Button, Field, Input, SettingsSection, Textarea } from '@falcondeck/ui'

type TitleSuggestionModelCardProps = {
  preferences: FalconDeckPreferences
  onUpdatePreferences: (payload: UpdatePreferencesPayload) => void
}

/** Title style (shared by automatic and suggested titles) and the OpenRouter
 * model behind Suggest title in the rename dialog. */
export function TitleSuggestionModelCard({
  preferences,
  onUpdatePreferences,
}: TitleSuggestionModelCardProps) {
  const model = preferences.title_suggestion_model ?? DEFAULT_TITLE_SUGGESTION_MODEL
  const [draft, setDraft] = useState(model)
  useEffect(() => setDraft(model), [model])
  const prompt = preferences.title_suggestion_prompt ?? DEFAULT_TITLE_SUGGESTION_PROMPT
  const [promptDraft, setPromptDraft] = useState(prompt)
  useEffect(() => setPromptDraft(prompt), [prompt])
  const promptCandidate = promptDraft.trim() || DEFAULT_TITLE_SUGGESTION_PROMPT

  const candidate = draft.trim()
  const valid = candidate.length > 0 && candidate.length <= 200 && !/\s/.test(candidate)
  const save = () => {
    if (valid && candidate !== model) {
      onUpdatePreferences({ title_suggestion_model: candidate })
    }
  }

  return (
    <>
      <SettingsSection
        title="Title style"
        description="Instructions for every generated title, automatic or suggested, on any device. Existing titles keep their name until you rename them."
        contentClassName="space-y-3"
      >
        <Field
          label="Title prompt"
          htmlFor="title-prompt"
          hint="For example, “Use 2–3 words in ALL CAPS.”"
        >
          <Textarea
            id="title-prompt"
            aria-label="Title prompt"
            value={promptDraft}
            onChange={(event) => setPromptDraft(event.target.value)}
            maxLength={2000}
            rows={4}
            placeholder="Use 2–3 words in ALL CAPS. Keep titles simple and specific."
          />
        </Field>
        <div className="flex gap-2">
          <Button
            type="button"
            disabled={promptCandidate === prompt}
            onClick={() => onUpdatePreferences({ title_suggestion_prompt: promptCandidate })}
          >
            Save prompt
          </Button>
          <Button
            type="button"
            variant="ghost"
            disabled={prompt === DEFAULT_TITLE_SUGGESTION_PROMPT && promptDraft === prompt}
            onClick={() => {
              setPromptDraft(DEFAULT_TITLE_SUGGESTION_PROMPT)
              onUpdatePreferences({ title_suggestion_prompt: DEFAULT_TITLE_SUGGESTION_PROMPT })
            }}
          >
            Reset prompt
          </Button>
        </div>
      </SettingsSection>

      <SettingsSection
        title="Suggest title"
        description="The OpenRouter model behind Suggest title in the rename dialog. A short conversation excerpt is sent only when you ask for a suggestion."
      >
        <Field
          label="OpenRouter model"
          htmlFor="rename-suggestion-model"
        >
          <div className="flex flex-wrap items-center gap-2">
            <Input
              id="rename-suggestion-model"
              aria-label="Rename suggestion model"
              className="min-w-64 flex-1"
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
              Reset model
            </Button>
          </div>
          {!valid ? (
            <p className="text-[length:var(--fd-text-xs)] text-danger">
              Enter an OpenRouter model ID without spaces.
            </p>
          ) : null}
        </Field>
      </SettingsSection>
    </>
  )
}
