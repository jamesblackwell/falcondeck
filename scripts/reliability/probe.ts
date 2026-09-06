// Uses the production encrypted client. JSONL input is a controller API, not a bypass RPC path.
import { createInterface } from 'node:readline'
import { readFileSync } from 'node:fs'
import WebSocket from 'ws'
import { claimHostPairing, RemoteHostClient } from '../../packages/client-core/src/remote-host-client'
Object.assign(globalThis, { WebSocket })
const state = JSON.parse(readFileSync(process.argv[2], 'utf8'))
const emit = (value: object) => console.log(JSON.stringify({ at: performance.now(), ...value }))
const pairing = await fetch(state.daemon_url + '/api/remote/pairing', {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ relay_url: state.daemon_proxy_url }),
}).then(r => r.json())
const session = await claimHostPairing({ relayUrl: state.phone_url, pairingCode: pairing.pairing.pairing_code, deviceLabel: 'Reliability probe' })
const client = new RemoteHostClient(session, {
  onStatusChange: status => emit({ event: 'status', status }),
  onPresence: presence => emit({ event: 'presence', presence }),
  onEvents: events => emit({ event: 'events', count: events.length, types: events.map(e => e.event.type) }),
  onError: error => emit({ event: 'error', error }),
  onHistoryTruncated: async () => { await client.rpc('snapshot.current', {}) },
})
client.start()
createInterface({ input: process.stdin }).on('line', async line => {
  const command = JSON.parse(line)
  const start = performance.now()
  try {
    if (command.method === 'stop') { client.stop(); process.exit(0) }
    const result = await client.rpc(command.method, command.params ?? {})
    emit({ id: command.id, ok: true, duration_ms: performance.now()-start, bytes: Buffer.byteLength(JSON.stringify(result)), result })
  } catch (error) {
    emit({ id: command.id, ok: false, duration_ms: performance.now()-start, error: String(error) })
  }
})
