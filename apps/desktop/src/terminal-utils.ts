import type { TerminalChunk, TerminalServerFrame } from '@falcondeck/client-core'

export const TERMINAL_FONT_FAMILY =
  '"Geist Mono", "SF Mono", "JetBrains Mono", ui-monospace, monospace'

export const TERMINAL_FONT_SIZE = 12
export const FALLBACK_TERMINAL_COLS = 80
export const FALLBACK_TERMINAL_ROWS = 24

/** Cap input writes at the daemon's per-frame chunk budget. */
const MAX_INPUT_CHUNK_BYTES = 64 * 1024

/** Matches `TERMINAL_WIRE_*` in `crates/falcondeck-core/src/terminal.rs`. */
export const TERMINAL_WIRE_REPLAY = 1
export const TERMINAL_WIRE_OUTPUT = 2
export const TERMINAL_WIRE_INPUT = 0x10

const FLOW_BYTES_THRESHOLD = 128 * 1024
const FLOW_HIGH_WATER = 10

export function encodeTerminalInput(value: string): string[] {
  const bytes = new TextEncoder().encode(value)
  const chunks: string[] = []
  for (let offset = 0; offset < bytes.byteLength; offset += MAX_INPUT_CHUNK_BYTES) {
    const slice = bytes.subarray(offset, Math.min(offset + MAX_INPUT_CHUNK_BYTES, bytes.byteLength))
    chunks.push(bytesToBase64(slice))
  }
  return chunks
}

export function encodeTerminalInputBinary(value: string): Uint8Array[] {
  const bytes = new TextEncoder().encode(value)
  const chunks: Uint8Array[] = []
  for (let offset = 0; offset < bytes.byteLength; offset += MAX_INPUT_CHUNK_BYTES) {
    const slice = bytes.subarray(offset, Math.min(offset + MAX_INPUT_CHUNK_BYTES, bytes.byteLength))
    const payload = new Uint8Array(1 + slice.byteLength)
    payload[0] = TERMINAL_WIRE_INPUT
    payload.set(slice, 1)
    chunks.push(payload)
  }
  return chunks
}

export function decodeTerminalChunk(dataBase64: string): Uint8Array {
  const binary = atob(dataBase64)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index)
  }
  return bytes
}

export function decodeOutputWire(data: ArrayBuffer): {
  replay: boolean
  seq: number
  bytes: Uint8Array
} | null {
  if (data.byteLength < 9) return null
  const view = new DataView(data)
  const kind = view.getUint8(0)
  if (kind !== TERMINAL_WIRE_REPLAY && kind !== TERMINAL_WIRE_OUTPUT) return null
  return {
    replay: kind === TERMINAL_WIRE_REPLAY,
    seq: Number(view.getBigUint64(1, true)),
    bytes: new Uint8Array(data, 9),
  }
}

export function encodeOutputWire(replay: boolean, seq: number, bytes: Uint8Array): Uint8Array {
  const out = new Uint8Array(9 + bytes.byteLength)
  out[0] = replay ? TERMINAL_WIRE_REPLAY : TERMINAL_WIRE_OUTPUT
  new DataView(out.buffer).setBigUint64(1, BigInt(seq), true)
  out.set(bytes, 9)
  return out
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
}

type TerminalCssColorReader = (name: string) => string | undefined

/**
 * Mirrors the app palette into xterm. The renderer bakes colors once, so the
 * theme object must be rebuilt (not mutated) whenever the app theme changes.
 */
export function buildTerminalThemeFromCssColors(get: TerminalCssColorReader) {
  return {
    background: get('--terminal-bg'),
    foreground: get('--terminal-fg'),
    cursor: get('--terminal-cursor'),
    cursorAccent: get('--terminal-bg'),
    selectionBackground: get('--terminal-selection'),
    black: get('--terminal-ansi-0'),
    red: get('--terminal-ansi-1'),
    green: get('--terminal-ansi-2'),
    yellow: get('--terminal-ansi-3'),
    blue: get('--terminal-ansi-4'),
    magenta: get('--terminal-ansi-5'),
    cyan: get('--terminal-ansi-6'),
    white: get('--terminal-ansi-7'),
    brightBlack: get('--terminal-ansi-8'),
    brightRed: get('--terminal-ansi-9'),
    brightGreen: get('--terminal-ansi-10'),
    brightYellow: get('--terminal-ansi-11'),
    brightBlue: get('--terminal-ansi-12'),
    brightMagenta: get('--terminal-ansi-13'),
    brightCyan: get('--terminal-ansi-14'),
    brightWhite: get('--terminal-ansi-15'),
  }
}

export function readTerminalTheme() {
  if (typeof document === 'undefined') return {}
  const probe = document.createElement('span')
  probe.style.position = 'absolute'
  probe.style.visibility = 'hidden'
  probe.style.pointerEvents = 'none'
  document.body.appendChild(probe)
  const style = getComputedStyle(document.documentElement)
  const get = (name: string) => {
    const raw = style.getPropertyValue(name).trim()
    if (!raw) return undefined
    probe.style.color = raw
    return getComputedStyle(probe).color
  }
  const theme = buildTerminalThemeFromCssColors(get)
  probe.remove()
  return theme
}

export function measureTerminalGrid(
  host: HTMLElement,
  fontSize = TERMINAL_FONT_SIZE,
): { cols: number; rows: number } {
  if (host.clientWidth === 0 || host.clientHeight === 0) {
    return { cols: FALLBACK_TERMINAL_COLS, rows: FALLBACK_TERMINAL_ROWS }
  }
  const probe = document.createElement('span')
  probe.style.cssText = [
    'position:absolute',
    'visibility:hidden',
    'pointer-events:none',
    `font-family:${TERMINAL_FONT_FAMILY}`,
    `font-size:${fontSize}px`,
    'line-height:normal',
    'white-space:pre',
  ].join(';')
  probe.textContent = 'W'.repeat(16)
  host.appendChild(probe)
  const rect = probe.getBoundingClientRect()
  probe.remove()
  const cellWidth = rect.width / 16 || fontSize * 0.6
  const cellHeight = rect.height || Math.ceil(fontSize * 1.2)
  return {
    cols: Math.max(2, Math.floor(host.clientWidth / cellWidth)),
    rows: Math.max(1, Math.floor(host.clientHeight / cellHeight)),
  }
}

interface StatusNoticeWriter {
  write(data: string | Uint8Array): void
}

export function writeStatusNotice(terminal: StatusNoticeWriter, text: string): void {
  terminal.write(`\r\n\x1b[2m${text}\x1b[0m\r\n`)
}

type PendingWrite = {
  bytes: Uint8Array
  replay: boolean
}

/**
 * Applies sequence-numbered chunks to the terminal. Replay frames, live
 * frames, and reconnect replays all flow through one continuity rule: apply
 * the next expected sequence, drop duplicates, and reset the emulator when a
 * gap proves pruned output was missed.
 *
 * Writes are paced against xterm's parser: at most FLOW_HIGH_WATER callbacks
 * in flight, so a burst of PTY output cannot stall the UI thread.
 */
export class TerminalChunkApplier {
  private appliedSeq: number | null = null
  private readonly queue: PendingWrite[] = []
  private inFlight = 0
  private bytesSinceCallback = 0
  private readonly terminal: {
    write(data: string | Uint8Array, callback?: () => void): void
    reset(): void
  }
  private readonly onNotice: (text: string) => void

  /**
   * Counts replay writes still being parsed by the emulator; user input must
   * not be forwarded while replayed output could trigger protocol replies.
   */
  replayDepth = 0

  constructor(
    terminal: {
      write(data: string | Uint8Array, callback?: () => void): void
      reset(): void
    },
    onNotice: (text: string) => void,
  ) {
    this.terminal = terminal
    this.onNotice = onNotice
  }

  apply(frame: TerminalServerFrame): void {
    if (frame.type !== 'terminal_output' && frame.type !== 'terminal_replay') return
    this.applyBytes(frame.chunk.seq, decodeTerminalChunk(frame.chunk.data_base64), frame.type === 'terminal_replay')
  }

  applyBytes(seq: number, bytes: Uint8Array, replay: boolean): void {
    if (this.appliedSeq !== null && seq <= this.appliedSeq) return
    if (this.appliedSeq !== null && seq > this.appliedSeq + 1) {
      this.terminal.reset()
      this.onNotice('Some terminal output was unavailable')
    }
    this.appliedSeq = seq
    this.queue.push({ bytes, replay })
    if (replay) this.replayDepth += 1
    this.pump()
  }

  private pump(): void {
    while (this.inFlight < FLOW_HIGH_WATER && this.queue.length > 0) {
      const next = this.queue.shift()
      if (!next) return
      this.bytesSinceCallback += next.bytes.byteLength
      const paced = this.bytesSinceCallback > FLOW_BYTES_THRESHOLD || next.replay || this.queue.length > 0
      if (paced) {
        this.bytesSinceCallback = 0
        this.inFlight += 1
        this.terminal.write(next.bytes, () => {
          this.inFlight -= 1
          if (next.replay) this.replayDepth -= 1
          this.pump()
        })
      } else {
        this.terminal.write(next.bytes)
        if (next.replay) this.replayDepth -= 1
      }
    }
  }

  /** Highest applied sequence, for reconnect replays; null before any output. */
  get lastSeq(): number | null {
    return this.appliedSeq
  }
}

export function terminalChunkText(chunk: TerminalChunk): string {
  return new TextDecoder().decode(decodeTerminalChunk(chunk.data_base64))
}
