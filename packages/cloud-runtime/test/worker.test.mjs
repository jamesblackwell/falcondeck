import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { access, chmod, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import test from 'node:test';
import { promisify } from 'node:util';
import { sourceTreeHash } from '../src/source.mjs';
import { downloadDaemon, prepareWorker, readyWorker, scrubWorker, startWorker, workerEnvironment } from '../src/worker.mjs';
import { exportWorkspace, safeFile } from '../src/worker-export.mjs';

const exec = promisify(execFile);
const sourceFile = (path, text, executable = false) => ({ path, content_base64: Buffer.from(text).toString('base64'), executable });

async function freePort() {
  const server = createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

async function terminateGroup(pid) {
  try { process.kill(-pid, 'SIGTERM'); } catch {}
  for (let attempt = 0; attempt < 100; attempt++) {
    try { process.kill(pid, 0); } catch { return; }
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  try { process.kill(-pid, 'SIGKILL'); } catch {}
}

async function fixture(t, files = [sourceFile('hello.txt', 'local dirty content\n'), sourceFile('remove.txt', 'delete me\n')]) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'falcondeck-cloud-worker-')));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const options = {
    workspacePath: join(directory, 'project'), homePath: join(directory, 'home'),
    runtimePath: join(directory, 'runtime'), daemonPath: join(directory, 'daemon'),
  };
  await writeFile(options.daemonPath, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  const config = { source: { files, tree_hash: sourceTreeHash(files) }, gateway_token: 'a'.repeat(48), openai_api_key: 'sk-test-explicit-worker-key' };
  return { directory, options, config };
}

test('worker materializes the explicit bytes and synthetic baseline without inheriting host auth', async t => {
  const files = [sourceFile('.gitignore', 'ignored.txt\n'), sourceFile('ignored.txt', 'included explicitly\n'), sourceFile('bin/run', '#!/bin/sh\necho ok\n', true)];
  const { options, config } = await fixture(t, files);
  const result = await prepareWorker(config, options);
  assert.equal(result.tree_hash, config.source.tree_hash);
  assert.equal(await readFile(join(options.workspacePath, 'ignored.txt'), 'utf8'), 'included explicitly\n');
  assert.equal((await lstat(join(options.workspacePath, 'bin/run'))).mode & 0o111, 0o111);
  const git = await exec('git', ['show', 'falcondeck-cloud-baseline:ignored.txt'], { cwd: options.workspacePath });
  assert.equal(git.stdout, 'included explicitly\n');
  assert.deepEqual(JSON.parse(await readFile(join(options.homePath, '.falcondeck/connectors.json'), 'utf8')), { mcpServers: {} });
  const environment = workerEnvironment(config, options);
  assert.equal(environment.OPENAI_API_KEY, config.openai_api_key);
  assert.equal(environment.HOME, options.homePath);
  assert.equal(environment.CODEX_HOME, join(options.homePath, '.codex'));
  assert.equal(environment.VERCEL_TOKEN, undefined);
  assert.equal(environment.SSH_AUTH_SOCK, undefined);
  assert.equal(environment.FALCONDECK_STATE_PATH, join(options.homePath, '.falcondeck/daemon-state.json'));
  const manifest = await readFile(join(options.runtimePath, 'manifest.json'), 'utf8');
  assert(!manifest.includes(config.openai_api_key));
  assert(!manifest.includes(config.gateway_token));
  await assert.rejects(() => access(join(options.homePath, '.codex/auth.json'), constants.F_OK));
});

test('worker independently rejects traversing and secret paths even if transport validation is bypassed', async t => {
  const { options, config } = await fixture(t);
  for (const path of ['../escape', '.env', 'nested/.ssh/id_rsa', '.falcondeck/connectors.json']) {
    const files = [sourceFile(path, 'secret')];
    await assert.rejects(() => prepareWorker({ ...config, source: { files, tree_hash: sourceTreeHash(files) } }, options));
  }
  await assert.rejects(() => prepareWorker({ ...config, source: { ...config.source, tree_hash: '0'.repeat(64) } }, options), /hash/);
});

test('downloaded daemon stays in the writable runtime and cold resume restores isolated child processes', async t => {
  const { options, config } = await fixture(t);
  delete options.daemonPath;
  const destination = join(options.runtimePath, 'falcondeck-daemon');
  await prepareWorker({ ...config, worker_daemon_url: 'https://example.com/daemon', worker_daemon_sha256: '0'.repeat(64) }, {
    ...options,
    download: async (_url, _sha, path) => {
      assert.equal(path, destination);
      await writeFile(path, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    },
  });
  const privatePath = join(options.runtimePath, 'private');
  await writeFile(join(privatePath, 'bootstrap.json'), JSON.stringify(config));
  await writeFile(join(privatePath, 'ready.json'), '{"stale":true}');
  const calls = [];
  const child = () => ({ exitCode: null, on() { return this; }, unref() {} });
  await startWorker({ gateway_token: config.gateway_token, openai_api_key: config.openai_api_key }, {
    ...options,
    spawn: (...args) => { calls.push(args); return child(); },
    healthCheck: async () => {
      await assert.rejects(() => access(join(privatePath, 'ready.json')));
    },
  });
  assert.equal(calls[0][0], destination);
  assert.equal(calls[0][2].env.OPENAI_API_KEY, config.openai_api_key);
  assert.equal(calls[0][2].detached, true);
  assert.equal(calls[1][2].env.OPENAI_API_KEY, undefined);
  assert.equal(calls[1][2].env.VERCEL_TOKEN, undefined);
  assert(!JSON.stringify(calls.map(call => call.slice(0, 2))).includes(config.openai_api_key));
  assert.deepEqual(await readdir(privatePath), ['ready.json']);
});

test('ready waits for asynchronous startup marker and fails after a bounded number of polls', async t => {
  const { options, config } = await fixture(t);
  await prepareWorker(config, options);
  let healthCalls = 0;
  const marker = join(options.runtimePath, 'private/ready.json');
  const timer = setTimeout(() => { writeFile(marker, '{}'); }, 8);
  t.after(() => clearTimeout(timer));
  assert.deepEqual(await readyWorker({ ...options, attempts: 100, pollMs: 1, healthCheck: async () => { healthCalls++; } }), { ready: true });
  assert.equal(healthCalls, 1);
  await rm(marker);
  await assert.rejects(() => readyWorker({ ...options, attempts: 2, pollMs: 1, healthCheck: async () => {} }), /timed out/);
});

test('cold start rejects a changed model endpoint before spawning and restores known-safe native config', async t => {
  const { options, config } = await fixture(t);
  const endpoint = 'https://model.example.com/v1';
  await prepareWorker({ ...config, model_base_url: endpoint }, options);
  const nativeConfig = join(options.homePath, '.codex/config.toml');
  await writeFile(nativeConfig, 'model_provider = "unexpected"\n[mcp_servers.unexpected]\ncommand = "something"\n');
  let spawned = 0;
  const spawnChild = () => {
    spawned++;
    return { exitCode: null, on() { return this; }, unref() {} };
  };
  await assert.rejects(() => startWorker({ ...config, model_base_url: 'https://changed.example.com/v1' }, {
    ...options, spawn: spawnChild, healthCheck: async () => {},
  }), /pinned/);
  assert.equal(spawned, 0);
  await assert.rejects(() => startWorker(config, { ...options, spawn: spawnChild, healthCheck: async () => {} }), /pinned/);
  assert.equal(spawned, 0);
  assert.deepEqual(await startWorker({ ...config, model_base_url: endpoint }, {
    ...options, spawn: spawnChild, healthCheck: async () => {},
  }), { ready: true });
  assert.equal(spawned, 2);
  const restored = await readFile(nativeConfig, 'utf8');
  assert(restored.includes(`base_url = "${endpoint}"`));
  assert(restored.includes('env_key = "OPENAI_API_KEY"'));
  assert(!restored.includes('unexpected'));
  assert(!restored.includes(config.openai_api_key));
  assert.equal((await lstat(nativeConfig)).mode & 0o077, 0);
});

test('a tampered worker manifest cannot redirect the supplied default API credential', async t => {
  const { options, config } = await fixture(t);
  await prepareWorker(config, options);
  const path = join(options.runtimePath, 'manifest.json');
  const manifest = JSON.parse(await readFile(path, 'utf8'));
  manifest.model_base_url = 'https://changed.example.com/v1';
  await writeFile(path, JSON.stringify(manifest));
  await assert.rejects(() => startWorker(config, {
    ...options, spawn: () => { assert.fail('A mismatched endpoint must fail before process creation'); },
  }), /pinned/);
});

test('startup runs a detached loopback daemon through the real authenticated gateway', async t => {
  const { options, config } = await fixture(t);
  await prepareWorker(config, options);
  const daemonPort = await freePort();
  const gatewayPort = await freePort();
  const observedPath = join(options.runtimePath, 'observed.json');
  await writeFile(options.daemonPath, `#!${process.execPath}\nconst http = require('node:http');\nconst fs = require('node:fs');\nfs.writeFileSync(${JSON.stringify(observedPath)},JSON.stringify({home:process.env.HOME,key:process.env.OPENAI_API_KEY,vercel:process.env.VERCEL_TOKEN??null}));\nconst port=Number(process.argv.find(v=>v.startsWith('--port=')).split('=')[1]);\nhttp.createServer((request,response)=>{response.writeHead(200,{'content-type':'application/json'});response.end('{"ok":true}');}).listen(port,'127.0.0.1');\n`, { mode: 0o755 });
  await chmod(options.daemonPath, 0o755);
  await writeFile(join(options.runtimePath, 'gateway.mjs'), await readFile(new URL('../src/gateway.mjs', import.meta.url)));
  const privatePath = join(options.runtimePath, 'private');
  await writeFile(join(privatePath, 'bootstrap.json'), JSON.stringify(config), { mode: 0o600 });
  const children = [];
  let childErrors = '';
  t.after(async () => { await Promise.all(children.map(child => terminateGroup(child.pid))); });
  const startOptions = { ...options, daemonPort, gatewayPort, pollMs: 10, attempts: 100,
    spawn: (command, args, settings) => {
      const child = spawn(command, args, { ...settings, stdio: ['ignore', 'ignore', 'pipe'] });
      child.stderr.on('data', chunk => { childErrors += chunk; });
      child.on('error', error => { childErrors += `spawn:${error.code}`; });
      child.on('exit', (code, signal) => { childErrors += `exit:${code}:${signal}`; });
      children.push(child);
      return child;
    } };
  // Polling begins before the detached startup finishes, matching SDK sequencing.
  const waiting = readyWorker({ ...options, daemonPort, pollMs: 10, attempts: 100 });
  waiting.catch(() => {});
  let started;
  try { started = await startWorker(config, startOptions); }
  catch (error) { await waiting.catch(() => {}); throw new Error(`${error.message}: ${childErrors}`); }
  assert.deepEqual(started, { ready: true });
  assert.deepEqual(await waiting, { ready: true });
  const response = await fetch(`http://127.0.0.1:${gatewayPort}/api/health`, { headers: { authorization: `Bearer ${config.gateway_token}` } });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true });
  const rejected = await fetch(`http://127.0.0.1:${gatewayPort}/api/health`);
  assert.equal(rejected.status, 401);
  assert.deepEqual(JSON.parse(await readFile(observedPath, 'utf8')), { home: options.homePath, key: config.openai_api_key, vercel: null });
  assert.deepEqual(await readdir(privatePath), ['ready.json']);
});

test('failed gateway startup terminates its detached daemon group', async t => {
  const { options, config } = await fixture(t);
  await prepareWorker(config, options);
  await writeFile(options.daemonPath, `#!${process.execPath}\nsetInterval(()=>{},1000);\n`, { mode: 0o755 });
  await chmod(options.daemonPath, 0o755);
  await writeFile(join(options.runtimePath, 'gateway.mjs'), 'process.exit(7);\n');
  const gatewayPort = await freePort();
  const children = [];
  t.after(async () => { await Promise.all(children.map(child => terminateGroup(child.pid))); });
  await assert.rejects(() => startWorker(config, { ...options,
    daemonPort: 1, gatewayPort,
    pollMs: 10, attempts: 100,
    spawn: (...args) => { const child = spawn(...args); children.push(child); return child; },
  }), /failed to start/);
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) await new Promise(resolve => child.once('exit', resolve));
    assert(child.exitCode !== null || child.signalCode !== null);
  }
});

test('export compares current bytes to upload baseline including commits, binary data and deletions', async t => {
  const { options, config } = await fixture(t);
  await prepareWorker(config, options);
  await writeFile(join(options.workspacePath, 'hello.txt'), 'cloud committed edit\n');
  await rm(join(options.workspacePath, 'remove.txt'));
  await writeFile(join(options.workspacePath, 'new.bin'), Buffer.from([0, 255, 1, 2]));
  await exec('git', ['add', '--all'], { cwd: options.workspacePath });
  await exec('git', ['-c', 'user.name=Agent', '-c', 'user.email=agent@localhost', 'commit', '--quiet', '-m', 'Cloud edit'], { cwd: options.workspacePath });
  await writeFile(join(options.workspacePath, 'untracked.txt'), 'new uncommitted file\n');
  await writeFile(join(options.workspacePath, '.env'), 'OPENAI_API_KEY=hidden-secret');
  await mkdir(join(options.workspacePath, 'node_modules'));
  await writeFile(join(options.workspacePath, 'node_modules/cache'), 'dependency');
  const sessionsPath = join(options.homePath, '.codex/sessions/2026/10/30');
  await mkdir(sessionsPath, { recursive: true });
  await writeFile(join(sessionsPath, 'rollout-test.jsonl'), '{"type":"event","text":"api_key=sk-test-explicit-worker-key"}\n');
  await writeFile(join(options.homePath, '.codex/auth.json'), '{"access_token":"must not export"}');
  const result = await exportWorkspace(options);
  assert.equal(result.tree_hash, config.source.tree_hash);
  assert.deepEqual(result.deleted_paths, ['remove.txt']);
  assert.deepEqual(result.current_files.map(file => file.path), ['hello.txt', 'new.bin', 'untracked.txt']);
  assert.equal(result.baseline_files.find(file => file.path === 'hello.txt').content_base64, config.source.files[0].content_base64);
  assert.equal(result.current_files.find(file => file.path === 'hello.txt').content_base64, Buffer.from('cloud committed edit\n').toString('base64'));
  const patch = Buffer.from(result.binary_patch_base64, 'base64').toString();
  assert(patch.includes('GIT binary patch'));
  assert(patch.includes('untracked.txt'));
  assert(patch.includes('remove.txt'));
  assert(!patch.includes('hidden-secret'));
  assert.equal(result.native_sessions.length, 1);
  assert(!Buffer.from(result.native_sessions[0].content_base64, 'base64').toString().includes(config.openai_api_key));
  assert(result.excluded_paths.includes('.env'));
  assert(result.excluded_paths.includes('node_modules'));
  assert(!(await readdir(options.runtimePath)).some(path => path.startsWith('export-')));
});

test('export never follows links to files outside its workspace', async t => {
  const { options, config, directory } = await fixture(t);
  await prepareWorker(config, options);
  await writeFile(join(directory, 'private'), 'outside bytes');
  await symlink(join(directory, 'private'), join(options.workspacePath, 'leak'));
  await assert.rejects(() => exportWorkspace(options), /links/);
});

test('file export caps reads even when a concurrent writer grows beyond its original stat size', async () => {
  let bytesRequested = 0;
  let closed = false;
  const growingFile = {
    stat: async () => ({ isFile: () => true, nlink: 1, size: 1, ino: 1, mtimeMs: 1 }),
    read: async (buffer, offset, length) => {
      bytesRequested += length;
      buffer.fill(0, offset, offset + length);
      return { bytesRead: length };
    },
    close: async () => { closed = true; },
  };
  await assert.rejects(() => safeFile('growing-source-file', 100_000, { openFile: async () => growingFile }), /grew/);
  assert.equal(bytesRequested, 100_001);
  assert.equal(closed, true);
});

test('scrub deletes retained auth and bootstrap credentials while preserving native sessions', async t => {
  const { options, config } = await fixture(t);
  await prepareWorker(config, options);
  const privatePath = join(options.runtimePath, 'private');
  for (const file of ['bootstrap.json', 'gateway.json', 'ready.json']) await writeFile(join(privatePath, file), JSON.stringify(config));
  await writeFile(join(options.homePath, '.codex/auth.json'), config.openai_api_key);
  await scrubWorker(options);
  assert.deepEqual(await readdir(privatePath), []);
  await assert.rejects(() => access(join(options.homePath, '.codex/auth.json')));
  assert((await lstat(join(options.runtimePath, 'manifest.json'))).isFile());
});

test('daemon downloader refuses untrusted transport before opening a connection', async t => {
  const { directory } = await fixture(t);
  await assert.rejects(() => downloadDaemon('http://example.com/daemon', '0'.repeat(64), join(directory, 'download')), /trusted/);
  await assert.rejects(() => downloadDaemon('https://example.com/daemon', 'bad', join(directory, 'download')), /trusted/);
  await assert.rejects(() => downloadDaemon('https://127.0.0.1/daemon', '0'.repeat(64), join(directory, 'download')), /public/);
});
