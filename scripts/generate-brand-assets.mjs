import { execFileSync } from 'node:child_process'
import { copyFileSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
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

/**
 * Generate a macOS .icns with the falcon mark inside a rounded rectangle
 * on a transparent background.  macOS does not auto-apply the squircle mask
 * to .icns files (unlike iOS), so we bake the shape into the icon itself.
 */
function generateMacOSIcns(markSource, output, bgColor) {
  const tmp = resolve(repoRoot, '.tmp-macicon')
  const iconsetDir = resolve(tmp, 'icon.iconset')
  ensureDir(iconsetDir)

  // macOS iconset spec: each base size plus its @2x variant
  const specs = [
    { name: 'icon_16x16.png', size: 16 },
    { name: 'icon_16x16@2x.png', size: 32 },
    { name: 'icon_32x32.png', size: 32 },
    { name: 'icon_32x32@2x.png', size: 64 },
    { name: 'icon_128x128.png', size: 128 },
    { name: 'icon_128x128@2x.png', size: 256 },
    { name: 'icon_256x256.png', size: 256 },
    { name: 'icon_256x256@2x.png', size: 512 },
    { name: 'icon_512x512.png', size: 512 },
    { name: 'icon_512x512@2x.png', size: 1024 },
  ]

  // Pre-rasterize the SVG mark to a large PNG first — ImageMagick's SVG
  // renderer struggles with complex paths inside multi-step composite commands.
  const markPng = resolve(tmp, 'mark.png')
  run('magick', ['-background', 'none', '-density', '144', markSource, '-resize', '1024x1024', `png32:${markPng}`])

  for (const { name, size } of specs) {
    // Apple's macOS icon corner radius is ~22.37% of the icon width
    const radius = Math.round(size * 0.2237)
    const markSize = Math.round(size * 0.62)
    const target = resolve(iconsetDir, name)

    run('magick', [
      // Transparent canvas with dark rounded-rect background
      '(', '-size', `${size}x${size}`, 'xc:none',
      '-fill', bgColor,
      '-draw', `roundrectangle 0,0 ${size - 1},${size - 1} ${radius},${radius}`,
      ')',
      // White falcon mark, resized and centered
      '(', markPng, '-resize', `${markSize}x${markSize}`, ')',
      '-gravity', 'center', '-composite',
      `png32:${target}`,
    ])
  }

  // Pack into .icns using Apple's built-in tool
  run('iconutil', ['-c', 'icns', '-o', output, iconsetDir])
  rmSync(tmp, { recursive: true, force: true })
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

  // Override the .icns with a properly shaped macOS icon (rounded corners on transparent bg).
  // Tauri generates a full-bleed square which renders with hard corners on macOS.
  generateMacOSIcns(sources.markLight, resolve(iconsDir, 'icon.icns'), darkBackground)
}

if (args.has('--desktop-only')) {
  generateDesktopAssets()
} else {
  generateMobileAssets()
  generateDesktopAssets()
  generateWebAssets(siteDir, 'FalconDeck', 'FalconDeck')
  generateWebAssets(remoteWebDir, 'FalconDeck Remote', 'FalconDeck')
}
