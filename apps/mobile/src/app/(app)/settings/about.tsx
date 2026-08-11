import { ScrollView } from 'react-native'
import Constants from 'expo-constants'

import { SettingsRow, SettingsSection, settingsPageStyles } from '@/components/settings'

export default function AboutSettingsScreen() {
  const version = Constants.expoConfig?.version ?? 'Development build'
  const build = Constants.expoConfig?.ios?.buildNumber ?? Constants.expoConfig?.android?.versionCode
  return (
    <ScrollView
      style={settingsPageStyles.container}
      contentContainerStyle={settingsPageStyles.content}
      contentInsetAdjustmentBehavior="automatic"
    >
      <SettingsSection title="FalconDeck Mobile" footer="The daemon remains the source of truth for workspaces and agent conversation history. This phone stores encrypted connection credentials and a reconnect cache.">
        <SettingsRow label="Version" value={version} />
        <SettingsRow label="Build" value={build ? String(build) : '—'} />
      </SettingsSection>
      <SettingsSection title="Architecture">
        <SettingsRow label="Connection" value="Encrypted relay" />
        <SettingsRow label="Conversation storage" value="Agent and daemon" />
        <SettingsRow label="Appearance" value="This device" />
      </SettingsSection>
    </ScrollView>
  )
}
