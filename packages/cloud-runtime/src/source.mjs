import { createHash } from 'node:crypto';

export const SOURCE_LIMITS = Object.freeze({ files: 10_000, fileBytes: 4 * 1024 * 1024, totalBytes: 32 * 1024 * 1024 });

// This policy applies to tracked files too. The source host applies its own
// capture policy; the transport and worker independently enforce this boundary.
const excludedDirectories = new Set([
  '.git', '.hg', '.svn', '.codex', '.claude', '.falcondeck', '.aws', '.azure', '.config', '.ssh',
  '.gnupg', '.npm', '.pnpm-store', '.next', '.nuxt', '.cache', 'node_modules',
  '.docker', '.kube', '.vercel', '.turbo', '.expo', '.venv', 'venv', '__pycache__',
  'vendor', 'target', 'dist', 'build', 'out', 'coverage', 'pods', 'deriveddata',
]);
const secretNames = /^(?:\.env.*|\.netrc|\.npmrc|\.pypirc|\.pgpass|\.yarnrc(?:\.yml)?|\.git-credentials|auth\.json|credentials.*|secrets?.*|service-account.*|id_(?:rsa|dsa|ecdsa|ed25519)(?:\.pub)?|.*\.(?:pem|key|p12|pfx|jks|keystore|mobileprovision|tfstate(?:\.backup)?))$/i;

export function validatePath(path) {
  if (typeof path !== 'string' || path.length < 1 || Buffer.byteLength(path) > 1024 ||
      path.startsWith('/') || /[\\\x00-\x1f\x7f]/u.test(path) || path.includes(':')) {
    throw new Error('Invalid source path');
  }
  const parts = path.split('/');
  if (parts.some(part => !part || part === '.' || part === '..' || /[. ]$/.test(part) ||
      excludedDirectories.has(part.toLowerCase()) || part.toLowerCase().startsWith('.secrets')) ||
      secretNames.test(parts.at(-1))) throw new Error('Excluded source path');
  return path;
}

export function fileDigest(bytes) { return createHash('sha256').update(bytes).digest('hex'); }

export function sourceTreeHash(files) {
  const hash = createHash('sha256');
  // Buffer.compare matches Rust's UTF-8 String ordering.
  for (const file of [...files].sort((a, b) => Buffer.compare(Buffer.from(a.path), Buffer.from(b.path)))) {
    hash.update(file.path).update('\0').update(file.executable ? '1' : '0').update('\0')
      .update(fileDigest(Buffer.from(file.content_base64, 'base64'))).update('\n');
  }
  return hash.digest('hex');
}

export function validateSource(source) {
  if (!source || !Array.isArray(source.files) || source.files.length > SOURCE_LIMITS.files) throw new Error('Invalid source manifest');
  const paths = new Set(), foldedPaths = new Set();
  let totalBytes = 0;
  const files = source.files.map(input => {
    const file = input && { ...input, content_base64: input.content_base64 ?? input.contentBase64 };
    if (!file || typeof file.content_base64 !== 'string' || typeof file.executable !== 'boolean') throw new Error('Invalid source file');
    validatePath(file.path);
    if (foldedPaths.has(file.path.toLowerCase())) throw new Error('Duplicate source path');
    paths.add(file.path);
    foldedPaths.add(file.path.toLowerCase());
    // Buffer.from alone accepts malformed/truncated base64. Canonical
    // round-tripping avoids nested regex repetition on multi-megabyte files.
    if (file.content_base64.length > Math.ceil(SOURCE_LIMITS.fileBytes / 3) * 4 ||
        file.content_base64.length % 4 !== 0) throw new Error('Invalid source encoding');
    const bytes = Buffer.from(file.content_base64, 'base64');
    if (bytes.toString('base64') !== file.content_base64) throw new Error('Invalid source encoding');
    if (bytes.length > SOURCE_LIMITS.fileBytes || (totalBytes += bytes.length) > SOURCE_LIMITS.totalBytes) throw new Error('Source size limit exceeded');
    if (/^-----BEGIN (?:RSA |EC |OPENSSH |DSA |ENCRYPTED )?PRIVATE KEY-----/m.test(bytes.toString('utf8'))) throw new Error('Private key content is excluded');
    return { path: file.path, content_base64: file.content_base64, executable: file.executable };
  });
  for (const path of paths) {
    const parts = path.split('/');
    for (let i = 1; i < parts.length; i++) if (foldedPaths.has(parts.slice(0, i).join('/').toLowerCase())) throw new Error('Source path collision');
  }
  const treeHash = sourceTreeHash(files);
  const expectedHash = source.tree_hash ?? source.treeHash;
  if (!/^[a-f0-9]{64}$/.test(expectedHash ?? '') || expectedHash !== treeHash) throw new Error('Source tree hash mismatch');
  return { files, tree_hash: treeHash, total_bytes: totalBytes };
}
