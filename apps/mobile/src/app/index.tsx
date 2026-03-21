import { Redirect } from 'expo-router'

import { useRelayStore } from '@/store'

export default function IndexScreen() {
  const sessionId = useRelayStore((s) => s.sessionId)

  if (sessionId) {
    return <Redirect href="/(app)" />
  }

  return <Redirect href="/(auth)/pair" />
}
