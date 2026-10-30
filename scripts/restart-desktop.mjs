import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readdirSync, renameSync, rmSync, writeSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const executable = '/Applications/FalconDeck.app/Contents/MacOS/falcondeck-desktop';
const app = '/Applications/FalconDeck.app';
const staleJob = 'com.falcondeck.apply-writer-fix';
const run = (command, args, { timeout = 15_000 } = {}) => execFileSync(command, args, {
  encoding: 'utf8', timeout, stdio: ['ignore', 'pipe', 'pipe'],
});
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const installFiles = { existsSync, readdirSync, rmSync };

export function cleanupDesktopInstallDirectories(files = installFiles, warn = console.warn) {
  if (!files.existsSync(executable)) {
    throw new Error('Expected an installed desktop app before cleaning install directories.');
  }
  for (const entry of files.readdirSync('/Applications', { withFileTypes: true })) {
    if (!entry.isDirectory() || !/^\.FalconDeck-(?:backup|stage)-[A-Za-z0-9]{6}$/.test(entry.name)) continue;
    const path = join('/Applications', entry.name);
    try { files.rmSync(path, { recursive: true, force: true }); }
    catch (error) { warn(`Could not remove desktop install directory ${path}: ${error.message}`); }
  }
}

// MCP helpers share the binary but have arguments. Never kill by process name.
export function mainPids(output) {
  return output.split('\n').flatMap((line) => {
    const match = line.trim().match(/^(\d+)\s+(.+)$/);
    return match && match[2] === executable ? [Number(match[1])] : [];
  });
}

// Agent turns run inside the app. Quitting it ends their process tree, which
// would kill this script before it relaunches the app.
export function hostedByApp(output, pid = process.pid) {
  const processes = new Map();
  for (const line of output.split('\n')) {
    const match = line.trim().match(/^(\d+)\s+(\d+)\s+(.+)$/);
    if (match) processes.set(Number(match[1]), { ppid: Number(match[2]), args: match[3] });
  }
  const seen = new Set();
  for (let current = processes.get(pid)?.ppid; current > 1 && !seen.has(current);
    current = processes.get(current)?.ppid) {
    seen.add(current);
    const args = processes.get(current)?.args;
    if (args === executable || args?.startsWith(`${executable} `)) return true;
  }
  return false;
}

// Continue in a new session that outlives the app; the log is the only report.
export function detachRestart(args, { start = spawn, logPath = join(homedir(), '.falcondeck', 'logs', 'desktop-restart.log') } = {}) {
  mkdirSync(dirname(logPath), { recursive: true });
  const out = openSync(logPath, 'a');
  try {
    writeSync(out, `\n${new Date().toISOString()} detached restart-desktop ${args.join(' ')}\n`);
    start(process.execPath, [fileURLToPath(import.meta.url), ...args], {
      detached: true, stdio: ['ignore', out, out], env: { ...process.env, FALCONDECK_RESTART_DETACHED: '1' },
    }).unref();
  } finally {
    closeSync(out);
  }
  return logPath;
}

async function probeDaemonPorts(ports, health, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('Health request timed out')), timeoutMs);
  try {
    // The first valid daemon response wins; a stalled connector must not hold
    // up readiness. Promise.any observes losing rejections after cancellation.
    return await Promise.any(ports.map(async (port) => {
      try {
        const response = await health(`http://127.0.0.1:${port}/api/health`, {
          signal: controller.signal, redirect: 'error',
        });
        if (response.ok) {
          const body = await response.json();
          if (body?.ok === true && typeof body.version === 'string'
            && Number.isInteger(body.workspaces) && body.workspaces >= 0) return Number(port);
        } else {
          await response.body?.cancel();
        }
        throw new Error(`HTTP ${response.status} (not daemon health)`);
      } catch (error) { throw new Error(`port ${port}: ${error.message}`); }
    }));
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}

export async function waitForDesktopHealth({ io = run, delay = sleep, health = fetch,
  now = () => performance.now(), log = console.log, timeoutMs = 120_000 } = {}) {
  const started = now();
  const deadline = started + timeoutMs;
  const read = (command, args) => io(command, args, {
    timeout: Math.max(1, Math.ceil(Math.min(15_000, deadline - now()))),
  });
  const pids = () => mainPids(read('/bin/ps', ['-ww', '-axo', 'pid=,args=']));
  let nextReport = started + 10_000;
  let lastCheck = 'No installed FalconDeck main process found.';
  while (now() < deadline) {
    const running = pids();
    if (now() >= deadline) {
      lastCheck = 'Deadline elapsed while inspecting installed main processes.';
      break;
    }
    if (running.length !== 1) {
      lastCheck = running.length ? `Multiple installed main processes found: ${running.join(', ')}.`
        : 'No installed FalconDeck main process found.';
    } else {
      const pid = running[0];
      let listeners = '';
      lastCheck = `PID ${pid} has no loopback TCP listener yet.`;
      try { listeners = read('/usr/sbin/lsof', ['-nP', '-a', '-p', String(pid), '-iTCP', '-sTCP:LISTEN', '-Fn']); }
      catch (error) { lastCheck = `PID ${pid}; could not inspect listening ports: ${error.message}`; }
      const ports = [...new Set([...listeners.matchAll(/^n127\.0\.0\.1:(\d+)$/gm)].map((match) => match[1]))];
      if (ports.length && now() < deadline) {
        // Connector proxies share the main PID. lsof's first socket is not
        // necessarily the daemon, and an HTTP 200 alone does not identify it.
        let port;
        try {
          port = await probeDaemonPorts(ports, health, Math.max(1, Math.ceil(Math.min(1000, deadline - now()))));
        } catch (error) {
          lastCheck = `PID ${pid}; ${error.errors.map((failure) => failure.message).join('; ')}.`;
        }
        if (port !== undefined) {
          const current = pids();
          if (now() >= deadline) lastCheck = `PID ${pid}; deadline elapsed while verifying its health.`;
          else if (current.length === 1 && current[0] === pid) return { pid, port };
          else lastCheck = current.length > 1 ? `Multiple installed main processes found: ${current.join(', ')}.`
            : `PID ${pid} exited during its health check.`;
        }
      }
    }
    if (now() >= nextReport) {
      log(`Waiting for FalconDeck daemon (${Math.round((now() - started) / 1000)}s): ${lastCheck}`);
      nextReport = now() + 10_000;
    }
    if (now() < deadline) await delay(Math.min(500, deadline - now()));
  }
  throw new Error(`FalconDeck did not become healthy within ${timeoutMs / 1000}s; no automatic restart was scheduled.\n`
    + `Last check: ${lastCheck}\nDaemon log: ${join(homedir(), '.falcondeck', 'logs', 'daemon.log')}`);
}

export async function restartDesktop({ installFrom, io = run, delay = sleep, health = fetch,
  now = () => performance.now(), log = console.log,
  files = { ...installFiles, mkdtempSync, renameSync } } = {}) {
  const pids = () => mainPids(io('/bin/ps', ['-ww', '-axo', 'pid=,args=']));
  const waitFor = async (check, attempts, message) => {
    for (let attempt = 0; attempt < attempts; attempt++) {
      if (await check()) return;
      await delay(500);
    }
    throw new Error(message);
  };
  const target = `gui/${process.getuid()}/${staleJob}`;
  let jobExists = false;
  try { io('/bin/launchctl', ['print', target]); jobExists = true; } catch (error) {
    // launchctl uses 113 for a missing service. Other errors are not absence.
    if (error.status !== 113) throw error;
  }
  if (jobExists) {
    io('/bin/launchctl', ['bootout', target]);
    await waitFor(() => {
      try { io('/bin/launchctl', ['print', target]); return false; } catch (error) {
        if (error.status === 113) return true;
        throw error;
      }
    }, 20, 'The stale restart service is still registered; refusing to restart.');
  }
  let stageDirectory;
  try {
    let staged;
    if (installFrom) {
      io('/usr/bin/codesign', ['--verify', '--deep', '--strict', installFrom]);
      // Complete the potentially failing copy before touching the running app.
      stageDirectory = files.mkdtempSync('/Applications/.FalconDeck-stage-');
      staged = join(stageDirectory, 'FalconDeck.app');
      io('/usr/bin/ditto', [installFrom, staged]);
      io('/usr/bin/codesign', ['--verify', '--deep', '--strict', staged]);
    }
    if (pids().length) {
      try {
        io('/usr/bin/osascript', ['-e', 'with timeout of 8 seconds', '-e',
          'tell application id "com.falcondeck.desktop" to quit', '-e', 'end timeout']);
      } catch { /* A busy app may not handle Apple Events; use exact main PIDs below. */ }
      for (let attempt = 0; attempt < 10 && pids().length; attempt++) await delay(500);
      for (const pid of pids()) {
        // Recheck immediately before signalling; never retain deployment-time PIDs.
        if (pids().includes(pid)) io('/bin/kill', ['-TERM', String(pid)]);
      }
      await waitFor(() => pids().length === 0, 30, 'FalconDeck did not quit; installation aborted.');
    }
    let backup;
    if (staged) {
      // Retain the previous signed bundle until the replacement is healthy.
      if (files.existsSync(app)) {
        backup = join(files.mkdtempSync('/Applications/.FalconDeck-backup-'), 'FalconDeck.app');
        files.renameSync(app, backup);
        log(`Previous app retained until health check succeeds at ${backup}`);
      }
      try { files.renameSync(staged, app); } catch (error) {
        if (backup) files.renameSync(backup, app);
        throw error;
      }
    }
    // One launch only. Failure reports an error, never reschedules another restart.
    io('/usr/bin/open', ['-g', app]);
    await waitForDesktopHealth({ io, delay, health, now, log });
    // The CLI holds the restart lock, so other install runs cannot be staging here.
    try { cleanupDesktopInstallDirectories(files); }
    catch (error) { console.warn(`Could not clean desktop install directories: ${error.message}`); }
  } finally {
    if (stageDirectory) {
      try { files.rmSync(stageDirectory, { recursive: true, force: true }); }
      catch (error) { console.warn(`Could not remove desktop staging directory ${stageDirectory}: ${error.message}`); }
    }
  }
}

export async function withRestartLock(lock, action) {
  // Keep the directory and inode: existence is not ownership. The old empty
  // directory lock can be reused after an interrupted deployment.
  mkdirSync(lock, { recursive: true });
  const fd = openSync(join(lock, 'owner'), 'a', 0o600);
  try {
    // BSD flock belongs to the shared open-file description. lockf acquires it
    // through inherited fd 3; our fd keeps it alive until close or process death.
    const result = spawnSync('/usr/bin/lockf', ['-s', '-t', '0', '3'], {
      stdio: ['ignore', 'ignore', 'pipe', fd], encoding: 'utf8', timeout: 5000,
    });
    if (result.error) throw result.error;
    if (result.status === 75) throw new Error('Another desktop restart is active; wait for it to finish.');
    if (result.status !== 0) throw new Error(`Cannot acquire desktop restart lock: ${result.stderr || result.signal || result.status}`);
    return await action();
  } finally {
    closeSync(fd);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    if (process.platform !== 'darwin') throw new Error('Desktop restart requires macOS.');
    const args = process.argv.slice(2);
    if (args.length && (args.length !== 2 || args[0] !== '--install-from')) {
      throw new Error('Usage: node scripts/restart-desktop.mjs [--install-from /path/FalconDeck.app]');
    }
    const source = args.length ? resolve(args[1]) : undefined;
    if (source && (source === app || !existsSync(join(source, 'Contents/MacOS/falcondeck-desktop')))) {
      throw new Error('Expected a separate, built FalconDeck.app bundle.');
    }
    if (!process.env.FALCONDECK_RESTART_DETACHED && hostedByApp(run('/bin/ps', ['-ww', '-axo', 'pid=,ppid=,args=']))) {
      const logPath = detachRestart(source ? ['--install-from', source] : []);
      console.log(`This shell runs inside FalconDeck, so quitting the app would end this restart.\n`
        + `Continuing detached; this session will end when the app quits. Result: ${logPath}`);
    } else {
      await withRestartLock(join(homedir(), '.falcondeck', 'desktop-restart.lock'), () => restartDesktop({ installFrom: source }));
      console.log('FalconDeck restarted once and its daemon is healthy.');
    }
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
