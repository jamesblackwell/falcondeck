import {
  AppearanceControls,
  SettingsPage,
  SettingsPageHeader,
  SettingsSection,
} from '@falcondeck/ui'

export function AppearanceSettingsPanel() {
  return (
    <SettingsPage>
      <SettingsPageHeader
        title="Appearance"
        description="Stored on this device, so each machine can match its own display and system theme."
      />

      <SettingsSection
        title="Theme and type"
        description="Switch between light and dark, or let FalconDeck follow the system automatically."
      >
        <AppearanceControls />
      </SettingsSection>
    </SettingsPage>
  )
}
