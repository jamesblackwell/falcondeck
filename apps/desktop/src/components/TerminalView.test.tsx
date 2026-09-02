import { afterEach, describe, expect, it, vi } from 'vitest'
import { render, waitFor } from '@testing-library/react'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import type { TerminalChunk, TerminalSessionInfo } from '@falcondeck/client-core'

import { TerminalChunkApplier, encodeTerminalInput, writeStatusNotice } from '../terminal-utils'
import { TerminalView } from './TerminalView'

vi.mock('@xterm/xterm', () => ({
  Terminal: class {
    cols = 80
    rows = 24
    options: Record<string, unknown> = {}
    onData = vi.fn()
    onTitleChange = vi.fn()
    onResize = vi.fn()
    loadAddon = vi.fn()
    open = vi.fn()
    write = vi.fn()
    reset = vi.fn()
    dispose = vi.fn()
  },
}))
vi.mock('@xterm/addon-fit', () => ({
  FitAddon: class {
    fit = vi.fn()
  },
}))
vi.mock('@xterm/addon-webgl', () => ({
  WebglAddon: class {
    onContextLoss = vi.fn()
    dispose = vi.fn()
  },
}))

const fakeSession = {
  id: 'term-test',
  workspace_id: 'ws',
  shell: '/bin/zsh',
  title: 'zsh',
  cwd: '/tmp',
  cols: 80,
  rows: 24,
  created_at: '2026-08-27T12:00:00Z',
} as TerminalSessionInfo

class FakeSocket {
  static instances: FakeSocket[] = []
  sent: string[] = []
  closed = false
  onopen: (() => void) | null = null
  onmessage: ((event: { data: string }) => void) | null = null
  onclose: (() => void) | null = null
  onerror: (() => void) | null = null
  constructor(public url: string) {
    FakeSocket.instances.push(this)
  }
  send(data: string) {
    this.sent.push(data)
  }
  close() {
    this.closed = true
  }
  open() {
    this.onopen?.()
  }
  receive(frame: unknown) {
    this.onmessage?.({ data: JSON.stringify(frame) })
  }
  drop() {
    this.onclose?.()
  }
}

afterEach(() => {
  FakeSocket.instances = []
})

describe('TerminalView styles', () => {
  it('loads the xterm stylesheet that hides and positions its keyboard textarea', () => {
    const appStyles = readFileSync(resolve(process.cwd(), 'src/index.css'), 'utf8')
    expect(appStyles).toContain('@import "@xterm/xterm/css/xterm.css"')
  })
})

describe('TerminalView socket lifecycle', () => {
  it('stops reconnecting once the session has exited', async () => {
    const onExited = vi.fn()
    render(
      <TerminalView
        session={fakeSession}
        socketUrl="ws://127.0.0.1:4123/api/terminals/term-test/ws"
        onExited={onExited}
        onTitleChange={vi.fn()}
        createSocket={(url) => new FakeSocket(url) as unknown as WebSocket}
      />,
    )
    await waitFor(() => expect(FakeSocket.instances).toHaveLength(1))
    const socket = FakeSocket.instances[0]
    socket.open()
    socket.receive({
      type: 'terminal_attached',
      session: fakeSession,
      next_seq: 0,
    })
    socket.receive({ type: 'terminal_output', chunk: { seq: 0, data_base64: btoa('hi') } })
    socket.receive({ type: 'terminal_exited', exit_code: 42 })
    socket.drop()

    // A full reconnect cycle plus margin: no second socket may ever appear.
    await new Promise((resolve) => setTimeout(resolve, 1300))
    expect(FakeSocket.instances).toHaveLength(1)
    expect(onExited).toHaveBeenCalledWith(42)
  })
})

function chunk(seq: number, text: string): { type: 'terminal_output'; chunk: TerminalChunk } {
  return {
    type: 'terminal_output',
    chunk: { seq, data_base64: btoa(text) },
  }
}

function replayChunk(seq: number, text: string): { type: 'terminal_replay'; chunk: TerminalChunk } {
  return {
    type: 'terminal_replay',
    chunk: { seq, data_base64: btoa(text) },
  }
}

function fakeTerminal() {
  return {
    writes: [] as string[],
    reset: vi.fn(),
    write(data: string | Uint8Array, _callback?: () => void) {
      this.writes.push(typeof data === 'string' ? data : new TextDecoder().decode(data))
      _callback?.()
    },
  }
}

describe('encodeTerminalInput', () => {
  it('passes keystrokes through as base64 of the UTF-8 bytes', () => {
    expect(encodeTerminalInput('ls\n')).toEqual([btoa('ls\n')])
    expect(encodeTerminalInput('héllo')).toEqual([btoa(new TextEncoder().encode('héllo').reduce((s, b) => s + String.fromCharCode(b), ''))])
  })

  it('splits oversized pastes into chunked frames', () => {
    const huge = 'x'.repeat(64 * 1024 + 1)
    const chunks = encodeTerminalInput(huge)
    expect(chunks).toHaveLength(2)
    expect(atob(chunks[0])).toHaveLength(64 * 1024)
    expect(atob(chunks[1])).toHaveLength(1)
  })
})

describe('writeStatusNotice', () => {
  it('writes dim, newline-surrounded status text', () => {
    const terminal = fakeTerminal()
    writeStatusNotice(terminal, 'Terminal exited')
    expect(terminal.writes).toEqual(['\r\n\x1b[2mTerminal exited\x1b[0m\r\n'])
  })
})

describe('TerminalChunkApplier', () => {
  it('applies contiguous live output in order', () => {
    const terminal = fakeTerminal()
    const applier = new TerminalChunkApplier(terminal, vi.fn())
    applier.apply(chunk(0, 'hello '))
    applier.apply(chunk(1, 'world'))
    expect(terminal.writes).toEqual(['hello ', 'world'])
    expect(applier.lastSeq).toBe(1)
    expect(applier.replayDepth).toBe(0)
  })

  it('drops duplicate or stale chunks', () => {
    const terminal = fakeTerminal()
    const applier = new TerminalChunkApplier(terminal, vi.fn())
    applier.apply(chunk(3, 'a'))
    applier.apply(chunk(3, 'a'))
    applier.apply(chunk(2, 'old'))
    expect(terminal.writes).toEqual(['a'])
    expect(applier.lastSeq).toBe(3)
  })

  it('applies replay chunks without forwarding input and then continues live', () => {
    const terminal = fakeTerminal()
    const applier = new TerminalChunkApplier(terminal, vi.fn())
    applier.apply(replayChunk(0, 'old bytes'))
    expect(applier.replayDepth).toBe(0)
    applier.apply(chunk(1, 'live'))
    expect(terminal.writes).toEqual(['old bytes', 'live'])
  })

  it('resets the emulator when a sequence gap proves output was pruned', () => {
    const terminal = fakeTerminal()
    const onNotice = vi.fn()
    const applier = new TerminalChunkApplier(terminal, onNotice)
    applier.apply(chunk(0, 'early'))
    applier.apply(chunk(9, 'after gap'))
    expect(terminal.reset).toHaveBeenCalledTimes(1)
    expect(onNotice).toHaveBeenCalledWith('Some terminal output was unavailable')
    expect(terminal.writes).toEqual(['early', 'after gap'])
    expect(applier.lastSeq).toBe(9)
  })

  it('resumes continuity after a reset-producing gap', () => {
    const terminal = fakeTerminal()
    const applier = new TerminalChunkApplier(terminal, vi.fn())
    applier.apply(chunk(0, 'a'))
    applier.apply(chunk(5, 'b'))
    applier.apply(chunk(6, 'c'))
    expect(terminal.reset).toHaveBeenCalledTimes(1)
    expect(terminal.writes).toEqual(['a', 'b', 'c'])
  })

  it('ignores frames that are not output or replay', () => {
    const terminal = fakeTerminal()
    const applier = new TerminalChunkApplier(terminal, vi.fn())
    applier.apply({ type: 'terminal_attached', session: {} as never, next_seq: 0 })
    applier.apply({ type: 'terminal_pong' })
    expect(terminal.writes).toEqual([])
    expect(applier.lastSeq).toBeNull()
  })
})
