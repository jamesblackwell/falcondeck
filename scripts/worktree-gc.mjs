#!/usr/bin/env node
// Inventory and (opt-in) cleanup of git worktrees that FalconDeck threads,
// Codex and ad-hoc scripts leave behind.
//
//   node scripts/worktree-gc.mjs                 dry-run table (default)
//   node scripts/worktree-gc.mjs --format markdown
//   node scripts/worktree-gc.mjs --apply         remove SAFE worktrees only
//
// Classes:
//   ACTIVE  owner thread running, a process has its cwd inside, or modified
//           within --active-hours (24).
//   SAFE    clean, every commit on a remote (by patch-id), no ignored files
//           beyond rebuildable dirs, older than --min-age-days (3).
//   REVIEW  everything else; the reasons are listed.
//
// --apply uses `git worktree remove` (never --force, never rm -rf) and then
// `git worktree prune`. It re-checks each entry immediately before removing it
// and skips standalone clones, REVIEW and ACTIVE entries entirely.

import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, lstatSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);

export const DEFAULTS = {
  minAgeDays: 3,
  activeHours: 24,
  rebuildable: ['node_modules', 'vendor', 'target', '.next', 'dist'],
  envAllowlist: ['.env*', '.envrc', '*.local.*'],
  top: 10,
  jobs: 4,
  fetch: true,
};

// Proposed widening, shown beside the strict result but never the default:
// framework caches and test output that a build or test run recreates.
// Entries containing '/' match consecutive path segments.
export const GENERATED_PRESET = [
  ...DEFAULTS.rebuildable,
  '.phpunit.cache', '__pycache__', '.pytest_cache', '.react-router', '.pnpm-store', '.expo', '.cache', '.turbo',
  'test-results', 'playwright-report', 'coverage', '.DS_Store',
  'bootstrap/cache', 'storage/framework', 'storage/logs', 'public/version.json',
];

const RUNNING_STATUSES = new Set(['running', 'waiting_for_input', 'starting', 'interrupting']);
const DAY = 86_400_000;

// ---------------------------------------------------------------- pure logic

export function parseArgs(argv) {
  const opts = { ...DEFAULTS, apply: false, format: 'text', includeOpenThreads: false, roots: [], state: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const value = () => {
      i += 1;
      if (i >= argv.length) throw new Error(`${arg} needs a value`);
      return argv[i];
    };
    if (arg === '--apply') opts.apply = true;
    else if (arg === '--dry-run') opts.apply = false;
    else if (arg === '--no-fetch') opts.fetch = false;
    else if (arg === '--include-open-threads') opts.includeOpenThreads = true;
    else if (arg === '--format') opts.format = value();
    else if (arg === '--json') opts.format = 'json';
    else if (arg === '--rebuildable-preset') {
      const preset = value();
      if (!['strict', 'generated'].includes(preset)) throw new Error(`bad preset ${preset}`);
      opts.rebuildable = preset === 'generated' ? GENERATED_PRESET : DEFAULTS.rebuildable;
    } else if (arg === '--min-age-days') opts.minAgeDays = Number(value());
    else if (arg === '--active-hours') opts.activeHours = Number(value());
    else if (arg === '--top') opts.top = Number(value());
    else if (arg === '--jobs') opts.jobs = Math.max(1, Number(value()));
    else if (arg === '--state') opts.state = value();
    else if (arg === '--root') opts.roots.push(value());
    else if (arg === '--help' || arg === '-h') opts.help = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  if (!['text', 'markdown', 'json'].includes(opts.format)) throw new Error(`bad --format ${opts.format}`);
  for (const key of ['minAgeDays', 'activeHours', 'top']) {
    if (!Number.isFinite(opts[key]) || opts[key] < 0) throw new Error(`bad numeric option for ${key}`);
  }
  return opts;
}

/**
 * True when an ignored path lives inside a rebuildable directory. Plain names
 * match any path segment; names containing '/' match consecutive segments.
 */
export function isRebuildable(path, rebuildable = DEFAULTS.rebuildable) {
  const segments = path.split('/').filter(Boolean);
  return rebuildable.some((name) => {
    const parts = name.split('/');
    for (let i = 0; i + parts.length <= segments.length; i += 1) {
      if (parts.every((part, j) => segments[i + j] === part)) return true;
    }
    return false;
  });
}

export function matchesAllowlist(name, patterns = DEFAULTS.envAllowlist) {
  return patterns.some((pattern) => {
    const re = new RegExp(`^${pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`);
    return re.test(name);
  });
}

/**
 * Parses `git status --porcelain=v1 -z`. Rename/copy entries carry a second
 * NUL-terminated path that must be consumed.
 */
export function parseStatusZ(out) {
  const fields = out.split('\0');
  const result = { tracked: [], untracked: [], ignored: [] };
  for (let i = 0; i < fields.length; i += 1) {
    const field = fields[i];
    if (field.length < 4) continue;
    const xy = field.slice(0, 2);
    const path = field.slice(3);
    if (xy === '??') result.untracked.push(path);
    else if (xy === '!!') result.ignored.push(path);
    else {
      result.tracked.push(path);
      if (/[RC]/.test(xy)) i += 1;
    }
  }
  return result;
}

/** `git cherry` output -> shas that have no patch-equivalent upstream ('+'). */
export function parseCherryUnmatched(out) {
  return out
    .split('\n')
    .filter((line) => line.startsWith('+ '))
    .map((line) => line.slice(2).trim());
}

/**
 * Commits reachable from HEAD but from no remote ref, minus those whose patch
 * exists upstream. Merge commits have no patch-id, so they stay unpushed.
 */
export function unpushedAfterCherry(candidates, cherryOutputs) {
  const matched = new Set();
  for (const out of cherryOutputs) {
    for (const line of out.split('\n')) {
      if (line.startsWith('- ')) matched.add(line.slice(2).trim());
    }
  }
  return candidates.filter((sha) => !matched.has(sha));
}

export function classify(entry, opts, now = Date.now()) {
  const ageMs = now - entry.mtimeMs;
  const ignoredOther = (entry.ignoredAll ?? []).filter((p) => !isRebuildable(p, opts.rebuildable));
  const reasons = [];
  const activeReasons = [];
  if (entry.owner && RUNNING_STATUSES.has(entry.owner.status)) {
    activeReasons.push(`thread ${entry.owner.status}`);
  }
  if (entry.liveProcess) activeReasons.push('process running inside');
  if (ageMs < opts.activeHours * 3_600_000) activeReasons.push(`modified <${opts.activeHours}h ago`);
  if (activeReasons.length) return { class: 'ACTIVE', reasons: activeReasons, ignoredOther };

  if (entry.kind === 'orphan') reasons.push('not a git checkout');
  if (entry.kind === 'clone') reasons.push('standalone clone (script only removes worktrees)');
  if (entry.error) reasons.push(`git error: ${entry.error}`);
  if (entry.kind !== 'orphan' && !entry.error) {
    if (entry.dirty.length) reasons.push(`${entry.dirty.length} uncommitted/untracked`);
    if (entry.unpushed === null) reasons.push('remote state unverified');
    else if (entry.unpushed > 0) reasons.push(`${entry.unpushed} commit(s) not on a remote`);
    if (ignoredOther.length) {
      reasons.push(`non-rebuildable ignored: ${ignoredOther.slice(0, 3).join(', ')}${ignoredOther.length > 3 ? ` +${ignoredOther.length - 3}` : ''}`);
    }
    if (entry.locked) reasons.push('worktree is locked');
  }
  if (ageMs < opts.minAgeDays * DAY) reasons.push(`younger than ${opts.minAgeDays}d`);
  return { class: reasons.length ? 'REVIEW' : 'SAFE', reasons, ignoredOther };
}

export function summarize(entries) {
  const out = {};
  for (const cls of ['SAFE', 'REVIEW', 'ACTIVE']) {
    const group = entries.filter((e) => e.class === cls);
    out[cls] = { count: group.length, bytes: group.reduce((sum, e) => sum + e.sizeBytes, 0) };
  }
  return out;
}

export function gb(bytes) {
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
}

export function formatAge(ms) {
  const days = ms / DAY;
  if (days >= 1) return `${Math.floor(days)}d`;
  return `${Math.max(0, Math.floor(ms / 3_600_000))}h`;
}

/** Whether --apply may remove this entry (class, kind and thread state). */
export function removalBlocker(entry, opts) {
  if (entry.class !== 'SAFE') return `class ${entry.class}`;
  if (entry.kind !== 'worktree') return `not a worktree (${entry.kind})`;
  if (entry.owner && !entry.owner.archived && !opts.includeOpenThreads) {
    return 'owner thread is still open (pass --include-open-threads)';
  }
  return null;
}

// ------------------------------------------------------------------ I/O side

async function git(cwd, args, { timeout = 120_000, allowFail = false, env = {} } = {}) {
  try {
    const { stdout } = await run('git', args, {
      cwd,
      timeout,
      maxBuffer: 256 * 1024 * 1024,
      env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C', ...env },
    });
    return stdout;
  } catch (error) {
    if (allowFail) return null;
    const message = (error.stderr || error.message || String(error)).trim().split('\n')[0];
    throw new Error(message);
  }
}

function directoriesAt(root, depth) {
  const found = [];
  const walk = (dir, level) => {
    let names;
    try {
      names = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of names) {
      const full = join(dir, name);
      let stat;
      try {
        stat = lstatSync(full);
      } catch {
        continue;
      }
      if (!stat.isDirectory()) continue;
      if (level === depth) found.push(full);
      else walk(full, level + 1);
    }
  };
  walk(root, 1);
  return found;
}

function hasGit(path) {
  return existsSync(join(path, '.git'));
}

/** Candidate checkout paths: variant/codex dirs at depth 2, /tmp checkouts at depth 1-2. */
export function discover(opts, home = homedir()) {
  const found = new Map();
  const add = (path, source) => {
    if (!found.has(path)) found.set(path, source);
  };
  for (const path of directoriesAt(join(home, '.falcondeck', 'variants'), 2)) add(path, 'variant');
  // Codex lays out ~/.codex/worktrees/<hash>/<repo>.
  for (const path of directoriesAt(join(home, '.codex', 'worktrees'), 2)) add(path, 'codex');
  for (const level of [1, 2]) {
    for (const path of directoriesAt('/private/tmp', level)) {
      if (hasGit(path)) add(path, 'tmp');
    }
  }
  for (const root of opts.roots) {
    for (const path of directoriesAt(root, 1)) if (hasGit(path)) add(path, 'extra');
  }
  return [...found].map(([path, source]) => ({ path, source }));
}

export function loadOwners(statePath) {
  const owners = new Map();
  if (!existsSync(statePath)) return owners;
  const state = JSON.parse(readFileSync(statePath, 'utf8'));
  for (const workspace of state.workspaces ?? []) {
    const archived = new Set(workspace.archived_thread_ids ?? []);
    for (const thread of Object.values(workspace.thread_states ?? {})) {
      if (!thread.variant?.path) continue;
      owners.set(thread.variant.path, {
        threadId: thread.thread_id,
        title: thread.title ?? '',
        status: thread.status ?? 'unknown',
        archived: archived.has(thread.thread_id),
        updatedAt: thread.updated_at ? Date.parse(thread.updated_at) : 0,
        workspace: workspace.path,
      });
    }
  }
  return owners;
}

async function processCwds() {
  try {
    const { stdout } = await run('lsof', ['-d', 'cwd', '-Fn'], { maxBuffer: 64 * 1024 * 1024, timeout: 60_000 });
    return stdout.split('\n').filter((l) => l.startsWith('n/')).map((l) => l.slice(1));
  } catch (error) {
    // lsof exits 1 when some processes are unreadable but still prints the rest.
    return (error.stdout ?? '').split('\n').filter((l) => l.startsWith('n/')).map((l) => l.slice(1));
  }
}

async function duBytes(path) {
  try {
    const { stdout } = await run('du', ['-sk', path], { maxBuffer: 1024 * 1024, timeout: 30 * 60_000 }).catch((e) => ({
      stdout: e.stdout ?? '',
    }));
    const kb = Number.parseInt(stdout.split('\t')[0], 10);
    return Number.isFinite(kb) ? kb * 1024 : 0;
  } catch {
    return 0;
  }
}

function mtimeOf(path) {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return 0;
  }
}

function sameFile(a, b) {
  try {
    return readFileSync(a).equals(readFileSync(b));
  } catch {
    return false;
  }
}

// Remote state is checked without writing to any repository: `ls-remote`
// supplies the real branch tips and the objects behind them are fetched into a
// scratch object directory that borrows the repo's own objects as alternates.
// No refs, FETCH_HEAD, config or index in the inspected repos are modified.
let scratchRoot = null;
const snapshots = new Map();
// One snapshot per repo per run; cleanup() also forgets them.

export function cleanup() {
  if (scratchRoot) rmSync(scratchRoot, { recursive: true, force: true });
  scratchRoot = null;
  snapshots.clear();
}

async function buildSnapshot(commonDir) {
  scratchRoot ??= mkdtempSync(join(tmpdir(), 'worktree-gc-'));
  const objects = mkdtempSync(join(scratchRoot, 'objects-'));
  const env = { GIT_OBJECT_DIRECTORY: objects, GIT_ALTERNATE_OBJECT_DIRECTORIES: join(commonDir, 'objects') };
  const listed = await git(commonDir, ['ls-remote', '--symref', 'origin'], { allowFail: true, timeout: 120_000 });
  if (listed === null) return null;
  const tips = new Map();
  let defaultBranch = null;
  for (const line of listed.split('\n')) {
    const symref = line.match(/^ref: refs\/heads\/(\S+)\tHEAD$/);
    if (symref) defaultBranch = symref[1];
    const ref = line.match(/^([0-9a-f]{40})\trefs\/heads\/(.+)$/);
    if (ref) tips.set(ref[2], ref[1]);
  }
  // Fetch by SHA: a glob refspec needs a destination ref, which would write.
  // --refmap= also stops any opportunistic update of refs/remotes/origin/*.
  const shas = [...new Set(tips.values())];
  for (let i = 0; i < shas.length; i += 200) {
    const fetched = await git(
      commonDir,
      ['fetch', '--quiet', '--no-tags', '--no-write-fetch-head', '--refmap=', 'origin', ...shas.slice(i, i + 200)],
      { allowFail: true, timeout: 600_000, env },
    );
    if (fetched === null) return null;
  }
  return { env, tips, defaultBranch };
}

function remoteSnapshot(commonDir, enabled) {
  if (!enabled) return Promise.resolve(null);
  if (!snapshots.has(commonDir)) snapshots.set(commonDir, buildSnapshot(commonDir));
  return snapshots.get(commonDir);
}

export async function inspect({ path, source }, ctx) {
  const { opts, owners, cwds } = ctx;
  const owner = owners.get(path) ?? null;
  const base = { path, source, owner, sizeBytes: 0, dirty: [], ignoredAll: [], ignoredOther: [], unpushed: 0, locked: false };
  base.liveProcess = cwds.some((cwd) => cwd === path || cwd.startsWith(path + sep));

  if (!hasGit(path)) {
    return { ...base, kind: 'orphan', repo: basename(dirname(path)), branch: null, mtimeMs: mtimeOf(path) };
  }
  const kind = lstatSync(join(path, '.git')).isDirectory() ? 'clone' : 'worktree';
  const entry = { ...base, kind };
  try {
    const gitDir = (await git(path, ['rev-parse', '--absolute-git-dir'])).trim();
    const commonRaw = (await git(path, ['rev-parse', '--path-format=absolute', '--git-common-dir'])).trim();
    const mainRoot = basename(commonRaw) === '.git' ? dirname(commonRaw) : commonRaw;
    entry.repo = basename(mainRoot).replace(/\.git$/, '');
    if (kind === 'clone') {
      const url = (await git(path, ['remote', 'get-url', 'origin'], { allowFail: true }))?.trim();
      entry.repo = (url ? basename(url).replace(/\.git$/, '') : basename(dirname(path))) || entry.repo;
    }
    entry.repoPath = mainRoot;
    entry.branch = (await git(path, ['symbolic-ref', '-q', '--short', 'HEAD'], { allowFail: true }))?.trim() || null;
    entry.headSha = (await git(path, ['rev-parse', 'HEAD'])).trim();
    entry.locked = existsSync(join(gitDir, 'locked'));

    const status = parseStatusZ(await git(path, ['status', '--porcelain=v1', '-z', '--untracked-files=normal', '--ignored=traditional']));
    // The daemon copies the project's env files (the allowlist) into every
    // variant, so ignored matches are machine-local copies, not work: the
    // original lives in the project folder. Untracked (not ignored) files only
    // pass when byte-identical to the project's copy.
    const identicalToProject = (rel) =>
      matchesAllowlist(basename(rel), opts.envAllowlist) && sameFile(join(path, rel), join(mainRoot, rel));
    entry.dirty = [...status.tracked, ...status.untracked.filter((p) => !identicalToProject(p))];
    entry.ignoredAll = status.ignored.filter((p) => !matchesAllowlist(basename(p), opts.envAllowlist));

    const snap = await remoteSnapshot(commonRaw, opts.fetch);
    if (!snap) entry.unpushed = null;
    else {
      const tips = [...snap.tips.values()];
      const candidates = (await git(path, ['rev-list', 'HEAD', '--not', ...tips], { env: snap.env })).split('\n').filter(Boolean);
      if (candidates.length === 0) entry.unpushed = 0;
      else {
        const compareWith = new Set([snap.tips.get(snap.defaultBranch), snap.tips.get(entry.branch)].filter(Boolean));
        const outputs = [];
        for (const sha of compareWith) {
          outputs.push((await git(path, ['cherry', sha, 'HEAD'], { allowFail: true, env: snap.env })) ?? '');
        }
        entry.unpushed = unpushedAfterCherry(candidates, outputs).length;
      }
    }

    const changed = [...status.tracked, ...status.untracked].map((p) => mtimeOf(join(path, p)));
    // The checkout root's own mtime is churned by unrelated tools (it moved on
    // idle, days-old threads), so it only counts when no thread owns the copy.
    entry.mtimeMs = Math.max(
      owner ? 0 : mtimeOf(path),
      mtimeOf(join(gitDir, 'HEAD')),
      mtimeOf(join(gitDir, 'index')),
      mtimeOf(join(gitDir, 'logs', 'HEAD')),
      owner?.updatedAt ?? 0,
      ...changed,
    );
  } catch (error) {
    entry.error = error.message;
    entry.repo ??= basename(dirname(path));
    entry.branch ??= null;
    entry.mtimeMs = Math.max(owner ? 0 : mtimeOf(path), owner?.updatedAt ?? 0);
  }
  return entry;
}

async function pool(items, jobs, fn) {
  const results = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(jobs, items.length) }, async () => {
      while (next < items.length) {
        const index = next;
        next += 1;
        results[index] = await fn(items[index], index);
      }
    }),
  );
  return results;
}

export async function collect(opts, { log = () => {} } = {}) {
  const statePath = opts.state ?? join(homedir(), '.falcondeck', 'daemon-state.json');
  const owners = loadOwners(statePath);
  const cwds = await processCwds();
  const candidates = discover(opts);
  log(`found ${candidates.length} candidate checkouts; inspecting`);
  const now = Date.now();
  const entries = await pool(candidates, opts.jobs, async (candidate, index) => {
    const entry = await inspect(candidate, { opts, owners, cwds });
    entry.sizeBytes = await duBytes(candidate.path);
    Object.assign(entry, classify(entry, opts, now));
    log(`[${index + 1}/${candidates.length}] ${entry.class} ${candidate.path}`);
    return entry;
  });
  return { entries, ownersKnown: owners.size, generatedAt: new Date(now).toISOString() };
}

// ------------------------------------------------------------------ rendering

function short(path) {
  const home = homedir();
  return path.startsWith(home) ? `~${path.slice(home.length)}` : path;
}

function thread(entry) {
  if (!entry.owner) return entry.source === 'variant' ? 'none (orphaned)' : '-';
  const state = entry.owner.archived ? 'archived' : 'open';
  return `${entry.owner.status}/${state} ${entry.owner.title}`.trim().slice(0, 48);
}

function row(entry, now) {
  return {
    class: entry.class,
    size: gb(entry.sizeBytes),
    age: formatAge(now - entry.mtimeMs),
    repo: entry.repo,
    path: short(entry.path),
    git: entry.error ? 'error' : entry.kind === 'orphan' ? 'n/a' : entry.dirty.length ? `dirty(${entry.dirty.length})` : 'clean',
    unpushed: entry.unpushed === null ? '?' : String(entry.unpushed ?? 0),
    ignored: entry.ignoredOther.length ? entry.ignoredOther.slice(0, 2).join(' ') : '-',
    thread: thread(entry),
    why: entry.reasons.join('; ') || '-',
  };
}

function table(rows, columns, markdown) {
  const cells = rows.map((r) => columns.map((c) => String(r[c])));
  if (markdown) {
    const lines = [`| ${columns.join(' | ')} |`, `|${columns.map(() => '---').join('|')}|`];
    for (const r of cells) lines.push(`| ${r.map((c) => c.replaceAll('|', '\\|')).join(' | ')} |`);
    return lines.join('\n');
  }
  const widths = columns.map((c, i) => Math.max(c.length, ...cells.map((r) => r[i].length)));
  const fmt = (r) => r.map((c, i) => c.padEnd(widths[i])).join('  ').trimEnd();
  return [fmt(columns), fmt(widths.map((w) => '-'.repeat(w))), ...cells.map(fmt)].join('\n');
}

export function render(result, opts) {
  const now = Date.parse(result.generatedAt);
  const entries = [...result.entries].sort((a, b) => b.sizeBytes - a.sizeBytes);
  const summary = summarize(entries);
  if (opts.format === 'json') {
    return JSON.stringify({ generatedAt: result.generatedAt, summary, entries }, null, 2);
  }
  const md = opts.format === 'markdown';
  const heading = (text) => (md ? `\n### ${text}\n` : `\n${text}\n${'='.repeat(text.length)}`);
  const out = [];
  out.push(`worktree-gc ${opts.apply ? 'APPLY' : 'dry-run'} - ${result.generatedAt}`);
  out.push(`remote state ${opts.fetch ? 'read live via git ls-remote (no repo is written to; failures => REVIEW)' : 'NOT checked (--no-fetch): nothing can be SAFE'}`);
  out.push(heading('Summary'));
  out.push(
    table(
      Object.entries(summary).map(([cls, v]) => ({ class: cls, count: v.count, size: gb(v.bytes) })),
      ['class', 'count', 'size'],
      md,
    ),
  );
  const generated = entries.map((e) => ({ ...e, ...classify(e, { ...opts, rebuildable: GENERATED_PRESET }, Date.parse(result.generatedAt)) }));
  const alt = summarize(generated);
  out.push(`\nIf framework caches and test output also counted as rebuildable (--rebuildable-preset generated): SAFE ${alt.SAFE.count} / ${gb(alt.SAFE.bytes)}, REVIEW ${alt.REVIEW.count} / ${gb(alt.REVIEW.bytes)}, ACTIVE ${alt.ACTIVE.count} / ${gb(alt.ACTIVE.bytes)}.`);
  const clones = entries.filter((e) => e.kind === 'clone' && e.reasons.length === 1);
  if (clones.length) {
    out.push(`\n${clones.length} standalone clone(s), ${gb(clones.reduce((s, e) => s + e.sizeBytes, 0))}, would be SAFE but are not worktrees; --apply will not touch them.`);
  }
  const open = entries.filter((e) => e.class === 'SAFE' && e.owner && !e.owner.archived);
  if (open.length) {
    out.push(`${open.length} SAFE worktree(s), ${gb(open.reduce((s, e) => s + e.sizeBytes, 0))}, belong to threads that are still open; --apply skips them unless --include-open-threads.`);
  }
  const bySource = {};
  for (const e of entries) {
    const key = `${e.source} / ${e.class}`;
    bySource[key] = bySource[key] ?? { count: 0, bytes: 0 };
    bySource[key].count += 1;
    bySource[key].bytes += e.sizeBytes;
  }
  out.push(heading('By location and class'));
  out.push(
    table(
      Object.entries(bySource).sort().map(([k, v]) => ({ where: k, count: v.count, size: gb(v.bytes) })),
      ['where', 'count', 'size'],
      md,
    ),
  );
  const review = entries.filter((e) => e.class === 'REVIEW').slice(0, opts.top);
  out.push(heading(`Largest ${review.length} REVIEW entries`));
  out.push(table(review.map((e) => row(e, now)), ['size', 'age', 'repo', 'path', 'git', 'unpushed', 'thread', 'why'], md));
  out.push(heading('All entries (largest first)'));
  out.push(table(entries.map((e) => row(e, now)), ['class', 'size', 'age', 'repo', 'path', 'git', 'unpushed', 'ignored', 'thread', 'why'], md));
  return out.join('\n');
}

// ---------------------------------------------------------------------- apply

export async function apply(result, opts, { log = console.log } = {}) {
  const removed = [];
  const skipped = [];
  const failed = [];
  const repos = new Set();
  for (const entry of result.entries) {
    const blocker = removalBlocker(entry, opts);
    if (blocker) {
      if (entry.class === 'SAFE') skipped.push({ path: entry.path, reason: blocker });
      continue;
    }
    // Re-assess right before removal: state may have changed since the scan.
    const fresh = await inspect({ path: entry.path, source: entry.source }, { opts, owners: loadOwners(opts.state ?? join(homedir(), '.falcondeck', 'daemon-state.json')), cwds: await processCwds() });
    Object.assign(fresh, classify(fresh, opts));
    const freshBlocker = removalBlocker(fresh, opts);
    if (freshBlocker) {
      skipped.push({ path: entry.path, reason: `changed since scan: ${freshBlocker}` });
      continue;
    }
    try {
      await git(entry.repoPath, ['worktree', 'remove', entry.path], { timeout: 30 * 60_000 });
      repos.add(entry.repoPath);
      removed.push({ path: entry.path, repo: entry.repo, branch: entry.branch, headSha: entry.headSha, bytes: entry.sizeBytes, threadId: entry.owner?.threadId ?? null });
      log(`removed ${entry.path}`);
    } catch (error) {
      failed.push({ path: entry.path, reason: error.message });
      log(`FAILED ${entry.path}: ${error.message}`);
    }
  }
  for (const repo of repos) await git(repo, ['worktree', 'prune'], { allowFail: true });
  const record = { at: new Date().toISOString(), removed, skipped, failed };
  const dir = join(homedir(), '.falcondeck', 'worktree-gc');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${record.at.replace(/[:.]/g, '-')}.json`);
  writeFileSync(file, JSON.stringify(record, null, 2));
  log(`removed ${removed.length} (${gb(removed.reduce((s, r) => s + r.bytes, 0))}), skipped ${skipped.length}, failed ${failed.length}`);
  log(`audit log: ${file} (branches are kept; each removed HEAD sha is recorded)`);
  return record;
}

const HELP = `Usage: worktree-gc [--apply] [--format text|markdown|json] [options]

  --apply                   remove SAFE worktrees (default is a dry run)
  --include-open-threads    with --apply, also remove SAFE worktrees whose thread is not archived
  --no-fetch                do not contact remotes (then nothing is SAFE)
  --rebuildable-preset P    strict (default: node_modules vendor target .next dist) | generated (adds framework caches, test output)
  --min-age-days N          SAFE age threshold (default ${DEFAULTS.minAgeDays})
  --active-hours N          ACTIVE recency window (default ${DEFAULTS.activeHours})
  --top N                   REVIEW rows to highlight (default ${DEFAULTS.top})
  --root PATH               extra directory whose children are checkouts (repeatable)
  --state PATH              daemon-state.json (default ~/.falcondeck/daemon-state.json)
  --jobs N                  parallel inspections (default ${DEFAULTS.jobs})
`;

export async function main(argv) {
  const opts = parseArgs(argv);
  if (opts.help) {
    process.stdout.write(HELP);
    return 0;
  }
  let result;
  try {
    result = await collect(opts, { log: (m) => process.stderr.write(`${m}\n`) });
  } catch (error) {
    cleanup();
    throw error;
  }
  process.stdout.write(`${render(result, opts)}\n`);
  try {
    if (opts.apply) await apply(result, opts);
  } finally {
    cleanup();
  }
  return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === realpathSync(process.argv[1])) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (error) => {
      process.stderr.write(`worktree-gc: ${error.message}\n`);
      process.exit(2);
    },
  );
}
