import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { validateSource } from './source.mjs';
import { networkPolicy, httpsEndpoint, daemonEndpoint } from './network.mjs';

const RUNTIME = '/opt/falcondeck-cloud';
const CONFIG = `${RUNTIME}/private/bootstrap.json`;
const WORKSPACE = '/workspace/project';
export const SNAPSHOT_EXPIRATION_MS = 24 * 60 * 60 * 1000;
export const MAX_TIMEOUT_MS = 24 * 60 * 60 * 1000;
const workerFiles = ['worker.mjs', 'worker-export.mjs', 'gateway.mjs', 'source.mjs'];

export class CloudRuntimeError extends Error {
  constructor(code, message, sandboxId) { super(message); this.code = code; this.sandbox_id = sandboxId; }
}

function credentials(value) {
  if (!value || ['token', 'teamId', 'projectId'].some(key => typeof value[key] !== 'string' || !value[key].trim() || value[key].length > 4096)) {
    throw new CloudRuntimeError('invalid_request', 'Explicit provider token, teamId and projectId are required');
  }
  return { token: value.token, teamId: value.teamId, projectId: value.projectId };
}

function sandboxName(value) {
  if (typeof value !== 'string' || !/^[a-z0-9][a-z0-9-]{0,62}$/.test(value)) throw new CloudRuntimeError('invalid_request', 'A valid sandbox name is required');
  return value;
}

function agentKey(value) {
  if (typeof value !== 'string' || !value.trim() || value.length > 4096 || /[\r\n\0]/.test(value)) throw new CloudRuntimeError('invalid_request', 'An explicit model API key is required');
  return value;
}

function metadata(sandbox) {
  return {
    sandbox_id: sandbox.name,
    status: sandbox.status,
    expires_at: sandbox.expiresAt?.toISOString?.() ?? null,
    current_snapshot_id: sandbox.currentSnapshotId ?? null,
    persistent: sandbox.persistent,
    snapshot_expiration_ms: sandbox.snapshotExpiration ?? null,
  };
}

function missingMetadata(name) {
  return { sandbox_id: name, status: 'deleted', deleted: true, missing: true,
    expires_at: null, current_snapshot_id: null, persistent: false, snapshot_expiration_ms: null };
}

function currentSession(sandbox) {
  // Sandbox convenience methods automatically resume stopped sessions. Use the
  // public Session API so a deadline race cannot allocate another paid session.
  return sandbox.currentSession();
}

async function checkedCommand(sandbox, args, timeoutMs = 120_000, maxOutputBytes = 64 * 1024) {
  // The SDK's synchronous command helper accumulates stdout/stderr without a
  // bound. Read the detached command's public log iterator ourselves instead.
  const command = await currentSession(sandbox).runCommand({ cmd: 'node', args, cwd: RUNTIME, timeoutMs, detached: true });
  const signal = AbortSignal.timeout(timeoutMs + 10_000);
  let bytes = 0;
  const stdout = [];
  try {
    for await (const log of command.logs({ signal })) {
      bytes += Buffer.byteLength(log.data);
      if (bytes > maxOutputBytes) throw new Error('Worker output limit exceeded');
      if (log.stream === 'stdout') stdout.push(log.data);
    }
    const finished = await command.wait({ signal });
    if (finished.exitCode !== 0) throw new Error('Worker operation failed');
    return { exitCode: finished.exitCode, stdout: async () => stdout.join('') };
  } catch (error) {
    try { await command.kill('SIGKILL', { abortSignal: AbortSignal.timeout(5_000) }); } catch {}
    throw error;
  }
}

async function writeConfig(sandbox, value) {
  // No secrets enter argv, image config, provider default env, or command logs.
  await currentSession(sandbox).writeFiles([{ path: CONFIG, content: Buffer.from(JSON.stringify(value)), mode: 0o600 }]);
  // Also enforce owner-only permissions if a retained config path existed.
  const result = await currentSession(sandbox).runCommand({ cmd: 'chmod', args: ['600', CONFIG], timeoutMs: 10_000 });
  if (result.exitCode !== 0) throw new Error('Private config permissions failed');
}

async function start(sandbox, config) {
  await writeConfig(sandbox, config);
  await currentSession(sandbox).runCommand({ cmd: 'node', args: [`${RUNTIME}/worker.mjs`, 'start', CONFIG], cwd: RUNTIME, detached: true });
  await checkedCommand(sandbox, [`${RUNTIME}/worker.mjs`, 'ready'], 60_000);
  const url = new URL(sandbox.domain(3000));
  if (url.protocol !== 'https:' || url.username || url.password) throw new Error('Invalid provider gateway URL');
  return {
    sandbox_id: sandbox.name, gateway_url: url.toString().replace(/\/$/, ''),
    gateway_token: config.gateway_token, workspace_path: WORKSPACE,
    expires_at: sandbox.expiresAt?.toISOString?.() ?? null,
    snapshot_expiration_ms: SNAPSHOT_EXPIRATION_MS,
  };
}

// SDK is injected in tests; importing this module does not authenticate or spend.
export function createAdapter({ Sandbox, APIError, resolve, token = () => randomBytes(32).toString('hex') }) {
  if (!Sandbox) throw new Error('Sandbox SDK is required');
  async function existingMetadata(auth, name) {
    try { return await Sandbox.get({ ...auth, name, resume: false }); }
    catch (error) {
      // This matches the pinned SDK's own isNotFoundError check, restricted to
      // the sandbox metadata GET. Session/command 404s are not deletion proof.
      if (typeof APIError === 'function' && error instanceof APIError && error.response?.status === 404) return null;
      throw error;
    }
  }
  return {
    async create(request) {
      const auth = credentials(request.credentials);
      let source, policy, runningPolicy;
      try {
        source = validateSource(request.source);
        policy = await networkPolicy(request, resolve, { bootstrap: true });
        runningPolicy = await networkPolicy(request, resolve);
      }
      catch { throw new CloudRuntimeError('invalid_request', 'Source manifest or egress policy failed validation'); }
      const modelKey = agentKey(request.openai_api_key);
      if (!Number.isInteger(request.timeout_ms) || request.timeout_ms < 60_000 || request.timeout_ms > MAX_TIMEOUT_MS ||
          ![1, 2, 4, 8].includes(request.cpus) || typeof request.image !== 'string' ||
          !/^[a-zA-Z0-9./_-]+@sha256:[a-f0-9]{64}$/.test(request.image)) {
        throw new CloudRuntimeError('invalid_request', 'A digest-pinned image, bounded timeout and supported CPU count are required');
      }
      if (!!request.worker_daemon_url !== !!request.worker_daemon_sha256 ||
          (request.worker_daemon_sha256 && !/^[a-f0-9]{64}$/.test(request.worker_daemon_sha256))) {
        throw new CloudRuntimeError('invalid_request', 'Daemon download needs an HTTPS URL and SHA-256 digest');
      }
      if (request.worker_daemon_url) daemonEndpoint(request.worker_daemon_url);
      const name = request.name === undefined ? `fd-cloud-${randomBytes(12).toString('hex')}` : sandboxName(request.name);
      let sandbox;
      try {
        sandbox = await Sandbox.create({ ...auth, name, image: request.image, timeout: request.timeout_ms,
          resources: { vcpus: request.cpus }, networkPolicy: policy, ports: [3000],
          env: {}, persistent: true, snapshotExpiration: SNAPSHOT_EXPIRATION_MS,
          keepLastSnapshots: { count: 1, expiration: SNAPSHOT_EXPIRATION_MS, deleteEvicted: true },
          tags: { product: 'falcondeck', purpose: 'cloud-execution' },
        });
        // The supplied image provisions writable, owner-only runtime paths.
        const mkdir = await currentSession(sandbox).runCommand({ cmd: 'mkdir', args: ['-p', `${RUNTIME}/private`], timeoutMs: 10_000 });
        if (mkdir.exitCode !== 0) throw new Error('Runtime directory creation failed');
        const chmod = await currentSession(sandbox).runCommand({ cmd: 'chmod', args: ['700', `${RUNTIME}/private`], timeoutMs: 10_000 });
        if (chmod.exitCode !== 0) throw new Error('Runtime permissions failed');
        await currentSession(sandbox).writeFiles(await Promise.all(workerFiles.map(async file => ({ path: `${RUNTIME}/${file}`, content: await readFile(new URL(file, import.meta.url)) }))));
        const config = { source, gateway_token: token(), openai_api_key: modelKey,
          model_base_url: request.model_base_url ?? 'https://api.openai.com/v1',
          worker_daemon_url: request.worker_daemon_url, worker_daemon_sha256: request.worker_daemon_sha256 };
        await writeConfig(sandbox, config);
        await checkedCommand(sandbox, [`${RUNTIME}/worker.mjs`, 'prepare', CONFIG]);
        // Revoke the narrowly scoped release download before any agent starts.
        await sandbox.update({ networkPolicy: runningPolicy });
        const { source: uploadedSource, ...startConfig } = config;
        return await start(sandbox, startConfig);
      } catch {
        if (sandbox) {
          // Failed boot is never useful retained state and must stop billing.
          // An update failure must not prevent the subsequent stop/delete.
          try { await sandbox.update({ persistent: false }); } catch {}
          try { await sandbox.stop(); } catch {}
          try { await sandbox.delete({ deleteOrphanSnapshots: true }); }
          catch { throw new CloudRuntimeError('cleanup_failed', 'Cloud boot failed and provider cleanup needs reconciliation', sandbox.name); }
        }
        throw new CloudRuntimeError('create_failed', 'Cloud environment could not be created or started', sandbox?.name ?? name);
      }
    },

    async inspect(request) {
      try {
        const name = sandboxName(request.sandbox_id);
        const sandbox = await existingMetadata(credentials(request.credentials), name);
        return sandbox ? metadata(sandbox) : missingMetadata(name);
      }
      catch (error) { if (error instanceof CloudRuntimeError) throw error; throw new CloudRuntimeError('inspect_failed', 'Cloud environment could not be inspected', request.sandbox_id); }
    },

    async resume(request) {
      const auth = credentials(request.credentials), name = sandboxName(request.sandbox_id);
      const modelKey = agentKey(request.openai_api_key);
      let resumed;
      try {
        httpsEndpoint(request.model_base_url ?? 'https://api.openai.com/v1');
        const existing = await Sandbox.get({ ...auth, name, resume: false });
        if (existing.status === 'running') throw new CloudRuntimeError('already_running', 'Environment is already running; use its existing gateway', name);
        if (!existing.currentSnapshotId) throw new CloudRuntimeError('snapshot_missing', 'No retained snapshot exists; this environment cannot resume', name);
        if (existing.status !== 'stopped') throw new CloudRuntimeError('not_stopped', 'Wait for this environment to finish stopping before resuming', name);
        const timeout = request.timeout_ms ?? existing.timeout;
        if (!Number.isInteger(timeout) || timeout < 60_000 || timeout > MAX_TIMEOUT_MS) throw new CloudRuntimeError('invalid_request', 'Resume requires a bounded session timeout', name);
        // Configuration changes while stopped apply to the next restored session.
        await existing.update({ timeout, persistent: true, snapshotExpiration: SNAPSHOT_EXPIRATION_MS,
          keepLastSnapshots: { count: 1, expiration: SNAPSHOT_EXPIRATION_MS, deleteEvicted: true } });
        resumed = await Sandbox.get({ ...auth, name, resume: true });
        return await start(resumed, { gateway_token: token(), openai_api_key: modelKey, model_base_url: request.model_base_url ?? 'https://api.openai.com/v1' });
      } catch (error) {
        if (resumed) {
          try { await checkedCommand(resumed, [`${RUNTIME}/worker.mjs`, 'scrub']); }
          catch { try { await resumed.update({ persistent: false }); } catch {} }
          try { await resumed.stop(); }
          catch { throw new CloudRuntimeError('cleanup_failed', 'Cloud resume failed and provider stop needs reconciliation', name); }
        }
        if (error instanceof CloudRuntimeError) throw error;
        throw new CloudRuntimeError('resume_failed', 'Cloud environment could not resume; no replacement was created', name);
      }
    },

    async export(request) {
      const auth = credentials(request.credentials), name = sandboxName(request.sandbox_id);
      try {
        const sandbox = await Sandbox.get({ ...auth, name, resume: false });
        if (sandbox.status !== 'running') throw new CloudRuntimeError('not_running', 'Resume this environment explicitly before exporting', name);
        const result = await checkedCommand(sandbox, [`${RUNTIME}/worker-export.mjs`], 120_000, 256 * 1024 * 1024);
        const output = await result.stdout();
        if (Buffer.byteLength(output) > 256 * 1024 * 1024) throw new Error('Export limit exceeded');
        const manifest = JSON.parse(output);
        validateSource({ files: manifest.baseline_files, tree_hash: manifest.tree_hash });
        validateSource({ files: manifest.current_files, tree_hash: manifest.current_tree_hash });
        return { sandbox_id: name, ...manifest };
      } catch (error) { if (error instanceof CloudRuntimeError) throw error; throw new CloudRuntimeError('export_failed', 'Cloud result could not be exported safely', name); }
    },

    async stop(request) {
      const auth = credentials(request.credentials), name = sandboxName(request.sandbox_id);
      try {
        const sandbox = await existingMetadata(auth, name);
        if (!sandbox) return missingMetadata(name);
        if (sandbox.status === 'running') {
          await checkedCommand(sandbox, [`${RUNTIME}/worker.mjs`, 'scrub']);
          await sandbox.stop();
        }
        const stopped = await existingMetadata(auth, name);
        return stopped ? metadata(stopped) : missingMetadata(name);
      } catch (error) { if (error instanceof CloudRuntimeError) throw error; throw new CloudRuntimeError('stop_failed', 'Cloud environment stop requires reconciliation', name); }
    },

    async delete(request) {
      const name = sandboxName(request.sandbox_id);
      try { const sandbox = await Sandbox.get({ ...credentials(request.credentials), name, resume: false });
        await sandbox.delete({ deleteOrphanSnapshots: true }); return { sandbox_id: name, deleted: true };
      } catch (error) { if (error instanceof CloudRuntimeError) throw error; throw new CloudRuntimeError('delete_failed', 'Cloud environment deletion requires reconciliation', name); }
    },
  };
}

export async function defaultAdapter() {
  process.env.VERCEL_SANDBOX_TELEMETRY_DISABLED = '1';
  process.env.DEBUG_FETCH = 'false';
  const { Sandbox, APIError } = await import('@vercel/sandbox');
  return createAdapter({ Sandbox, APIError });
}
