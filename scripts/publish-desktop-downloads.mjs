import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const repoRoot = path.resolve(import.meta.dirname, '..')
const version = fs.readFileSync(path.join(repoRoot, 'Cargo.toml'), 'utf8')
  .match(/\[workspace\.package\][\s\S]*?version\s*=\s*"([^"]+)"/)?.[1]
if (!version) throw new Error('Could not read desktop version from Cargo.toml')
const tag = process.argv[2] ?? `desktop-v${version}`
if (tag !== `desktop-v${version}`) throw new Error(`Release tag ${tag} does not match ${version}`)

const gh = (args) => execFileSync('gh', args, { cwd: repoRoot, encoding: 'utf8' })
const release = JSON.parse(gh(['release', 'view', tag, '--json', 'assets']))
const installers = ['aarch64', 'x64'].map((arch) => {
  const name = `FalconDeck_${version}_${arch}.dmg`
  const asset = release.assets.find((entry) => entry.name === name)
  if (!asset?.digest?.startsWith('sha256:')) throw new Error(`${tag} has no verified digest for ${name}`)
  return { name, digest: asset.digest, alias: `FalconDeck_${arch}.dmg` }
})

const downloadDir = fs.mkdtempSync(path.join(os.tmpdir(), 'falcondeck-downloads-'))
try {
  gh(['release', 'download', tag, ...installers.flatMap(({ name }) => ['--pattern', name]), '--dir', downloadDir])
  const aliases = installers.map(({ name, digest, alias }) => {
    const source = path.join(downloadDir, name)
    const actual = `sha256:${createHash('sha256').update(fs.readFileSync(source)).digest('hex')}`
    if (actual !== digest) throw new Error(`Downloaded ${name} does not match its release digest`)
    const destination = path.join(downloadDir, alias)
    fs.copyFileSync(source, destination)
    return destination
  })
  // The aliases are byte-for-byte copies of the signed, notarized installers.
  // Clobber only aliases so draft workflow retries remain idempotent.
  gh(['release', 'upload', tag, ...aliases, '--clobber'])
  console.log(`Published stable Mac download filenames for ${tag}`)
} finally {
  fs.rmSync(downloadDir, { recursive: true, force: true })
}
