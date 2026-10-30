#!/usr/bin/env node
// Run inside the with-daemon image with --network=none. Runtime sources are
// mounted read-only at /qualification/runtime; no real credential is accepted.
import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { access, lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { networkInterfaces } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const RUNTIME_SOURCE = '/qualification/runtime';
const DAEMON = '/usr/local/bin/falcondeck-daemon';
const PLACEHOLDER_KEY = 'sk-local-image-qualification-placeholder-no-model-request';
const SAFE_PATH = '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin';
const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const digest = bytes => createHash('sha256').update(bytes).digest('hex');

function diagnosticText(value, secrets) {
  let text = String(value).slice(0, 4096);
  for (const secret of secrets) text = text.replaceAll(secret, '[REDACTED]');
  return text
    .replace(/\b(?:sk-|gh[pousr]_|github_pat_|vercel_)[A-Za-z0-9_-]{8,}\b/g, '[REDACTED_CREDENTIAL]')
    .replace(/\bBearer\s+[^\s"',;}{]+/gi, 'Bearer [REDACTED]')
    .replace(/((?:api[_-]?key|access[_-]?token|refresh[_-]?token|gateway[_-]?token|password|secret)["']?\s*[:=]\s*["']?)[^\s"',;}{]+/gi, '$1[REDACTED]')
    .replace(/(https?:\/\/)[^/\s@]+@/gi, '$1[REDACTED]@')
    .replace(/[\x00-\x1f\x7f]/g, ' ')
    .slice(0, 384);
}

function initialItemDiagnostics(items, secrets) {
  return {
    count: items.length,
    truncated: items.length > 4,
    items: items.slice(0, 4).map(item => {
      if (!item || typeof item !== 'object') return { shape: typeof item };
      const summary = {
        kind: diagnosticText(item.kind ?? item.type ?? 'unknown', secrets),
        keys: Object.keys(item).slice(0, 20).map(key => diagnosticText(key, secrets).slice(0, 48)),
        has_turn_id: typeof item.turn_id === 'string',
      };
      for (const key of ['level', 'status', 'lifecycle', 'message', 'text', 'reason', 'title']) {
        if (typeof item[key] === 'string') summary[key] = diagnosticText(item[key], secrets);
      }
      return summary;
    }),
  };
}

async function freePort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const port = server.address().port;
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  return port;
}

async function absent(path) {
  try { await lstat(path); return false; }
  catch (error) { if (error.code === 'ENOENT') return true; throw error; }
}

async function processes() {
  const result = new Map();
  for (const name of await readdir('/proc')) {
    if (!/^[1-9][0-9]*$/.test(name)) continue;
    try {
      const text = await readFile(`/proc/${name}/stat`, 'utf8');
      const fields = text.slice(text.lastIndexOf(')') + 2).trim().split(/\s+/);
      result.set(Number(name), {
        pid: Number(name), parent: Number(fields[1]), group: Number(fields[2]),
        state: fields[0], started: fields[19],
      });
    } catch (error) { if (!['ENOENT', 'ESRCH', 'EACCES'].includes(error.code)) throw error; }
  }
  return result;
}

// Codex app-server creates its own process group. Record actual descendants
// before shutting down their daemon, rather than killing by binary name.
async function ownedProcessGroups(children) {
  const snapshot = await processes();
  const ownGroup = snapshot.get(process.pid)?.group;
  const owned = new Set(children.filter(child => child.pid && child.exitCode === null && child.signalCode === null).map(child => child.pid));
  let changed;
  do {
    changed = false;
    for (const entry of snapshot.values()) {
      if (!owned.has(entry.pid) && owned.has(entry.parent)) { owned.add(entry.pid); changed = true; }
    }
  } while (changed);
  const groups = new Map();
  for (const pid of owned) {
    const entry = snapshot.get(pid);
    if (!entry || entry.group < 2 || entry.group === ownGroup) continue;
    if (!groups.has(entry.group)) groups.set(entry.group, []);
    groups.get(entry.group).push(entry);
  }
  return groups;
}

async function liveOwnedGroups(groups) {
  const snapshot = await processes();
  return [...groups.entries()].filter(([, members]) => members.some(member => {
    const current = snapshot.get(member.pid);
    return current && current.started === member.started && current.group === member.group && current.state !== 'Z';
  })).map(([group]) => group);
}

async function terminateOwned(children) {
  if (children.length === 0) return;
  const groups = await ownedProcessGroups(children);
  const signal = group => {
    try { process.kill(-group, 'SIGTERM'); }
    catch (error) { if (error.code !== 'ESRCH') throw error; }
  };
  for (const group of await liveOwnedGroups(groups)) signal(group);
  for (let attempt = 0; attempt < 100; attempt++) {
    if (!(await liveOwnedGroups(groups)).length) return;
    await delay(50);
  }
  for (const group of await liveOwnedGroups(groups)) {
    try { process.kill(-group, 'SIGKILL'); }
    catch (error) { if (error.code !== 'ESRCH') throw error; }
  }
  for (let attempt = 0; attempt < 40; attempt++) {
    if (!(await liveOwnedGroups(groups)).length) return;
    await delay(50);
  }
  throw new Error('Qualification-owned process groups did not terminate');
}

async function qualify() {
  const checks = {};
  const children = [];
  const controller = new AbortController();
  const report = {
    ok: false,
    scope: 'local-linux-image',
    architecture: process.arch,
    checks,
    not_tested: ['model_turn', 'paid_cloud_provider', 'snapshot_restore'],
  };
  let stage = 'preflight';
  let scratch;
  let options;
  let scrubWorker;
  let cleanupStarted;
  const cleanup = () => cleanupStarted ??= (async () => {
    const errors = [];
    if (scrubWorker && options) {
      try {
        await scrubWorker(options);
        for (const relative of ['private/bootstrap.json', 'private/gateway.json', 'private/ready.json']) {
          assert(await absent(join(options.runtimePath, relative)), 'Private bootstrap state survived scrubbing');
        }
        assert(await absent(join(options.homePath, '.codex/auth.json')), 'Native credential cache survived scrubbing');
        checks.credential_scrub = true;
      } catch { errors.push('Credential scrubbing failed'); }
    }
    try { await terminateOwned(children); checks.owned_process_cleanup = true; }
    catch { errors.push('Qualification process cleanup failed'); }
    if (scratch && checks.owned_process_cleanup) {
      try { await rm(scratch, { recursive: true, force: true }); checks.scratch_cleanup = true; }
      catch { errors.push('Qualification scratch cleanup failed'); }
    }
    if (errors.length) throw new Error(errors.join('; '));
  })();
  const interrupt = () => {
    controller.abort();
    void cleanup().catch(() => {});
  };
  process.on('SIGTERM', interrupt);
  process.on('SIGINT', interrupt);
  const guard = () => { if (controller.signal.aborted) throw new Error('Qualification interrupted'); };
  try {
    assert.equal(process.platform, 'linux', 'Run qualification inside the Linux worker container');
    assert.equal(process.arch, 'x64', 'Qualify the linux/amd64 worker image');
    assert(Object.values(networkInterfaces()).flat().every(address => address.internal), 'Run with Docker --network=none');
    checks.network_isolated = true;
    const binary = await lstat(DAEMON);
    assert(binary.isFile() && !binary.isSymbolicLink(), 'The image must contain the real daemon executable');
    await access(DAEMON, constants.X_OK);
    const binaryHash = digest(await readFile(DAEMON));
    const version = await exec(DAEMON, ['--version'], { env: { PATH: SAFE_PATH }, timeout: 10_000 });
    assert(/^falcondeck-daemon \S+\s*$/.test(version.stdout), 'Daemon version probe failed');
    report.daemon_version = version.stdout.trim();
    report.daemon_sha256 = binaryHash;
    const codexVersion = await exec('codex', ['--version'], { env: { PATH: SAFE_PATH, HOME: '/tmp' }, timeout: 10_000 });
    assert(/^codex-cli \S+\s*$/.test(codexVersion.stdout), 'Native Codex executable is unavailable');
    report.codex_version = codexVersion.stdout.trim();
    checks.real_image_binaries = true;

    stage = 'prepare';
    const worker = await import(pathToFileURL(join(RUNTIME_SOURCE, 'worker.mjs')));
    const { sourceTreeHash, validateSource } = await import(pathToFileURL(join(RUNTIME_SOURCE, 'source.mjs')));
    const { exportWorkspace } = await import(pathToFileURL(join(RUNTIME_SOURCE, 'worker-export.mjs')));
    scrubWorker = worker.scrubWorker;
    scratch = await mkdtemp('/workspace/falcondeck-image-qualification-');
    options = {
      workspacePath: join(scratch, 'project'), homePath: join(scratch, 'home'),
      runtimePath: join(scratch, 'runtime'), daemonPath: DAEMON,
      daemonPort: await freePort(), gatewayPort: await freePort(),
      attempts: 120, pollMs: 250,
    };
    while (options.gatewayPort === options.daemonPort) options.gatewayPort = await freePort();
    await mkdir(options.runtimePath, { mode: 0o700 });
    for (const filename of ['worker.mjs', 'worker-export.mjs', 'source.mjs', 'gateway.mjs']) {
      const bytes = await readFile(join(RUNTIME_SOURCE, filename));
      await writeFile(join(options.runtimePath, filename), bytes, { mode: 0o600 });
      assert.equal(digest(await readFile(join(options.runtimePath, filename))), digest(bytes));
    }
    checks.real_runtime_scripts = true;
    const file = (path, bytes, executable = false) => ({ path, content_base64: Buffer.from(bytes).toString('base64'), executable });
    const files = [
      file('.gitignore', 'ignored.txt\n'), file('ignored.txt', 'explicit captured source\n'),
      file('tracked.txt', 'captured dirty working bytes\n'),
      file('remove.bin', [0, 255, 1]), file('binary.bin', [0, 1, 254, 255]),
      file('bin/check.sh', '#!/bin/sh\nexit 0\n', true),
    ];
    const token = randomBytes(32).toString('hex');
    const config = {
      source: { files, tree_hash: sourceTreeHash(files) },
      gateway_token: token, openai_api_key: PLACEHOLDER_KEY,
    };
    const prepared = await worker.prepareWorker(config, options);
    assert.equal(prepared.tree_hash, config.source.tree_hash);
    const gitEnv = { PATH: SAFE_PATH, HOME: options.homePath, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_OPTIONAL_LOCKS: '0' };
    const git = args => exec('git', args, { cwd: options.workspacePath, env: gitEnv, encoding: 'buffer', timeout: 10_000, maxBuffer: 1024 * 1024 });
    for (const entry of files) {
      const bytes = Buffer.from(entry.content_base64, 'base64');
      assert.deepEqual(await readFile(join(options.workspacePath, entry.path)), bytes);
      assert.equal(Boolean((await lstat(join(options.workspacePath, entry.path))).mode & 0o111), entry.executable);
      assert.deepEqual((await git(['show', `falcondeck-cloud-baseline:${entry.path}`])).stdout, bytes);
    }
    const indexPath = join(options.workspacePath, '.git/index');
    const originalIndexHash = digest(await readFile(indexPath));
    assert.equal((await git(['rev-parse', 'falcondeck-cloud-baseline'])).stdout.toString().trim(), prepared.baseline_commit);
    checks.captured_bytes_modes_and_baseline = true;
    await writeFile(join(options.runtimePath, 'private/bootstrap.json'), JSON.stringify(config), { mode: 0o600 });
    guard();

    stage = 'real-worker-readiness';
    await worker.startWorker(config, {
      ...options,
      spawn(command, args, settings) {
        guard();
        assert.equal(settings.detached, true, 'Worker processes must actually detach');
        assert(command === DAEMON || command === process.execPath, 'Unexpected worker process');
        const child = spawn(command, args, settings);
        children.push(child);
        return child;
      },
    });
    guard();
    const ready = JSON.parse(await readFile(join(options.runtimePath, 'private/ready.json'), 'utf8'));
    assert.equal(ready.daemon_pid, children[0]?.pid);
    assert.equal(ready.gateway_pid, children[1]?.pid);
    const snapshot = await processes();
    for (const child of children) assert.equal(snapshot.get(child.pid)?.group, child.pid, 'Worker did not start in its own process group');
    const gateway = `http://127.0.0.1:${options.gatewayPort}`;
    const requestCounts = { health: 0, workspace_connect: 0, thread_create: 0, thread_read: 0 };
    report.control_requests = requestCounts;
    const request = async (method, path, body, authenticated = true) => {
      guard();
      // This helper cannot admit a turn, completion, deployment or arbitrary URL.
      assert((method === 'GET' && /^\/api\/(?:health|workspaces\/[A-Za-z0-9_-]+\/threads\/[A-Za-z0-9_-]+)$/.test(path)) ||
        (method === 'POST' && (path === '/api/workspaces/connect' || /^\/api\/workspaces\/[A-Za-z0-9_-]+\/threads$/.test(path))), 'Qualification request is outside the no-turn allowlist');
      requestCounts[path === '/api/health' ? 'health' : path === '/api/workspaces/connect' ? 'workspace_connect' : method === 'POST' ? 'thread_create' : 'thread_read']++;
      return fetch(`${gateway}${path}`, {
        method,
        headers: { ...(authenticated ? { authorization: `Bearer ${token}` } : {}), ...(body ? { 'content-type': 'application/json' } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(60_000)]),
        redirect: 'error',
      });
    };
    const health = await request('GET', '/api/health');
    assert.equal(health.status, 200, 'Real daemon failed authenticated gateway health');
    assert.equal((await health.json()).ok, true);
    const denied = await request('GET', '/api/health', undefined, false);
    assert.equal(denied.status, 401, 'Gateway accepted an unauthenticated request');
    await denied.arrayBuffer();
    checks.detached_daemon_and_authenticated_gateway = true;

    stage = 'native-empty-thread';
    const connected = await request('POST', '/api/workspaces/connect', { path: options.workspacePath, kind: 'project' });
    assert.equal(connected.status, 200, 'Real daemon could not connect the fixture workspace');
    const workspace = await connected.json();
    assert.equal(typeof workspace.id, 'string', 'Workspace response has no identity');
    const created = await request('POST', `/api/workspaces/${workspace.id}/threads`, {
      workspace_id: workspace.id, provider: 'codex', model_id: null,
      approval_policy: 'on-request', sandbox_mode: 'workspace-write',
    });
    assert.equal(created.status, 200, 'Real native Codex thread creation failed');
    const handle = await created.json();
    const thread = handle.thread;
    assert.equal(typeof thread?.id, 'string', 'Native thread response has no identity');
    assert.equal(typeof thread.native_session_id, 'string', 'Native thread has no underlying Codex session');
    assert.equal(handle.workspace?.id, workspace.id);
    const detailResponse = await request('GET', `/api/workspaces/${workspace.id}/threads/${thread.id}`);
    assert.equal(detailResponse.status, 200, 'Real native thread history read failed');
    const detail = await detailResponse.json();
    report.native_initial_state = {
      create_has_turn: thread.latest_turn_id !== null,
      detail_has_turn: detail.thread?.latest_turn_id !== null,
      status: diagnosticText(detail.thread?.status, [token, PLACEHOLDER_KEY]),
      queued_turn_count: Array.isArray(detail.thread?.queued_turns) ? detail.thread.queued_turns.length : null,
    };
    if (Array.isArray(detail.items)) report.native_initial_items = initialItemDiagnostics(detail.items, [token, PLACEHOLDER_KEY]);
    assert.equal(detail.thread.id, thread.id, 'Native history returned a different thread');
    assert.equal(detail.thread.provider, 'codex');
    assert.equal(detail.thread.latest_turn_id, null, 'A model turn was unexpectedly admitted');
    assert.equal(detail.thread.status, 'idle', 'Qualification native thread is not idle');
    assert.equal(detail.thread.queued_turns?.length, 0, 'A qualification-only thread unexpectedly queued a turn');
    assert(Array.isArray(detail.items), 'Native history has no item list');
    checks.no_turn_control_surface = true;
    assert.equal(detail.items.length, 0, 'A qualification-only native thread unexpectedly has conversation items');
    checks.native_empty_thread_and_history = true;

    stage = 'export';
    await writeFile(join(options.workspacePath, 'tracked.txt'), 'local qualification output\n');
    await rm(join(options.workspacePath, 'remove.bin'));
    await writeFile(join(options.workspacePath, 'new.bin'), Buffer.from([255, 0, 127]));
    await writeFile(join(options.workspacePath, '.env'), 'LOCAL_QUALIFICATION_EXCLUDED=placeholder\n');
    const result = await exportWorkspace(options);
    assert.equal(result.tree_hash, config.source.tree_hash, 'Export baseline changed');
    assert.equal(result.current_tree_hash, sourceTreeHash(result.current_files), 'Current export hash is invalid');
    validateSource({ files: result.current_files, tree_hash: result.current_tree_hash });
    assert.deepEqual(result.deleted_paths, ['remove.bin']);
    assert.equal(result.current_files.find(entry => entry.path === 'tracked.txt')?.content_base64, Buffer.from('local qualification output\n').toString('base64'));
    assert.equal(result.current_files.find(entry => entry.path === 'new.bin')?.content_base64, Buffer.from([255, 0, 127]).toString('base64'));
    assert.equal(result.current_files.find(entry => entry.path === 'bin/check.sh')?.executable, true);
    assert(result.excluded_paths.includes('.env'));
    assert(!result.current_files.some(entry => entry.path === '.env'));
    assert.equal(digest(await readFile(indexPath)), originalIndexHash, 'Qualification mutated the source Git index');
    assert(Array.isArray(result.native_sessions), 'Export has no native-session artifact list');
    for (const session of result.native_sessions) {
      assert(/^\.codex\/sessions\/(?:[A-Za-z0-9_.-]+\/)*rollout-[A-Za-z0-9_.-]+\.jsonl$/.test(session.path), 'Unsafe native-session artifact path');
      assert(!Buffer.from(session.content_base64, 'base64').toString().includes(PLACEHOLDER_KEY), 'Native export retained the placeholder model credential');
    }
    assert(!JSON.stringify(result).includes(token), 'Result export retained the gateway credential');
    report.native_session_files = result.native_sessions.length;
    checks.real_export_hashes_delta_and_credential_exclusions = true;
    checks.git_index_preserved = true;
    guard();
    report.ok = true;
  } catch (error) {
    report.error = { stage, message: error instanceof assert.AssertionError ? error.message.split('\n')[0] : error.code ?? error.message };
  } finally {
    try { await cleanup(); }
    catch (error) { report.ok = false; report.cleanup_error = error.message; }
    process.off('SIGTERM', interrupt);
    process.off('SIGINT', interrupt);
  }
  process.stdout.write(`${JSON.stringify(report)}\n`);
  return report.ok ? 0 : 1;
}

process.exitCode = await qualify();
