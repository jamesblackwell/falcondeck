import test from 'node:test';
import assert from 'node:assert/strict';
import { sourceTreeHash, validateSource, validatePath } from '../src/source.mjs';

const file = (path, content = 'hello', executable = false) => ({ path, content_base64: Buffer.from(content).toString('base64'), executable });
const manifest = files => ({ files, tree_hash: sourceTreeHash(files) });

test('source tree hash is stable across ordering and changes with bytes/mode/path', () => {
  const files = [file('b'), file('a')];
  assert.equal(sourceTreeHash(files), sourceTreeHash(files.toReversed()));
  for (const changed of [file('b', 'different'), file('b', 'hello', true), file('c')]) {
    assert.notEqual(sourceTreeHash(files), sourceTreeHash([changed, files[1]]));
  }
  assert.equal(validateSource(manifest(files)).total_bytes, 10);
});

test('paths cannot escape or upload credentials, native homes, dependencies, git internals', () => {
  for (const path of ['/etc/passwd', '../x', 'a/../x', 'a//x', 'C:x', 'a\\x', 'a\nx', '.git/config', '.GIT/config', '.hg/x', 'x/.secrets-cache/x', 'a/.env.test', '.codex/sessions/x', 'node_modules/x', 'a/key.pem', 'credentials.json', 'x.', 'x ']) {
    assert.throws(() => validatePath(path), undefined, path);
  }
  for (const path of ['README.md', 'src/env.ts', 'package-lock.json', 'config.example.json']) assert.equal(validatePath(path), path);
});

test('source rejects malformed base64, duplicate or colliding paths, wrong hash, and oversize data', () => {
  for (const files of [[file('x'), file('x')], [file('X'), file('x')], [file('X'), file('x/y')], [file('x'), file('x/y')], [{...file('x'), content_base64:'abc'}], [file('x', 'x'.repeat(4 * 1024 * 1024 + 1))]]) {
    assert.throws(() => validateSource(manifest(files)));
  }
  assert.throws(() => validateSource({ ...manifest([file('x')]), tree_hash: '0'.repeat(64) }));
  assert.throws(() => validateSource(manifest([file('notes.txt', '-----BEGIN PRIVATE KEY-----\nsensitive')])));
});

test('valid maximum-size base64 does not overflow the regex stack', () => {
  const files = [{ path: 'large.bin', executable: false, content_base64: Buffer.alloc(4 * 1024 * 1024).toString('base64') }];
  assert.equal(validateSource(manifest(files)).total_bytes, 4 * 1024 * 1024);
  assert.throws(() => validateSource(manifest([{ ...file('x'), content_base64: 'Zg=!' }])));
  assert.throws(() => validateSource(manifest([{ ...file('x'), content_base64: 'Zh==' }])));
});
