import { useEffect, useMemo, useState } from 'react'
import { ScrollView } from 'react-native'

import {
  ChoiceRow,
  SettingsRow,
  SettingsSection,
  settingsPageStyles,
} from '@/components/settings'
import { OptionSheet, type OptionSheetItem } from '@/components/ui'
import {
  fetchOpenRouterSpeechModels,
  getDesktopSpeechStatus,
  type SpeechModel,
} from '@/features/speech/openRouterTranscription'
import {
  getSpeechSettings,
  updateSpeechSettings,
  type SpeechProvider,
} from '@/features/speech/speechSettings'

export default function SpeechSettingsScreen() {
  const [settings, setSettings] = useState(getSpeechSettings)
  const [desktopStatus, setDesktopStatus] = useState<
    'checking' | 'configured' | 'missing' | 'offline'
  >('checking')
  const [models, setModels] = useState<SpeechModel[]>([])
  const [modelsError, setModelsError] = useState<string | null>(null)
  const [showModels, setShowModels] = useState(false)
  const [refreshKey, setRefreshKey] = useState(0)

  useEffect(() => {
    if (settings.provider !== 'openrouter') return
    let active = true
    setDesktopStatus('checking')
    setModelsError(null)
    void (async () => {
      try {
        const status = await getDesktopSpeechStatus()
        if (!active) return
        setDesktopStatus(status.configured ? 'configured' : 'missing')
      } catch {
        if (active) setDesktopStatus('offline')
        return
      }
      try {
        const availableModels = await fetchOpenRouterSpeechModels()
        if (active) setModels(availableModels)
      } catch {
        if (!active) return
        setModelsError(
          'Could not refresh models. Tap to retry; your saved model still works.',
        )
      }
    })()
    return () => {
      active = false
    }
  }, [refreshKey, settings.provider])

  const modelItems = useMemo<OptionSheetItem[]>(() => {
    const available = models.map((model) => ({
      value: model.id,
      label: model.name,
      description: model.id,
    }))
    return available.some((model) => model.value === settings.model)
      ? available
      : [{ value: settings.model, label: settings.model }, ...available]
  }, [models, settings.model])

  const selectProvider = (provider: SpeechProvider) => {
    setSettings(updateSpeechSettings({ provider }))
  }

  return (
    <ScrollView
      style={settingsPageStyles.container}
      contentContainerStyle={settingsPageStyles.content}
      contentInsetAdjustmentBehavior="automatic"
      keyboardShouldPersistTaps="handled"
    >
      <SettingsSection
        title="Transcription"
        footer="You can change this at any time. On-device recognition requires a speech model supported by your phone."
      >
        <ChoiceRow
          label="On-device"
          description="Keep speech on this phone and work offline."
          selected={settings.provider === 'on-device'}
          onPress={() => selectProvider('on-device')}
        />
        <ChoiceRow
          label="OpenRouter"
          description="Encrypt audio to your paired desktop for transcription."
          selected={settings.provider === 'openrouter'}
          onPress={() => selectProvider('openrouter')}
        />
      </SettingsSection>

      {settings.provider === 'openrouter' ? (
        <SettingsSection
          title="OpenRouter"
          footer="Add or remove the API key in FalconDeck desktop settings. The key never reaches this phone or FalconDeck's relay. Failed recordings remain local for retry."
        >
          <SettingsRow
            label="Desktop credential"
            detail={
              desktopStatus === 'configured'
                ? 'Stored in the desktop OS credential store'
                : desktopStatus === 'missing'
                  ? 'Not configured — open FalconDeck settings on your desktop'
                  : desktopStatus === 'offline'
                    ? 'Paired desktop did not respond. Tap to retry.'
                    : 'Checking paired desktop…'
            }
            value={
              desktopStatus === 'configured'
                ? 'Ready'
                : desktopStatus === 'offline'
                  ? 'Retry'
                  : undefined
            }
            onPress={() => setRefreshKey((current) => current + 1)}
            accessibilityHint="Check the paired desktop again"
          />
          <SettingsRow
            label="Model"
            detail={
              modelsError ??
              (models.length
                ? `${models.length} transcription models available`
                : 'Loading available models…')
            }
            value={settings.model.split('/').pop()}
            onPress={() => setShowModels(true)}
          />
        </SettingsSection>
      ) : null}

      {showModels ? (
        <OptionSheet
          title="Transcription model"
          items={modelItems}
          selected={settings.model}
          onSelect={(model) => {
            setSettings(updateSpeechSettings({ model }))
            setShowModels(false)
          }}
          onClose={() => setShowModels(false)}
        />
      ) : null}
    </ScrollView>
  )
}
