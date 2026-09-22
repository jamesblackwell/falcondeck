#!/usr/bin/env node
// One-request runner fixture. Its session file uses Unreal Agent's JSONL
// record shape so the ACP adapter's restart path reads native history.
import { readFileSync, mkdirSync, appendFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const args = process.argv.slice(2)
const sessions = args[args.indexOf('-session-directory') + 1]
const workspace = args[args.indexOf('-workspace') + 1]
const request = JSON.parse(readFileSync(0, 'utf8'))
if (request.prompt === 'wait') {
  process.on('SIGINT', () => {
    writeFileSync(join(workspace, 'runner-interrupted'), 'yes')
    process.exit(130)
  })
  process.stdout.write(JSON.stringify({
    Kind: 'model_response',
    Data: { Response: { Output: [{ ProviderID: 'waiting', Type: 'message', Data: { Role: 'assistant', Text: 'WAITING' } }] } },
  }) + '\n')
  setInterval(() => {}, 1000)
} else {
  if (request.prompt === 'noisy') process.stderr.write('x'.repeat(131072))
  mkdirSync(sessions, { recursive: true })
  const input = {
    Kind: 'input',
    Data: { ID: 'input-1', Kind: 'external', Payload: request.prompt },
  }
  const reply = {
    Kind: 'model_response',
    Data: {
      Response: {
        Output: [{
          ProviderID: 'reply-1',
          Type: 'message',
          Data: { Role: 'assistant', Text: `ECHO:${request.prompt}`, Phase: 'final' },
        }],
      },
    },
  }
  appendFileSync(join(sessions, `${request.session_id}.session.jsonl`),
    [input, reply].map(Item => JSON.stringify({ type: 'item', data: { Item } }) + '\n').join(''))
  process.stdout.write(JSON.stringify(input) + '\n')
  process.stdout.write(JSON.stringify(reply) + '\n')
}
