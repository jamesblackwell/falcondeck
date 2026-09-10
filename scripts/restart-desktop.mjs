import { execFileSync, spawnSync } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, renameSync, rmdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const executable = '/Applications/FalconDeck.app/Contents/MacOS/falcondeck-desktop';
const app = '/Applications/FalconDeck.app';
const staleJob = 'com.falcondeck.apply-writer-fix';
const run = (command, args) => execFileSync(command, args, {
  encoding: 'utf8', timeout: 15_000, stdio: ['ignore', 'pipe', 'pipe'],
});
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

// MCP helpers share the binary but have arguments. Never kill by process name.
export function mainPids(output) {
  return output.split('\n').flatMap((line) => {
    const match = line.trim().match(/^(\d+)\s+(.+)$/);
    return match && match[2] === executable ? [Number(match[1])] : [];
  });
}

export async function restartDesktop({ installFrom, io = run, delay = sleep, health = fetch,
  files = { existsSync, mkdtempSync, renameSync, rmdirSync } } = {}) {
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
  let staged;
  if (installFrom) {
    io('/usr/bin/codesign', ['--verify', '--deep', '--strict', installFrom]);
    // Complete the potentially failing copy before touching the running app.
    staged = join(files.mkdtempSync('/Applications/.FalconDeck-stage-'), 'FalconDeck.app');
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
  if (staged) {
    // Keep the previous signed bundle for rollback; do not recursively delete apps.
    let backup;
    if (files.existsSync(app)) {
      backup = join(files.mkdtempSync('/Applications/.FalconDeck-backup-'), 'FalconDeck.app');
      files.renameSync(app, backup);
      console.log(`Previous app retained at ${backup}`);
    }
    try { files.renameSync(staged, app); } catch (error) {
      if (backup) files.renameSync(backup, app);
      throw error;
    }
    files.rmdirSync(dirname(staged));
  }
  // One launch only. Failure reports an error, never reschedules another restart.
  io('/usr/bin/open', ['-g', app]);
  await waitFor(async () => {
    const running = pids();
    if (running.length !== 1) return false;
    let listeners;
    try { listeners = io('/usr/sbin/lsof', ['-nP', '-a', '-p', String(running[0]), '-iTCP', '-sTCP:LISTEN', '-Fn']); }
    catch { return false; }
    const port = listeners.match(/^n127\.0\.0\.1:(\d+)$/m)?.[1];
    if (!port) return false;
    try {
      const response = await health(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(1000) });
      return response.ok && pids().includes(running[0]);
    } catch { return false; }
  }, 60, 'FalconDeck launched but did not become healthy; no automatic restart was scheduled.');
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
    await withRestartLock(join(homedir(), '.falcondeck', 'desktop-restart.lock'), () => restartDesktop({ installFrom: source }));
    console.log('FalconDeck restarted once and its daemon is healthy.');
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
