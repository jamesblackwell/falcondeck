import { installCryptoPolyfill } from '@/crypto/polyfill'
import '@/theme/unistyles'
import { clearLegacyOpenRouterApiKey } from '@/storage/secure'

installCryptoPolyfill()
void clearLegacyOpenRouterApiKey()

import 'expo-router/entry'
