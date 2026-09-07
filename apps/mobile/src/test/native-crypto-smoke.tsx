// Standalone simulator entry; never imported by the product entry point.
import React, { useEffect, useState } from 'react'
import { Text, View } from 'react-native'
import { registerRootComponent } from 'expo'
import { decryptJson, encryptJson, setAesGcmBackend } from '@falcondeck/client-core'
import { installNativeAes } from '../crypto/native-aes'
import { installCryptoPolyfill } from '../crypto/polyfill'

installCryptoPolyfill()

async function smoke() {
  const key = new Uint8Array(32).fill(42)
  const payload = { text: 'native interop 🔐'.repeat(1000) }
  setAesGcmBackend(null)
  const reference = await encryptJson(key, payload)
  installNativeAes()
  const decoded = await decryptJson<typeof payload>(key, reference)
  if (decoded.text !== payload.text) throw new Error('native decrypt mismatch')
  const native = await encryptJson(key, payload)
  setAesGcmBackend(null)
  const result = await decryptJson<typeof payload>(key, native)
  if (result.text !== payload.text) throw new Error('native encrypt mismatch')
  return 'PASS: native AES encrypt/decrypt interoperates with JS AES'
}

function CryptoSmoke() {
  const [result, setResult] = useState('Running native crypto smoke…')
  useEffect(() => { void smoke().then(setResult, error => setResult(`FAIL: ${error}`)) }, [])
  return <View style={{ padding: 40, paddingTop: 100 }}><Text selectable>{result}</Text></View>
}
registerRootComponent(CryptoSmoke)
