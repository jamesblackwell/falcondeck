import type { TerminalChunk, TerminalServerFrame } from '@falcondeck/client-core'

export const TERMINAL_FONT_FAMILY =
  '"Geist Mono", "SF Mono", "JetBrains Mono", ui-monospace, monospace'

/** Cap input writes at the daemon's per-frame chunk budget. */
const MAX_INPUT_CHUNK_BYTES = 64 * 1024

export function encodeTerminalInput(value: string): string[] {
  const bytes = new TextEncoder().encode(value)
  const chunks: string[] = []
  for (let offset = 0; offset < bytes.byteLength; offset += MAX_INPUT_CHUNK_BYTES) {
    const slice = bytes.subarray(offset, Math.min(offset + MAX_INPUT_CHUNK_BYTES, bytes.byteLength))
    let binary = ''
    for (const byte of slice) binary += String.fromCharCode(byte)
    chunks.push(btoa(binary))
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

interface StatusNoticeWriter {
  write(data: string | Uint8Array): void
}

export function writeStatusNotice(terminal: StatusNoticeWriter, text: string): void {
  terminal.write(`\r\n\x1b[2m${text}\x1b[0m\r\n`)
}

/**
 * Applies sequence-numbered chunks to the terminal. Replay frames, live
 * frames, and reconnect replays all flow through one continuity rule: apply
 * the next expected sequence, drop duplicates, and reset the emulator when a
 * gap proves pruned output was missed.
 */
export class TerminalChunkApplier {
  private appliedSeq: number | null = null

  /**
   * Counts replay writes still being parsed by the emulator; user input must
   * not be forwarded while replayed output could trigger protocol replies.
   */
  replayDepth = 0

  constructor(
    private readonly terminal: {
      write(data: string | Uint8Array, callback?: () => void): void
      reset(): void
    },
    private readonly onNotice: (text: string) => void,
  ) {}

  apply(frame: TerminalServerFrame): void {
    if (frame.type !== 'terminal_output' && frame.type !== 'terminal_replay') return
    const { seq, data_base64 } = frame.chunk
    if (this.appliedSeq !== null && seq <= this.appliedSeq) return
    if (this.appliedSeq !== null && seq > this.appliedSeq + 1) {
      this.terminal.reset()
      this.onNotice('Some terminal output was unavailable')
    }
    const bytes = decodeTerminalChunk(data_base64)
    if (frame.type === 'terminal_replay') {
      this.replayDepth += 1
      this.terminal.write(bytes, () => {
        this.replayDepth -= 1
      })
    } else {
      this.terminal.write(bytes)
    }
    this.appliedSeq = seq
  }

  /** Highest applied sequence, for reconnect replays; null before any output. */
  get lastSeq(): number | null {
    return this.appliedSeq
  }
}

export function terminalChunkText(chunk: TerminalChunk): string {
  return new TextDecoder().decode(decodeTerminalChunk(chunk.data_base64))
}
