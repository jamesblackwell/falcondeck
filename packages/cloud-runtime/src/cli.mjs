#!/usr/bin/env node
import { realpath } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { CloudRuntimeError, defaultAdapter } from './adapter.mjs';

export async function runCli({ input = process.stdin, output = process.stdout, adapterFactory = defaultAdapter } = {}) {
  try {
    let bytes = 0;
    const chunks = [];
    for await (const chunk of input) {
      bytes += Buffer.byteLength(chunk);
      if (bytes > 64 * 1024 * 1024) throw new CloudRuntimeError('invalid_request', 'Request exceeds the source transport limit');
      chunks.push(Buffer.from(chunk));
    }
    let request;
    try { request = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
    catch { throw new CloudRuntimeError('invalid_request', 'Expected one JSON request on standard input'); }
    if (!request || !['create', 'inspect', 'resume', 'export', 'stop', 'delete'].includes(request.operation)) throw new CloudRuntimeError('invalid_request', 'Unsupported cloud operation');
    const adapter = await adapterFactory();
    const result = await adapter[request.operation](request);
    output.write(`${JSON.stringify(result)}\n`);
    return 0;
  } catch (error) {
    const safe = error instanceof CloudRuntimeError ? error : new CloudRuntimeError('runtime_failed', 'Cloud runtime operation failed');
    output.write(`${JSON.stringify({ error: { code: safe.code, message: safe.message, ...(safe.sandbox_id ? { sandbox_id: safe.sandbox_id } : {}) } })}\n`);
    return 1;
  }
}

if (process.argv[1] && await realpath(process.argv[1]).catch(() => '') === fileURLToPath(import.meta.url)) process.exitCode = await runCli();
