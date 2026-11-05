#!/usr/bin/env node
// Streams into the real Conversation in WKWebView and/or Chromium and writes
// per-frame recordings. See docs/15-conversation-quality.md.
//
//   node scripts/stream-qa/run.mjs --label before --engines webkit,chromium
import { execFileSync, spawn } from 'node:child_process'
import { createReadStream, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const repo = path.join(here, '../..')
const option = (name, fallback) => {
  const index = process.argv.indexOf(`--${name}`)
  return index === -1 ? fallback : process.argv[index + 1]
}
const label = option('label', 'run')
const engines = option('engines', 'webkit').split(',')
const only = option('only', '')
const repeat = Number(option('repeat', 1))
const out = option('out', '/tmp/fd-stream-qa')
const build = option('build', '/tmp/fd-stream-qa-build')
const skipBuild = process.argv.includes('--skip-build')

export const scenarios = {
  'read-start': 'reader=start',
  'read-start-end': 'reader=start&parkThroughEnd=1',
  'read-mid': 'reader=mid',
  'read-history': 'reader=history',
  near: 'reader=near',
  'thought-follow': 'reader=none&thought=1',
  'tools-expanded': 'reader=start&tools=expanded',
  'tool-above': 'reader=start&tools=expanded&liveToolAbove=1',
  'expand-above': 'reader=start&expandAbove=1',
  'late-image': 'reader=history&lateImage=13000',
  'long-climb': 'reader=climb&history=200',
  'long-follow': 'reader=none&history=200',
  'long-climb-eager': 'reader=climb&history=200&eager=1',
  'long-follow-eager': 'reader=none&history=200&eager=1',
}

const names = only ? only.split(',') : Object.keys(scenarios)
mkdirSync(out, { recursive: true })

if (!skipBuild) {
  execFileSync('npx', ['vite', 'build', '--config', path.join(here, 'vite.config.mjs')], {
    cwd: repo,
    env: { ...process.env, STREAM_QA_OUT: build },
    stdio: ['ignore', 'ignore', 'inherit'],
  })
}

const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2', '.wasm': 'application/wasm' }
const server = createServer((request, response) => {
  const url = new URL(request.url, 'http://localhost')
  if (url.pathname === '/qa-slow-image.svg') {
    const delay = Number(url.searchParams.get('delay') ?? 1000)
    setTimeout(() => {
      response.writeHead(200, { 'content-type': 'image/svg+xml' })
      response.end('<svg xmlns="http://www.w3.org/2000/svg" width="640" height="360"><rect width="640" height="360" fill="#456"/></svg>')
    }, delay)
    return
  }
  const pathname = url.pathname === '/' ? '/stream-qa.html' : url.pathname
  const file = path.join(build, pathname)
  if (!file.startsWith(build) || !existsSync(file)) {
    response.writeHead(404)
    response.end()
    return
  }
  response.writeHead(200, { 'content-type': mime[path.extname(file)] ?? 'application/octet-stream' })
  createReadStream(file).pipe(response)
})
await new Promise((resolve) => server.listen(0, 'localhost', resolve))
const port = server.address().port

const hostBinary = path.join(out, 'webkit-host')
if (engines.includes('webkit')) {
  execFileSync('swiftc', ['-O', path.join(here, 'webkit-host.swift'), '-o', hostBinary], { stdio: 'inherit' })
}

function runWebKit(url, target) {
  return new Promise((resolve, reject) => {
    const child = spawn(hostBinary, [url, target], { stdio: ['ignore', 'ignore', 'inherit'] })
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`webkit-host exited ${code}`))))
  })
}

async function runChromium(url, target) {
  const chrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
  const profile = mkdtempSync(path.join(tmpdir(), 'fd-stream-qa-chrome-'))
  const debugPort = 9300 + Math.floor(Math.random() * 500)
  const child = spawn(chrome, [
    `--remote-debugging-port=${debugPort}`,
    `--user-data-dir=${profile}`,
    '--headless=new',
    '--no-first-run',
    '--disable-background-timer-throttling',
    '--disable-renderer-backgrounding',
    '--disable-backgrounding-occluded-windows',
    '--window-size=1040,800',
    'about:blank',
  ], { stdio: 'ignore' })
  try {
    let page
    for (let attempt = 0; attempt < 50 && !page; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 200))
      const list = await fetch(`http://127.0.0.1:${debugPort}/json`).then((r) => r.json()).catch(() => [])
      page = list.find((entry) => entry.type === 'page')
    }
    if (!page) throw new Error('Chrome did not start')
    const socket = new WebSocket(page.webSocketDebuggerUrl)
    await new Promise((resolve) => socket.addEventListener('open', resolve))
    let id = 0
    const send = (method, params = {}) => socket.send(JSON.stringify({ id: ++id, method, params }))
    const finished = new Promise((resolve, reject) => {
      socket.addEventListener('message', (message) => {
        const data = JSON.parse(message.data)
        if (data.method !== 'Runtime.bindingCalled') return
        const payload = JSON.parse(data.params.payload)
        if (payload.cmd === 'wheel') {
          send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: 500, y: 350, deltaX: 0, deltaY: payload.deltaY })
        } else if (payload.cmd === 'done') {
          writeFileSync(target, payload.result)
          resolve()
        } else if (payload.cmd === 'error') {
          reject(new Error(payload.message))
        }
      })
    })
    send('Runtime.enable')
    send('Page.enable')
    send('Runtime.addBinding', { name: 'qaHost' })
    send('Page.navigate', { url })
    await Promise.race([
      finished,
      new Promise((_, reject) => setTimeout(() => reject(new Error('Chrome run timed out')), 180_000)),
    ])
    socket.close()
  } finally {
    child.kill()
    await new Promise((resolve) => setTimeout(resolve, 300))
    rmSync(profile, { recursive: true, force: true })
  }
}

let failed = 0
for (const engine of engines) {
  for (const name of names) {
    for (let index = 0; index < repeat; index += 1) {
      const suffix = repeat > 1 ? `-${index + 1}` : ''
      const target = path.join(out, `${label}-${engine}-${name}${suffix}.json`)
      const url = `http://localhost:${port}/stream-qa.html?${scenarios[name]}`
      process.stdout.write(`${label} ${engine} ${name}${suffix} … `)
      try {
        await (engine === 'webkit' ? runWebKit(url, target) : runChromium(url, target))
        console.log('ok')
      } catch (cause) {
        failed += 1
        console.log(String(cause))
      }
    }
  }
}
server.close()
process.exit(failed ? 1 : 0)
