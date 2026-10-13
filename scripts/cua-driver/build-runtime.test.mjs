import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { isPatchedRuntimeCurrent, runtimeFingerprint } from './build-runtime.mjs'

test('runtime identity includes target and both source patches', () => {
  const original = runtimeFingerprint('aarch64-apple-darwin', 'patch', 'watchdog')
  assert.notEqual(original, runtimeFingerprint('x86_64-apple-darwin', 'patch', 'watchdog'))
  assert.notEqual(original, runtimeFingerprint('aarch64-apple-darwin', 'new patch', 'watchdog'))
  assert.notEqual(original, runtimeFingerprint('aarch64-apple-darwin', 'patch', 'new watchdog'))
})

test('same-version unpatched or replaced binaries cannot pass the cache check', () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'cua-cache-test-'))
  try {
    const binary = path.join(temporary, 'cua-driver')
    const fingerprint = runtimeFingerprint('aarch64-apple-darwin')
    fs.writeFileSync(binary, 'patched binary')
    assert.equal(isPatchedRuntimeCurrent(binary, fingerprint), false)
    fs.writeFileSync(`${binary}.json`, JSON.stringify({ fingerprint,
      sha256: crypto.createHash('sha256').update(fs.readFileSync(binary)).digest('hex') }))
    assert.equal(isPatchedRuntimeCurrent(binary, fingerprint), true)
    assert.equal(isPatchedRuntimeCurrent(binary, 'older patch'), false)
    fs.writeFileSync(binary, 'upstream binary with same version')
    assert.equal(isPatchedRuntimeCurrent(binary, fingerprint), false)
    fs.writeFileSync(`${binary}.json`, 'invalid JSON')
    assert.equal(isPatchedRuntimeCurrent(binary, fingerprint), false)
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true })
  }
})
