import { bench, describe } from 'vitest'

import { decryptJson, decryptJsonBatch, encryptJson } from './crypto'

const key = new Uint8Array(32).fill(7)
const envelopes = await Promise.all(
  Array.from({ length: 128 }, (_, index) => encryptJson(key, { index, delta: 'token' })),
)

describe('remote replay decryption', () => {
  bench('decrypts 128 updates sequentially', async () => {
    for (const envelope of envelopes) await decryptJson(key, envelope)
  })

  bench('decrypts 128 updates concurrently', async () => {
    await decryptJsonBatch(key, envelopes)
  })
})
