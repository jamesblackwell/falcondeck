import { getRandomValues, randomUUID } from 'expo-crypto'

type CryptoLike = {
  getRandomValues?: Crypto['getRandomValues']
  randomUUID?: () => string
  subtle?: SubtleCrypto
}

export function installCryptoPolyfill() {
  const cryptoObject: CryptoLike = globalThis.crypto ?? {}

  if (typeof cryptoObject.getRandomValues !== 'function') {
    cryptoObject.getRandomValues = ((array) => getRandomValues(array as never) as never) as Crypto['getRandomValues']
  }

  if (typeof cryptoObject.randomUUID !== 'function') {
    cryptoObject.randomUUID = randomUUID
  }

  globalThis.crypto = cryptoObject as Crypto
}
