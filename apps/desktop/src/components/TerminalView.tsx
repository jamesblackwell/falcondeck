import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef } from 'react'
import type { ITerminalAddon, Terminal as XTerm } from '@xterm/xterm'
import type { TerminalSessionInfo, TerminalServerFrame } from '@falcondeck/client-core'
import { openExternalUrl } from '../api'
import {
  decodeOutputWire,
  encodeTerminalInputBinary,
  readTerminalTheme,
  TerminalChunkApplier,
  TERMINAL_FONT_FAMILY,
  TERMINAL_FONT_SIZE,
  TERMINAL_WIRE_INPUT,
  writeStatusNotice,
} from '../terminal-utils'
import { tabIndexForKeyEvent } from '../terminal-tabs'
import { commandForEvent } from '../shortcuts'

const RECONNECT_DELAY_MS = 1_000
const PING_INTERVAL_MS = 15_000
const RESIZE_DEBOUNCE_MS = 32
const MAX_WEBGL_RECOVERY_ATTEMPTS = 3
const FONT_SIZE_MIN = 10
const FONT_SIZE_MAX = 22

export interface TerminalViewProps {
  session: TerminalSessionInfo
  socketUrl: string
  active: boolean
  onExited: (exitCode: number | null) => void
  onTitleChange: (title: string) => void
  onUserInput?: () => void
  /** Overrides the socket factory so tests can inject a fake WebSocket. */
  createSocket?: (url: string) => WebSocket
}

export type TerminalViewHandle = {
  focus(): void
  fit(): void
  reactivate(): void
  findNext(term: string, options?: { incremental?: boolean; caseSensitive?: boolean }): boolean
  findPrevious(term: string, options?: { incremental?: boolean; caseSensitive?: boolean }): boolean
  clearSearch(): void
}

type SearchAddonApi = ITerminalAddon & {
  findNext(term: string, options?: { incremental?: boolean; caseSensitive?: boolean }): boolean
  findPrevious(term: string, options?: { incremental?: boolean; caseSensitive?: boolean }): boolean
  clearDecorations(): void
}

type WebglAddonApi = ITerminalAddon & {
  onContextLoss(cb: () => void): { dispose(): void }
}

type FitAddonApi = ITerminalAddon & { fit(): void }

export const TerminalView = forwardRef<TerminalViewHandle, TerminalViewProps>(function TerminalView(
  { session, socketUrl, active, onExited, onTitleChange, onUserInput, createSocket },
  ref,
) {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const onExitedRef = useRef(onExited)
  const onTitleChangeRef = useRef(onTitleChange)
  const onUserInputRef = useRef(onUserInput)
  const apiRef = useRef<TerminalViewHandle | null>(null)
  const activeRef = useRef(active)
  activeRef.current = active

  useEffect(() => {
    onExitedRef.current = onExited
    onTitleChangeRef.current = onTitleChange
    onUserInputRef.current = onUserInput
  })

  const sendInput = useCallback((socket: WebSocket, data: string) => {
    for (const payload of encodeTerminalInputBinary(data)) {
      socket.send(payload)
    }
  }, [])

  useEffect(() => {
    const node = containerRef.current
    if (!node) return
    const host: HTMLElement = node

    let disposed = false
    let sessionDead = false
    let terminal: XTerm | null = null
    let fitAddon: FitAddonApi | null = null
    let webgl: WebglAddonApi | null = null
    let searchAddon: SearchAddonApi | null = null
    let socket: WebSocket | null = null
    let reconnectTimer: number | null = null
    let pingTimer: number | null = null
    let applier: TerminalChunkApplier | null = null
    let resizeFrame: number | null = null
    let resizeTimer: number | null = null
    let resizeObserver: ResizeObserver | null = null
    let themeObserver: MutationObserver | null = null
    let lastCols = 0
    let lastRows = 0
    let fontSize = TERMINAL_FONT_SIZE
    let webglRecoveryAttempts = 0
    let pendingWebglRecovery = false
    let WebglAddonCtor: (new () => WebglAddonApi) | null = null

    const socketFactory = createSocket ?? ((url: string) => new WebSocket(url))

    function scheduleConnect() {
      if (disposed) return
      reconnectTimer = window.setTimeout(connect, RECONNECT_DELAY_MS)
    }

    function handleServerFrame(raw: TerminalServerFrame) {
      if (disposed || !terminal || !applier) return
      switch (raw.type) {
        case 'terminal_attached':
          break
        case 'terminal_output':
        case 'terminal_replay':
          applier.apply(raw)
          break
        case 'terminal_exited':
          sessionDead = true
          writeStatusNotice(
            terminal,
            raw.exit_code === null ? 'Terminal exited' : `Terminal exited with code ${raw.exit_code}`,
          )
          onExitedRef.current?.(raw.exit_code)
          break
        case 'terminal_error':
          sessionDead = true
          writeStatusNotice(terminal, `Terminal error: ${raw.message}`)
          break
        case 'terminal_pong':
          break
      }
    }

    function connect() {
      if (disposed || !terminal || !applier) return
      const since = applier.lastSeq === null ? 0 : applier.lastSeq + 1
      const activeUrl = new URL(socketUrl)
      activeUrl.searchParams.set('since_seq', String(since))
      const activeSocket = socketFactory(activeUrl.toString())
      activeSocket.binaryType = 'arraybuffer'
      socket = activeSocket
      activeSocket.onmessage = (message) => {
        if (message.data instanceof ArrayBuffer) {
          const decoded = decodeOutputWire(message.data)
          if (decoded && applier) applier.applyBytes(decoded.seq, decoded.bytes, decoded.replay)
          return
        }
        let frame: TerminalServerFrame
        try {
          frame = JSON.parse(String(message.data)) as TerminalServerFrame
        } catch {
          return
        }
        handleServerFrame(frame)
      }
      activeSocket.onopen = () => {
        sendResize(true)
        startPing()
      }
      activeSocket.onclose = () => {
        if (disposed || sessionDead) return
        stopPing()
        socket = null
        if (terminal) writeStatusNotice(terminal, 'Terminal connection lost; reconnecting…')
        scheduleConnect()
      }
    }

    function startPing() {
      stopPing()
      pingTimer = window.setInterval(() => {
        if (socket && socket.readyState === WebSocket.OPEN) {
          socket.send(JSON.stringify({ type: 'terminal_ping' }))
        }
      }, PING_INTERVAL_MS)
    }

    function stopPing() {
      if (pingTimer !== null) {
        window.clearInterval(pingTimer)
        pingTimer = null
      }
    }

    function sendResize(immediate = false) {
      if (!terminal || !socket || socket.readyState !== WebSocket.OPEN) return
      const cols = terminal.cols
      const rows = terminal.rows
      if (cols === lastCols && rows === lastRows) return
      const dispatch = () => {
        resizeTimer = null
        if (!terminal || !socket || socket.readyState !== WebSocket.OPEN) return
        if (terminal.cols === lastCols && terminal.rows === lastRows) return
        lastCols = terminal.cols
        lastRows = terminal.rows
        socket.send(JSON.stringify({ type: 'terminal_resize', cols: lastCols, rows: lastRows }))
      }
      if (immediate) {
        if (resizeTimer !== null) window.clearTimeout(resizeTimer)
        dispatch()
        return
      }
      if (resizeTimer !== null) return
      resizeTimer = window.setTimeout(dispatch, RESIZE_DEBOUNCE_MS)
    }

    function fit() {
      if (!terminal || !fitAddon) return
      if (host.clientWidth === 0 || host.clientHeight === 0) return
      fitAddon.fit()
      sendResize()
    }

    function scheduleFit() {
      if (resizeFrame !== null) return
      resizeFrame = window.requestAnimationFrame(() => {
        resizeFrame = null
        fit()
      })
    }

    function refreshRenderer() {
      if (!terminal) return
      terminal.refresh(0, terminal.rows - 1)
    }

    function enableWebgl() {
      if (!terminal || !WebglAddonCtor || webgl) return
      try {
        const addon = new WebglAddonCtor()
        addon.onContextLoss(() => {
          pendingWebglRecovery = true
          try {
            addon.dispose()
          } catch {
            // Context is already gone.
          }
          if (webgl === addon) webgl = null
          recoverWebgl()
        })
        terminal.loadAddon(addon)
        webgl = addon
        pendingWebglRecovery = false
        scheduleFit()
      } catch {
        webgl = null
      }
    }

    function recoverWebgl() {
      if (!pendingWebglRecovery) return
      if (!host.offsetParent || !document.hasFocus()) return
      pendingWebglRecovery = false
      if (webglRecoveryAttempts >= MAX_WEBGL_RECOVERY_ATTEMPTS) {
        refreshRenderer()
        return
      }
      webglRecoveryAttempts += 1
      enableWebgl()
      refreshRenderer()
    }

    function reactivate() {
      if (pendingWebglRecovery || (!webgl && WebglAddonCtor && webglRecoveryAttempts < MAX_WEBGL_RECOVERY_ATTEMPTS)) {
        pendingWebglRecovery = true
        recoverWebgl()
      } else {
        webglRecoveryAttempts = 0
        fit()
        refreshRenderer()
      }
    }

    function focusTerminal() {
      terminal?.focus()
    }

    function handleWheel(event: WheelEvent) {
      if (!event.ctrlKey || event.metaKey) return
      event.preventDefault()
      const next = Math.min(
        FONT_SIZE_MAX,
        Math.max(FONT_SIZE_MIN, fontSize + (event.deltaY < 0 ? 1 : -1)),
      )
      if (next === fontSize || !terminal) return
      fontSize = next
      terminal.options.fontSize = fontSize
      scheduleFit()
    }

    function ensureSearchAddon(): SearchAddonApi | null {
      return searchAddon
    }

    apiRef.current = {
      focus: focusTerminal,
      fit,
      reactivate,
      findNext(term, options) {
        return ensureSearchAddon()?.findNext(term, options) ?? false
      },
      findPrevious(term, options) {
        return ensureSearchAddon()?.findPrevious(term, options) ?? false
      },
      clearSearch() {
        ensureSearchAddon()?.clearDecorations()
      },
    }

    async function mount() {
      const [
        { Terminal },
        { FitAddon },
        webglModule,
        { WebLinksAddon },
        { ClipboardAddon },
        { Unicode11Addon },
        searchModule,
      ] = await Promise.all([
        import('@xterm/xterm'),
        import('@xterm/addon-fit'),
        import('@xterm/addon-webgl').then(
          (module) => module,
          () => null,
        ),
        import('@xterm/addon-web-links'),
        import('@xterm/addon-clipboard'),
        import('@xterm/addon-unicode11'),
        import('@xterm/addon-search'),
      ])
      if (disposed) return

      terminal = new Terminal({
        allowProposedApi: true,
        cursorBlink: true,
        fontFamily: TERMINAL_FONT_FAMILY,
        fontSize,
        scrollback: 10_000,
        theme: readTerminalTheme(),
        macOptionIsMeta: false,
      })
      const activeTerminal = terminal
      fitAddon = new FitAddon()
      activeTerminal.loadAddon(fitAddon)
      activeTerminal.loadAddon(new ClipboardAddon())
      activeTerminal.loadAddon(
        new WebLinksAddon((event, uri) => {
          event.preventDefault()
          if (event.metaKey || event.ctrlKey) void openExternalUrl(uri)
        }),
      )
      const unicodeAddon = new Unicode11Addon()
      activeTerminal.loadAddon(unicodeAddon)
      activeTerminal.unicode.activeVersion = '11'
      searchAddon = new searchModule.SearchAddon({ highlightLimit: 1000 })
      activeTerminal.loadAddon(searchAddon)

      if (webglModule) {
        WebglAddonCtor = webglModule.WebglAddon
        enableWebgl()
      }

      applier = new TerminalChunkApplier(activeTerminal, (text) => {
        writeStatusNotice(activeTerminal, text)
      })
      activeTerminal.open(host)
      scheduleFit()
      activeTerminal.attachCustomKeyEventHandler((event) => {
        if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'f') return false
        // Panel-level shortcuts (find, tab strip navigation) bubble past xterm
        // so the shell never sees them as input.
        if (commandForEvent('terminal', event)) return false
        if (tabIndexForKeyEvent(event, Number.MAX_SAFE_INTEGER) !== null) return false
        return true
      })
      activeTerminal.onData((data) => {
        if (!applier || applier.replayDepth > 0) return
        if (!socket || socket.readyState !== WebSocket.OPEN) return
        onUserInputRef.current?.()
        sendInput(socket, data)
      })
      activeTerminal.onBinary((data) => {
        if (!applier || applier.replayDepth > 0) return
        if (!socket || socket.readyState !== WebSocket.OPEN) return
        const bytes = Uint8Array.from(data, (char) => char.charCodeAt(0) & 255)
        const payload = new Uint8Array(1 + bytes.byteLength)
        payload[0] = TERMINAL_WIRE_INPUT
        payload.set(bytes, 1)
        onUserInputRef.current?.()
        socket.send(payload)
      })
      activeTerminal.onTitleChange((title) => {
        if (!applier || applier.replayDepth > 0) return
        onTitleChangeRef.current?.(title)
      })
      activeTerminal.onResize(() => sendResize())
      activeTerminal.onSelectionChange(() => {
        const selection = activeTerminal.getSelection()
        if (!selection) return
        void navigator.clipboard?.writeText(selection).catch(() => undefined)
      })

      fit()
      connect()
      if (activeRef.current) {
        focusTerminal()
      }

      resizeObserver = new ResizeObserver(() => scheduleFit())
      resizeObserver.observe(host)
      themeObserver = new MutationObserver(() => {
        if (terminal) terminal.options.theme = readTerminalTheme()
      })
      themeObserver.observe(document.documentElement, {
        attributes: true,
        attributeFilter: ['data-theme', 'data-palette'],
      })
      host.addEventListener('wheel', handleWheel, { passive: false })
    }

    void mount().catch((error: unknown) => {
      if (!disposed) {
        host.textContent = error instanceof Error ? error.message : String(error)
      }
    })

    return () => {
      disposed = true
      apiRef.current = null
      if (reconnectTimer !== null) window.clearTimeout(reconnectTimer)
      if (resizeFrame !== null) window.cancelAnimationFrame(resizeFrame)
      if (resizeTimer !== null) window.clearTimeout(resizeTimer)
      stopPing()
      resizeObserver?.disconnect()
      themeObserver?.disconnect()
      host.removeEventListener('wheel', handleWheel)
      if (socket) {
        socket.onclose = null
        socket.close()
      }
      webgl?.dispose()
      terminal?.dispose()
      terminal = null
      fitAddon = null
    }
  }, [session.id, socketUrl, sendInput, createSocket])

  useImperativeHandle(
    ref,
    () => ({
      focus() {
        apiRef.current?.focus()
      },
      fit() {
        apiRef.current?.fit()
      },
      reactivate() {
        apiRef.current?.reactivate()
      },
      findNext(term, options) {
        return apiRef.current?.findNext(term, options) ?? false
      },
      findPrevious(term, options) {
        return apiRef.current?.findPrevious(term, options) ?? false
      },
      clearSearch() {
        apiRef.current?.clearSearch()
      },
    }),
    [],
  )

  useEffect(() => {
    if (!active) return
    apiRef.current?.reactivate()
    apiRef.current?.focus()
  }, [active])

  return (
    <div
      ref={containerRef}
      className="h-full min-h-0 w-full overflow-hidden px-2 py-1"
      data-terminal-view-host=""
      data-terminal-active={active || undefined}
    />
  )
})
