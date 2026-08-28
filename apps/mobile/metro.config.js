const { getDefaultConfig } = require('expo/metro-config')
const fs = require('fs')
const path = require('path')

const projectRoot = __dirname
const monorepoRoot = path.resolve(projectRoot, '../..')

const mermaidSrc = path.resolve(monorepoRoot, 'node_modules/mermaid/dist/mermaid.min.js')
const mermaidDest = path.resolve(projectRoot, 'src/vendor/mermaid.min.txt')
if (fs.existsSync(mermaidSrc)) {
  fs.mkdirSync(path.dirname(mermaidDest), { recursive: true })
  const source = fs.statSync(mermaidSrc)
  const needsCopy = !fs.existsSync(mermaidDest) ||
    fs.statSync(mermaidDest).size !== source.size
  if (needsCopy) {
    fs.copyFileSync(mermaidSrc, mermaidDest)
  }
}

const config = getDefaultConfig(projectRoot)

// Ship the mermaid engine as an asset read on demand, not as bundled JS.
config.resolver.assetExts = Array.from(
  new Set([...(config.resolver.assetExts ?? []), 'txt']),
)

// Watch the monorepo packages
config.watchFolders = Array.from(new Set([...(config.watchFolders ?? []), monorepoRoot]))

// Resolve from both app and monorepo root node_modules
config.resolver.nodeModulesPaths = [
  path.resolve(projectRoot, 'node_modules'),
  path.resolve(monorepoRoot, 'node_modules'),
]

// npm hoists these packages to the workspace root. Resolve every import to
// that one SDK-pinned copy, including imports originating inside hoisted Expo
// modules, so Metro cannot create a second React or React Native runtime.
const rootNodeModules = path.resolve(monorepoRoot, 'node_modules')
config.resolver.extraNodeModules = {
  ...(config.resolver.extraNodeModules ?? {}),
  react: path.resolve(rootNodeModules, 'react'),
  'react-dom': path.resolve(rootNodeModules, 'react-dom'),
  'react-native': path.resolve(rootNodeModules, 'react-native'),
}

module.exports = config
