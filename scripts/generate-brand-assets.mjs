import { execFileSync } from 'node:child_process'
import { copyFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const scriptDir = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(scriptDir, '..')
const brandDir = resolve(repoRoot, 'assets', 'brand')
const desktopDir = resolve(repoRoot, 'apps', 'desktop')
const mobileDir = resolve(repoRoot, 'apps', 'mobile')
const remoteWebDir = resolve(repoRoot, 'apps', 'remote-web')
const siteDir = resolve(repoRoot, 'apps', 'site')
const darkBackground = '#111113'

const sources = {
  dark: resolve(brandDir, 'logomark-dark.svg'),
  light: resolve(brandDir, 'logomark-light.svg'),
  markDark: resolve(brandDir, 'logomark-mark-dark.svg'),
  markLight: resolve(brandDir, 'logomark-mark-light.svg'),
}
const args = new Set(process.argv.slice(2))

function run(command, args, cwd = repoRoot) {
  execFileSync(command, args, { cwd, stdio: 'inherit' })
}

function ensureDir(path) {
  mkdirSync(path, { recursive: true })
}

function renderSquare(source, target, size) {
  run('magick', [source, '-resize', `${size}x${size}`, target])
}

function renderPaddedTransparent(source, target, iconSize, canvasSize) {
  renderPaddedTransparentRect(source, target, iconSize, canvasSize, canvasSize)
}

function renderPaddedTransparentRect(source, target, iconSize, width, height) {
  run('magick', [
    source,
    '-background',
    'none',
    '-resize',
    `${iconSize}x${iconSize}`,
    '-gravity',
    'center',
    '-extent',
    `${width}x${height}`,
    `png32:${target}`,
  ])
}

function renderPaddedOnSolid(source, target, iconSize, canvasSize, backgroundColor) {
  run('magick', [
    source,
    '-background',
    backgroundColor,
    '-resize',
    `${iconSize}x${iconSize}`,
    '-gravity',
    'center',
    '-extent',
    `${canvasSize}x${canvasSize}`,
    target,
  ])
}

function writeWebManifest(target, name, shortName) {
  const manifest = {
    name,
    short_name: shortName,
    theme_color: darkBackground,
    background_color: darkBackground,
    display: 'standalone',
    icons: [
      { src: '/icon-192.png', sizes: '192x192', type: 'image/png' },
      { src: '/icon-512.png', sizes: '512x512', type: 'image/png' },
      { src: '/icon-maskable-192.png', sizes: '192x192', type: 'image/png', purpose: 'maskable' },
      { src: '/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ],
  }

  writeFileSync(target, `${JSON.stringify(manifest, null, 2)}\n`)
}

function generateWebAssets(appDir, manifestName, manifestShortName) {
  const publicDir = resolve(appDir, 'public')
  ensureDir(publicDir)

  copyFileSync(sources.markDark, resolve(publicDir, 'favicon.svg'))
  copyFileSync(sources.markDark, resolve(publicDir, 'safari-pinned-tab.svg'))

  renderSquare(sources.dark, resolve(publicDir, 'apple-touch-icon.png'), 180)
  renderSquare(sources.dark, resolve(publicDir, 'favicon-32x32.png'), 32)
  renderSquare(sources.dark, resolve(publicDir, 'favicon-16x16.png'), 16)
  renderSquare(sources.dark, resolve(publicDir, 'icon-192.png'), 192)
  renderSquare(sources.dark, resolve(publicDir, 'icon-512.png'), 512)
  renderPaddedOnSolid(sources.markLight, resolve(publicDir, 'icon-maskable-192.png'), 144, 192, darkBackground)
  renderPaddedOnSolid(sources.markLight, resolve(publicDir, 'icon-maskable-512.png'), 384, 512, darkBackground)
  writeWebManifest(resolve(publicDir, 'site.webmanifest'), manifestName, manifestShortName)
}

function generateMobileAssets() {
  const assetsDir = resolve(mobileDir, 'assets')
  ensureDir(assetsDir)

  renderSquare(sources.dark, resolve(assetsDir, 'icon.png'), 1024)
  renderPaddedTransparent(sources.markLight, resolve(assetsDir, 'adaptive-icon.png'), 760, 1024)
  renderPaddedTransparent(sources.markLight, resolve(assetsDir, 'adaptive-icon-monochrome.png'), 760, 1024)
  renderPaddedTransparentRect(sources.markLight, resolve(assetsDir, 'splash.png'), 720, 1284, 2778)
}

function generateDesktopAssets() {
  const publicDir = resolve(desktopDir, 'public')
  const iconsDir = resolve(desktopDir, 'src-tauri', 'icons')

  ensureDir(publicDir)
  copyFileSync(sources.markDark, resolve(publicDir, 'favicon.svg'))
  renderSquare(sources.dark, resolve(publicDir, 'favicon-32x32.png'), 32)

  ensureDir(iconsDir)
  run('npm', ['exec', 'tauri', 'icon', '--', '../../assets/brand/logomark-dark.svg', '-o', 'src-tauri/icons', '--ios-color', darkBackground], desktopDir)
}

if (args.has('--desktop-only')) {
  generateDesktopAssets()
} else {
  generateMobileAssets()
  generateDesktopAssets()
  generateWebAssets(siteDir, 'FalconDeck', 'FalconDeck')
  generateWebAssets(remoteWebDir, 'FalconDeck Remote', 'FalconDeck')
}
