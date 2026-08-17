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
      <SettingsSection
        title="FalconDeck Mobile"
        footer="Your projects and conversation history live on your desktop. This phone stores only its encrypted connection and a cache for fast reconnects."
      >
        <SettingsRow label="Version" value={version} />
        <SettingsRow label="Build" value={build ? String(build) : '—'} />
      </SettingsSection>
    </ScrollView>
  )
}
