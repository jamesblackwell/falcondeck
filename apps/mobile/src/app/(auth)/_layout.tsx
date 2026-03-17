import { Stack } from 'expo-router'

import { colors } from '@/theme/tokens'

export default function AuthLayout() {
  return (
    <Stack
      screenOptions={{
        headerShown: false,
        contentStyle: { backgroundColor: colors.surface[0] },
      }}
    />
  )
}
