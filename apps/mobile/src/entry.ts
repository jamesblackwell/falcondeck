import { installCryptoPolyfill } from '@/crypto/polyfill'
import '@/theme/unistyles'
import { clearLegacyOpenRouterApiKey } from '@/storage/secure'
import { speechLiveActivity } from '@/features/speech/speechLiveActivity'

installCryptoPolyfill()
void clearLegacyOpenRouterApiKey()
speechLiveActivity.initialize()

import 'expo-router/entry'
