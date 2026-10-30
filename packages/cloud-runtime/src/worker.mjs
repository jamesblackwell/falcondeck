import { createHash } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { access, chmod, lstat, mkdir, open, readFile, readdir, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { get as httpsGet } from 'node:https';
import { get as httpGet } from 'node:http';
import { isIP } from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { validateSource } from './source.mjs';

const exec = promisify(execFile);
export const WORKSPACE_PATH = '/workspace/project';
export const HOME_PATH = '/workspace/home';
export const RUNTIME_PATH = '/opt/falcondeck-cloud';
export const DAEMON_PORT = 4380;
const MAX_DAEMON_BYTES = 128 * 1024 * 1024;
const SAFE_PATH = '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin';

function paths(options = {}) {
  const homePath = options.homePath ?? HOME_PATH;
  const runtimePath = options.runtimePath ?? RUNTIME_PATH;
  return {
    workspacePath: options.workspacePath ?? WORKSPACE_PATH,
    homePath, runtimePath,
    privatePath: join(runtimePath, 'private'),
    daemonPath: options.daemonPath ?? '/usr/local/bin/falcondeck-daemon',
    ...options,
  };
}

async function daemonBinary(config, p, forPrepare = false) {
  if (p.daemonPath !== '/usr/local/bin/falcondeck-daemon') return p.daemonPath;
  const downloaded = join(p.runtimePath, 'falcondeck-daemon');
  if (forPrepare && (config.worker_daemon_url || config.worker_daemon_sha256)) return downloaded;
  try {
    const stat = await lstat(downloaded);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Downloaded daemon is unsafe');
    await access(downloaded, constants.X_OK);
    return downloaded;
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  return p.daemonPath;
}

export function workerEnvironment(config, options = {}) {
  const p = paths(options);
  if (typeof config.openai_api_key !== 'string' || !config.openai_api_key || config.openai_api_key.length > 16384) {
    throw new Error('An explicit model API key is required');
  }
  return {
    PATH: SAFE_PATH,
    HOME: p.homePath,
    USER: 'falcondeck',
    LANG: 'C.UTF-8',
    TMPDIR: '/tmp',
    CODEX_HOME: join(p.homePath, '.codex'),
    XDG_CONFIG_HOME: join(p.homePath, '.config'),
    XDG_DATA_HOME: join(p.homePath, '.local/share'),
    FALCONDECK_STATE_PATH: join(p.homePath, '.falcondeck/daemon-state.json'),
    OPENAI_API_KEY: config.openai_api_key,
  };
}

function publicAddress(address) {
  if (isIP(address) === 4) {
    const [a, b] = address.split('.').map(Number);
    return !(a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127)
      || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && [0, 168].includes(b)) || a >= 224
      || (a === 198 && [18, 19, 51].includes(b)) || (a === 203 && b === 0));
  }
  // Only global-unicast IPv6, excluding documentation and mapped addresses.
  return isIP(address) === 6 && /^[23][0-9a-f]{3}:/i.test(address) && !/^2001:db8:/i.test(address);
}

export async function downloadDaemon(urlValue, expectedSha, destination) {
  const url = new URL(urlValue);
  if (url.protocol !== 'https:' || url.username || url.password || url.hash || (url.port && url.port !== '443')
    || !/^[a-f0-9]{64}$/i.test(expectedSha)) throw new Error('Invalid trusted daemon download');
  const addresses = await lookup(url.hostname, { all: true, verbatim: true });
  if (!addresses.length || addresses.some(({ address }) => !publicAddress(address))) {
    throw new Error('Daemon download must resolve only to public addresses');
  }
  const selected = addresses[0];
  const target = `${destination}.download`;
  const handle = await open(target, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o700);
  try {
    await new Promise((resolve, reject) => {
      const request = httpsGet(url, {
        lookup: (_hostname, options, callback) => {
          if (options?.all) callback(null, [selected]);
          else callback(null, selected.address, selected.family);
        },
        timeout: 30_000,
      }, async response => {
        if (response.statusCode !== 200) {
          response.resume();
          reject(new Error('Daemon download failed; redirects are not accepted'));
          return;
        }
        const hash = createHash('sha256');
        let size = 0;
        try {
          for await (const chunk of response) {
            size += chunk.length;
            if (size > MAX_DAEMON_BYTES) throw new Error('Daemon download exceeds limit');
            hash.update(chunk);
            await handle.writeFile(chunk);
          }
          if (hash.digest('hex') !== expectedSha.toLowerCase()) throw new Error('Daemon checksum mismatch');
          resolve();
        } catch (error) { response.destroy(); reject(error); }
      });
      request.on('timeout', () => request.destroy(new Error('Daemon download timed out')));
      request.on('error', reject);
    });
    await handle.close();
    await rename(target, destination);
    await chmod(destination, 0o755);
  } catch (error) {
    await handle.close().catch(() => {});
    await rm(target, { force: true });
    throw error;
  }
}

async function privateJson(path, value) {
  await writeFile(path, `${JSON.stringify(value)}\n`, { mode: 0o600 });
  await chmod(path, 0o600);
}

async function assertDirectory(path) {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const stat = await lstat(path);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Worker directory is unsafe');
}

function modelEndpoint(value = 'https://api.openai.com/v1') {
  const parsed = new URL(value);
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error('Invalid model endpoint');
  }
  return value;
}

async function writeCodexConfig(homePath, endpoint) {
  await assertDirectory(join(homePath, '.codex'));
  // Restore only the explicit API provider on every cold start. Native config
  // from an earlier turn cannot redirect a newly supplied model credential.
  const contents = [
    'model_provider = "falcondeck-cloud"',
    'preferred_auth_method = "apikey"',
    '[model_providers.falcondeck-cloud]',
    'name = "FalconDeck cloud API"',
    `base_url = ${JSON.stringify(endpoint)}`,
    'env_key = "OPENAI_API_KEY"',
    'wire_api = "responses"',
    'requires_openai_auth = false',
    '',
  ].join('\n');
  const path = join(homePath, '.codex/config.toml');
  await rm(path, { force: true });
  const file = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { await file.writeFile(contents); }
  finally { await file.close(); }
}

export async function prepareWorker(config, options = {}) {
  const p = paths(options);
  const source = validateSource(config.source);
  const modelBaseUrl = modelEndpoint(config.model_base_url);
  workerEnvironment(config, p);
  if (typeof config.gateway_token !== 'string' || !/^[a-zA-Z0-9_-]{32,128}$/.test(config.gateway_token)) {
    throw new Error('Invalid gateway token');
  }
  await assertDirectory(p.runtimePath);
  await assertDirectory(p.privatePath);
  await chmod(p.privatePath, 0o700);
  await assertDirectory(p.workspacePath);
  if ((await readdir(p.workspacePath)).length) throw new Error('Worker workspace must be empty');
  await assertDirectory(p.homePath);
  for (const relative of ['.codex', '.falcondeck', '.config', '.local/share']) {
    await assertDirectory(join(p.homePath, relative));
  }
  const daemonPath = await daemonBinary(config, p, true);
  if (config.worker_daemon_url || config.worker_daemon_sha256) {
    await (options.download ?? downloadDaemon)(config.worker_daemon_url, config.worker_daemon_sha256, daemonPath);
  } else {
    const stat = await lstat(daemonPath);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Preinstalled daemon is unavailable');
    await access(daemonPath, constants.X_OK);
  }
  for (const file of source.files) {
    const destination = join(p.workspacePath, file.path);
    await mkdir(dirname(destination), { recursive: true, mode: 0o755 });
    const handle = await open(destination, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, file.executable ? 0o755 : 0o644);
    try { await handle.writeFile(Buffer.from(file.content_base64, 'base64')); }
    finally { await handle.close(); }
  }
  await privateJson(join(p.homePath, '.falcondeck/connectors.json'), { mcpServers: {} });
  await privateJson(join(p.homePath, '.falcondeck/providers.json'), { providers: {} });
  await writeCodexConfig(p.homePath, modelBaseUrl);
  const gitEnv = { PATH: SAFE_PATH, HOME: p.homePath, LANG: 'C.UTF-8', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' };
  const git = args => exec('git', args, { cwd: p.workspacePath, env: gitEnv, maxBuffer: 1024 * 1024 });
  await git(['init', '--quiet']);
  // Force-add only the already filtered snapshot, including intentional ignored source.
  for (let offset = 0; offset < source.files.length; offset += 100) {
    await git(['add', '--force', '--', ...source.files.slice(offset, offset + 100).map(file => file.path)]);
  }
  await git(['-c', 'user.name=FalconDeck', '-c', 'user.email=cloud@localhost', '-c', 'commit.gpgsign=false', 'commit', '--quiet', '--allow-empty', '-m', 'Cloud source baseline']);
  await git(['tag', 'falcondeck-cloud-baseline']);
  const baselineCommit = (await git(['rev-parse', 'HEAD'])).stdout.trim();
  await privateJson(join(p.runtimePath, 'manifest.json'), {
    version: 1, tree_hash: source.tree_hash, baseline_commit: baselineCommit,
    baseline_files: source.files, model_base_url: modelBaseUrl,
  });
  return { workspace_path: p.workspacePath, tree_hash: source.tree_hash, baseline_commit: baselineCommit };
}

function health(port, token) {
  return new Promise((resolve, reject) => {
    const request = httpGet({ hostname: '127.0.0.1', port, path: '/api/health', timeout: 1_000,
      headers: token ? { authorization: `Bearer ${token}` } : {} }, response => {
      response.resume();
      response.statusCode === 200 ? resolve() : reject(new Error('Worker health check failed'));
    });
    request.on('timeout', () => request.destroy(new Error('Worker health check timed out')));
    request.on('error', reject);
  });
}

export async function startWorker(config, options = {}) {
  const p = paths(options);
  const daemonPort = options.daemonPort ?? DAEMON_PORT;
  const gatewayPort = options.gatewayPort ?? 3000;
  const environment = workerEnvironment(config, p);
  if (typeof config.gateway_token !== 'string' || !/^[a-zA-Z0-9_-]{32,128}$/.test(config.gateway_token)) {
    throw new Error('Invalid gateway token');
  }
  const manifest = JSON.parse(await readFile(join(p.runtimePath, 'manifest.json'), 'utf8'));
  const endpoint = modelEndpoint(config.model_base_url);
  // The source caller's explicit endpoint (or the OpenAI default) is authority.
  // A retained manifest can make startup refuse, but cannot select a new host.
  if (modelEndpoint(manifest.model_base_url) !== endpoint) throw new Error('Model endpoint is pinned to the uploaded environment');
  await writeCodexConfig(p.homePath, endpoint);
  await rm(join(p.privatePath, 'ready.json'), { force: true });
  await assertDirectory(join(p.homePath, '.falcondeck'));
  await privateJson(join(p.homePath, '.falcondeck/connectors.json'), { mcpServers: {} });
  await privateJson(join(p.homePath, '.falcondeck/providers.json'), { providers: {} });
  const gatewayConfig = join(p.privatePath, 'gateway.json');
  await privateJson(gatewayConfig, { token: config.gateway_token, upstreamPort: daemonPort, port: gatewayPort });
  const spawnProcess = options.spawn ?? spawn;
  const daemon = spawnProcess(await daemonBinary(config, p), [`--port=${daemonPort}`, '--codex-bin=codex'], {
    cwd: p.workspacePath, env: environment, detached: true, stdio: 'ignore',
  });
  let daemonError;
  daemon.on('error', () => { daemonError = true; });
  daemon.unref();
  const gateway = spawnProcess(process.execPath, [join(p.runtimePath, 'gateway.mjs'), gatewayConfig], {
    cwd: p.workspacePath,
    env: { PATH: SAFE_PATH, HOME: p.homePath, LANG: 'C.UTF-8' },
    detached: true, stdio: 'ignore',
  });
  let gatewayError;
  gateway.on('error', () => { gatewayError = true; });
  gateway.unref();
  try {
    for (let attempt = 0; attempt < (options.attempts ?? 120); attempt++) {
      if (daemonError || gatewayError || daemon.exitCode !== null || gateway.exitCode !== null) {
        throw new Error('Worker process failed to start');
      }
      try {
        await (options.healthCheck ?? health)(gatewayPort, config.gateway_token);
        await privateJson(join(p.privatePath, 'ready.json'), { daemon_pid: daemon.pid, gateway_pid: gateway.pid });
        // Both children loaded their secrets. Retained snapshots must not carry
        // model credentials or the exposed gateway capability in config files.
        await rm(join(p.privatePath, 'bootstrap.json'), { force: true });
        await rm(gatewayConfig, { force: true });
        return { ready: true };
      } catch {}
      await new Promise(resolve => setTimeout(resolve, options.pollMs ?? 500));
    }
    throw new Error('Worker startup timed out');
  } catch (error) {
    for (const child of [gateway, daemon]) {
      if (child.pid) { try { process.kill(-child.pid, 'SIGTERM'); } catch {} }
    }
    throw error;
  }
}

export async function readyWorker(options = {}) {
  const p = paths(options);
  const attempts = options.attempts ?? 120;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      await access(join(p.privatePath, 'ready.json'));
      await (options.healthCheck ?? health)(options.daemonPort ?? DAEMON_PORT);
      return { ready: true };
    } catch {}
    await new Promise(resolve => setTimeout(resolve, options.pollMs ?? 500));
  }
  throw new Error('Worker startup timed out');
}

export async function scrubWorker(options = {}) {
  const p = paths(options);
  for (const relative of ['bootstrap.json', 'gateway.json', 'ready.json']) {
    await rm(join(p.privatePath, relative), { force: true });
  }
  // Codex must never leave copied/login credentials in the retained snapshot.
  for (const relative of ['.codex/auth.json', '.codex/auth.json.lock']) {
    await rm(join(p.homePath, relative), { force: true });
  }
  return { scrubbed: true };
}

async function main() {
  const [operation, configPath] = process.argv.slice(2);
  if (operation === 'ready') return readyWorker();
  if (operation === 'scrub') return scrubWorker();
  if (!['prepare', 'start'].includes(operation) || configPath !== join(RUNTIME_PATH, 'private/bootstrap.json')) {
    throw new Error('Invalid worker operation');
  }
  const stat = await lstat(configPath);
  if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077)) throw new Error('Unsafe worker configuration');
  const config = JSON.parse(await readFile(configPath, 'utf8'));
  return operation === 'prepare' ? prepareWorker(config) : startWorker(config);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === await realpath(process.argv[1]).catch(() => null)) {
  main().then(result => process.stdout.write(`${JSON.stringify(result)}\n`)).catch(() => {
    process.stderr.write('Cloud worker operation failed\n');
    process.exitCode = 1;
  });
}
