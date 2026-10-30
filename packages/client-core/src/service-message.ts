import type { ServiceLevel } from './types'

export type ServiceMessagePresentation = {
  message: string
  rawDetail: string | null
  classification: 'codex_skill_icon_invalid' | 'http_html_response' | null
}

const INVALID_SKILL_ICON_MESSAGE =
  'A skill icon could not be loaded because its path is invalid. The skill is still available.'

function stripTerminalControlSequences(raw: string): string {
  let output = ''
  for (let index = 0; index < raw.length; index += 1) {
    const character = raw[index]
    if (character !== '\u001b') {
      output += character
      continue
    }

    const next = raw[index + 1]
    index += 1
    if (next === '[') {
      while (index + 1 < raw.length) {
        index += 1
        const final = raw[index]
        if (final >= '@' && final <= '~') break
      }
    } else if (next === ']') {
      while (index + 1 < raw.length) {
        index += 1
        if (raw[index] === '\u0007') break
        if (raw[index] === '\u001b' && raw[index + 1] === '\\') {
          index += 1
          break
        }
      }
    } else if (next === 'P' || next === 'X' || next === '^' || next === '_') {
      while (index + 1 < raw.length) {
        index += 1
        if (raw[index] === '\u001b' && raw[index + 1] === '\\') {
          index += 1
          break
        }
      }
    } else if (next === '(' || next === ')') {
      index += 1
    }
  }
  return output
}

function parsedPrettyDiagnostic(raw: string): { level: string; message: string } | null {
  const match = raw.match(/\b(ERROR|WARN(?:ING)?|INFO|DEBUG|TRACE)\b[\s\S]*?:\s+(.+)$/)
  return match ? { level: match[1], message: match[2].trim() } : null
}

function parsedDiagnostic(raw: string): { target?: unknown; level?: unknown; fields?: { message?: unknown } } | null {
  try {
    const value = JSON.parse(raw) as unknown
    return value && typeof value === 'object'
      ? value as { target?: unknown; level?: unknown; fields?: { message?: unknown } }
      : null
  } catch {
    return null
  }
}

function htmlHttpResponseSummary(message: string): string | null {
  // HTTP error bodies can contain a whole challenge page, including SVG and scripts.
  // Only inspect the transport prefix; page content is technical detail, not UI copy.
  const documentStart = message.search(/<(?:!doctype\s+html|html|head|body)\b/i)
  if (documentStart < 0) return null
  const prefix = message.slice(0, documentStart)
  const status = prefix.match(/\bHTTP(?:\/\d+(?:\.\d+)?)?\s+([1-5]\d{2})\b/i)?.[1]
  if (!status) return null

  const startup = prefix.match(/^\s*(\S+ failed to start:)/)?.[1]
  const summary = `Server returned HTTP ${status} with an HTML page instead of the expected response.`
  return startup ? `${startup} ${summary}` : summary
}

/** Converts known provider diagnostics to user copy while retaining the exact input for inspection. */
export function serviceMessagePresentation(
  level: ServiceLevel,
  rawMessage: string,
): ServiceMessagePresentation {
  const normalizedMessage = stripTerminalControlSequences(rawMessage)
  const diagnostic = parsedDiagnostic(normalizedMessage)
  const prettyDiagnostic = diagnostic ? null : parsedPrettyDiagnostic(normalizedMessage)
  const diagnosticMessage = typeof diagnostic?.fields?.message === 'string'
    ? diagnostic.fields.message.trim()
    : prettyDiagnostic?.message ?? ''
  const readableDiagnostic = diagnosticMessage || normalizedMessage
  const rawDetail = readableDiagnostic !== rawMessage ? rawMessage : null

  const httpSummary = htmlHttpResponseSummary(readableDiagnostic)
  if (httpSummary) {
    return {
      message: httpSummary,
      rawDetail: rawMessage,
      classification: 'http_html_response',
    }
  }

  if (level !== 'warning') {
    return {
      message: readableDiagnostic,
      rawDetail,
      classification: null,
    }
  }

  const targetMatches = diagnostic == null || diagnostic.target === 'codex_core::skills::loader'
  const levelMatches = diagnostic == null
    ? prettyDiagnostic == null || prettyDiagnostic.level === 'WARN' || prettyDiagnostic.level === 'WARNING'
    : diagnostic.level === 'WARN'
  const isInvalidSkillIcon = targetMatches && levelMatches &&
    readableDiagnostic.startsWith('ignoring interface.icon_large:') &&
    readableDiagnostic.includes("icon path with '.' must resolve under plugin assets/")

  if (!isInvalidSkillIcon) {
    return {
      message: readableDiagnostic,
      rawDetail,
      classification: null,
    }
  }

  return {
    message: INVALID_SKILL_ICON_MESSAGE,
    rawDetail: rawMessage,
    classification: 'codex_skill_icon_invalid',
  }
}
