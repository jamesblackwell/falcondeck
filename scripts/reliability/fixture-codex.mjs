#!/usr/bin/env node
// Test-only app-server fixture. Never calls a model or reads native agent history.
import { createInterface } from 'node:readline'
import { appendFileSync, existsSync, readFileSync, writeFileSync, openSync, closeSync, unlinkSync, renameSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
if (process.argv.includes('--version')) { console.log('codex-cli 0.150.0'); process.exit(0) }
if (process.argv.includes('login')) { console.log('Logged in using fixture'); process.exit(0) }
const root = process.env.FALCONDECK_LAB_ROOT
if (!root) throw new Error('FALCONDECK_LAB_ROOT is required')
const path = join(process.cwd(), '.lab-threads.json')
let threads = []
const send = value => process.stdout.write(JSON.stringify(value) + '\n')
const notify = (method, params) => send({ method, params })
const save = () => {
  const temporary = `${path}.${process.pid}.tmp`
  writeFileSync(temporary, JSON.stringify(threads)); renameSync(temporary, path)
}
const ledger = entry => appendFileSync(join(root, 'ledger.jsonl'), JSON.stringify({ at: Date.now(), ...entry }) + '\n')
// The daemon may open a metadata and a conversation app-server for one workspace.
// Keep their fixture history coherent rather than manufacturing lost-message bugs.
function lock() {
  const deadline = Date.now() + 10000
  while (true) {
    try {
      const fd = openSync(`${path}.lock`, 'wx')
      writeFileSync(fd, String(process.pid)); closeSync(fd)
      return
    } catch (error) {
      if (error.code !== 'EEXIST') throw error
      try {
        const owner = Number(readFileSync(`${path}.lock`, 'utf8'))
        if (owner > 0) {
          try { process.kill(owner, 0) }
          catch (failure) { if (failure.code === 'ESRCH') unlinkSync(`${path}.lock`) }
        }
      } catch (failure) { if (failure.code !== 'ENOENT') throw failure }
      if (Date.now() > deadline) throw new Error('Fixture history lock timed out')
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10)
    }
  }
}
createInterface({ input: process.stdin }).on('line', line => {
  const { id, method, params = {} } = JSON.parse(line)
  if (id === undefined) return
  lock()
  try {
  threads = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : []
  ledger({ stage: 'harness.received', method })
  let result = {}
  const thread = threads.find(t => t.id === params.threadId)
  switch (method) {
    case 'initialize': result = { userAgent: 'falcondeck-lab/1' }; break
    case 'account/read': result = { account: { type: 'apiKey' }, requiresOpenaiAuth: false }; break
    case 'model/list': result = { data: [{ id: 'lab-model', displayName: 'Lab deterministic', isDefault: true, supportedReasoningEfforts: [] }] }; break
    case 'thread/list': result = { data: threads.map(({ turns, ...summary }) => summary), nextCursor: null }; break
    case 'thread/start': {
      const created = { id: randomUUID(), cwd: process.cwd(), preview: 'Lab conversation', name: 'Lab conversation', createdAt: Math.floor(Date.now()/1000), updatedAt: Math.floor(Date.now()/1000), turns: [], status: { type: 'idle' } }
      threads.push(created); save(); result = { thread: created, model: 'lab-model' }; break
    }
    case 'thread/read': case 'thread/resume':
      if (!thread) { send({ id, error: { code: -32602, message: 'Unknown lab thread' } }); return }
      result = { thread, model: 'lab-model' }; break
    case 'turn/start': {
      if (!thread) { send({ id, error: { code: -32602, message: 'Unknown lab thread' } }); return }
      const text = (params.input ?? []).map(i => i.text ?? '').join('')
      const operation = text.match(/LAB-[a-zA-Z0-9-]+/)?.[0] ?? 'unlabelled'
      const turn = { id: randomUUID(), status: 'inProgress', items: [{ type: 'userMessage', id: randomUUID(), content: [{ type: 'inputText', text }] }] }
      thread.turns.push(turn); save()
      ledger({ stage: 'execution', operation, threadId: thread.id, turnId: turn.id })
      send({ id, result: { turn } })
      notify('turn/started', { threadId: thread.id, turn })
      const item = { type: 'agentMessage', id: randomUUID(), text: `RECEIVED ${operation}` }
      notify('item/started', { threadId: thread.id, turnId: turn.id, item: { ...item, text: '' } })
      notify('item/agentMessage/delta', { threadId: thread.id, turnId: turn.id, itemId: item.id, delta: item.text })
      turn.items.push(item); turn.status = 'completed'; save()
      notify('item/completed', { threadId: thread.id, turnId: turn.id, item })
      notify('turn/completed', { threadId: thread.id, turn }); return
    }
    case 'skills/list': result = { data: [] }; break
    case 'collaborationMode/list': result = { data: [] }; break
    case 'turn/interrupt': result = {}; break
    default:
      if (!['skills/extraRoots/set', 'config/read', 'config/mcpServer/reload'].includes(method)) {
        send({ id, error: { code: -32601, message: `Fixture does not implement ${method}` } }); return
      }
  }
  send({ id, result })
  } finally { unlinkSync(`${path}.lock`) }
})
