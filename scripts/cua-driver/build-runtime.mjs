import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { fileURLToPath } from 'node:url'

export const UPSTREAM_VERSION = '0.33.4'
// Tag resolves to ba0033a661101669c60ce05f1fe5753bf8bad748.
const SOURCE_URL = `https://codeload.github.com/trycua/cua/tar.gz/refs/tags/cua-driver-rs-v${UPSTREAM_VERSION}`
const SOURCE_SHA256 = 'f77348f155a4aaded3251c3f418daf9a571699ed819c80813d97a7897bebda39'
const patchDirectory = path.dirname(fileURLToPath(import.meta.url))
const patchPath = path.join(patchDirectory, 'browser-snapshot.patch')
const watchdogPath = path.join(patchDirectory, 'snapshot-watchdog.rs')

function sha256(contents) {
  return crypto.createHash('sha256').update(contents).digest('hex')
}

export function runtimeFingerprint(target, patch = fs.readFileSync(patchPath), watchdog = fs.readFileSync(watchdogPath)) {
  return sha256(JSON.stringify([SOURCE_SHA256, target, sha256(patch), sha256(watchdog)]))
}

export function isPatchedRuntimeCurrent(binary, fingerprint) {
  try {
    const marker = JSON.parse(fs.readFileSync(`${binary}.json`, 'utf8'))
    return marker.fingerprint === fingerprint && marker.sha256 === sha256(fs.readFileSync(binary))
  } catch {
    return false
  }
}

async function downloadSource(destination) {
  const response = await fetch(SOURCE_URL)
  if (!response.ok || !response.body) throw new Error(`Failed to download cua-driver source (${response.status})`)
  const hash = crypto.createHash('sha256')
  // The monorepo archive is large; stream it instead of retaining it in RAM.
  await pipeline(Readable.fromWeb(response.body), new Transform({
    transform(chunk, encoding, callback) { hash.update(chunk); callback(null, chunk) },
  }), fs.createWriteStream(destination, { mode: 0o600 }))
  if (hash.digest('hex') !== SOURCE_SHA256) throw new Error('Checksum mismatch for cua-driver source')
}

export async function preparePatchedBinary({ repoRoot, target, destination, force = false }) {
  const patch = fs.readFileSync(patchPath)
  const watchdog = fs.readFileSync(watchdogPath)
  const fingerprint = runtimeFingerprint(target, patch, watchdog)
  if (!force && isPatchedRuntimeCurrent(destination, fingerprint)) {
    console.log(`Using patched cua-driver ${UPSTREAM_VERSION} for ${target}`)
    return
  }
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'falcondeck-cua-build-'))
  const staged = `${destination}.${process.pid}.tmp`
  const stagedMarker = `${staged}.json`
  try {
    const archive = path.join(temporary, 'source.tar.gz')
    await downloadSource(archive)
    const prefix = `cua-cua-driver-rs-v${UPSTREAM_VERSION}`
    execFileSync('tar', ['-xzf', archive, '-C', temporary, '--strip-components=1',
      `${prefix}/libs/cua-driver/rust`, `${prefix}/libs/cua`, `${prefix}/libs/images/sandbox-images.json`])
    const source = path.join(temporary, 'libs/cua-driver/rust')
    const localPatch = path.join(temporary, 'browser-snapshot.patch')
    fs.writeFileSync(localPatch, patch)
    execFileSync('git', ['apply', '--check', localPatch], { cwd: source })
    execFileSync('git', ['apply', localPatch], { cwd: source })
    fs.writeFileSync(path.join(source, 'crates/cua-driver/src/falcondeck_snapshot_watchdog.rs'), watchdog)
    const buildCache = path.join(repoRoot, 'target/cua-driver')
    // Run from the FalconDeck root to use its installed Rust toolchain and
    // cross-compilation targets, rather than the source archive's toolchain.
    execFileSync('cargo', ['build', '--manifest-path', path.join(source, 'Cargo.toml'),
      '--locked', '--release', '--target', target, '--target-dir', buildCache,
      '--jobs', process.env.CARGO_BUILD_JOBS || '2', '-p', 'cua-driver'], {
      cwd: repoRoot,
      stdio: 'inherit',
      env: { ...process.env, CUA_DRIVER_GIT_SHA: 'ba0033a661101669c60ce05f1fe5753bf8bad748' },
    })
    const built = path.join(buildCache, target, 'release/cua-driver')
    const arch = target.startsWith('aarch64') ? 'arm64' : 'x86_64'
    // Xcode 26 lipo treats arguments after -verify_arch as architecture names.
    execFileSync('lipo', [built, '-verify_arch', arch])
    const host = execFileSync('rustc', ['-vV'], { cwd: repoRoot, encoding: 'utf8' }).match(/^host: (.+)$/m)?.[1]
    if (host === target) {
      const version = execFileSync(built, ['--version'], { encoding: 'utf8', timeout: 5000 }).trim()
      if (version !== `cua-driver ${UPSTREAM_VERSION}`) throw new Error(`Unexpected built driver version: ${version}`)
    }
    fs.mkdirSync(path.dirname(destination), { recursive: true })
    fs.copyFileSync(built, staged)
    fs.chmodSync(staged, 0o755)
    fs.writeFileSync(stagedMarker, JSON.stringify({ fingerprint, sha256: sha256(fs.readFileSync(staged)) }))
    // Never truncate a running sidecar or admit an unpatched same-version binary.
    fs.renameSync(staged, destination)
    fs.renameSync(stagedMarker, `${destination}.json`)
  } finally {
    fs.rmSync(staged, { force: true })
    fs.rmSync(stagedMarker, { force: true })
    fs.rmSync(temporary, { recursive: true, force: true })
  }
  console.log(`Prepared patched cua-driver ${UPSTREAM_VERSION} for ${target}`)
}
