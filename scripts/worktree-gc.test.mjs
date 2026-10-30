import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DEFAULTS,
  GENERATED_PRESET,
  apply,
  classify,
  cleanup,
  inspect,
  isRebuildable,
  matchesAllowlist,
  parseArgs,
  parseCherryUnmatched,
  parseStatusZ,
  removalBlocker,
  unpushedAfterCherry,
} from './worktree-gc.mjs';

const OLD = Date.now() - 30 * 86_400_000;
const opts = { ...DEFAULTS, minAgeDays: 3, activeHours: 24, includeOpenThreads: false, state: '/nonexistent/state.json' };
const base = {
  kind: 'worktree',
  dirty: [],
  ignoredAll: [],
  unpushed: 0,
  owner: null,
  liveProcess: false,
  locked: false,
  mtimeMs: OLD,
};

test('rebuildable dirs and the env allowlist', () => {
  assert.ok(isRebuildable('apps/web/node_modules/'));
  assert.ok(isRebuildable('vendor/'));
  assert.ok(isRebuildable('target/'));
  assert.ok(!isRebuildable('storage/logs/'));
  assert.ok(!isRebuildable('node_modules_backup/'));
  assert.ok(!isRebuildable('bootstrap/cache/x.php'));
  assert.ok(isRebuildable('bootstrap/cache/x.php', GENERATED_PRESET));
  assert.ok(!isRebuildable('bootstrap/app.php', GENERATED_PRESET));
  assert.ok(!isRebuildable('storage/app/uploads/', GENERATED_PRESET));
  assert.ok(matchesAllowlist('.env.local'));
  assert.ok(matchesAllowlist('.envrc'));
  assert.ok(matchesAllowlist('app.local.json'));
  assert.ok(!matchesAllowlist('secrets.txt'));
});

test('parseStatusZ separates tracked, untracked, ignored and consumes rename sources', () => {
  const out = ['R  new.txt', 'old.txt', ' M a.rs', '?? scratch/', '!! node_modules/', ''].join('\0');
  assert.deepEqual(parseStatusZ(out), {
    tracked: ['new.txt', 'a.rs'],
    untracked: ['scratch/'],
    ignored: ['node_modules/'],
  });
});

test('cherry parsing keeps merges unpushed and honours patch-equivalent commits', () => {
  assert.deepEqual(parseCherryUnmatched('+ aaa\n- bbb\n'), ['aaa']);
  assert.deepEqual(unpushedAfterCherry(['aaa', 'bbb', 'ccc'], ['- bbb\n+ aaa\n', '- aaa\n']), ['ccc']);
});

test('classification rules', () => {
  assert.equal(classify(base, opts).class, 'SAFE');
  assert.equal(classify({ ...base, dirty: ['a'] }, opts).class, 'REVIEW');
  assert.equal(classify({ ...base, unpushed: 2 }, opts).class, 'REVIEW');
  assert.equal(classify({ ...base, unpushed: null }, opts).class, 'REVIEW');
  assert.equal(classify({ ...base, ignoredAll: ['.idea/'] }, opts).class, 'REVIEW');
  assert.equal(classify({ ...base, kind: 'clone' }, opts).class, 'REVIEW');
  assert.equal(classify({ ...base, kind: 'orphan' }, opts).class, 'REVIEW');
  assert.equal(classify({ ...base, locked: true }, opts).class, 'REVIEW');
  assert.equal(classify({ ...base, mtimeMs: Date.now() - 2 * 86_400_000 }, opts).class, 'REVIEW');
  assert.equal(classify({ ...base, mtimeMs: Date.now() - 3_600_000 }, opts).class, 'ACTIVE');
  assert.equal(classify({ ...base, liveProcess: true }, opts).class, 'ACTIVE');
  const running = { threadId: 't', title: '', status: 'running', archived: false };
  assert.equal(classify({ ...base, owner: running }, opts).class, 'ACTIVE');
  // ACTIVE wins over every REVIEW reason.
  assert.equal(classify({ ...base, owner: running, dirty: ['a'] }, opts).class, 'ACTIVE');
});

test('removal needs SAFE, a worktree, and an archived thread unless opted in', () => {
  const safe = { ...base, class: 'SAFE' };
  assert.equal(removalBlocker(safe, opts), null);
  assert.ok(removalBlocker({ ...safe, class: 'REVIEW' }, opts));
  assert.ok(removalBlocker({ ...safe, kind: 'clone' }, opts));
  const open = { ...safe, owner: { archived: false } };
  assert.ok(removalBlocker(open, opts));
  assert.equal(removalBlocker(open, { ...opts, includeOpenThreads: true }), null);
  assert.equal(removalBlocker({ ...safe, owner: { archived: true } }, opts), null);
});

test('parseArgs defaults to a dry run and rejects junk', () => {
  assert.equal(parseArgs([]).apply, false);
  assert.equal(parseArgs(['--apply']).apply, true);
  assert.throws(() => parseArgs(['--bogus']));
  assert.throws(() => parseArgs(['--format', 'xml']));
});

// ---- integration against real git repositories --------------------------------

let sandbox;
let project;
let origin;
const sh = (cwd, ...args) =>
  execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t', GIT_CONFIG_GLOBAL: '/dev/null' },
  }).trim();

function worktree(name, branch) {
  const path = join(sandbox, 'variants', name);
  sh(project, 'worktree', 'add', '-b', branch, path, 'main');
  return path;
}

async function assess(path, options = {}) {
  const o = { ...opts, minAgeDays: 0, activeHours: 0, ...options };
  cleanup(); // the remote moves between tests, so never reuse a snapshot
  const entry = await inspect({ path, source: 'variant' }, { opts: o, owners: new Map(), cwds: [] });
  return { ...entry, ...classify(entry, o), sizeBytes: 1 };
}

before(() => {
  sandbox = realpathSync(mkdtempSync(join(tmpdir(), 'worktree-gc-test-')));
  origin = join(sandbox, 'origin.git');
  project = join(sandbox, 'project');
  mkdirSync(project);
  sh(sandbox, 'init', '--bare', '-b', 'main', origin);
  sh(project, 'init', '-b', 'main');
  writeFileSync(join(project, '.gitignore'), 'node_modules/\n.idea/\n.env\n');
  writeFileSync(join(project, 'a.txt'), 'one\n');
  sh(project, 'add', '.');
  sh(project, 'commit', '-m', 'init');
  sh(project, 'remote', 'add', 'origin', origin);
  sh(project, 'push', 'origin', 'main');
});

after(() => {
  cleanup();
  rmSync(sandbox, { recursive: true, force: true });
});

test('clean worktree whose commit is on a remote branch is SAFE, and node_modules does not matter', async () => {
  const path = worktree('safe', 'falcondeck/safe');
  writeFileSync(join(path, 'b.txt'), 'b\n');
  sh(path, 'add', '.');
  sh(path, 'commit', '-m', 'work');
  sh(path, 'push', 'origin', 'falcondeck/safe');
  mkdirSync(join(path, 'node_modules'));
  writeFileSync(join(path, 'node_modules', 'x.js'), 'x');
  const entry = await assess(path);
  assert.equal(entry.unpushed, 0);
  assert.equal(entry.class, 'SAFE', entry.reasons.join('; '));
});

test('unpushed commits make a worktree REVIEW', async () => {
  const path = worktree('unpushed', 'falcondeck/unpushed');
  writeFileSync(join(path, 'c.txt'), 'c\n');
  sh(path, 'add', '.');
  sh(path, 'commit', '-m', 'local only');
  const entry = await assess(path);
  assert.equal(entry.unpushed, 1);
  assert.equal(entry.class, 'REVIEW');
});

test('a commit cherry-picked onto main with a new SHA counts as pushed (patch-id)', async () => {
  const path = worktree('picked', 'falcondeck/picked');
  writeFileSync(join(path, 'd.txt'), 'd\n');
  sh(path, 'add', '.');
  sh(path, 'commit', '-m', 'feature');
  const local = sh(path, 'rev-parse', 'HEAD');
  // Land an equivalent patch on origin/main from the project checkout.
  execFileSync('git', ['cherry-pick', local], {
    cwd: project,
    env: { ...process.env, GIT_COMMITTER_NAME: 'u', GIT_COMMITTER_EMAIL: 'u@u', GIT_COMMITTER_DATE: '2030-01-01T00:00:00Z', GIT_CONFIG_GLOBAL: '/dev/null' },
  });
  sh(project, 'push', 'origin', 'main');
  assert.notEqual(sh(project, 'rev-parse', 'HEAD'), local);
  const entry = await assess(path);
  assert.equal(entry.unpushed, 0, 'patch-equivalent commit should not count as unpushed');
  assert.equal(entry.class, 'SAFE', entry.reasons.join('; '));
});

test('dirty tree, untracked file and non-rebuildable ignored dir are all REVIEW', async () => {
  const dirty = worktree('dirty', 'falcondeck/dirty');
  writeFileSync(join(dirty, 'a.txt'), 'changed\n');
  assert.match((await assess(dirty)).reasons.join(';'), /uncommitted/);

  const untracked = worktree('untracked', 'falcondeck/untracked');
  writeFileSync(join(untracked, 'new.txt'), 'n');
  assert.equal((await assess(untracked)).class, 'REVIEW');

  const ignored = worktree('ignored', 'falcondeck/ignored');
  mkdirSync(join(ignored, '.idea'));
  writeFileSync(join(ignored, '.idea', 'workspace.xml'), 'x');
  const entry = await assess(ignored);
  assert.equal(entry.class, 'REVIEW');
  assert.match(entry.reasons.join(';'), /non-rebuildable ignored/);
});

test('ignored env copies are machine-local; untracked allowlisted files must match the project', async () => {
  writeFileSync(join(project, '.env'), 'KEY=1\n');
  writeFileSync(join(project, 'app.local.json'), '{"a":1}\n');
  const ignoredEnv = worktree('env-ignored', 'falcondeck/env-ignored');
  writeFileSync(join(ignoredEnv, '.env'), 'KEY=2\n');
  assert.equal((await assess(ignoredEnv)).class, 'SAFE');

  const same = worktree('local-same', 'falcondeck/local-same');
  writeFileSync(join(same, 'app.local.json'), '{"a":1}\n');
  assert.equal((await assess(same)).class, 'SAFE');

  const edited = worktree('local-edited', 'falcondeck/local-edited');
  writeFileSync(join(edited, 'app.local.json'), '{"a":2}\n');
  assert.equal((await assess(edited)).class, 'REVIEW');
});

test('unreachable remote means REVIEW, never SAFE', async () => {
  const path = worktree('offline', 'falcondeck/offline');
  const entry = await assess(path, { fetch: false });
  assert.equal(entry.unpushed, null);
  assert.equal(entry.class, 'REVIEW');
});

test('fresh worktrees are ACTIVE under default thresholds', async () => {
  const path = worktree('fresh', 'falcondeck/fresh');
  const entry = await assess(path, { minAgeDays: 3, activeHours: 24 });
  assert.equal(entry.class, 'ACTIVE');
});

test('inspection leaves the inspected repository untouched', async () => {
  const path = worktree('readonly', 'falcondeck/readonly');
  const snapshot = () => sh(project, 'for-each-ref') + sh(project, 'config', '--list');
  const before = snapshot();
  await assess(path);
  assert.equal(snapshot(), before, 'refs and config must not change');
  assert.ok(!existsSync(join(project, '.git', 'FETCH_HEAD')), 'FETCH_HEAD must not be written');
});

test('--apply removes only SAFE worktrees, keeps the branch, and records an audit log', async () => {
  const home = join(sandbox, 'home');
  mkdirSync(home);
  const savedHome = process.env.HOME;
  process.env.HOME = home;
  try {
    const safe = await assess(join(sandbox, 'variants', 'safe'));
    const dirty = await assess(join(sandbox, 'variants', 'dirty'));
    const unpushed = await assess(join(sandbox, 'variants', 'unpushed'));
    assert.deepEqual([safe.class, dirty.class, unpushed.class], ['SAFE', 'REVIEW', 'REVIEW'], safe.reasons.join(';'));
    const record = await apply({ entries: [safe, dirty, unpushed] }, { ...opts, minAgeDays: 0, activeHours: 0 }, { log: () => {} });
    assert.equal(record.removed.length, 1);
    assert.equal(record.removed[0].path, safe.path);
    assert.ok(!existsSync(safe.path));
    assert.ok(existsSync(dirty.path) && existsSync(unpushed.path));
    assert.match(sh(project, 'branch', '--list', 'falcondeck/safe'), /falcondeck\/safe/);
    assert.ok(!sh(project, 'worktree', 'list').includes('variants/safe'));
  } finally {
    process.env.HOME = savedHome;
  }
});

test('--apply re-checks state: a worktree dirtied after the scan is not removed', async () => {
  const path = join(sandbox, 'variants', 'picked');
  const stale = await assess(path);
  assert.equal(stale.class, 'SAFE');
  writeFileSync(join(path, 'late.txt'), 'late\n');
  const savedHome = process.env.HOME;
  process.env.HOME = join(sandbox, 'home');
  try {
    const record = await apply({ entries: [stale] }, { ...opts, minAgeDays: 0, activeHours: 0 }, { log: () => {} });
    assert.equal(record.removed.length, 0);
    assert.match(record.skipped[0].reason, /changed since scan/);
    assert.ok(existsSync(path));
  } finally {
    process.env.HOME = savedHome;
  }
});
