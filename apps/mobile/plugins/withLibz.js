const { withXcodeProject } = require('expo/config-plugins')

/**
 * react-native-mmkv uses zlib (_crc32) but its podspec doesn't declare the
 * dependency. When react-native-nitro-modules is a direct dep, the pod graph
 * changes and libz is no longer transitively linked to the app target.
 */
module.exports = function withLibz(config) {
  return withXcodeProject(config, (cfg) => {
    const project = cfg.modResults
    const configs = project.pbxXCBuildConfigurationSection()

    for (const key of Object.keys(configs)) {
      const buildConfig = configs[key]
      if (typeof buildConfig !== 'object' || !buildConfig.buildSettings) continue

      // Only modify configs that have INFOPLIST_FILE (= app target, not pods)
      if (!buildConfig.buildSettings.INFOPLIST_FILE) continue

      const flags = buildConfig.buildSettings.OTHER_LDFLAGS
      if (Array.isArray(flags)) {
        if (!flags.includes('"-lz"')) {
          flags.push('"-lz"')
        }
      } else if (typeof flags === 'string') {
        if (!flags.includes('-lz')) {
          buildConfig.buildSettings.OTHER_LDFLAGS = [flags, '"-lz"']
        }
      } else {
        buildConfig.buildSettings.OTHER_LDFLAGS = ['"$(inherited)"', '"-lz"']
      }
    }

    return cfg
  })
}
