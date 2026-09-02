import { useCallback, useEffect, useRef } from 'react'
import type { TerminalSessionInfo, TerminalServerFrame } from '@falcondeck/client-core'
import { encodeTerminalInput, readTerminalTheme, TerminalChunkApplier, writeStatusNotice } from '../terminal-utils'

const RECONNECT_DELAY_MS = 1_000

export interface TerminalViewProps {
  session: TerminalSessionInfo
  socketUrl: string
  onExited: (exitCode: number | null) => void
  onTitleChange: (title: string) => void
  onUserInput?: () => void
  /** Overrides the socket factory so tests can inject a fake WebSocket. */
  createSocket?: (url: string) => WebSocket
}

export function TerminalView({
  session,
  socketUrl,
  onExited,
  onTitleChange,
  onUserInput,
  createSocket,
}: TerminalViewProps) {
  const containerRef = useRef<HTMLDivElement | null>(null)
  // Callback refs are refreshed in an effect, never during render.
  const onExitedRef = useRef(onExited)
  const onTitleChangeRef = useRef(onTitleChange)
  const onUserInputRef = useRef(onUserInput)
  useEffect(() => {
    onExitedRef.current = onExited
    onTitleChangeRef.current = onTitleChange
    onUserInputRef.current = onUserInput
  })

  const sendInput = useCallback((socket: WebSocket, data: string) => {
    for (const dataBase64 of encodeTerminalInput(data)) {
      socket.send(JSON.stringify({ type: 'terminal_input', data_base64: dataBase64 }))
    }
  }, [])

  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    let disposed = false
    // Set once the session is gone for good (shell exit or daemon-reported
    // error): reconnecting could never succeed again and would spam the dead
    // terminal with notices every second.
    let sessionDead = false
    let terminal: import('@xterm/xterm').Terminal | null = null
    let fitAddon: { fit(): void } | null = null
    let webgl: { dispose(): void } | null = null
    let socket: WebSocket | null = null
    let reconnectTimer: number | null = null
    let applier: TerminalChunkApplier | null = null
    let resizeFrame: number | null = null
    let resizeObserver: ResizeObserver | null = null
    let themeObserver: MutationObserver | null = null

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
      const active = socketFactory(activeUrl.toString())
      socket = active
      active.onmessage = (message) => {
        let frame: TerminalServerFrame
        try {
          frame = JSON.parse(String(message.data)) as TerminalServerFrame
        } catch {
          return
        }
        handleServerFrame(frame)
      }
      active.onopen = () => {
        if (!terminal) return
        active.send(
          JSON.stringify({ type: 'terminal_resize', cols: terminal.cols, rows: terminal.rows }),
        )
      }
      active.onclose = () => {
        if (disposed || sessionDead) return
        socket = null
        if (terminal) writeStatusNotice(terminal, 'Terminal connection lost; reconnecting…')
        scheduleConnect()
      }
    }

    function fit() {
      if (!terminal || !fitAddon) return
      if (container.clientWidth === 0 || container.clientHeight === 0) return
      fitAddon.fit()
      if (socket && socket.readyState === WebSocket.OPEN && terminal) {
        socket.send(
          JSON.stringify({ type: 'terminal_resize', cols: terminal.cols, rows: terminal.rows }),
        )
      }
    }

    function scheduleFit() {
      if (resizeFrame !== null) return
      resizeFrame = window.requestAnimationFrame(() => {
        resizeFrame = null
        fit()
      })
    }

    async function mount() {
      const [{ Terminal }, { FitAddon }, webglModule] = await Promise.all([
        import('@xterm/xterm'),
        import('@xterm/addon-fit'),
        import('@xterm/addon-webgl').then(
          (module) => module,
          () => null,
        ),
      ])
      if (disposed) return

      terminal = new Terminal({
        cursorBlink: true,
        fontFamily: '"Geist Mono", "SF Mono", "JetBrains Mono", ui-monospace, monospace',
        fontSize: 12,
        scrollback: 10_000,
        theme: readTerminalTheme(),
      })
      const activeTerminal = terminal
      fitAddon = new FitAddon()
      activeTerminal.loadAddon(fitAddon)

      // Register WebGL before open() so the slower DOM renderer is never
      // created when acceleration is available; on failure it falls back.
      if (webglModule) {
        try {
          const addon = new webglModule.WebglAddon()
          addon.onContextLoss(() => addon.dispose())
          activeTerminal.loadAddon(addon)
          webgl = addon
        } catch {
          webgl = null
        }
      }

      applier = new TerminalChunkApplier(activeTerminal, (text) => {
        writeStatusNotice(activeTerminal, text)
      })
      activeTerminal.open(container)
      activeTerminal.onData((data) => {
        if (!applier || applier.replayDepth > 0) return
        if (!socket || socket.readyState !== WebSocket.OPEN) return
        onUserInputRef.current?.()
        sendInput(socket, data)
      })
      activeTerminal.onTitleChange((title) => {
        if (!applier || applier.replayDepth > 0) return
        onTitleChangeRef.current?.(title)
      })
      activeTerminal.onResize((cols, rows) => {
        if (!socket || socket.readyState !== WebSocket.OPEN) return
        socket.send(JSON.stringify({ type: 'terminal_resize', cols, rows }))
      })

      fit()
      connect()

      resizeObserver = new ResizeObserver(() => scheduleFit())
      resizeObserver.observe(container)
      themeObserver = new MutationObserver(() => {
        if (terminal) terminal.options.theme = readTerminalTheme()
      })
      themeObserver.observe(document.documentElement, {
        attributes: true,
        attributeFilter: ['data-theme', 'data-palette'],
      })
    }

    void mount().catch((error: unknown) => {
      if (!disposed) {
        container.textContent = error instanceof Error ? error.message : String(error)
      }
    })

    return () => {
      disposed = true
      if (reconnectTimer !== null) window.clearTimeout(reconnectTimer)
      if (resizeFrame !== null) window.cancelAnimationFrame(resizeFrame)
      resizeObserver?.disconnect()
      themeObserver?.disconnect()
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

  return (
    <div
      ref={containerRef}
      className="h-full min-h-0 w-full overflow-hidden px-2 py-1"
      data-terminal-view-host=""
    />
  )
}
