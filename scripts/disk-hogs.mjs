#!/usr/bin/env node
// Read-only report of the usual big disk consumers on a developer Mac, beyond
// the worktrees that worktree-gc.mjs covers. It runs `du` and a few status
// commands and never deletes or modifies anything.
//
//   node scripts/disk-hogs.mjs [--top 10] [--format text|markdown|json]

import { execFile } from 'node:child_process';
import { existsSync, readdirSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);

/** Known locations, grouped the way people think about them. */
export function locations(home = homedir()) {
  const lib = join(home, 'Library');
  return [
    { label: 'OrbStack / Docker data', paths: [join(home, '.orbstack'), join(lib, 'Group Containers', 'HUAQ24HBR6.dev.orbstack')], note: 'images, containers and volumes live in a sparse VM disk; `orb`/`docker system df` shows detail' },
    { label: 'Docker Desktop data', paths: [join(lib, 'Containers', 'com.docker.docker')], note: '' },
    { label: 'Xcode DerivedData', paths: [join(lib, 'Developer', 'Xcode', 'DerivedData')], note: 'rebuildable' },
    { label: 'Xcode Archives', paths: [join(lib, 'Developer', 'Xcode', 'Archives')], note: 'old .xcarchive files are the usual bulk' },
    { label: 'Xcode iOS DeviceSupport', paths: [join(lib, 'Developer', 'Xcode', 'iOS DeviceSupport')], note: 'one folder per device/OS version' },
    { label: 'Simulator devices', paths: [join(lib, 'Developer', 'CoreSimulator', 'Devices')], note: 'per-simulator data' },
    { label: 'Simulator runtimes', paths: ['/Library/Developer/CoreSimulator/Images', '/Library/Developer/CoreSimulator/Cryptex'], note: 'upper bound; Volumes/ holds mounts of these images and is deliberately not counted. `xcrun simctl runtime list` gives the exact total' },
    { label: 'pnpm store', paths: [join(lib, 'pnpm'), join(home, '.local', 'share', 'pnpm')], note: 'prune with `pnpm store prune`' },
    { label: 'npm cache', paths: [join(home, '.npm')], note: '`npm cache verify`' },
    { label: 'Cargo registry + git', paths: [join(home, '.cargo', 'registry'), join(home, '.cargo', 'git')], note: '' },
    { label: 'Rust toolchains', paths: [join(home, '.rustup')], note: '' },
    { label: 'FalconDeck cargo target', paths: [join(home, 'www', 'sites', 'falcondeck', 'target')], note: 'scripts/prune-cargo-target.sh trims it' },
    { label: 'EAS local builds', paths: [join(home, '.eas-build-local'), join(lib, 'Caches', 'eas-cli'), join(home, '.cache', 'eas-cli')], note: '' },
    { label: 'Homebrew cache', paths: [join(lib, 'Caches', 'Homebrew')], note: '`brew cleanup`' },
    { label: 'Playwright / Puppeteer browsers', paths: [join(lib, 'Caches', 'ms-playwright'), join(home, '.cache', 'puppeteer')], note: '' },
    { label: '~/Library/Caches (total)', paths: [join(lib, 'Caches')], note: 'overlaps the Homebrew/Playwright rows' },
    { label: 'Trash', paths: [join(home, '.Trash')], note: '' },
    { label: 'Codex worktrees', paths: [join(home, '.codex', 'worktrees')], note: 'covered by worktree-gc.mjs' },
    { label: 'FalconDeck variants', paths: [join(home, '.falcondeck', 'variants')], note: 'covered by worktree-gc.mjs' },
    { label: 'Conductor workspaces', paths: [join(home, 'conductor', 'workspaces')], note: 'not covered by worktree-gc.mjs' },
  ];
}

async function du(path) {
  if (!existsSync(path)) return 0;
  const { stdout } = await run('du', ['-sk', path], { maxBuffer: 1 << 20, timeout: 30 * 60_000 }).catch((e) => ({ stdout: e.stdout ?? '' }));
  const kb = Number.parseInt(stdout.split('\t')[0], 10);
  return Number.isFinite(kb) ? kb * 1024 : 0;
}

async function tryRun(command, args) {
  try {
    const { stdout } = await run(command, args, { timeout: 20_000, maxBuffer: 4 << 20 });
    return stdout.trim();
  } catch {
    return null;
  }
}

async function pool(items, jobs, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(jobs, items.length) }, async () => {
      while (next < items.length) {
        const i = next;
        next += 1;
        out[i] = await fn(items[i]);
      }
    }),
  );
  return out;
}

export async function collect({ jobs = 3 } = {}) {
  const entries = await pool(locations(), jobs, async (loc) => {
    const parts = await Promise.all(loc.paths.map(async (path) => ({ path, bytes: await du(path) })));
    return { ...loc, bytes: parts.reduce((s, p) => s + p.bytes, 0), present: parts.filter((p) => p.bytes > 0).map((p) => p.path) };
  });
  // Non-git /private/tmp entries (git checkouts are worktree-gc's job).
  let tmp = [];
  try {
    const names = readdirSync('/private/tmp').map((n) => join('/private/tmp', n));
    tmp = (await pool(names, 6, async (path) => ({ path, bytes: await du(path), git: existsSync(join(path, '.git')) }))).sort((a, b) => b.bytes - a.bytes);
  } catch {
    // unreadable /private/tmp: skip
  }
  const docker = await tryRun('docker', ['system', 'df']);
  const runtimes = await tryRun('xcrun', ['simctl', 'runtime', 'list']);
  const volume = await tryRun('df', ['-h', '/System/Volumes/Data']);
  return { entries: entries.sort((a, b) => b.bytes - a.bytes), tmp, docker, runtimes, volume };
}

const gb = (bytes) => `${(bytes / 1024 ** 3).toFixed(1)} GB`;
const short = (p) => (p.startsWith(homedir()) ? `~${p.slice(homedir().length)}` : p);

export function render(result, { top = 10, format = 'text' } = {}) {
  if (format === 'json') return JSON.stringify(result, null, 2);
  const md = format === 'markdown';
  const rows = result.entries.filter((e) => e.bytes > 0).slice(0, top);
  const lines = [];
  lines.push(md ? `### Top ${rows.length} other disk users (read-only)` : `Top ${rows.length} other disk users (read-only)`);
  lines.push(md ? '| # | what | size | where | note |\n|---|---|---|---|---|' : '');
  rows.forEach((e, i) => {
    const where = e.present.map(short).join(', ');
    lines.push(md ? `| ${i + 1} | ${e.label} | ${gb(e.bytes)} | ${where} | ${e.note} |` : `${String(i + 1).padStart(2)}. ${gb(e.bytes).padStart(9)}  ${e.label}  (${where})${e.note ? `  - ${e.note}` : ''}`);
  });
  const tmpTop = result.tmp.filter((t) => !t.git).slice(0, top);
  const tmpTotal = result.tmp.reduce((s, t) => s + t.bytes, 0);
  lines.push('', md ? `### /private/tmp: ${gb(tmpTotal)} in ${result.tmp.length} entries; ${tmpTop.length} largest non-git` : `/private/tmp: ${gb(tmpTotal)} in ${result.tmp.length} entries; ${tmpTop.length} largest non-git`);
  for (const t of tmpTop) lines.push(md ? `- ${gb(t.bytes)} \`${t.path}\`` : `  ${gb(t.bytes).padStart(9)}  ${t.path}`);
  if (result.docker) lines.push('', md ? '### docker system df\n```\n' + result.docker + '\n```' : `docker system df\n${result.docker}`);
  else lines.push('', 'docker daemon not running (images not sized; start OrbStack to see `docker system df`)');
  if (result.runtimes) lines.push('', md ? '### simulator runtimes\n```\n' + result.runtimes + '\n```' : `simulator runtimes\n${result.runtimes}`);
  return lines.join('\n');
}

if (process.argv[1] && fileURLToPath(import.meta.url) === realpathSync(process.argv[1])) {
  const args = process.argv.slice(2);
  const arg = (name, fallback) => (args.includes(name) ? args[args.indexOf(name) + 1] : fallback);
  collect().then((result) => {
    process.stdout.write(`${render(result, { top: Number(arg('--top', 10)), format: arg('--format', 'text') })}\n`);
  });
}
