import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

describe('tauri security configuration', () => {
  it('allows local daemon origins in CSP for images and media', () => {
    const configPath = path.resolve(__dirname, '../src-tauri/tauri.conf.json')
    const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'))
    const csp = config.app?.security?.csp as string

    expect(csp).toBeDefined()
    expect(csp).toContain('img-src')
    expect(csp).toMatch(/img-src[^;]*http:\/\/127\.0\.0\.1:\*/)
    expect(csp).toMatch(/img-src[^;]*http:\/\/localhost:\*/)
    expect(csp).toMatch(/media-src[^;]*http:\/\/127\.0\.0\.1:\*/)
    expect(csp).toMatch(/media-src[^;]*http:\/\/localhost:\*/)
    expect(csp).toMatch(/connect-src[^;]*http:\/\/127\.0\.0\.1:\*/)
    expect(csp).toMatch(/connect-src[^;]*http:\/\/localhost:\*/)
  })
})
