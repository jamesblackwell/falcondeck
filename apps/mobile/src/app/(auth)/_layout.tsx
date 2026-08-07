import { Stack } from 'expo-router'
import { useUnistyles } from 'react-native-unistyles'

export default function AuthLayout() {
  const { theme } = useUnistyles()
  return (
    <Stack
      screenOptions={{
        headerShown: false,
        contentStyle: { backgroundColor: theme.colors.surface[0] },
      }}
    />
  )
}
