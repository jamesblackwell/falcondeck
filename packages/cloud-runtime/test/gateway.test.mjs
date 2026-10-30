import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { once } from 'node:events';
import test from 'node:test';
import { createGateway } from '../src/gateway.mjs';

const token = 'test-only-random-looking-token-with-32-bytes';

async function listen(server) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return server.address().port;
}

function trackSockets(server) {
  const sockets = new Set();
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  return async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => server.close(resolve));
  };
}

async function fixture(t, handler, options = {}) {
  const daemon = http.createServer(handler);
  const closeDaemon = trackSockets(daemon);
  const upstreamPort = await listen(daemon);
  const gateway = createGateway({ token, upstreamPort, ...options });
  const closeGateway = trackSockets(gateway);
  const port = await listen(gateway);
  t.after(async () => {
    await closeGateway();
    await closeDaemon();
  });
  return { daemon, port, upstreamPort };
}

function request(port, { path = '/api/health', headers = {}, method = 'GET', body } = {}) {
  return new Promise((resolve, reject) => {
    const outgoing = http.request({
      hostname: '127.0.0.1', port, path, headers, method, agent: false,
    }, (incoming) => {
      const chunks = [];
      incoming.on('data', (chunk) => chunks.push(chunk));
      incoming.on('end', () => resolve({
        status: incoming.statusCode, headers: incoming.headers, body: Buffer.concat(chunks).toString(),
      }));
      incoming.on('error', reject);
    });
    outgoing.on('error', reject);
    outgoing.end(body);
  });
}

function rawRequest(port, message) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1');
    let result = '';
    socket.on('connect', () => socket.write(message));
    socket.on('data', (chunk) => { result += chunk; });
    socket.on('end', () => resolve(result));
    socket.on('error', reject);
  });
}

test('rejects missing, query, malformed, and duplicate bearer credentials before daemon access', async (t) => {
  let hits = 0;
  const { port } = await fixture(t, (_req, res) => { hits += 1; res.end('private'); });
  const requests = [
    {},
    { path: `/api/health?token=${token}` },
    { headers: { authorization: `bearer ${token}` } },
    { headers: { authorization: `Bearer ${token}extra` } },
    { headers: { authorization: `Bearer  ${token}` } },
  ];
  for (const options of requests) {
    const response = await request(port, options);
    assert.equal(response.status, 401);
    assert.equal(response.headers['access-control-allow-origin'], undefined);
    assert.ok(!response.body.includes(token));
  }
  const duplicate = await rawRequest(port,
    `GET /api/health HTTP/1.1\r\nHost: example.invalid\r\nAuthorization: Bearer ${token}\r\nAuthorization: Bearer ${token}\r\n\r\n`);
  assert.match(duplicate, /^HTTP\/1\.1 401 /);
  assert.equal(hits, 0);
});

test('proxies method, body and API path while stripping bearer and proxy identity headers', async (t) => {
  let received;
  const { port, upstreamPort } = await fixture(t, async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    received = { headers: req.headers, method: req.method, path: req.url, body: Buffer.concat(chunks).toString() };
    res.writeHead(201, {
      'content-type': 'application/json', 'access-control-allow-origin': '*',
      'access-control-allow-credentials': 'true', 'set-cookie': 'private=yes',
      connection: 'x-daemon-secret', 'x-daemon-secret': 'hidden',
    });
    res.end('{"ok":true}');
  });
  const response = await request(port, {
    method: 'POST', path: '/api/workspaces/test/threads?include=all', body: '{"prompt":"hello"}',
    headers: {
      authorization: `Bearer ${token}`, origin: 'https://untrusted.invalid', cookie: 'auth=secret',
      'content-type': 'application/json', 'x-forwarded-host': 'private.internal',
      forwarded: 'for=private.internal', 'proxy-authorization': 'private',
      connection: 'x-client-secret', 'x-client-secret': 'hidden', host: 'external.invalid',
    },
  });
  assert.equal(response.status, 201);
  assert.deepEqual(JSON.parse(response.body), { ok: true });
  assert.equal(received.method, 'POST');
  assert.equal(received.path, '/api/workspaces/test/threads?include=all');
  assert.equal(received.body, '{"prompt":"hello"}');
  assert.equal(received.headers.host, `127.0.0.1:${upstreamPort}`);
  for (const name of ['authorization', 'origin', 'cookie', 'forwarded', 'proxy-authorization', 'x-forwarded-host', 'x-client-secret']) {
    assert.equal(received.headers[name], undefined, name);
  }
  for (const name of ['access-control-allow-origin', 'access-control-allow-credentials', 'set-cookie', 'x-daemon-secret']) {
    assert.equal(response.headers[name], undefined, name);
  }
  assert.equal(response.headers['cache-control'], 'no-store');
});

test('rejects non-API, absolute and ambiguous paths without changing the fixed upstream', async (t) => {
  let hits = 0;
  const { port } = await fixture(t, (_req, res) => { hits += 1; res.end(); });
  for (const path of ['https://private.internal/api/health', '//private.internal/api/health', '/api\\health', '/api/health#fragment', '/other']) {
    const response = await request(port, { path, headers: { authorization: `Bearer ${token}` } });
    assert.equal(response.status, 400, path);
  }
  const preflight = await request(port, { method: 'OPTIONS', headers: { authorization: `Bearer ${token}` } });
  assert.equal(preflight.status, 405);
  assert.equal(hits, 0);
});

test('enforces the request body ceiling for declared and chunked bodies', async (t) => {
  let hits = 0;
  const { port } = await fixture(t, (_req, res) => { hits += 1; res.end(); }, { maxBodyBytes: 8 });
  const headers = { authorization: `Bearer ${token}` };
  const declared = await request(port, { method: 'POST', headers: { ...headers, 'content-length': '9' }, body: '123456789' });
  assert.equal(declared.status, 413);
  const chunked = await request(port, { method: 'POST', headers: { ...headers, 'transfer-encoding': 'chunked' }, body: '123456789' });
  assert.equal(chunked.status, 413);
  assert.equal(hits, 0);
});

test('upstream errors expose a fixed response and do not echo request credentials', async (t) => {
  const daemon = http.createServer();
  const upstreamPort = await listen(daemon);
  await new Promise((resolve) => daemon.close(resolve));
  const gateway = createGateway({ token, upstreamPort });
  const closeGateway = trackSockets(gateway);
  const port = await listen(gateway);
  t.after(closeGateway);
  const response = await request(port, { headers: { authorization: `Bearer ${token}` } });
  assert.equal(response.status, 502);
  assert.deepEqual(JSON.parse(response.body), { error: 'Bad Gateway' });
});

test('authenticates and tunnels event/terminal WebSockets with loopback headers', async (t) => {
  const { daemon, port, upstreamPort } = await fixture(t, (_req, res) => { res.writeHead(404).end(); });
  let hits = 0;
  daemon.on('upgrade', (req, socket, head) => {
    hits += 1;
    assert.equal(req.headers.authorization, undefined);
    assert.equal(req.headers.cookie, undefined);
    assert.equal(req.headers.origin, 'tauri://localhost');
    assert.equal(req.headers.host, `127.0.0.1:${upstreamPort}`);
    // The gateway must wait for this upgrade before sending client head bytes.
    assert.equal(head.length, 0);
    socket.write('HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Accept: test\r\n\r\nfrom-daemon');
    let first = true;
    socket.on('data', (chunk) => {
      if (first) {
        assert.equal(chunk.toString(), 'initial');
        first = false;
      } else {
        socket.write(chunk);
      }
    });
  });
  for (const path of ['/api/events', '/api/terminals/terminal_123/ws']) {
    await new Promise((resolve, reject) => {
      const socket = net.connect(port, '127.0.0.1');
      let received = '';
      let sent = false;
      const timeout = setTimeout(() => { socket.destroy(); reject(new Error('No WebSocket tunnel response')); }, 2000);
      socket.on('connect', () => socket.write(
        `GET ${path} HTTP/1.1\r\nHost: public.invalid\r\nAuthorization: Bearer ${token}\r\nOrigin: https://public.invalid\r\nCookie: secret=yes\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Key: test\r\nSec-WebSocket-Version: 13\r\n\r\ninitial`));
      socket.on('error', reject);
      socket.on('data', (chunk) => {
        received += chunk;
        if (received.includes('from-daemon') && !sent) {
          sent = true;
          socket.write('client-data');
        }
        if (received.includes('client-data')) {
          clearTimeout(timeout);
          assert.match(received, /^HTTP\/1\.1 101 Switching Protocols/);
          assert.ok(!received.includes(token));
          socket.destroy();
          resolve();
        }
      });
    });
  }
  assert.equal(hits, 2);
  for (const [path, auth, status] of [
    ['/api/events', '', 401], ['/api/arbitrary/ws', `Authorization: Bearer ${token}\r\n`, 400],
  ]) {
    const response = await rawRequest(port,
      `GET ${path} HTTP/1.1\r\nHost: public.invalid\r\n${auth}Connection: Upgrade\r\nUpgrade: websocket\r\n\r\n`);
    assert.match(response, new RegExp(`^HTTP/1.1 ${status} `));
  }
  assert.equal(hits, 2);
});

test('invalid gateway credentials and upstream configuration fail closed', () => {
  assert.throws(() => createGateway({ token: 'short', upstreamPort: 1234 }));
  assert.throws(() => createGateway({ token, upstreamPort: '1234' }));
  assert.throws(() => createGateway({ token, upstreamPort: 1234, maxBodyBytes: Infinity }));
});
