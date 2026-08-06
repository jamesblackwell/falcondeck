import { existsSync, readFileSync, rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'

const pidPath = join(homedir(), '.falcondeck', 'daemon-state.dev.pid')
const devDaemonPort = '4123'

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

function commandForPid(pid) {
  try {
    return execFileSync('ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf8' }).trim()
  } catch {
    return ''
  }
}

function fallbackDevDaemonPid() {
  if (process.platform === 'win32') {
    return null
  }

  try {
    const output = execFileSync(
      'lsof',
      [`-tiTCP:${devDaemonPort}`, '-sTCP:LISTEN', '-n', '-P'],
      { encoding: 'utf8' },
    )

    for (const rawPid of output.split(/\s+/).filter(Boolean)) {
      const pid = Number.parseInt(rawPid, 10)
      if (!Number.isInteger(pid) || pid <= 0) {
        continue
      }

      const command = commandForPid(pid)
      if (command.includes('falcondeck-daemon') && command.includes(`--port=${devDaemonPort}`)) {
        return pid
      }
    }
  } catch {
    // Ignore fallback lookup failures and behave as though nothing is running.
  }

  return null
}

let pid = null
if (existsSync(pidPath)) {
  const rawPid = readFileSync(pidPath, 'utf8').trim()
  const parsedPid = Number.parseInt(rawPid, 10)

  if (!Number.isInteger(parsedPid) || parsedPid <= 0) {
    removePidFile()
    pid = fallbackDevDaemonPid()
  } else if (processExists(parsedPid)) {
    pid = parsedPid
  } else {
    removePidFile()
    pid = fallbackDevDaemonPid()
  }
} else {
  pid = fallbackDevDaemonPid()
}

if (!Number.isInteger(pid) || pid <= 0) {
  console.log('No FalconDeck dev daemon found.')
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
