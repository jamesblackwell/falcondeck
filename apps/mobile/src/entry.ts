import { installNativeAes } from '@/crypto/native-aes'
import { installCryptoPolyfill } from '@/crypto/polyfill'
import '@/theme/unistyles'
import { clearLegacyOpenRouterApiKey } from '@/storage/secure'
import { speechLiveActivity } from '@/features/speech/speechLiveActivity'

installCryptoPolyfill()
installNativeAes()
void clearLegacyOpenRouterApiKey()
speechLiveActivity.initialize()

import 'expo-router/entry'
