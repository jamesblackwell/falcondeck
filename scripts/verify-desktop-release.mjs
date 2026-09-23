import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const repoRoot = path.resolve(import.meta.dirname, '..')
const cargoManifest = fs.readFileSync(path.join(repoRoot, 'Cargo.toml'), 'utf8')
const version = cargoManifest.match(/\[workspace\.package\][\s\S]*?version\s*=\s*"([^"]+)"/)?.[1]
if (!version) throw new Error('Could not read desktop version from Cargo.toml')

const tag = process.argv[2] ?? `desktop-v${version}`
if (tag !== `desktop-v${version}`) {
  throw new Error(`Release tag ${tag} does not match the workspace version ${version}`)
}

const release = JSON.parse(execFileSync('gh', [
  'release', 'view', tag, '--json', 'assets,tagName',
], { cwd: repoRoot, encoding: 'utf8' }))
const assetNames = new Set(release.assets.map((asset) => asset.name))
const expectedAssets = [
  `FalconDeck_${version}_aarch64.dmg`,
  `FalconDeck_${version}_x64.dmg`,
  'FalconDeck_aarch64.app.tar.gz',
  'FalconDeck_aarch64.app.tar.gz.sig',
  'FalconDeck_x64.app.tar.gz',
  'FalconDeck_x64.app.tar.gz.sig',
  'latest.json',
]
for (const asset of expectedAssets) {
  if (!assetNames.has(asset)) throw new Error(`${tag} is missing ${asset}`)
}

const downloadDir = fs.mkdtempSync(path.join(os.tmpdir(), 'falcondeck-release-'))
try {
  execFileSync('gh', [
    'release', 'download', tag,
    '--pattern', 'latest.json',
    '--pattern', '*.sig',
    '--dir', downloadDir,
  ], { cwd: repoRoot, stdio: 'pipe' })

  const manifest = JSON.parse(fs.readFileSync(path.join(downloadDir, 'latest.json'), 'utf8'))
  if (manifest.version !== version) {
    throw new Error(`latest.json version ${manifest.version} does not match ${version}`)
  }
  for (const [target, suffix] of [
    ['darwin-aarch64', 'aarch64'],
    ['darwin-x86_64', 'x64'],
  ]) {
    const artifact = `FalconDeck_${suffix}.app.tar.gz`
    const signature = fs.readFileSync(path.join(downloadDir, `${artifact}.sig`), 'utf8')
    const expectedUrl = `https://github.com/jamesblackwell/falcondeck/releases/download/${tag}/${artifact}`
    for (const key of [target, `${target}-app`]) {
      const entry = manifest.platforms?.[key]
      if (entry?.url !== expectedUrl) throw new Error(`${key} has an invalid update URL`)
      if (entry.signature !== signature) {
        throw new Error(`${key} signature differs from ${artifact}.sig`)
      }
    }
  }
  console.log(`Verified ${tag}: both Mac installers and signed updater entries are present`)
} finally {
  fs.rmSync(downloadDir, { recursive: true, force: true })
}
