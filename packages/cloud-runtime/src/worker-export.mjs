import { constants } from 'node:fs';
import { chmod, lstat, mkdir, mkdtemp, open, opendir, realpath, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { SOURCE_LIMITS, sourceTreeHash, validatePath, validateSource } from './source.mjs';

const exec = promisify(execFile);
const MAX_SESSION_BYTES = 16 * 1024 * 1024;
const MAX_SESSION_FILES = 1000;
const MAX_PATCH_BYTES = 64 * 1024 * 1024;
const MAX_DIRECTORY_ENTRIES = 50_000;

async function withDirectory(path, callback) {
  const handle = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    const before = await handle.stat();
    if (!before.isDirectory()) throw new Error('Unsafe export directory');
    // Linux workers traverse open directory descriptors, rather than mutable
    // ancestor names. A concurrent rename/symlink swap cannot redirect a read.
    // macOS supports the local unit tests with identity rechecks instead.
    const pinned = process.platform === 'linux' ? `/proc/self/fd/${handle.fd}` : path;
    const result = await callback(pinned);
    const after = await lstat(path);
    if (!after.isDirectory() || after.isSymbolicLink() || before.dev !== after.dev || before.ino !== after.ino
      || before.mtimeMs !== after.mtimeMs) throw new Error('Workspace changed during export; retry after the turn stops');
    return result;
  } finally { await handle.close(); }
}

export async function safeFile(path, maxBytes, { openFile = open } = {}) {
  const handle = await openFile(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.nlink !== 1 || before.size > maxBytes) throw new Error('Unsafe or oversized export file');
    const chunks = [];
    let size = 0;
    // A concurrent writer can grow a regular file after stat(). Never ask
    // readFile() to allocate whatever size it reaches before our after-check.
    for (;;) {
      const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, maxBytes + 1 - size));
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, null);
      if (bytesRead === 0) break;
      size += bytesRead;
      if (size > maxBytes) throw new Error('Export file grew beyond its size limit');
      chunks.push(chunk.subarray(0, bytesRead));
    }
    const bytes = Buffer.concat(chunks, size);
    const after = await handle.stat();
    if (before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs || bytes.length > maxBytes) {
      throw new Error('Workspace changed during export; retry after the turn stops');
    }
    return { bytes, executable: Boolean(before.mode & 0o111) };
  } finally { await handle.close(); }
}

async function currentFiles(root) {
  const files = [];
  const excluded = [];
  let totalBytes = 0;
  let entryCount = 0;
  async function walk(directory, relative = '') {
    return withDirectory(directory, async pinned => {
    for await (const entry of await opendir(pinned)) {
      if (++entryCount > MAX_DIRECTORY_ENTRIES) throw new Error('Export directory entry limit exceeded');
      const path = relative ? `${relative}/${entry.name}` : entry.name;
      try { validatePath(path); }
      catch {
        if (path !== '.git') excluded.push(path);
        continue;
      }
      const absolute = join(pinned, entry.name);
      const stat = await lstat(absolute);
      if (stat.isSymbolicLink()) throw new Error('Symbolic links cannot be exported');
      if (stat.isDirectory()) { await walk(absolute, path); continue; }
      if (!stat.isFile()) throw new Error('Special files cannot be exported');
      const { bytes, executable } = await safeFile(absolute, SOURCE_LIMITS.fileBytes);
      totalBytes += bytes.length;
      if (totalBytes > SOURCE_LIMITS.totalBytes || files.length >= SOURCE_LIMITS.files) throw new Error('Export size limit exceeded');
      files.push({ path, content_base64: bytes.toString('base64'), executable });
    }
    });
  }
  const canonical = await realpath(root);
  await walk(root);
  if (await realpath(root) !== canonical) throw new Error('Workspace root changed during export');
  files.sort((a, b) => Buffer.compare(Buffer.from(a.path), Buffer.from(b.path)));
  return { files, excluded };
}

function redactCredentials(text) {
  return text
    .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, '[REDACTED_API_KEY]')
    .replace(/(Bearer\s+)[A-Za-z0-9._~+\/-]{16,}/gi, '$1[REDACTED_TOKEN]')
    .replace(/((?:OPENAI_API_KEY|VERCEL_TOKEN|api[_-]?key|access[_-]?token|refresh[_-]?token)["']?\s*[:=]\s*["']?)[^\s"',;}{]+/gi, '$1[REDACTED_SECRET]');
}

async function nativeSessions(homePath) {
  const files = [];
  let totalBytes = 0;
  let entryCount = 0;
  async function walk(directory, relative = '') {
    return withDirectory(directory, async pinned => {
    for await (const entry of await opendir(pinned)) {
      if (++entryCount > MAX_DIRECTORY_ENTRIES) throw new Error('Native session directory entry limit exceeded');
      if (!/^[a-zA-Z0-9_.-]+$/.test(entry.name)) throw new Error('Invalid session archive path');
      const path = relative ? `${relative}/${entry.name}` : entry.name;
      const absolute = join(pinned, entry.name);
      const stat = await lstat(absolute);
      if (stat.isSymbolicLink()) throw new Error('Unsafe session archive link');
      if (stat.isDirectory()) { await walk(absolute, path); continue; }
      if (!/^rollout-.*\.jsonl$/.test(entry.name)) continue;
      const { bytes } = await safeFile(absolute, MAX_SESSION_BYTES);
      totalBytes += bytes.length;
      if (totalBytes > MAX_SESSION_BYTES || files.length >= MAX_SESSION_FILES) throw new Error('Native session archive exceeds limit');
      // Only native rollouts are included. Login caches, configs, logs and indexes
      // stay out of the archive; recognizable inline credentials are redacted.
      const content = redactCredentials(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
      files.push({ path: `.codex/sessions/${path}`, content_base64: Buffer.from(content).toString('base64') });
    }
    });
  }
  try {
    await withDirectory(homePath, home => withDirectory(join(home, '.codex'), codex => walk(join(codex, 'sessions'))));
  } catch (error) { if (error.code === 'ENOENT') return files; throw error; }
  return files.sort((a, b) => a.path.localeCompare(b.path));
}

async function binaryPatch(baseline, current, runtimePath) {
  // Generate the patch from independently read bytes in our own bare repository.
  // Do not execute filters, hooks or configuration from the agent's .git folder.
  const temporary = await mkdtemp(join(runtimePath, 'export-'));
  const gitPath = join(temporary, 'git');
  const workPath = join(temporary, 'tree');
  const environment = {
    PATH: '/usr/local/bin:/usr/bin:/bin', HOME: temporary, LANG: 'C.UTF-8',
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_DIR: gitPath, GIT_WORK_TREE: workPath,
  };
  const git = args => exec('git', args, { cwd: temporary, env: environment, encoding: 'buffer', maxBuffer: MAX_PATCH_BYTES });
  async function materialize(files) {
    await rm(workPath, { recursive: true, force: true });
    await mkdir(workPath, { mode: 0o700 });
    for (const file of files) {
      const destination = join(workPath, file.path);
      await mkdir(dirname(destination), { recursive: true });
      await writeFile(destination, Buffer.from(file.content_base64, 'base64'), { mode: file.executable ? 0o755 : 0o644 });
      await chmod(destination, file.executable ? 0o755 : 0o644);
    }
    // Ignore .gitignore rules so every eligible path gets a result entry.
    await git(['add', '--force', '--all', '--', '.']);
  }
  try {
    const { GIT_DIR, GIT_WORK_TREE, ...initEnvironment } = environment;
    await exec('git', ['init', '--quiet', '--bare', gitPath], { cwd: temporary, env: initEnvironment });
    await materialize(baseline);
    await git(['-c', 'user.name=FalconDeck', '-c', 'user.email=cloud@localhost', '-c', 'commit.gpgsign=false', 'commit', '--quiet', '--allow-empty', '-m', 'Cloud source baseline']);
    await materialize(current);
    const patch = (await git(['-c', 'core.quotePath=true', 'diff', '--cached', '--binary', '--full-index', '--no-ext-diff', '--no-textconv', 'HEAD', '--'])).stdout;
    if (patch.length > MAX_PATCH_BYTES) throw new Error('Result patch exceeds limit');
    return patch.toString('base64');
  } finally { await rm(temporary, { recursive: true, force: true }); }
}

export async function exportWorkspace(options = {}) {
  const workspacePath = options.workspacePath ?? '/workspace/project';
  const homePath = options.homePath ?? '/workspace/home';
  const runtimePath = options.runtimePath ?? '/opt/falcondeck-cloud';
  const manifestStat = await lstat(join(runtimePath, 'manifest.json'));
  if (!manifestStat.isFile() || manifestStat.isSymbolicLink() || manifestStat.size > SOURCE_LIMITS.totalBytes * 2) {
    throw new Error('Invalid baseline manifest');
  }
  const manifest = JSON.parse((await safeFile(join(runtimePath, 'manifest.json'), SOURCE_LIMITS.totalBytes * 2)).bytes.toString('utf8'));
  const baseline = validateSource({ tree_hash: manifest.tree_hash, files: manifest.baseline_files });
  const rootStat = await lstat(workspacePath);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error('Invalid workspace');
  const { files, excluded } = await currentFiles(workspacePath);
  const currentTreeHash = sourceTreeHash(files);
  // Reapply both path and content checks before any result reaches stdout.
  validateSource({ files, tree_hash: currentTreeHash });
  const existing = new Set(files.map(file => file.path));
  const sessions = await nativeSessions(homePath);
  return {
    version: 1,
    tree_hash: baseline.tree_hash,
    current_tree_hash: currentTreeHash,
    baseline_files: baseline.files,
    current_files: files,
    deleted_paths: baseline.files.filter(file => !existing.has(file.path)).map(file => file.path),
    binary_patch_base64: await binaryPatch(baseline.files, files, runtimePath),
    native_sessions: sessions,
    excluded_paths: excluded,
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === await realpath(process.argv[1]).catch(() => null)) {
  exportWorkspace().then(result => process.stdout.write(`${JSON.stringify(result)}\n`)).catch(() => {
    process.stderr.write('Cloud result export failed\n');
    process.exitCode = 1;
  });
}
