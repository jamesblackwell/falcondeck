import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

const DENO_VERSION = '2.9.2'
const repoRoot = process.cwd()
const requestedTarget = process.argv
  .find((argument) => argument.startsWith('--target='))
  ?.slice('--target='.length)
const forceDownload = process.argv.includes('--download')

function hostTarget() {
  try {
    return execFileSync('rustc', ['--print', 'host-tuple'], { encoding: 'utf8' }).trim()
  } catch {
    const verbose = execFileSync('rustc', ['-vV'], { encoding: 'utf8' })
    return verbose.match(/^host:\s+(\S+)$/m)?.[1] ?? ''
  }
}

const target = requestedTarget || process.env.TAURI_ENV_TARGET_TRIPLE || hostTarget()
if (!target) throw new Error('Could not determine the Rust target triple for the extension runtime')

const supportedTargets = new Set([
  'aarch64-apple-darwin',
  'x86_64-apple-darwin',
  'aarch64-unknown-linux-gnu',
  'x86_64-unknown-linux-gnu',
  'aarch64-pc-windows-msvc',
  'x86_64-pc-windows-msvc',
])
if (!supportedTargets.has(target)) {
  throw new Error(`No bundled Deno runtime is configured for target ${target}`)
}

const windowsTarget = target.includes('windows')
const extension = windowsTarget ? '.exe' : ''
const destination = path.join(
  repoRoot,
  'apps',
  'desktop',
  'src-tauri',
  'binaries',
  `deno-${target}${extension}`,
)

function installedDeno() {
  if (target !== hostTarget()) return null
  try {
    const command = process.platform === 'win32' ? 'where.exe' : 'which'
    const candidate = execFileSync(command, ['deno'], { encoding: 'utf8' }).trim().split(/\r?\n/)[0]
    const version = execFileSync(candidate, ['--version'], { encoding: 'utf8' })
      .match(/^deno\s+(\S+)/m)?.[1]
    return version === DENO_VERSION ? candidate : null
  } catch {
    return null
  }
}

async function downloadRuntime() {
  const asset = `deno-${target}.zip`
  const releaseBase = `https://github.com/denoland/deno/releases/download/v${DENO_VERSION}`
  const [archiveResponse, checksumResponse] = await Promise.all([
    fetch(`${releaseBase}/${asset}`),
    fetch(`${releaseBase}/${asset}.sha256sum`),
  ])
  if (!archiveResponse.ok || !checksumResponse.ok) {
    throw new Error(`Failed to download the pinned Deno ${DENO_VERSION} runtime for ${target}`)
  }

  const archive = Buffer.from(await archiveResponse.arrayBuffer())
  const expectedChecksum = (await checksumResponse.text()).trim().split(/\s+/)[0]
  const actualChecksum = crypto.createHash('sha256').update(archive).digest('hex')
  if (!expectedChecksum || actualChecksum !== expectedChecksum) {
    throw new Error(`Checksum mismatch for ${asset}`)
  }

  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'falcondeck-deno-'))
  const archivePath = path.join(temporaryDirectory, asset)
  fs.writeFileSync(archivePath, archive)
  try {
    if (process.platform === 'win32') {
      execFileSync('powershell.exe', [
        '-NoProfile',
        '-Command',
        'Expand-Archive -LiteralPath $args[0] -DestinationPath $args[1] -Force',
        archivePath,
        temporaryDirectory,
      ])
    } else {
      execFileSync('unzip', ['-oq', archivePath, '-d', temporaryDirectory])
    }
    const extracted = path.join(temporaryDirectory, `deno${extension}`)
    fs.copyFileSync(extracted, destination)
  } finally {
    fs.rmSync(temporaryDirectory, { recursive: true, force: true })
  }
}

fs.mkdirSync(path.dirname(destination), { recursive: true })
if (!forceDownload) {
  const localDeno = installedDeno()
  if (localDeno) fs.copyFileSync(localDeno, destination)
}
if (!fs.existsSync(destination) || forceDownload) await downloadRuntime()
if (!windowsTarget) fs.chmodSync(destination, 0o755)

console.log(`Prepared bundled Deno ${DENO_VERSION} runtime for ${target}`)
