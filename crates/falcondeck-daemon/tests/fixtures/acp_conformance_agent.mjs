import { createInterface } from 'node:readline'

const scenario = process.argv[2] ?? 'normal'
const sessionId = 'fixture-session-1'
let promptCount = 0
let permissionPromptId = null
let planPromptId = null
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

  if (message.id === 901 && planPromptId !== null) {
    if (message.result?.outcome === 'approved') {
      result(planPromptId, { stopReason: 'end_turn' })
    } else {
      send({
        jsonrpc: '2.0',
        id: planPromptId,
        error: { code: -32000, message: 'probe did not approve the plan' },
      })
    }
    planPromptId = null
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
    if (scenario === 'startup-banner') {
      update({
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'STARTUP_BANNER' },
      })
    }
    return
  }

  if (message.method === 'session/prompt') {
    promptCount += 1
    if (scenario === 'startup-banner' || scenario === 'empty-turn') {
      result(message.id, { stopReason: 'end_turn' })
      return
    }
    if (scenario === 'empty-stderr-error') {
      // JSON-RPC stdout first, then stderr: OpenCode's real failure mode is
      // a successful stopReason with the cause only on the error pipe.
      result(message.id, {
        stopReason: 'end_turn',
        usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
      })
      process.stderr.write(
        'timestamp=2026-06-27T15:45:21.351Z level=ERROR message="stream error" providerID=zai-coding-plan error.error="AI_APICallError: Authentication Failed"\n',
      )
      return
    }
    if (scenario === 'steer') {
      // Echoes each prompt so the test can observe delivery order. A prompt
      // containing "hold" stays open until session/cancel resolves it as
      // cancelled — the shape a steered prompt takes in the wild.
      const text = (message.params?.prompt ?? [])
        .map((block) => block.text ?? '')
        .join('')
      update({
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: `SEEN:${text}` },
      })
      // A steered prompt re-bundles the cancelled original. Only the
      // steering section (or the raw text when there is no wrapper)
      // decides whether this segment stays open for session/cancel.
      const steering = text.match(
        /<steering_messages>[\s\S]*?<\/steering_messages>/,
      )
      const holdScope = steering ? steering[0] : text
      if (holdScope.includes('hold')) {
        cancelPromptId = message.id
        return
      }
      result(message.id, { stopReason: 'end_turn' })
      return
    }
    if (scenario === 'plan-approval') {
      planPromptId = message.id
      send({
        jsonrpc: '2.0',
        id: 901,
        method: '_x.ai/exit_plan_mode',
        params: {
          sessionId,
          toolCallId: 'fixture-plan-1',
          planContent: '## Fixture plan\n\n1. Add the regression test.',
        },
      })
      return
    }
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
    update({
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: 'replayed fixture answer' },
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
