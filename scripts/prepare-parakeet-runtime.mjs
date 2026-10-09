import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const target = process.argv.find(arg => arg.startsWith('--target='))?.slice(9)
  ?? process.env.TAURI_ENV_TARGET_TRIPLE
  ?? execFileSync('rustc', ['-vV'], { encoding: 'utf8' }).match(/^host: (.+)$/m)?.[1]
if (!['aarch64-apple-darwin', 'x86_64-apple-darwin'].includes(target)) {
  throw new Error(`Parakeet sidecar build is unsupported for ${target}`)
}
const arch = target.startsWith('aarch64') ? 'arm64' : 'x86_64'
const args = ['build', '-c', 'release', '--package-path', path.join(root, 'apps/desktop/parakeet-runtime'),
  '--triple', `${arch}-apple-macosx14.0`]
execFileSync('swift', args, { stdio: 'inherit' })
const binDir = execFileSync('swift', [...args, '--show-bin-path'], { encoding: 'utf8' }).trim()
const destination = path.join(root, 'apps/desktop/src-tauri/binaries', `falcondeck-parakeet-${target}`)
fs.mkdirSync(path.dirname(destination), { recursive: true })
fs.copyFileSync(path.join(binDir, 'falcondeck-parakeet'), destination)
fs.chmodSync(destination, 0o755)
console.log(`Prepared ${destination}`)
