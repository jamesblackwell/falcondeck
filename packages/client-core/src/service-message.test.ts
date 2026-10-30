import { describe, expect, it } from 'vitest'

import { serviceMessagePresentation } from './service-message'

const raw = JSON.stringify({
  timestamp: '2026-08-09T05:02:59.293394Z',
  level: 'WARN',
  fields: { message: "ignoring interface.icon_large: icon path with '.' must resolve under plugin assets/" },
  target: 'codex_core::skills::loader',
})

describe('serviceMessagePresentation', () => {
  it('classifies the non-fatal Codex invalid skill icon diagnostic', () => {
    expect(serviceMessagePresentation('warning', raw)).toEqual({
      message: 'A skill icon could not be loaded because its path is invalid. The skill is still available.',
      rawDetail: raw,
      classification: 'codex_skill_icon_invalid',
    })
  })

  it('also handles an already-extracted loader message', () => {
    expect(serviceMessagePresentation('warning', "ignoring interface.icon_large: icon path with '.' must resolve under plugin assets/").classification)
      .toBe('codex_skill_icon_invalid')
  })

  it('extracts generic diagnostic copy while retaining exact technical detail', () => {
    const warning = '{"level":"WARN","fields":{"message":"MCP startup failed"}}'
    expect(serviceMessagePresentation('warning', warning)).toEqual({
      message: 'MCP startup failed',
      rawDetail: warning,
      classification: null,
    })
    expect(serviceMessagePresentation('error', raw)).toEqual({
      message: "ignoring interface.icon_large: icon path with '.' must resolve under plugin assets/",
      rawDetail: raw,
      classification: null,
    })
  })

  it('leaves ordinary user-readable service text untouched', () => {
    expect(serviceMessagePresentation('error', 'Connection failed. Try again.')).toEqual({
      message: 'Connection failed. Try again.',
      rawDetail: null,
      classification: null,
    })
  })

  it.each(['warning', 'error'] as const)('summarizes HTML HTTP responses in %s diagnostics and retains the exact payload', (level) => {
    const raw = 'openai-api-credit-promo failed to start: Send message error Transport\n' +
      '[codex_mcp_client::worker]: unexpected server response: HTTP 403: ' +
      '<html>\n<head><style>.logo{color:red}</style></head>\n<body><svg><path d="M0 0"/></svg>\n' +
      '<script>challenge()</script></body></html>, when send initialize request'

    expect(serviceMessagePresentation(level, raw)).toEqual({
      message: 'openai-api-credit-promo failed to start: Server returned HTTP 403 with an HTML page instead of the expected response.',
      rawDetail: raw,
      classification: 'http_html_response',
    })
  })

  it('summarizes structured HTTP diagnostics with a doctype and preserves their envelope', () => {
    const raw = JSON.stringify({
      level: 'ERROR',
      fields: { message: 'unexpected server response: HTTP/1.1 502 Bad Gateway: <!DOCTYPE HTML><HTML><BODY>Unavailable</BODY></HTML>' },
    })

    expect(serviceMessagePresentation('error', raw)).toEqual({
      message: 'Server returned HTTP 502 with an HTML page instead of the expected response.',
      rawDetail: raw,
      classification: 'http_html_response',
    })
  })

  it.each([
    'Connector failed: HTTP 403: access denied',
    'Invalid template: <html><body>Missing placeholder</body></html>',
    'Invalid template: <html><body>HTTP 403</body></html>',
  ])('preserves diagnostics without an HTTP status followed by an HTML document: %s', (raw) => {
    expect(serviceMessagePresentation('error', raw)).toEqual({
      message: raw,
      rawDetail: null,
      classification: null,
    })
  })

  it('removes ANSI styling and extracts human-readable tracing diagnostics', () => {
    const raw = '\u001b[2m2026-08-09T10:52:51.408419Z\u001b[0m \u001b[31mERROR\u001b[0m codex_models_manager::cache: failed to load models cache: missing field `base_instructions` at line 94 column 5'
    const presentation = serviceMessagePresentation('error', raw)

    expect(presentation.message).toBe('failed to load models cache: missing field `base_instructions` at line 94 column 5')
    expect(presentation.rawDetail).toBe(raw)
    expect(presentation.classification).toBeNull()
  })
})
