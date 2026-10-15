import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdirSync, mkdtempSync, rmdirSync, unlinkSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mainPids, pruneDesktopBackups, restartDesktop, waitForDesktopHealth, withRestartLock } from './restart-desktop.mjs';

const binary = '/Applications/FalconDeck.app/Contents/MacOS/falcondeck-desktop';
function fixture({ stale = false, stubborn = false, unhealthy = false, bootoutFails = false } = {}) {
  const calls = [];
  let running = true;
  let elapsed = 0;
  return {
    calls,
    now: () => elapsed,
    log: () => {},
    delay: async (ms) => { elapsed += ms; },
    health: async (url) => {
      assert.equal(url, 'http://127.0.0.1:59182/api/health');
      return { ok: !unhealthy, status: unhealthy ? 503 : 200,
        json: async () => ({ ok: true, version: '0.1.3', workspaces: 90 }) };
    },
    io(command, args) {
      calls.push([command, ...args]);
      if (command.endsWith('/launchctl')) {
        assert.ok(['print', 'bootout'].includes(args[0]), 'must never register a service');
        assert.equal(args[1], `gui/${process.getuid()}/com.falcondeck.apply-writer-fix`);
        if (args[0] === 'print' && !stale) throw Object.assign(new Error('missing'), { status: 113 });
        if (args[0] === 'bootout') {
          if (bootoutFails) throw new Error('cannot remove stale job');
          stale = false;
        }
      }
      if (command.endsWith('/ps')) return `${running ? `123 ${binary}\n` : ''}456 ${binary} mcp-server`;
      if (command.endsWith('/kill')) { assert.deepEqual(args, ['-TERM', '123']); running = stubborn; }
      if (command.endsWith('/open')) running = true;
      if (command.endsWith('/lsof')) return 'p123\nf13\nn127.0.0.1:59182\n';
      return '';
    },
  };
}

test('identifies only the installed main process, not MCP helpers or dev apps', () => {
  assert.deepEqual(mainPids(`1 ${binary}\n2 ${binary} mcp-server\n3 /tmp/FalconDeck.app/Contents/MacOS/falcondeck-desktop`), [1]);
});
test('one restart, no service created, helpers untouched', async () => {
  const f = fixture();
  await restartDesktop(f);
  assert.equal(f.calls.filter(([c]) => c.endsWith('/open')).length, 1);
  assert.equal(f.calls.filter(([c]) => c.endsWith('/kill')).length, 1);
});
test('removes the known keep-alive job before quitting the app', async () => {
  const f = fixture({ stale: true });
  await restartDesktop(f);
  assert.ok(f.calls.findIndex(([, action]) => action === 'bootout') < f.calls.findIndex(([c]) => c.endsWith('/osascript')));
});
test('refuses to restart when the keep-alive job cannot be removed', async () => {
  const f = fixture({ stale: true, bootoutFails: true });
  await assert.rejects(restartDesktop(f), /cannot remove/);
  assert.ok(!f.calls.some(([c]) => c.endsWith('/open') || c.endsWith('/kill')));
});
test('quit timeout never installs or opens another instance', async () => {
  const f = fixture({ stubborn: true });
  await assert.rejects(restartDesktop(f), /did not quit/);
  assert.ok(!f.calls.some(([c]) => c.endsWith('/open') || c.endsWith('/ditto')));
});
test('failed health check does not trigger another restart', async () => {
  const f = fixture({ unhealthy: true });
  await assert.rejects(restartDesktop(f), /no automatic restart/);
  assert.equal(f.calls.filter(([c]) => c.endsWith('/open')).length, 1);
});
test('finds the daemon when a connector listener appears first', async () => {
  const f = fixture();
  const original = f.io;
  await restartDesktop({ ...f, io: (command, args) => command.endsWith('/lsof')
    ? 'p123\nf31\nn127.0.0.1:59183\nf13\nn127.0.0.1:59182\n'
    : original(command, args),
  health: async (url) => url.includes(':59183/') ? { ok: false, status: 404 } : f.health(url) });
  assert.equal(f.calls.filter(([c]) => c.endsWith('/open')).length, 1);
});
test('waits for daemon readiness beyond the old thirty-second window', async () => {
  const f = fixture();
  let probes = 0;
  await restartDesktop({ ...f, health: async (url) => ++probes <= 70
    ? { ok: false, status: 503 } : f.health(url) });
  assert.ok(probes > 60);
  assert.equal(f.calls.filter(([c]) => c.endsWith('/open')).length, 1);
});
test('an unrelated HTTP success is not daemon health', async () => {
  const f = fixture();
  await assert.rejects(restartDesktop({ ...f, health: async () => ({ ok: true, status: 200,
    json: async () => ({ connected: true }) }) }), /no automatic restart/);
});
test('health failures report the observed PID, port, response, and log path', async () => {
  const f = fixture({ unhealthy: true });
  await assert.rejects(restartDesktop(f), (error) => {
    assert.match(error.message, /PID 123/);
    assert.match(error.message, /59182.*HTTP 503/);
    assert.match(error.message, /\.falcondeck\/logs\/daemon\.log/);
    return true;
  });
});
test('a launch without a main process reports that state instead of claiming it launched', async () => {
  const f = fixture();
  const original = f.io;
  await assert.rejects(waitForDesktopHealth({ ...f,
    io: (command, args) => command.endsWith('/ps') ? `456 ${binary} mcp-extensions` : original(command, args),
  }), /No installed FalconDeck main process found/);
  assert.ok(!f.calls.some(([c]) => c.endsWith('/open') || c.endsWith('/lsof')));
});
test('health timeout includes request time rather than counting polling attempts', async () => {
  const f = fixture();
  let elapsed = 0;
  let probes = 0;
  await assert.rejects(waitForDesktopHealth({ ...f, timeoutMs: 2000,
    now: () => elapsed,
    delay: async (ms) => { elapsed += ms; },
    health: async () => { probes++; elapsed += 1500; return { ok: false, status: 503 }; },
  }), /within 2s/);
  assert.equal(probes, 1);
  assert.equal(elapsed, 2000);
});
test('a healthy daemon returns immediately and cancels stalled connector probes', async () => {
  const f = fixture();
  const original = f.io;
  let releaseConnector;
  let connectorSignal;
  const waiting = waitForDesktopHealth({ ...f,
    io: (command, args) => command.endsWith('/lsof')
      ? 'p123\nn127.0.0.1:59183\nn127.0.0.1:59182\n' : original(command, args),
    health: async (url, { signal }) => {
      if (url.includes(':59183/')) {
        connectorSignal = signal;
        return new Promise((resolve) => { releaseConnector = () => resolve({ ok: false, status: 503 }); });
      }
      return f.health(url);
    },
  });
  try {
    assert.equal(await Promise.race([
      waiting.then(() => 'healthy'),
      new Promise((resolve) => setImmediate(() => resolve('still waiting'))),
    ]), 'healthy');
    assert.ok(connectorSignal.aborted, 'cancel requests that lost the health probe race');
  } finally { releaseConnector(); await waiting; }
});
test('health succeeds only while exactly one installed main process remains', async () => {
  const f = fixture();
  const original = f.io;
  let reads = 0;
  await assert.rejects(waitForDesktopHealth({ ...f,
    io: (command, args) => {
      const output = original(command, args);
      return command.endsWith('/ps') && ++reads > 1 ? `${output}\n789 ${binary}` : output;
    },
  }), /Multiple installed main processes found: 123, 789/);
});
test('a process check that exhausts the deadline cannot report success', async () => {
  const f = fixture();
  const original = f.io;
  let elapsed = 0;
  let reads = 0;
  const timeouts = [];
  await assert.rejects(waitForDesktopHealth({ ...f, timeoutMs: 1000, now: () => elapsed,
    delay: async (ms) => { elapsed += ms; },
    io: (command, args, options) => {
      timeouts.push(options?.timeout);
      if (command.endsWith('/ps') && ++reads === 2) elapsed = 1000;
      return original(command, args);
    },
  }), /within 1s/);
  assert.ok(timeouts.every((timeout) => timeout > 0 && timeout <= 1000));
});
test('listener inspection failures retain the command error in diagnostics', async () => {
  const f = fixture();
  const original = f.io;
  await assert.rejects(waitForDesktopHealth({ ...f,
    io: (command, args) => {
      if (command.endsWith('/lsof')) throw new Error('lsof permission denied');
      return original(command, args);
    },
  }), /PID 123.*lsof permission denied/);
});
test('real HTTP probes cancel a stalled JSON body when another port is healthy', async () => {
  const f = fixture();
  const original = f.io;
  let notifyStalled;
  let stalledResponse;
  const stalledStarted = new Promise((resolve) => { notifyStalled = resolve; });
  const stalled = createServer((_request, response) => {
    stalledResponse = response;
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.write('{"ok":');
    notifyStalled();
  });
  const daemon = createServer(async (_request, response) => {
    await stalledStarted;
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ ok: true, version: '0.1.3', workspaces: 90 }));
  });
  const servers = [stalled, daemon];
  try {
    await Promise.all(servers.map((server) => {
      server.listen(0, '127.0.0.1');
      return once(server, 'listening');
    }));
    const port = daemon.address().port;
    const result = await waitForDesktopHealth({ ...f, health: fetch,
      io: (command, args) => command.endsWith('/lsof')
        ? `p123\nn127.0.0.1:${stalled.address().port}\nn127.0.0.1:${port}\n` : original(command, args),
    });
    assert.deepEqual(result, { pid: 123, port });
    if (!stalledResponse.destroyed) await once(stalledResponse, 'close', { signal: AbortSignal.timeout(2000) });
  } finally {
    await Promise.all(servers.map((server) => new Promise((resolve) => {
      server.close(resolve);
      server.closeAllConnections();
    })));
  }
});
test('failed installation copy leaves the running app untouched', async () => {
  const f = fixture();
  const original = f.io;
  const removed = [];
  f.io = (command, args) => {
    if (command.endsWith('/ditto')) throw new Error('copy failed');
    return original(command, args);
  };
  await assert.rejects(restartDesktop({ ...f, installFrom: '/built/FalconDeck.app',
    files: { mkdtempSync: () => '/Applications/.FalconDeck-stage-test',
      rmSync: (path, options) => removed.push([path, options]) },
  }), /copy failed/);
  assert.ok(!f.calls.some(([c]) => c.endsWith('/osascript') || c.endsWith('/kill') || c.endsWith('/open')));
  assert.deepEqual(removed, [['/Applications/.FalconDeck-stage-test', { recursive: true, force: true }]]);
});
test('failed staged verification cleans the copied bundle without quitting the app', async () => {
  const f = fixture();
  const original = f.io;
  const removed = [];
  await assert.rejects(restartDesktop({ ...f, installFrom: '/built/FalconDeck.app',
    io: (command, args) => {
      if (command.endsWith('/codesign') && args.at(-1).includes('-stage-')) throw new Error('invalid staged signature');
      return original(command, args);
    },
    files: { mkdtempSync: () => '/Applications/.FalconDeck-stage-test',
      rmSync: (path) => removed.push(path) },
  }), /invalid staged signature/);
  assert.deepEqual(removed, ['/Applications/.FalconDeck-stage-test']);
  assert.ok(!f.calls.some(([c]) => c.endsWith('/osascript') || c.endsWith('/kill') || c.endsWith('/open')));
});
test('a refused quit cleans the staged bundle and leaves the installed bundle in place', async () => {
  const f = fixture({ stubborn: true });
  const removed = [];
  await assert.rejects(restartDesktop({ ...f, installFrom: '/built/FalconDeck.app', files: {
    mkdtempSync: () => '/Applications/.FalconDeck-stage-test',
    renameSync: () => assert.fail('must not replace an app that did not quit'),
    rmSync: (path) => removed.push(path),
  } }), /did not quit/);
  assert.deepEqual(removed, ['/Applications/.FalconDeck-stage-test']);
  assert.ok(!f.calls.some(([c]) => c.endsWith('/open')));
});
test('failed bundle promotion restores the previous app and cleans the stage', async () => {
  const f = fixture();
  const moves = [];
  const removed = [];
  await assert.rejects(restartDesktop({ ...f, installFrom: '/built/FalconDeck.app', files: {
    existsSync: () => true,
    mkdtempSync: (prefix) => `${prefix}test01`,
    renameSync: (from, to) => {
      moves.push([from, to]);
      if (from.includes('-stage-')) throw new Error('promotion failed');
    },
    rmSync: (path) => removed.push(path),
  } }), /promotion failed/);
  assert.deepEqual(moves, [
    ['/Applications/FalconDeck.app', '/Applications/.FalconDeck-backup-test01/FalconDeck.app'],
    ['/Applications/.FalconDeck-stage-test01/FalconDeck.app', '/Applications/FalconDeck.app'],
    ['/Applications/.FalconDeck-backup-test01/FalconDeck.app', '/Applications/FalconDeck.app'],
  ]);
  assert.deepEqual(removed, ['/Applications/.FalconDeck-stage-test01']);
  assert.ok(!f.calls.some(([c]) => c.endsWith('/open')));
});
test('installs a verified staged bundle, retains backup, then opens once', async () => {
  const f = fixture();
  const moves = [];
  const removed = [];
  let healthy = false;
  await restartDesktop({ ...f, installFrom: '/built/FalconDeck.app', files: {
    existsSync: () => true,
    mkdtempSync: (prefix) => `${prefix}test01`,
    renameSync: (from, to) => moves.push([from, to]),
    readdirSync: () => {
      assert.ok(healthy, 'must retain older backups until the replacement is healthy');
      return ['test01', 'older1', 'older2'].map((suffix) => ({
        name: `.FalconDeck-backup-${suffix}`, isDirectory: () => true,
      }));
    },
    rmSync: (path, options) => {
      assert.deepEqual(options, path.includes('-stage-') ? { recursive: true, force: true } : { recursive: true });
      removed.push(path);
    },
  }, health: async (url) => { const result = await f.health(url); healthy = result.ok; return result; } });
  assert.deepEqual(moves, [
    ['/Applications/FalconDeck.app', '/Applications/.FalconDeck-backup-test01/FalconDeck.app'],
    ['/Applications/.FalconDeck-stage-test01/FalconDeck.app', '/Applications/FalconDeck.app'],
  ]);
  assert.deepEqual(removed, ['/Applications/.FalconDeck-backup-older1', '/Applications/.FalconDeck-backup-older2',
    '/Applications/.FalconDeck-stage-test01']);
  const verification = f.calls.findIndex(([c, ...args]) => c.endsWith('/codesign') && args.at(-1).includes('-stage-'));
  assert.ok(verification < f.calls.findIndex(([c]) => c.endsWith('/osascript')));
  assert.equal(f.calls.filter(([c]) => c.endsWith('/open')).length, 1);
});
test('an unhealthy replacement preserves all previous backups', async () => {
  const f = fixture({ unhealthy: true });
  const removed = [];
  await assert.rejects(restartDesktop({ ...f, installFrom: '/built/FalconDeck.app', files: {
    existsSync: () => true,
    mkdtempSync: (prefix) => `${prefix}test01`,
    renameSync: () => {},
    readdirSync: () => assert.fail('must not prune before health check succeeds'),
    rmSync: (path) => removed.push(path),
  } }), /no automatic restart/);
  assert.deepEqual(removed, ['/Applications/.FalconDeck-stage-test01']);
});
test('backup pruning ignores unrelated directories and symlinks', () => {
  const removed = [];
  pruneDesktopBackups('/Applications/.FalconDeck-backup-test01', {
    existsSync: () => true,
    readdirSync: () => [
      { name: '.FalconDeck-backup-test01', isDirectory: () => true },
      { name: '.FalconDeck-backup-older1', isDirectory: () => true },
      { name: '.FalconDeck-backup-linked', isDirectory: () => false },
      { name: '.FalconDeck-backup-manual-archive', isDirectory: () => true },
      { name: 'FalconDeck.app', isDirectory: () => true },
      { name: '.FalconDeck-stage-test01', isDirectory: () => true },
    ],
    rmSync: (path) => removed.push(path),
  });
  assert.deepEqual(removed, ['/Applications/.FalconDeck-backup-older1']);
});
test('backup pruning refuses to delete anything without a valid retained app', () => {
  const files = { existsSync: () => false, readdirSync: () => assert.fail('must not enumerate backups') };
  assert.throws(() => pruneDesktopBackups('/Applications/.FalconDeck-backup-test01', files), /existing desktop backup/);
  assert.throws(() => pruneDesktopBackups('/Applications/FalconDeck.app', files), /existing desktop backup/);
});
test('overlapping restart is rejected and lock is released on failure', { skip: process.platform !== 'darwin' }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'falcondeck-restart-test-'));
  const lock = join(dir, 'lock');
  try {
    await assert.rejects(withRestartLock(lock, async () => {
      await assert.rejects(withRestartLock(lock, () => assert.fail('overlap')), /Another desktop restart/);
      throw new Error('startup failed');
    }), /startup failed/);
    await withRestartLock(lock, async () => {});
  } finally { unlinkSync(join(lock, 'owner')); rmdirSync(lock); rmdirSync(dir); }
});

test('an abandoned directory from the old installer does not block restart', { skip: process.platform !== 'darwin' }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'falcondeck-restart-test-'));
  const lock = join(dir, 'lock');
  mkdirSync(lock);
  try { await withRestartLock(lock, async () => {}); }
  finally { unlinkSync(join(lock, 'owner')); rmdirSync(lock); rmdirSync(dir); }
});

test('SIGKILL releases ownership without finally cleanup', { skip: process.platform !== 'darwin', timeout: 10000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'falcondeck-restart-test-'));
  const lock = join(dir, 'lock');
  const module = new URL('./restart-desktop.mjs', import.meta.url).href;
  const child = spawn(process.execPath, ['--input-type=module', '-e',
    `import { withRestartLock } from ${JSON.stringify(module)};
     await withRestartLock(${JSON.stringify(lock)}, async () => {
       process.stdout.write('locked'); await new Promise(() => setInterval(() => {}, 1000));
     });`,
  ], { stdio: ['ignore', 'pipe', 'pipe'] });
  const exited = once(child, 'exit');
  try {
    await Promise.race([
      once(child.stdout, 'data'),
      exited.then(() => { throw new Error('Lock holder exited before acquiring lock'); }),
    ]);
    await assert.rejects(withRestartLock(lock, () => assert.fail('overlap')), /Another desktop restart/);
    child.kill('SIGKILL');
    await exited;
    await withRestartLock(lock, async () => {});
  } finally {
    if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await exited; }
    unlinkSync(join(lock, 'owner')); rmdirSync(lock); rmdirSync(dir);
  }
});
