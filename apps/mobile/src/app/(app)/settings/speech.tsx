import { useEffect, useMemo, useState } from 'react'
import { ScrollView, View } from 'react-native'
import { StyleSheet } from 'react-native-unistyles'

import {
  ChoiceRow,
  SettingsRow,
  SettingsSection,
  settingsPageStyles,
} from '@/components/settings'
import {
  Button,
  Input,
  OptionSheet,
  Text,
  type OptionSheetItem,
} from '@/components/ui'
import {
  fetchOpenRouterSpeechModels,
  type SpeechModel,
} from '@/features/speech/openRouterTranscription'
import {
  getSpeechSettings,
  updateSpeechSettings,
  type SpeechProvider,
} from '@/features/speech/speechSettings'
import {
  clearOpenRouterApiKey,
  loadOpenRouterApiKey,
  persistOpenRouterApiKey,
} from '@/storage/secure'

export default function SpeechSettingsScreen() {
  const [settings, setSettings] = useState(getSpeechSettings)
  const [apiKey, setApiKey] = useState('')
  const [hasSavedKey, setHasSavedKey] = useState(false)
  const [isSaving, setIsSaving] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const [models, setModels] = useState<SpeechModel[]>([])
  const [modelsError, setModelsError] = useState<string | null>(null)
  const [showModels, setShowModels] = useState(false)

  useEffect(() => {
    void loadOpenRouterApiKey().then((key) => setHasSavedKey(Boolean(key)))
    void fetchOpenRouterSpeechModels()
      .then(setModels)
      .catch(() =>
        setModelsError(
          'Could not refresh the model list. Your saved model will still work.',
        ),
      )
  }, [])

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
    setNotice(null)
  }

  const saveKey = async () => {
    const cleaned = apiKey.trim()
    if (!cleaned) return
    setIsSaving(true)
    try {
      await persistOpenRouterApiKey(cleaned)
      setApiKey('')
      setHasSavedKey(true)
      setSettings(updateSpeechSettings({ provider: 'openrouter' }))
      setNotice('OpenRouter API key saved securely on this device.')
    } catch {
      setNotice('Could not save the API key.')
    } finally {
      setIsSaving(false)
    }
  }

  const removeKey = async () => {
    await clearOpenRouterApiKey()
    setApiKey('')
    setHasSavedKey(false)
    setNotice('OpenRouter API key removed.')
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
          description="Record locally, then transcribe with your selected model."
          selected={settings.provider === 'openrouter'}
          onPress={() => selectProvider('openrouter')}
        />
      </SettingsSection>

      <SettingsSection
        title="OpenRouter"
        footer="The key is stored in the phone's secure keychain. Audio is retained locally if a transcription request fails."
      >
        <View style={styles.keyEditor}>
          <Input
            value={apiKey}
            onChangeText={setApiKey}
            placeholder={
              hasSavedKey ? 'API key saved — enter a replacement' : 'sk-or-v1-…'
            }
            secureTextEntry
            autoCapitalize="none"
            autoCorrect={false}
            accessibilityLabel="OpenRouter API key"
          />
          <View style={styles.keyActions}>
            <Button
              label="Save key"
              size="sm"
              onPress={() => void saveKey()}
              disabled={!apiKey.trim()}
              loading={isSaving}
            />
            {hasSavedKey ? (
              <Button
                label="Remove"
                size="sm"
                variant="ghost"
                onPress={() => void removeKey()}
              />
            ) : null}
          </View>
        </View>
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

      {notice ? (
        <Text
          variant="caption"
          color={notice.includes('Could not') ? 'danger' : 'secondary'}
          accessibilityLiveRegion="polite"
        >
          {notice}
        </Text>
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

const styles = StyleSheet.create((theme) => ({
  keyEditor: {
    padding: theme.spacing[4],
    gap: theme.spacing[3],
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.border.subtle,
  },
  keyActions: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    gap: theme.spacing[2],
  },
}))
