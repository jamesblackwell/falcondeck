import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { preparePatchedBinary, UPSTREAM_VERSION } from './cua-driver/build-runtime.mjs'

const CUA_DRIVER_VERSION = UPSTREAM_VERSION
const RELEASE_TAG = `cua-driver-rs-v${CUA_DRIVER_VERSION}`
const RELEASE_BASE = `https://github.com/trycua/cua/releases/download/${RELEASE_TAG}`
const SKILL_FILES = [
  'SKILL.md', 'WORKFLOW.md', 'RUNTIME.md', 'VISUAL.md',
  'MACOS.md', 'WINDOWS.md', 'LINUX.md', 'BROWSER.md',
  'RECORDING.md', 'EMBEDDING.md', 'README.md',
]
const ASSET_SHA256 = {
  [`cua-driver-rs-v${CUA_DRIVER_VERSION}-skills.tar.gz`]:
    '5f33bb04b06b5abf4f95266eeb0ed5bbdd020155eb40f737081e6ac5f31b8246',
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

function extractTarGz(archive) {
  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'falcondeck-cua-'))
  const archivePath = path.join(temporaryDirectory, 'asset.tar.gz')
  fs.writeFileSync(archivePath, archive)
  try {
    execFileSync('tar', ['-xzf', archivePath, '-C', temporaryDirectory])
    return { temporaryDirectory, extractedRoot: findExtractedRoot(temporaryDirectory) }
  } catch (error) {
    fs.rmSync(temporaryDirectory, { recursive: true, force: true })
    throw error
  }
}

function findExtractedRoot(temporaryDirectory) {
  const stack = [temporaryDirectory]
  while (stack.length > 0) {
    const current = stack.pop()
    const entries = fs.readdirSync(current, { withFileTypes: true })
    for (const entry of entries) {
      const full = path.join(current, entry.name)
      if (entry.name === 'asset.tar.gz') continue
      if (entry.isFile() && entry.name === 'SKILL.md') {
        return current
      }
      if (entry.isDirectory()) stack.push(full)
    }
  }
  return null
}

async function prepareBinary(target) {
  if (!['aarch64-apple-darwin', 'x86_64-apple-darwin'].includes(target)) {
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
  await preparePatchedBinary({ repoRoot, target, destination, force: forceDownload })
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
  const extracted = extractTarGz(archive)
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
