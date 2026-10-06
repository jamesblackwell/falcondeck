import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

function runPublisher(t, corrupt = false) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'falcondeck-downloads-test-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  fs.mkdirSync(path.join(root, 'scripts'))
  fs.mkdirSync(path.join(root, 'bin'))
  fs.writeFileSync(path.join(root, 'Cargo.toml'), '[workspace.package]\nversion = "1.2.3"\n')
  fs.copyFileSync(new URL('./publish-desktop-downloads.mjs', import.meta.url), path.join(root, 'scripts/publish-desktop-downloads.mjs'))
  fs.writeFileSync(path.join(root, 'bin/gh'), `#!${process.execPath}
import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
const args = process.argv.slice(2)
const architectures = ['aarch64', 'x64']
const bytes = (arch) => Buffer.from('signed installer for ' + arch)
if (args[1] === 'view') {
  console.log(JSON.stringify({ assets: architectures.map(arch => ({
    name: 'FalconDeck_1.2.3_' + arch + '.dmg',
    digest: 'sha256:' + createHash('sha256').update(bytes(arch)).digest('hex'),
  })) }))
} else if (args[1] === 'download') {
  const directory = args[args.indexOf('--dir') + 1]
  fs.writeFileSync('download-dir', directory)
  for (const arch of architectures) {
    fs.writeFileSync(path.join(directory, 'FalconDeck_1.2.3_' + arch + '.dmg'),
      ${corrupt} && arch === 'x64' ? Buffer.from('corrupt') : bytes(arch))
  }
} else if (args[1] === 'upload') {
  const files = args.slice(3).filter(arg => arg !== '--clobber')
  fs.writeFileSync('uploaded.json', JSON.stringify(files.map(file => ({
    name: path.basename(file), bytes: fs.readFileSync(file, 'utf8'),
  }))))
} else throw new Error('Unexpected gh invocation')
`, { mode: 0o755 })
  const result = spawnSync(process.execPath, ['scripts/publish-desktop-downloads.mjs'], {
    cwd: root, encoding: 'utf8', env: { ...process.env, PATH: `${path.join(root, 'bin')}${path.delimiter}${process.env.PATH}` },
  })
  const directory = fs.readFileSync(path.join(root, 'download-dir'), 'utf8')
  assert.equal(fs.existsSync(directory), false, 'downloaded installers are cleaned up')
  return { root, result }
}

test('publishes byte-identical stable filenames for both signed installers', (t) => {
  const { root, result } = runPublisher(t)
  assert.equal(result.status, 0, result.stderr)
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root, 'uploaded.json'), 'utf8')), [
    { name: 'FalconDeck_aarch64.dmg', bytes: 'signed installer for aarch64' },
    { name: 'FalconDeck_x64.dmg', bytes: 'signed installer for x64' },
  ])
})

test('a digest mismatch prevents either installer from being published', (t) => {
  const { root, result } = runPublisher(t, true)
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /does not match its release digest/)
  assert.equal(fs.existsSync(path.join(root, 'uploaded.json')), false)
})
