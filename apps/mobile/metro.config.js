const { getDefaultConfig } = require('expo/metro-config')
const path = require('path')

const projectRoot = __dirname
const monorepoRoot = path.resolve(projectRoot, '../..')

const config = getDefaultConfig(projectRoot)

// Watch the monorepo packages
config.watchFolders = Array.from(new Set([...(config.watchFolders ?? []), monorepoRoot]))

// Resolve from both app and monorepo root node_modules
config.resolver.nodeModulesPaths = [
  path.resolve(projectRoot, 'node_modules'),
  path.resolve(monorepoRoot, 'node_modules'),
]

// Block the root monorepo copies of react/react-native/react-dom.
// These are different versions (e.g. react-native 0.81.6 at root vs 0.81.5 local)
// and loading both causes "property is not writable" crashes.
const rootNodeModules = path.resolve(monorepoRoot, 'node_modules')
const blockedPaths = ['react', 'react-native', 'react-dom'].map(
  (pkg) => new RegExp(`^${rootNodeModules.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/${pkg}/`),
)

config.resolver.blockList = [
  ...(Array.isArray(config.resolver.blockList)
    ? config.resolver.blockList
    : config.resolver.blockList
      ? [config.resolver.blockList]
      : []),
  ...blockedPaths,
]

module.exports = config
