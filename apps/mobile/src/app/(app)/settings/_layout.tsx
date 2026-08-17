import { Pressable } from 'react-native'
import { Stack, useRouter } from 'expo-router'
import { X } from 'lucide-react-native'
import { StyleSheet, useUnistyles } from 'react-native-unistyles'

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
      hitSlop={6}
      style={({ pressed }) => [styles.closeButton, pressed && styles.closeButtonPressed]}
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
          // No large title here: on iOS 26 the nav bar reserved its row but
          // never painted the label, leaving a headerless-looking gap. The
          // inline title matches the child screens anyway.
          headerRight: renderCloseButton,
        }}
      />
      <Stack.Screen name="connections" options={{ title: 'Connections' }} />
      <Stack.Screen name="appearance" options={{ title: 'Appearance' }} />
      <Stack.Screen name="conversation" options={{ title: 'Conversation' }} />
      <Stack.Screen name="notifications" options={{ title: 'Notifications' }} />
      <Stack.Screen name="speech" options={{ title: 'Speech' }} />
      <Stack.Screen name="about" options={{ title: 'About FalconDeck' }} />
    </Stack>
  )
}

const styles = StyleSheet.create((theme) => ({
  closeButton: {
    width: theme.minTouchTarget,
    height: theme.minTouchTarget,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: theme.radius.full,
  },
  closeButtonPressed: {
    backgroundColor: theme.colors.surface[2],
  },
}))
