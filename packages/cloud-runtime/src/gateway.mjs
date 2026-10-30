import { timingSafeEqual } from 'node:crypto';
import { lstat, readFile, realpath } from 'node:fs/promises';
import http from 'node:http';
import { fileURLToPath } from 'node:url';

const HOP_HEADERS = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailer', 'transfer-encoding', 'upgrade',
]);
const PRIVATE_HEADERS = new Set([
  'authorization', 'cookie', 'forwarded', 'origin', 'referer', 'host', 'x-real-ip',
]);
const METHODS = new Set(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE']);

function headersWithoutHopHeaders(headers) {
  const blocked = new Set(HOP_HEADERS);
  for (const name of String(headers.connection ?? '').split(',')) {
    blocked.add(name.trim().toLowerCase());
  }
  return Object.fromEntries(Object.entries(headers).filter(([name]) => !blocked.has(name)));
}

function upstreamHeaders(request, port, upgrade = false) {
  const headers = headersWithoutHopHeaders(request.headers);
  for (const name of Object.keys(headers)) {
    if (PRIVATE_HEADERS.has(name) || name.startsWith('x-forwarded-') || name.startsWith('proxy-')) {
      delete headers[name];
    }
  }
  headers.host = `127.0.0.1:${port}`;
  // The bearer capability authenticates this gateway hop. The existing daemon
  // still requires its local webview origin before upgrading a WebSocket.
  if (upgrade) {
    headers.origin = 'tauri://localhost';
    headers.connection = 'Upgrade';
    headers.upgrade = 'websocket';
  }
  return headers;
}

function responseHeaders(headers) {
  const clean = headersWithoutHopHeaders(headers);
  for (const name of Object.keys(clean)) {
    if (name.startsWith('access-control-') || name === 'set-cookie') delete clean[name];
  }
  clean['cache-control'] = 'no-store';
  return clean;
}

function authorized(request, expected) {
  // Node coalesces/discards some duplicate headers. Inspect raw headers so an
  // intermediary cannot disagree with us about which credential was supplied.
  let count = 0;
  for (let index = 0; index < request.rawHeaders.length; index += 2) {
    if (request.rawHeaders[index].toLowerCase() === 'authorization') count += 1;
  }
  const value = request.headers.authorization;
  if (count !== 1 || typeof value !== 'string' || !value.startsWith('Bearer ')) return false;
  const supplied = Buffer.from(value.slice(7));
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

function validPath(path) {
  return typeof path === 'string'
    && /^\/api(?:\/|\?|$)/.test(path)
    && !/[\\#\u0000-\u0020\u007f]/.test(path);
}

function websocketPath(path) {
  const pathname = path.split('?', 1)[0];
  return pathname === '/api/events' || /^\/api\/terminals\/[A-Za-z0-9_-]+\/ws$/.test(pathname);
}

function rejectHttp(response, status) {
  response.writeHead(status, {
    'content-type': 'application/json', 'cache-control': 'no-store', connection: 'close',
  });
  response.end(JSON.stringify({ error: http.STATUS_CODES[status] }));
}

function rejectSocket(socket, status) {
  socket.on('error', () => {});
  socket.end(`HTTP/1.1 ${status} ${http.STATUS_CODES[status]}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
}

/** A single fixed upstream; no request field can select a destination host. */
export function createGateway({
  token, upstreamPort, maxBodyBytes = 56 * 1024 * 1024, requestTimeoutMs = 30_000,
} = {}) {
  if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{32,256}$/.test(token)) {
    throw new Error('Gateway requires a random URL-safe bearer token');
  }
  if (!Number.isInteger(upstreamPort) || upstreamPort < 1 || upstreamPort > 65535) {
    throw new Error('Invalid daemon port');
  }
  if (!Number.isSafeInteger(maxBodyBytes) || maxBodyBytes < 1 || maxBodyBytes > 64 * 1024 * 1024
      || !Number.isInteger(requestTimeoutMs) || requestTimeoutMs < 1 || requestTimeoutMs > 300_000) {
    throw new Error('Invalid gateway limits');
  }
  const expected = Buffer.from(token);
  const server = http.createServer(async (request, response) => {
    if (!authorized(request, expected)) return rejectHttp(response, 401);
    if (!validPath(request.url)) return rejectHttp(response, 400);
    if (!METHODS.has(request.method)) return rejectHttp(response, 405);
    const length = request.headers['content-length'];
    if (length !== undefined && (!/^\d+$/.test(length) || Number(length) > maxBodyBytes)) {
      return rejectHttp(response, 413);
    }
    const chunks = [];
    let size = 0;
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      rejectHttp(response, 408);
      request.destroy();
    }, requestTimeoutMs);
    timer.unref();
    try {
      for await (const chunk of request) {
        size += chunk.length;
        if (size > maxBodyBytes) {
          clearTimeout(timer);
          rejectHttp(response, 413);
          return;
        }
        chunks.push(chunk);
      }
    } catch {
      if (!timedOut && !response.destroyed) rejectHttp(response, 400);
      return;
    } finally {
      clearTimeout(timer);
    }
    if (timedOut || response.destroyed) return;
    const headers = upstreamHeaders(request, upstreamPort);
    delete headers['content-length'];
    headers['content-length'] = String(size);
    const upstream = http.request({
      hostname: '127.0.0.1', port: upstreamPort, method: request.method,
      path: request.url, headers, agent: false,
    }, (upstreamResponse) => {
      response.writeHead(upstreamResponse.statusCode ?? 502, responseHeaders(upstreamResponse.headers));
      upstreamResponse.on('error', () => response.destroy());
      upstreamResponse.pipe(response);
    });
    upstream.setTimeout(requestTimeoutMs, () => upstream.destroy(new Error('timeout')));
    upstream.on('error', () => {
      if (!response.headersSent) rejectHttp(response, 502);
      else response.destroy();
    });
    response.on('close', () => upstream.destroy());
    upstream.end(Buffer.concat(chunks, size));
  });
  server.requestTimeout = requestTimeoutMs;
  server.headersTimeout = Math.min(requestTimeoutMs, 15_000);
  server.keepAliveTimeout = 5_000;
  server.maxHeadersCount = 100;
  server.on('connect', (_request, socket) => rejectSocket(socket, 405));
  server.on('upgrade', (request, client, head) => {
    if (!authorized(request, expected)) return rejectSocket(client, 401);
    if (!validPath(request.url) || !websocketPath(request.url)) return rejectSocket(client, 400);
    if (request.method !== 'GET' || request.headers.upgrade?.toLowerCase() !== 'websocket') {
      return rejectSocket(client, 400);
    }
    const upstream = http.request({
      hostname: '127.0.0.1', port: upstreamPort, method: 'GET', path: request.url,
      headers: upstreamHeaders(request, upstreamPort, true), agent: false,
    });
    const timer = setTimeout(() => {
      upstream.destroy();
      rejectSocket(client, 504);
    }, requestTimeoutMs);
    timer.unref();
    let remote;
    client.on('error', () => { upstream.destroy(); remote?.destroy(); });
    client.on('close', () => { clearTimeout(timer); upstream.destroy(); remote?.destroy(); });
    upstream.on('upgrade', (reply, socket, upstreamHead) => {
      clearTimeout(timer);
      remote = socket;
      const headers = responseHeaders(reply.headers);
      headers.connection = 'Upgrade';
      headers.upgrade = 'websocket';
      const lines = Object.entries(headers).flatMap(([name, values]) =>
        (Array.isArray(values) ? values : [values]).map((value) => `${name}: ${value}\r\n`));
      client.write(`HTTP/1.1 101 Switching Protocols\r\n${lines.join('')}\r\n`);
      if (upstreamHead.length) client.write(upstreamHead);
      if (head.length) socket.write(head);
      socket.on('error', () => client.destroy());
      socket.on('close', () => client.destroy());
      client.pipe(socket).pipe(client);
    });
    upstream.on('response', (reply) => {
      clearTimeout(timer);
      reply.resume();
      rejectSocket(client, reply.statusCode ?? 502);
    });
    upstream.on('error', () => {
      clearTimeout(timer);
      if (!client.destroyed) rejectSocket(client, 502);
    });
    upstream.end();
  });
  return server;
}

async function main() {
  const configPath = process.argv[2];
  if (!configPath || process.argv.length !== 3) throw new Error('Expected a private config file path');
  const metadata = await lstat(configPath);
  if (!metadata.isFile() || (metadata.mode & 0o077) !== 0 || metadata.size > 64 * 1024
      || (process.getuid && metadata.uid !== process.getuid())) {
    throw new Error('Gateway configuration must be an owner-only regular file');
  }
  const config = JSON.parse(await readFile(configPath, 'utf8'));
  const port = config.port ?? 3000;
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid gateway port');
  const server = createGateway(config);
  server.listen(port, '0.0.0.0');
  server.on('error', () => { process.exitCode = 1; });
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => {
      server.close();
      setTimeout(() => process.exit(0), 2000).unref();
    });
  }
}

if (process.argv[1] && await realpath(process.argv[1]).catch(() => '') === fileURLToPath(import.meta.url)) {
  main().catch(() => {
    // Configuration may contain credentials: never print the parser/error text.
    process.stderr.write('Gateway startup failed\n');
    process.exitCode = 1;
  });
}
