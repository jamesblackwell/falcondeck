import { installNativeAes } from '@/crypto/native-aes'
import { installCryptoPolyfill } from '@/crypto/polyfill'
import '@/theme/unistyles'
import { clearLegacyOpenRouterApiKey } from '@/storage/secure'
import { speechLiveActivity } from '@/features/speech/speechLiveActivity'

installCryptoPolyfill()
installNativeAes()
void clearLegacyOpenRouterApiKey()
speechLiveActivity.initialize()

// Ordinary builds do not start the simulator diagnostics collector.
const reliabilityEndpoint = process.env.EXPO_PUBLIC_RELIABILITY_URL
if (reliabilityEndpoint) {
  void import('./lib/reliability-probe').then(({ installReliabilityProbe }) => {
    installReliabilityProbe(reliabilityEndpoint)
  })
}

import 'expo-router/entry'
