import { useEffect } from 'react'

let queued: unknown = { type: 'ready', height: 180 }

export function __setWebViewMessage(next: unknown) {
  queued = next
}

export function __resetWebViewMock() {
  queued = { type: 'ready', height: 180 }
}

export function WebView(props: {
  onMessage?: (event: { nativeEvent: { data: string } }) => void
  onShouldStartLoadWithRequest?: (request: { url: string }) => boolean
  source?: { html?: string }
}) {
  const onMessage = props.onMessage
  const html = props.source?.html
  const onShouldStartLoadWithRequest = props.onShouldStartLoadWithRequest

  useEffect(() => {
    onShouldStartLoadWithRequest?.({ url: 'about:blank' })
    onShouldStartLoadWithRequest?.({ url: 'data:text/html,diagram' })
    onShouldStartLoadWithRequest?.({ url: 'https://example.com' })
    const data = typeof queued === 'string' ? queued : JSON.stringify(queued)
    onMessage?.({ nativeEvent: { data } })
  }, [html, onMessage, onShouldStartLoadWithRequest])
  return null
}

export default WebView
