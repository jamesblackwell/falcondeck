import fs from 'node:fs'
import path from 'node:path'

const repoRoot = process.cwd()
const requireUpdaterKey = process.argv.includes('--require-updater-key')
const cargoManifestPath = path.join(repoRoot, 'Cargo.toml')
const rootPackagePath = path.join(repoRoot, 'package.json')
const desktopPackagePath = path.join(repoRoot, 'apps', 'desktop', 'package.json')
const tauriConfigPath = path.join(repoRoot, 'apps', 'desktop', 'src-tauri', 'tauri.conf.json')
const updaterPublicKey = process.env.FALCONDECK_UPDATER_PUBLIC_KEY?.trim() ?? ''
const updaterPlaceholder = '__FALCONDECK_UPDATER_PUBLIC_KEY__'

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'))
}

function writeJson(filePath, value) {
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`)
}

const cargoManifest = fs.readFileSync(cargoManifestPath, 'utf8')
const versionMatch = cargoManifest.match(/\[workspace\.package\][\s\S]*?version\s*=\s*"([^"]+)"/)

if (!versionMatch) {
  throw new Error('Could not find [workspace.package].version in Cargo.toml')
}

const workspaceVersion = versionMatch[1]
const rootPackage = readJson(rootPackagePath)
const desktopPackage = readJson(desktopPackagePath)
const tauriConfig = readJson(tauriConfigPath)

rootPackage.version = workspaceVersion
desktopPackage.version = workspaceVersion
tauriConfig.version = workspaceVersion

if (!tauriConfig.plugins?.updater) {
  throw new Error('apps/desktop/src-tauri/tauri.conf.json is missing plugins.updater')
}

if (updaterPublicKey) {
  tauriConfig.plugins.updater.pubkey = updaterPublicKey
} else if (requireUpdaterKey) {
  throw new Error(
    'FALCONDECK_UPDATER_PUBLIC_KEY is required for release preparation. Generate a Tauri updater keypair and pass the public key through CI.',
  )
} else if (!tauriConfig.plugins.updater.pubkey?.trim()) {
  tauriConfig.plugins.updater.pubkey = updaterPlaceholder
}

writeJson(rootPackagePath, rootPackage)
writeJson(desktopPackagePath, desktopPackage)
writeJson(tauriConfigPath, tauriConfig)

if (!updaterPublicKey && tauriConfig.plugins.updater.pubkey === updaterPlaceholder) {
  console.warn(
    'Desktop updater public key placeholder is still in use. Set FALCONDECK_UPDATER_PUBLIC_KEY before packaging releases.',
  )
}

console.log(`Prepared FalconDeck desktop release config for version ${workspaceVersion}`)
