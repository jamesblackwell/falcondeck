import { existsSync, readFileSync, rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'

const pidPath = join(homedir(), '.falcondeck', 'daemon-state.dev.pid')

function removePidFile() {
  try {
    rmSync(pidPath, { force: true })
  } catch {
    // Ignore cleanup failures for the dev-only pid file.
  }
}

function processExists(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error?.code !== 'ESRCH'
  }
}

if (!existsSync(pidPath)) {
  console.log('No FalconDeck dev daemon pid file found.')
  process.exit(0)
}

const rawPid = readFileSync(pidPath, 'utf8').trim()
const pid = Number.parseInt(rawPid, 10)

if (!Number.isInteger(pid) || pid <= 0) {
  removePidFile()
  console.log('Removed invalid FalconDeck dev daemon pid file.')
  process.exit(0)
}

if (!processExists(pid)) {
  removePidFile()
  console.log('FalconDeck dev daemon is not running.')
  process.exit(0)
}

if (process.platform === 'win32') {
  try {
    execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' })
  } catch (error) {
    console.error(`Failed to stop FalconDeck dev daemon ${pid}: ${error.message}`)
    process.exit(1)
  }
  removePidFile()
  console.log(`Stopped FalconDeck dev daemon ${pid}.`)
  process.exit(0)
}

try {
  process.kill(pid, 'SIGTERM')
} catch (error) {
  if (error?.code !== 'ESRCH') {
    console.error(`Failed to stop FalconDeck dev daemon ${pid}: ${error.message}`)
    process.exit(1)
  }
}

const deadline = Date.now() + 3000
while (Date.now() < deadline && processExists(pid)) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100)
}

if (processExists(pid)) {
  try {
    process.kill(pid, 'SIGKILL')
  } catch (error) {
    if (error?.code !== 'ESRCH') {
      console.error(`Failed to force-stop FalconDeck dev daemon ${pid}: ${error.message}`)
      process.exit(1)
    }
  }
}

removePidFile()
console.log(`Stopped FalconDeck dev daemon ${pid}.`)
