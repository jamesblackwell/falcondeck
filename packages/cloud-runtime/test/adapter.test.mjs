import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable, Writable } from 'node:stream';
import { mkdtemp, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { APIError } from '@vercel/sandbox';
import { createAdapter, SNAPSHOT_EXPIRATION_MS } from '../src/adapter.mjs';
import { sourceTreeHash } from '../src/source.mjs';
import { networkPolicy } from '../src/network.mjs';
import { runCli } from '../src/cli.mjs';

const auth = { token: 'provider-secret', teamId: 'team_fixture', projectId: 'prj_fixture' };
const publicDns = async () => [{ address: '93.184.216.34' }];
const files = [{ path: 'README.md', content_base64: Buffer.from('fixture').toString('base64'), executable: false }];
const request = () => ({ credentials: auth, name: 'fd-cloud-fixture', image: `fixture@sha256:${'a'.repeat(64)}`,
  timeout_ms: 60_000, cpus: 1, allowed_domains: ['api.openai.com'], openai_api_key: 'model-secret',
  source: { files, tree_hash: sourceTreeHash(files) } });

function fixture({ failCommand, failCreate = false, status = 'running', snapshot = 'snap_fixture', failStop = false, failDelete = false, failUpdate = false } = {}) {
  const calls = [], writes = [];
  const sandbox = {
    name: 'fd-cloud-fixture', status, currentSnapshotId: snapshot, persistent: true,
    expiresAt: new Date('2026-10-30T12:00:00Z'), snapshotExpiration: SNAPSHOT_EXPIRATION_MS,
    domain: port => { assert.equal(port, 3000); return 'https://fixture.vercel.run'; },
    async writeFiles(value) { writes.push(...value); calls.push(['writeFiles']); },
    async runCommand(value) {
      calls.push(['runCommand', value]);
      const exitCode = failCommand?.(value) ? 1 : 0;
      return { exitCode, stdout: async () => '{}',
        logs: async function* () { yield { stream: 'stdout', data: '{}' }; },
        wait: async () => ({ exitCode }), kill: async () => { calls.push(['kill']); },
      };
    },
    async update(value) { calls.push(['update', value]); if (failUpdate) throw new Error('update failed'); Object.assign(sandbox, value); },
    async stop() { calls.push(['stop']); if (failStop) throw new Error('secret stop message'); sandbox.status = 'stopped'; },
    async delete(value) { calls.push(['delete', value]); if (failDelete) throw new Error('delete failed'); sandbox.status = 'deleted'; },
    currentSession() { return session; },
  };
  const session = { runCommand: sandbox.runCommand.bind(sandbox), writeFiles: sandbox.writeFiles.bind(sandbox) };
  // These convenience methods would auto-resume in the real SDK. Make any
  // accidental use fail the test rather than hiding a new billing session.
  sandbox.runCommand = async () => { throw new Error('Implicit-resume command API must not be called'); };
  sandbox.writeFiles = async () => { throw new Error('Implicit-resume upload API must not be called'); };
  const Sandbox = {
    async create(value) { calls.push(['create', value]); if (failCreate) throw new Error('provider-secret'); return sandbox; },
    async get(value) { calls.push(['get', value]); if (value.resume) sandbox.status = 'running'; return sandbox; },
  };
  return { adapter: createAdapter({ Sandbox, APIError, resolve: publicDns, token: () => 'g'.repeat(64) }), calls, writes, sandbox, session };
}

test('create pins SDK scope, timeout, default-deny policy, short snapshot retention and only gateway exposure', async () => {
  const { adapter, calls, writes } = fixture();
  const result = await adapter.create(request());
  assert.equal(result.gateway_token, 'g'.repeat(64));
  assert.equal(result.workspace_path, '/workspace/project');
  const options = calls.find(([kind]) => kind === 'create')[1];
  assert.deepEqual(options.env, {});
  assert.deepEqual(options.ports, [3000]);
  assert.equal(options.snapshotExpiration, SNAPSHOT_EXPIRATION_MS);
  assert.deepEqual(options.keepLastSnapshots, { count: 1, expiration: SNAPSHOT_EXPIRATION_MS, deleteEvicted: true });
  assert.deepEqual(options.networkPolicy.allow, ['api.openai.com']);
  assert(options.networkPolicy.subnets.deny.includes('169.254.0.0/16'));
  const commands = calls.filter(([kind]) => kind === 'runCommand').map(([, value]) => value);
  assert(commands.some(value => value.detached && value.args.includes('start')));
  assert(!JSON.stringify(commands).includes('model-secret'));
  assert(!JSON.stringify(commands).includes('provider-secret'));
  assert(!JSON.stringify(writes.map(({ content }) => content.toString())).includes('provider-secret'));
  assert(writes.some(({ content }) => content.toString().includes('model-secret')));
  assert(!calls.some(([kind]) => kind === 'stop'));
});

test('invalid capture, unpinned image, missing key and prohibited network fail before billable create', async () => {
  for (const change of [{ image: 'latest' }, { openai_api_key: '' }, { allowed_domains: ['api.openai.com', 'connect.falcondeck.com'] },
    { source: { files, tree_hash: '0'.repeat(64) } }, { worker_daemon_url: 'http://example.com/daemon' }]) {
    const { adapter, calls } = fixture();
    await assert.rejects(adapter.create({ ...request(), ...change }));
    assert(!calls.some(([kind]) => kind === 'create'));
  }
  await assert.rejects(networkPolicy(request(), async () => [{ address: '10.1.2.3' }]), /prohibited network/);
  await assert.rejects(networkPolicy({ ...request(), allowed_domains: ['*.openai.com'] }, publicDns));
});

test('trusted release download host is revoked after prepare and before any daemon starts', async () => {
  const { adapter, calls } = fixture();
  await adapter.create({ ...request(), worker_daemon_url: 'https://connect.falcondeck.com/dist/falcondeck-daemon-x86_64-linux', worker_daemon_sha256: 'b'.repeat(64) });
  assert(calls.find(([kind]) => kind === 'create')[1].networkPolicy.allow.includes('connect.falcondeck.com'));
  const prepare = calls.findIndex(([kind, value]) => kind === 'runCommand' && value.args.includes('prepare'));
  const revoke = calls.findIndex(([kind, value]) => kind === 'update' && value.networkPolicy);
  const start = calls.findIndex(([kind, value]) => kind === 'runCommand' && value.args.includes('start'));
  assert(prepare < revoke && revoke < start);
  assert.deepEqual(calls[revoke][1].networkPolicy.allow, ['api.openai.com']);
  await assert.rejects(networkPolicy({ ...request(), worker_daemon_url: 'https://connect.falcondeck.com/api/snapshot' }, publicDns));
});

test('failed boot stops billing without retaining secret snapshots; cleanup failure includes durable identity', async () => {
  const failed = fixture({ failCommand: value => value.args?.includes('prepare') });
  await assert.rejects(failed.adapter.create(request()), { code: 'create_failed' });
  assert(failed.calls.some(([kind, value]) => kind === 'update' && value.persistent === false));
  assert(failed.calls.some(([kind]) => kind === 'stop'));
  assert(failed.calls.some(([kind, value]) => kind === 'delete' && value.deleteOrphanSnapshots));
  const leaked = fixture({ failCommand: value => value.args?.includes('prepare'), failStop: true, failDelete: true });
  await assert.rejects(leaked.adapter.create(request()), { code: 'cleanup_failed', sandbox_id: 'fd-cloud-fixture' });
  const updateFailed = fixture({ failCommand: value => value.args?.includes('prepare'), failUpdate: true });
  await assert.rejects(updateFailed.adapter.create(request()), { code: 'create_failed' });
  assert(updateFailed.calls.some(([kind]) => kind === 'stop'));
  assert(updateFailed.calls.some(([kind]) => kind === 'delete'));
});

test('inspect, stop and export never implicitly resume stopped environments', async () => {
  const { adapter, calls } = fixture({ status: 'stopped' });
  assert.equal((await adapter.inspect({ credentials: auth, sandbox_id: 'fd-cloud-fixture' })).status, 'stopped');
  assert.equal((await adapter.stop({ credentials: auth, sandbox_id: 'fd-cloud-fixture' })).status, 'stopped');
  await assert.rejects(adapter.export({ credentials: auth, sandbox_id: 'fd-cloud-fixture' }), { code: 'not_running' });
  assert(!calls.some(([kind]) => kind === 'runCommand' || kind === 'create'));
  assert(calls.filter(([kind]) => kind === 'get').every(([, options]) => options.resume === false));
});

test('resume requires an extant snapshot and never creates a substitute environment', async () => {
  const { adapter, calls } = fixture({ status: 'stopped', snapshot: null });
  await assert.rejects(adapter.resume({ credentials: auth, sandbox_id: 'fd-cloud-fixture', openai_api_key: 'model-key' }), { code: 'snapshot_missing' });
  assert(!calls.some(([kind, options]) => kind === 'create' || (kind === 'get' && options.resume)));
});

test('resume configures the actual provider timeout before restoring the same sandbox', async () => {
  const { adapter, calls } = fixture({ status: 'stopped' });
  const result = await adapter.resume({ credentials: auth, sandbox_id: 'fd-cloud-fixture', openai_api_key: 'fresh-model-key', timeout_ms: 120_000 });
  assert.equal(result.sandbox_id, 'fd-cloud-fixture');
  const update = calls.findIndex(([kind, value]) => kind === 'update' && value.timeout === 120_000);
  const resume = calls.findIndex(([kind, value]) => kind === 'get' && value.resume);
  assert(update >= 0 && update < resume);
  assert(!calls.some(([kind]) => kind === 'create'));
  assert(!calls.some(([kind, value]) => kind === 'runCommand' && value.args.includes('prepare')));
});

test('stop scrubs runtime secrets and preserves bounded resume state after verified export', async () => {
  const { adapter, calls } = fixture();
  const result = await adapter.stop({ credentials: auth, sandbox_id: 'fd-cloud-fixture', export_verified: true });
  assert.equal(result.status, 'stopped');
  assert.equal(result.persistent, true);
  const scrub = calls.findIndex(([kind, value]) => kind === 'runCommand' && value.args.includes('scrub'));
  const stop = calls.findIndex(([kind]) => kind === 'stop');
  assert(scrub >= 0 && scrub < stop);
  assert(!calls.some(([kind]) => kind === 'delete'));
  assert(!calls.some(([kind, value]) => kind === 'update' && value.persistent === false));
});

test('deleting retained environment state is an explicit separate operation', async () => {
  const { adapter, calls } = fixture({ status: 'stopped' });
  assert.deepEqual(await adapter.delete({ credentials: auth, sandbox_id: 'fd-cloud-fixture' }), { sandbox_id: 'fd-cloud-fixture', deleted: true });
  assert(calls.some(([kind, value]) => kind === 'delete' && value.deleteOrphanSnapshots));
  assert(!calls.some(([kind]) => kind === 'runCommand' || kind === 'create'));
});

test('inspect and stop recognize only genuine sandbox metadata 404s as confirmed absence', async () => {
  const missing = new APIError(new Response('{}', { status: 404 }), { json: { error: { code: 'not_found' } } });
  let creates = 0;
  const adapterFor = error => createAdapter({ Sandbox: { get: async () => { throw error; }, create: async () => { creates++; } }, APIError });
  for (const operation of ['inspect', 'stop']) {
    const result = await adapterFor(missing)[operation]({ credentials: auth, sandbox_id: 'fd-cloud-fixture' });
    assert.equal(result.status, 'deleted');
    assert.equal(result.deleted, true);
    assert.equal(result.missing, true);
    for (const error of [Object.assign(new Error('network error'), { status: 404 }),
      { response: { status: 404 } }, new APIError(new Response('{}', { status: 403 })),
      new APIError(new Response('{}', { status: 410 }), { json: { error: { code: 'snapshot_not_found' } } })]) {
      await assert.rejects(adapterFor(error)[operation]({ credentials: auth, sandbox_id: 'fd-cloud-fixture' }), { code: `${operation}_failed` });
    }
  }
  assert.equal(creates, 0);
});

test('a session command 404 is not confused with deletion and never implicitly resumes', async () => {
  const { adapter, calls, session } = fixture();
  session.runCommand = async () => { throw new APIError(new Response('{}', { status: 404 })); };
  await assert.rejects(adapter.stop({ credentials: auth, sandbox_id: 'fd-cloud-fixture' }), { code: 'stop_failed' });
  assert(calls.filter(([kind]) => kind === 'get').every(([, options]) => options.resume === false));
  assert(!calls.some(([kind]) => kind === 'create'));
});

test('worker output is bounded while streaming instead of buffering unbounded SDK output', async () => {
  const { adapter, session } = fixture();
  let killed = false, read = 0, waited = false;
  session.runCommand = async () => ({
    logs: async function* () {
      for (let index = 0; index < 1000; index++) { read++; yield { stream: 'stdout', data: 'x'.repeat(32 * 1024) }; }
    },
    wait: async () => { waited = true; return { exitCode: 0 }; },
    kill: async () => { killed = true; },
  });
  await assert.rejects(adapter.stop({ credentials: auth, sandbox_id: 'fd-cloud-fixture' }), { code: 'stop_failed' });
  assert.equal(read, 3);
  assert.equal(killed, true);
  assert.equal(waited, false);
});

test('CLI uses one stdin JSON request and redacts unexpected provider error messages', async () => {
  let output = '';
  const sink = new Writable({ write(chunk, _encoding, callback) { output += chunk; callback(); } });
  assert.equal(await runCli({ input: Readable.from([JSON.stringify({ operation: 'inspect' })]), output: sink,
    adapterFactory: async () => ({ inspect: async () => { throw new Error('provider-secret sk-proj-secret'); } }) }), 1);
  assert.deepEqual(JSON.parse(output), { error: { code: 'runtime_failed', message: 'Cloud runtime operation failed' } });
  assert(!output.includes('sk-proj'));
});

test('CLI executes through an npm-style symlink rather than silently exiting', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'fd-cloud-cli-test-'));
  try {
    const link = join(directory, 'falcondeck-cloud-runtime');
    await symlink(fileURLToPath(new URL('../src/cli.mjs', import.meta.url)), link);
    const result = spawnSync(process.execPath, [link], { input: '{"operation":"unsupported"}', encoding: 'utf8', timeout: 5000 });
    assert.equal(result.status, 1);
    assert.equal(JSON.parse(result.stdout).error.code, 'invalid_request');
    assert.equal(result.stderr, '');
  } finally { await rm(directory, { force: true, recursive: true }); }
});
