import { Stack } from 'expo-router'

import { colors } from '@/theme/tokens'

export default function SettingsLayout() {
  return (
    <Stack
      screenOptions={{
        headerShown: false,
        contentStyle: { backgroundColor: colors.surface[0] },
      }}
    />
  )
}
