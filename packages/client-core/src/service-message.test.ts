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

  it('removes ANSI styling and extracts human-readable tracing diagnostics', () => {
    const raw = '\u001b[2m2026-08-09T10:52:51.408419Z\u001b[0m \u001b[31mERROR\u001b[0m codex_models_manager::cache: failed to load models cache: missing field `base_instructions` at line 94 column 5'
    const presentation = serviceMessagePresentation('error', raw)

    expect(presentation.message).toBe('failed to load models cache: missing field `base_instructions` at line 94 column 5')
    expect(presentation.rawDetail).toBe(raw)
    expect(presentation.classification).toBeNull()
  })
})
