const { withAppDelegate } = require('expo/config-plugins')

/**
 * Ask iOS for the standard ~30s background execution window so the relay
 * WebSocket can survive a short app switch. No extra UIBackgroundModes.
 * beginBackgroundTask does not keep the process alive after that window.
 *
 * Prebuild regenerates AppDelegate.swift; this plugin re-inserts the hold.
 */
const PROPERTY = `  // Keep the JS relay WebSocket alive across a short app switch. iOS
  // otherwise suspends the process and tears the socket down within
  // seconds. This is the standard ~30s window, not a background mode.
  private var relayBackgroundTask: UIBackgroundTaskIdentifier = .invalid
`

const METHODS = `
  public override func applicationWillResignActive(_ application: UIApplication) {
    super.applicationWillResignActive(application)
    beginRelayBackgroundHold(application)
  }

  public override func applicationDidEnterBackground(_ application: UIApplication) {
    super.applicationDidEnterBackground(application)
    beginRelayBackgroundHold(application)
  }

  public override func applicationWillEnterForeground(_ application: UIApplication) {
    endRelayBackgroundHold(application)
    super.applicationWillEnterForeground(application)
  }

  public override func applicationDidBecomeActive(_ application: UIApplication) {
    endRelayBackgroundHold(application)
    super.applicationDidBecomeActive(application)
  }

  private func beginRelayBackgroundHold(_ application: UIApplication) {
    if relayBackgroundTask != .invalid { return }
    relayBackgroundTask = application.beginBackgroundTask(withName: "falcondeck.relay") { [weak self] in
      self?.endRelayBackgroundHold(application)
    }
  }

  private func endRelayBackgroundHold(_ application: UIApplication) {
    let task = relayBackgroundTask
    relayBackgroundTask = .invalid
    if task != .invalid {
      application.endBackgroundTask(task)
    }
  }
`

module.exports = function withRelayBackgroundHold(config) {
  return withAppDelegate(config, (cfg) => {
    if (cfg.modResults.language !== 'swift') {
      throw new Error('withRelayBackgroundHold requires a Swift AppDelegate')
    }

    let src = cfg.modResults.contents
    if (src.includes('beginRelayBackgroundHold')) {
      return cfg
    }

    if (!src.includes('var reactNativeFactory: RCTReactNativeFactory?')) {
      throw new Error('withRelayBackgroundHold: could not find reactNativeFactory on AppDelegate')
    }
    src = src.replace(
      'var reactNativeFactory: RCTReactNativeFactory?\n',
      `var reactNativeFactory: RCTReactNativeFactory?\n${PROPERTY}\n`,
    )

    if (src.includes('  // Linking API\n')) {
      src = src.replace('  // Linking API\n', `${METHODS}\n  // Linking API\n`)
    } else if (src.includes('\nclass ReactNativeDelegate')) {
      src = src.replace('\nclass ReactNativeDelegate', `${METHODS}\nclass ReactNativeDelegate`)
    } else {
      throw new Error('withRelayBackgroundHold: could not find an insertion point in AppDelegate')
    }

    cfg.modResults.contents = src
    return cfg
  })
}
