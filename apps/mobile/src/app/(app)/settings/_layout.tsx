import { Pressable } from 'react-native'
import { Stack, useRouter } from 'expo-router'
import { X } from 'lucide-react-native'
import { useUnistyles } from 'react-native-unistyles'

export default function SettingsLayout() {
  const { theme } = useUnistyles()
  const router = useRouter()

  // Settings is a drawer sibling, not a pushed screen, so the root has no back
  // button of its own — without this there is no way out but the swipe gesture.
  const renderCloseButton = () => (
    <Pressable
      onPress={() => router.navigate('/(app)')}
      accessibilityRole="button"
      accessibilityLabel="Close settings"
      hitSlop={12}
    >
      <X size={theme.iconSize.lg} color={theme.colors.fg.primary} />
    </Pressable>
  )

  return (
    <Stack
      screenOptions={{
        headerShown: true,
        headerBackTitle: 'Back',
        headerShadowVisible: false,
        headerStyle: { backgroundColor: theme.colors.surface[0] },
        headerTintColor: theme.colors.fg.primary,
        headerTitleStyle: { color: theme.colors.fg.primary },
        contentStyle: { backgroundColor: theme.colors.surface[0] },
      }}
    >
      <Stack.Screen
        name="index"
        options={{
          title: 'Settings',
          headerLargeTitleEnabled: true,
          headerRight: renderCloseButton,
        }}
      />
      <Stack.Screen name="connections" options={{ title: 'Connections' }} />
      <Stack.Screen name="appearance" options={{ title: 'Appearance' }} />
      <Stack.Screen name="conversation" options={{ title: 'Conversation' }} />
      <Stack.Screen name="notifications" options={{ title: 'Notifications' }} />
      <Stack.Screen name="about" options={{ title: 'About FalconDeck' }} />
    </Stack>
  )
}
