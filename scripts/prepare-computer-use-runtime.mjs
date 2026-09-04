import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

const CUA_DRIVER_VERSION = '0.23.2'
const RELEASE_TAG = `cua-driver-rs-v${CUA_DRIVER_VERSION}`
const RELEASE_BASE = `https://github.com/trycua/cua/releases/download/${RELEASE_TAG}`
const SKILL_FILES = ['SKILL.md', 'MACOS.md', 'BROWSER.md', 'RECORDING.md', 'README.md']
const ASSET_SHA256 = {
  [`cua-driver-rs-${CUA_DRIVER_VERSION}-darwin-arm64.tar.gz`]:
    'c606a0410eb1bf59ee81d697f6fbf8b7126b2e9a3f802272a34807b45b6ecd6f',
  [`cua-driver-rs-${CUA_DRIVER_VERSION}-darwin-x86_64.tar.gz`]:
    '8017f02f815a801467c47e1a574735921ecf855b6b907b20341ab906cf33a751',
  [`cua-driver-rs-v${CUA_DRIVER_VERSION}-skills.tar.gz`]:
    'c6ad84caad3ae0f9115338c839c7c4e4b44c934f1311e4d445cb2b39c4a5a25e',
}

const repoRoot = process.cwd()
const requestedTarget = process.argv
  .find((argument) => argument.startsWith('--target='))
  ?.slice('--target='.length)
const forceDownload = process.argv.includes('--download')
const skillsOnly = process.argv.includes('--skills')
const binaryOnly = process.argv.includes('--binary')

function hostTarget() {
  try {
    return execFileSync('rustc', ['--print', 'host-tuple'], { encoding: 'utf8' }).trim()
  } catch {
    const verbose = execFileSync('rustc', ['-vV'], { encoding: 'utf8' })
    return verbose.match(/^host:\s+(\S+)$/m)?.[1] ?? ''
  }
}

function supportedAsset(target) {
  if (target === 'aarch64-apple-darwin') {
    return `cua-driver-rs-${CUA_DRIVER_VERSION}-darwin-arm64.tar.gz`
  }
  if (target === 'x86_64-apple-darwin') {
    return `cua-driver-rs-${CUA_DRIVER_VERSION}-darwin-x86_64.tar.gz`
  }
  return null
}

async function downloadVerified(asset) {
  const expected = ASSET_SHA256[asset]
  if (!expected) throw new Error(`No pinned checksum for ${asset}`)
  const response = await fetch(`${RELEASE_BASE}/${asset}`)
  if (!response.ok) {
    throw new Error(`Failed to download ${asset} (${response.status})`)
  }
  const archive = Buffer.from(await response.arrayBuffer())
  const actual = crypto.createHash('sha256').update(archive).digest('hex')
  if (actual !== expected) {
    throw new Error(`Checksum mismatch for ${asset}`)
  }
  return archive
}

function extractTarGz(archive, destination) {
  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'falcondeck-cua-'))
  const archivePath = path.join(temporaryDirectory, 'asset.tar.gz')
  fs.writeFileSync(archivePath, archive)
  try {
    execFileSync('tar', ['-xzf', archivePath, '-C', temporaryDirectory])
    return { temporaryDirectory, extractedRoot: findExtractedRoot(temporaryDirectory, destination) }
  } catch (error) {
    fs.rmSync(temporaryDirectory, { recursive: true, force: true })
    throw error
  }
}

function findExtractedRoot(temporaryDirectory, kind) {
  const stack = [temporaryDirectory]
  while (stack.length > 0) {
    const current = stack.pop()
    const entries = fs.readdirSync(current, { withFileTypes: true })
    for (const entry of entries) {
      const full = path.join(current, entry.name)
      if (entry.name === 'asset.tar.gz') continue
      if (kind === 'binary' && entry.isFile() && entry.name === 'cua-driver') {
        return full
      }
      if (kind === 'skills' && entry.isFile() && entry.name === 'SKILL.md') {
        return current
      }
      if (entry.isDirectory()) stack.push(full)
    }
  }
  return null
}

async function prepareBinary(target) {
  const asset = supportedAsset(target)
  if (!asset) {
    console.log(`Skipping bundled cua-driver for unsupported target ${target}`)
    return
  }

  const destination = path.join(
    repoRoot,
    'apps',
    'desktop',
    'src-tauri',
    'binaries',
    `cua-driver-${target}`,
  )
  fs.mkdirSync(path.dirname(destination), { recursive: true })
  if (fs.existsSync(destination) && !forceDownload) {
    console.log(`Using existing bundled cua-driver ${CUA_DRIVER_VERSION} for ${target}`)
    return
  }

  const archive = await downloadVerified(asset)
  const extracted = extractTarGz(archive, 'binary')
  try {
    if (!extracted.extractedRoot) {
      throw new Error(`Archive ${asset} did not contain a cua-driver binary`)
    }
    fs.copyFileSync(extracted.extractedRoot, destination)
    fs.chmodSync(destination, 0o755)
  } finally {
    fs.rmSync(extracted.temporaryDirectory, { recursive: true, force: true })
  }
  console.log(`Prepared bundled cua-driver ${CUA_DRIVER_VERSION} for ${target}`)
}

async function prepareSkills() {
  const destination = path.join(
    repoRoot,
    'crates',
    'falcondeck-daemon',
    'src',
    'agent_context',
    'cua-driver',
  )
  const versionPath = path.join(destination, 'VERSION')
  const alreadyCurrent =
    fs.existsSync(versionPath) &&
    fs.readFileSync(versionPath, 'utf8').trim() === CUA_DRIVER_VERSION &&
    SKILL_FILES.every((name) => fs.existsSync(path.join(destination, name)))
  if (alreadyCurrent && !forceDownload) {
    console.log(`Using checked-in cua-driver skill pack ${CUA_DRIVER_VERSION}`)
    return
  }

  const archive = await downloadVerified(`cua-driver-rs-v${CUA_DRIVER_VERSION}-skills.tar.gz`)
  const extracted = extractTarGz(archive, 'skills')
  try {
    if (!extracted.extractedRoot) {
      throw new Error('Skills archive did not contain a cua-driver directory')
    }
    fs.mkdirSync(destination, { recursive: true })
    for (const name of SKILL_FILES) {
      const source = path.join(extracted.extractedRoot, name)
      if (!fs.existsSync(source)) {
        throw new Error(`Skills archive is missing ${name}`)
      }
      fs.copyFileSync(source, path.join(destination, name))
    }
    fs.writeFileSync(versionPath, `${CUA_DRIVER_VERSION}\n`)
  } finally {
    fs.rmSync(extracted.temporaryDirectory, { recursive: true, force: true })
  }
  console.log(`Refreshed cua-driver skill pack ${CUA_DRIVER_VERSION}`)
}

const target = requestedTarget || process.env.TAURI_ENV_TARGET_TRIPLE || hostTarget()
const runBinary = !skillsOnly
const runSkills = !binaryOnly
if (runBinary) {
  if (!target) throw new Error('Could not determine the Rust target triple for cua-driver')
  await prepareBinary(target)
}
if (runSkills) await prepareSkills()
