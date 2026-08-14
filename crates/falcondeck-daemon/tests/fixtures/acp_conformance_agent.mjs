import { createInterface } from 'node:readline'

const scenario = process.argv[2] ?? 'normal'
const sessionId = 'fixture-session-1'
let promptCount = 0
let permissionPromptId = null
let cancelPromptId = null

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`)
}

function result(id, value) {
  send({ jsonrpc: '2.0', id, result: value })
}

function update(value) {
  send({
    jsonrpc: '2.0',
    method: 'session/update',
    params: { sessionId, update: value },
  })
}

function completeToolPrompt(id) {
  update({
    sessionUpdate: 'tool_call',
    toolCallId: 'fixture-read-1',
    title: 'Read probe fixture',
    kind: 'read',
    status: 'in_progress',
  })
  update({
    sessionUpdate: 'tool_call_update',
    toolCallId: 'fixture-read-1',
    status: 'completed',
    content: [{ type: 'content', content: { type: 'text', text: 'fixture read' } }],
  })
  update({
    sessionUpdate: 'agent_message_chunk',
    content: { type: 'text', text: 'FALCONDECK_ACP_TOOL_OK' },
  })
  result(id, { stopReason: 'end_turn' })
}

const input = createInterface({ input: process.stdin, crlfDelay: Infinity })
input.on('line', (line) => {
  const message = JSON.parse(line)

  if (message.id === 900 && permissionPromptId !== null) {
    const outcome = message.result?.outcome
    if (outcome?.outcome === 'selected' && outcome.optionId === 'allow-read') {
      completeToolPrompt(permissionPromptId)
    } else {
      send({
        jsonrpc: '2.0',
        id: permissionPromptId,
        error: { code: -32000, message: 'probe did not select allow_once' },
      })
    }
    permissionPromptId = null
    return
  }

  if (message.method === 'session/cancel' && cancelPromptId !== null) {
    result(cancelPromptId, { stopReason: 'cancelled' })
    cancelPromptId = null
    return
  }

  if (message.method === 'initialize') {
    if (scenario === 'exit') process.exit(7)
    if (scenario === 'timeout') return
    if (scenario === 'malformed') {
      process.stdout.write('not-json\n')
      return
    }
    if (scenario === 'request-error') {
      send({
        jsonrpc: '2.0',
        id: message.id,
        error: { code: -32000, message: 'fixture initialize failure' },
      })
      return
    }
    result(message.id, {
      protocolVersion: scenario === 'protocol-mismatch' ? 999 : 1,
      agentInfo: { name: 'fixture-acp', title: 'Fixture ACP adapter', version: '1.0.0' },
      authMethods: [{ id: 'fixture', name: 'Fixture login', type: 'terminal' }],
      agentCapabilities: {
        loadSession: scenario !== 'no-resume',
        mcpCapabilities: { http: false, sse: false },
        promptCapabilities: { image: true },
      },
    })
    return
  }

  if (message.method === 'session/new') {
    if (scenario === 'session-new-timeout') return
    process.stderr.write('fixture adapter diagnostic\n')
    result(message.id, {
      sessionId,
      modes: {
        currentModeId: 'safe',
        availableModes: [{ id: 'safe', name: 'Safe' }],
      },
    })
    return
  }

  if (message.method === 'session/prompt') {
    promptCount += 1
    if (promptCount === 1) {
      update({ sessionUpdate: 'available_commands_update', availableCommands: [] })
      update({ sessionUpdate: 'provider_extension', fixtureValue: true })
      update({
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'FALCONDECK_ACP_TEXT_OK' },
      })
      result(message.id, { stopReason: 'end_turn' })
      return
    }
    if (promptCount === 2) {
      permissionPromptId = message.id
      send({
        jsonrpc: '2.0',
        id: 900,
        method: 'session/request_permission',
        params: {
          sessionId,
          toolCall: { toolCallId: 'fixture-read-1', title: 'Read fixture', kind: 'read' },
          options: [
            { optionId: 'deny-read', name: 'Deny', kind: 'reject_once' },
            { optionId: 'allow-read', name: 'Allow', kind: 'allow_once' },
          ],
        },
      })
      return
    }
    cancelPromptId = message.id
    update({
      sessionUpdate: 'tool_call',
      toolCallId: 'fixture-sleep-1',
      title: 'Sleep',
      kind: 'execute',
      status: 'in_progress',
    })
    return
  }

  if (message.method === 'session/load') {
    update({
      sessionUpdate: 'user_message_chunk',
      content: { type: 'text', text: 'replayed fixture prompt' },
    })
    result(message.id, { sessionId })
    return
  }

  if (message.id !== undefined) {
    send({
      jsonrpc: '2.0',
      id: message.id,
      error: { code: -32601, message: `unsupported fixture method: ${message.method}` },
    })
  }
})
