import { Redirect, useLocalSearchParams } from 'expo-router'

import { pairingPayloadFromSearchParams } from '@/features/pairing/parsePairingQr'
import { useRelayStore } from '@/store'

export default function IndexScreen() {
  const sessionId = useRelayStore((s) => s.sessionId)
  const incomingParams = useLocalSearchParams<{
    code?: string | string[]
    relay?: string | string[]
  }>()
  const incomingPayload = pairingPayloadFromSearchParams(incomingParams)

  // Camera / Universal Links to https://app.falcondeck.com?code= land on `/`.
  // Keep the pairing grant and send it to the pair screen instead of dropping it.
  if (incomingPayload) {
    const params = new URL(incomingPayload).searchParams
    const query = params.toString()
    return <Redirect href={`/(auth)/pair?${query}`} />
  }

  if (sessionId) {
    return <Redirect href="/(app)" />
  }

  return <Redirect href="/(auth)/pair" />
}
