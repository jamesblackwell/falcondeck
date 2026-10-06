import { createInterface } from 'node:readline'
import { readFileSync } from 'node:fs'

const recorded = JSON.parse(readFileSync(new URL('./hermes_acp.json', import.meta.url)))
const diffPermissions = new Set()

const sessions = new Map()
const prompts = new Map()
const permissions = new Map()
const responses = []
let sessionCount = 0
let promptCount = 0
const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`)
const result = (id, value) => send({ jsonrpc: '2.0', id, result: value })
const update = (sessionId, value) => send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId, update: value } })
const permission = (sessionId, id) => send({
  jsonrpc: '2.0', id, method: 'session/request_permission', params: {
    sessionId, toolCall: { title: 'Edit fixture', kind: 'edit' }, options: [
      { optionId: `${sessionId}:a`, name: 'Reject', kind: 'allow_once' },
      { optionId: `${sessionId}:b`, name: 'Allow once', kind: 'allow_always' },
      { optionId: `${sessionId}:c`, name: 'Always allow', kind: 'reject_once' },
      { optionId: `${sessionId}:d`, name: 'Allow matching commands permanently', kind: 'allow_always' },
    ],
  },
})

createInterface({ input: process.stdin, crlfDelay: Infinity }).on('line', (line) => {
  const m = JSON.parse(line)
  if (!m.method) {
    responses.push(m)
    const sessionId = permissions.get(m.id)
    const promptId = prompts.get(sessionId)
    if (promptId) {
      if (diffPermissions.delete(sessionId)) {
        update(sessionId, { sessionUpdate: 'tool_call_update', toolCallId: 'toolCallId-6',
          status: m.result?.outcome?.optionId === 'allow_once' ? 'completed' : 'failed' })
      }
      prompts.delete(sessionId)
      result(promptId, { stopReason: 'end_turn' })
    }
    return
  }
  const sessionId = m.params?.sessionId
  if (m.method === 'initialize') {
    result(m.id, { protocolVersion: 1, agentCapabilities: { loadSession: true, promptCapabilities: { image: true } } })
  } else if (m.method === 'session/new') {
    const id = `hermes-${++sessionCount}`
    sessions.set(id, { model: 'openai-codex:gpt-5.6-luna', mode: 'default' })
    result(m.id, {
      sessionId: id,
      models: { currentModelId: 'openai-codex:gpt-5.6-luna', availableModels: [
        { modelId: 'openai-codex:gpt-5.6-luna', name: 'Luna' },
        { modelId: 'custom:Team Endpoint:model/v1', name: 'Team endpoint' },
      ] },
      modes: { currentModeId: 'default', availableModes: [
        { id: 'default', name: 'Default' }, { id: 'accept_edits', name: 'Accept Edits' }, { id: 'dont_ask', name: "Don't Ask" },
      ] },
    })
    update(id, { sessionUpdate: 'available_commands_update', availableCommands: [{ name: 'model' }, { name: 'compress' }, { name: 'extra' }] })
  } else if (m.method === 'session/set_model') {
    if (m.params.modelId === 'invalid:model') {
      send({ jsonrpc: '2.0', id: m.id, error: { code: -32602, message: 'Rejected model', data: { details: 'invalid modelId' } } })
    } else {
      sessions.get(sessionId).model = m.params.modelId
      result(m.id, {})
    }
  } else if (m.method === 'session/set_mode') {
    sessions.get(sessionId).mode = m.params.modeId
    result(m.id, {})
  } else if (m.method === 'session/prompt') {
    promptCount++
    const text = m.params.prompt.find((b) => b.type === 'text')?.text ?? ''
    if (text === 'diff-permission') {
      prompts.set(sessionId, m.id)
      diffPermissions.add(sessionId)
      const id = `permission:${sessionId}`
      permissions.set(id, sessionId)
      update(sessionId, { sessionUpdate: 'tool_call', toolCallId: 'toolCallId-6', kind: 'edit', title: 'write_file' })
      send({ ...recorded.permission, id, params: { ...recorded.permission.params, sessionId } })
    } else if (text === 'wait' || text === 'permission' || text === 'timeout' || text === 'disconnect') {
      prompts.set(sessionId, m.id)
      update(sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'STARTED' } })
      if (text !== 'wait') {
        const id = `permission:${sessionId}`
        permissions.set(id, sessionId)
        permission(sessionId, id)
      }
      if (text === 'timeout') setTimeout(() => { prompts.delete(sessionId); result(m.id, { stopReason: 'end_turn' }) }, 100)
      if (text === 'disconnect') setTimeout(() => process.exit(7), 100)
    } else if (text === 'error') {
      update(sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'STARTED' } })
      setTimeout(() => {
        result(m.id, { stopReason: 'end_turn' })
        process.stderr.write('[ERROR] Non-retryable client error: HTTP 400 unsupported model\n')
      }, 100)
    } else {
      update(sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: JSON.stringify({ ...sessions.get(sessionId), prompt: m.params.prompt }) } })
      result(m.id, { stopReason: 'end_turn' })
    }
  } else if (m.method === 'session/cancel') {
    const id = prompts.get(sessionId)
    if (id) {
      prompts.delete(sessionId)
      result(id, { stopReason: 'cancelled' })
      permission(sessionId, `late:${sessionId}`)
    }
  } else if (m.method === 'probe/state') {
    result(m.id, { promptCount, responses })
  } else if (m.id !== undefined) result(m.id, {})
})
