import { useEffect, useState } from 'react'
import type { HighlighterCore, ThemedToken } from 'shiki'

let highlighterPromise: Promise<HighlighterCore> | null = null

function getHighlighter() {
  if (!highlighterPromise) {
    highlighterPromise = import('shiki').then((shiki) =>
      shiki.createHighlighter({
        themes: ['github-dark-default'],
        langs: [
          'javascript',
          'typescript',
          'tsx',
          'jsx',
          'css',
          'html',
          'json',
          'rust',
          'python',
          'go',
          'yaml',
          'toml',
          'markdown',
          'bash',
          'sql',
          'swift',
          'kotlin',
          'java',
          'ruby',
          'php',
          'c',
          'cpp',
        ],
      }),
    )
  }
  return highlighterPromise
}

const extToLang: Record<string, string> = {
  js: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  ts: 'typescript',
  mts: 'typescript',
  cts: 'typescript',
  tsx: 'tsx',
  jsx: 'jsx',
  css: 'css',
  html: 'html',
  htm: 'html',
  json: 'json',
  rs: 'rust',
  py: 'python',
  go: 'go',
  yml: 'yaml',
  yaml: 'yaml',
  toml: 'toml',
  md: 'markdown',
  mdx: 'markdown',
  sh: 'bash',
  bash: 'bash',
  zsh: 'bash',
  sql: 'sql',
  swift: 'swift',
  kt: 'kotlin',
  java: 'java',
  rb: 'ruby',
  php: 'php',
  c: 'c',
  h: 'c',
  cpp: 'cpp',
  cc: 'cpp',
  hpp: 'cpp',
}

function langFromPath(filePath: string): string | null {
  const ext = filePath.split('.').pop()?.toLowerCase()
  return ext ? extToLang[ext] ?? null : null
}

/**
 * Returns token arrays for each line of code, syntax-highlighted via shiki.
 * Lines should be the raw code strings (without +/- prefix).
 */
export function useShikiTokens(
  lines: string[],
  filePath: string | null,
): ThemedToken[][] | null {
  const [tokens, setTokens] = useState<ThemedToken[][] | null>(null)

  useEffect(() => {
    if (!filePath || lines.length === 0) {
      setTokens(null)
      return
    }

    const lang = langFromPath(filePath)
    if (!lang) {
      setTokens(null)
      return
    }

    let cancelled = false

    void getHighlighter().then((highlighter) => {
      if (cancelled) return
      try {
        const loadedLangs = highlighter.getLoadedLanguages()
        if (!loadedLangs.includes(lang as never)) {
          setTokens(null)
          return
        }

        const code = lines.join('\n')
        const result = highlighter.codeToTokens(code, {
          lang,
          theme: 'github-dark-default',
        })
        if (!cancelled) {
          setTokens(result.tokens)
        }
      } catch {
        if (!cancelled) setTokens(null)
      }
    })

    return () => {
      cancelled = true
    }
  }, [lines, filePath])

  return tokens
}
