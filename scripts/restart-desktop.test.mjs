import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdirSync, mkdtempSync, rmdirSync, unlinkSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mainPids, restartDesktop, withRestartLock } from './restart-desktop.mjs';

const binary = '/Applications/FalconDeck.app/Contents/MacOS/falcondeck-desktop';
function fixture({ stale = false, stubborn = false, unhealthy = false, bootoutFails = false } = {}) {
  const calls = [];
  let running = true;
  return {
    calls,
    delay: async () => {},
    health: async (url) => {
      assert.equal(url, 'http://127.0.0.1:59182/api/health');
      return { ok: !unhealthy };
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
test('failed installation copy leaves the running app untouched', async () => {
  const f = fixture();
  const original = f.io;
  f.io = (command, args) => {
    if (command.endsWith('/ditto')) throw new Error('copy failed');
    return original(command, args);
  };
  await assert.rejects(restartDesktop({ ...f, installFrom: '/built/FalconDeck.app',
    files: { mkdtempSync: () => '/Applications/.FalconDeck-stage-test' },
  }), /copy failed/);
  assert.ok(!f.calls.some(([c]) => c.endsWith('/osascript') || c.endsWith('/kill') || c.endsWith('/open')));
});
test('installs a verified staged bundle, retains backup, then opens once', async () => {
  const f = fixture();
  const moves = [];
  await restartDesktop({ ...f, installFrom: '/built/FalconDeck.app', files: {
    existsSync: () => true,
    mkdtempSync: (prefix) => `${prefix}test`,
    renameSync: (from, to) => moves.push([from, to]),
    rmdirSync: () => {},
  } });
  assert.deepEqual(moves, [
    ['/Applications/FalconDeck.app', '/Applications/.FalconDeck-backup-test/FalconDeck.app'],
    ['/Applications/.FalconDeck-stage-test/FalconDeck.app', '/Applications/FalconDeck.app'],
  ]);
  const verification = f.calls.findIndex(([c, ...args]) => c.endsWith('/codesign') && args.at(-1).includes('-stage-'));
  assert.ok(verification < f.calls.findIndex(([c]) => c.endsWith('/osascript')));
  assert.equal(f.calls.filter(([c]) => c.endsWith('/open')).length, 1);
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
