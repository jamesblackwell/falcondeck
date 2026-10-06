// A native-store ACP fixture: handles survive processes, message ids are
// absent like Hermes replay, and compression rotates only the internal head.
import { createInterface } from 'node:readline'
import { readFileSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'

const store = process.env.HERMES_FIXTURE_STORE
const native = () => { try { return JSON.parse(readFileSync(store, 'utf8')) } catch { return {} } }
const save = (sessions) => writeFileSync(store, JSON.stringify(sessions))
const loaded = new Map()
const requests = []
const send = (value) => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...value })}\n`)
const result = (id, value) => send({ id, result: value })
const update = (sessionId, value) => send({ method: 'session/update', params: { sessionId, update: value } })
const text = (sessionId, kind, value) => update(sessionId, { sessionUpdate: kind, content: { type: 'text', text: value } })
const metadata = () => ({
  models: { currentModelId: 'openai-codex:gpt-5.6-luna', availableModels: [{ modelId: 'openai-codex:gpt-5.6-luna', name: 'Luna' }] },
  modes: { currentModeId: 'default', availableModes: [{ id: 'default', name: 'Default' }] },
})
const tool = (sessionId, n) => {
  update(sessionId, { sessionUpdate: 'tool_call', toolCallId: `tool-${n}`, title: 'Identity', kind: 'read', status: 'in_progress' })
  update(sessionId, { sessionUpdate: 'tool_call_update', toolCallId: `tool-${n}`, status: 'completed', content: [{ type: 'content', content: { type: 'text', text: `result-${n}` } }] })
}
const replay = (sessionId, history) => {
  for (let n = 0; n < history.length; n++) {
    text(sessionId, 'user_message_chunk', history[n])
    tool(sessionId, n)
    text(sessionId, 'agent_message_chunk', `reply-${n}`)
  }
}

createInterface({ input: process.stdin, crlfDelay: Infinity }).on('line', (line) => {
  const m = JSON.parse(line)
  if (!m.method) return
  requests.push(m)
  const sid = m.params?.sessionId
  if (m.method === 'initialize') result(m.id, { protocolVersion: 1, agentCapabilities: { loadSession: true } })
  else if (m.method === 'session/new') {
    const sid = `acp-${randomUUID()}`
    const sessions = native()
    sessions[sid] = { head: sid, history: [] }
    save(sessions)
    loaded.set(sid, m.params.mcpServers)
    result(m.id, { sessionId: sid, ...metadata() })
    update(sid, { sessionUpdate: 'available_commands_update', availableCommands: [{ name: 'compress' }] })
  } else if (m.method === 'session/load') {
    const sessions = native()
    if (!sessions[sid]) return send({ id: m.id, error: { code: -32602, message: 'Native session is unavailable' } })
    loaded.set(sid, m.params.mcpServers)
    replay(sid, sessions[sid].history)
    update(sid, { sessionUpdate: 'session_info_update', title: 'Native title', _meta: { hermes: { sessionProvenance: { acpSessionId: sid, currentHermesSessionId: sessions[sid].head } } } })
    result(m.id, metadata())
  } else if (m.method === 'session/set_model' || m.method === 'session/set_mode') result(m.id, {})
  else if (m.method === 'session/prompt') {
    const sessions = native()
    const body = m.params.prompt.filter((p) => p.type === 'text').map((p) => p.text).join('\n')
    const session = sessions[sid]
    if (body === '/compress') {
      session.head = `head-${randomUUID()}`
      update(sid, { sessionUpdate: 'session_info_update', _meta: { hermes: { sessionProvenance: { acpSessionId: sid, currentHermesSessionId: session.head } } } })
      text(sid, 'agent_message_chunk', 'Compressed')
    } else {
      const n = session.history.length
      session.history.push(body)
      text(sid, 'user_message_chunk', body)
      tool(sid, n)
      text(sid, 'agent_message_chunk', `reply-${n}`)
    }
    save(sessions)
    result(m.id, { stopReason: 'end_turn' })
  } else if (m.method === 'probe/seed') {
    const sessions = native()
    sessions[sid].history = Array.from({ length: m.params.count }, (_, n) => m.params.repeated ? 'again' : `native-user-${n}`)
    save(sessions)
    result(m.id, {})
  } else if (m.method === 'probe/state') result(m.id, { pid: process.pid, loaded: Object.fromEntries(loaded), requests, sessions: native() })
  else if (m.id !== undefined) result(m.id, {})
})
