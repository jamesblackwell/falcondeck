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
        footer={
          settings.provider
            ? 'You can change this at any time.'
            : 'Not set yet — FalconDeck asks the first time you record.'
        }
      >
        <ChoiceRow
          label="On-device"
          description="Keep speech on this phone. Works offline."
          selected={settings.provider === 'on-device'}
          onPress={() => selectProvider('on-device')}
        />
        <ChoiceRow
          label="OpenRouter"
          description="Send audio to your desktop, encrypted end to end."
          selected={settings.provider === 'openrouter'}
          onPress={() => selectProvider('openrouter')}
        />
      </SettingsSection>

      {settings.provider === 'openrouter' ? (
        <SettingsSection
          title="OpenRouter"
          footer="Manage the API key in FalconDeck desktop settings; it never reaches this phone or the relay. A recording that fails to send stays on this phone so you can retry."
        >
          <SettingsRow
            label="API key"
            detail={
              desktopStatus === 'configured'
                ? 'Stored on the paired desktop'
                : desktopStatus === 'missing'
                  ? 'Not configured — open FalconDeck settings on your desktop'
                  : desktopStatus === 'offline'
                    ? 'Could not check desktop. Tap to retry.'
                    : 'Checking desktop…'
            }
            value={
              desktopStatus === 'configured'
                ? 'Ready'
                : desktopStatus === 'offline'
                  ? 'Retry'
                  : undefined
            }
            // Only offer the tap when there is something to retry — a chevron
            // on a row that is already Ready promises a screen that isn't there.
            onPress={
              desktopStatus === 'configured'
                ? undefined
                : () => setRefreshKey((current) => current + 1)
            }
            accessibilityHint="Check the paired desktop again"
          />
          <SettingsRow
            label="Model"
            detail={
              modelsError ??
              (models.length
                ? `${models.length} ${models.length === 1 ? 'model' : 'models'} available`
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
