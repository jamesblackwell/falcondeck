import type { ExpoConfig, ConfigContext } from 'expo/config'

export default ({ config }: ConfigContext): ExpoConfig => ({
  ...config,
  name: 'FalconDeck',
  slug: 'falcondeck-mobile',
  version: '0.1.0',
  scheme: 'falcondeck',
  orientation: 'default',
  userInterfaceStyle: 'automatic',
  newArchEnabled: true,
  runtimeVersion: {
    policy: 'appVersion',
  },
  updates: {
    url: 'https://u.expo.dev/14208bcf-41e5-478e-b88c-386745568d6a',
    checkAutomatically: 'ON_LOAD',
    // Hold the splash up to 3s while a pending OTA downloads, so a fix ships
    // on the FIRST cold launch. At 0 the update only applies on the *second*
    // cold launch, which kept devices on stale bundles for days and made
    // every OTA fix look broken. Requires a native rebuild to take effect.
    fallbackToCacheTimeout: 3000,
  },
  icon: './assets/icon.png',
  splash: {
    image: './assets/splash.png',
    resizeMode: 'contain',
    backgroundColor: '#09090b',
  },
  ios: {
    bundleIdentifier: 'com.falcondeck.mobile',
    supportsTablet: true,
    // Keeps Read Aloud playback running when the device is locked or the app
    // is backgrounded, like a music player. Requires a native rebuild.
    infoPlist: {
      UIBackgroundModes: ['audio'],
    },
    config: {
      usesNonExemptEncryption: false,
    },
  },
  android: {
    package: 'com.falcondeck.mobile',
    adaptiveIcon: {
      foregroundImage: './assets/adaptive-icon.png',
      backgroundColor: '#09090b',
    },
  },
  web: {
    bundler: 'metro',
  },
  plugins: [
    [
      'expo-router',
      {
        root: './src/app',
      },
    ],
    'expo-secure-store',
    // Geist ships with the app so chat typography matches desktop exactly.
    // Without this the theme's family names resolve to nothing: iOS silently
    // falls back to San Francisco — and, critically, third-party apps cannot
    // use SF Mono, so code would render in a *proportional* face.
    //
    // Only Regular/Bold/Italic/BoldItalic are bundled: Geist's Medium and
    // SemiBold files declare their own compatible family names ("Geist
    // SemiBold"), so iOS treats them as separate families and would never
    // match them from `fontFamily: 'Geist'`. Restricting both platforms to the
    // four faces that do share the family keeps weight resolution real and
    // identical everywhere — 500/600 snap to the nearest bundled face rather
    // than rendering as a synthesized weight on one platform only.
    [
      'expo-font',
      {
        ios: {
          fonts: [
            './assets/fonts/Geist-Regular.ttf',
            './assets/fonts/Geist-Bold.ttf',
            './assets/fonts/Geist-Italic.ttf',
            './assets/fonts/Geist-BoldItalic.ttf',
            './assets/fonts/GeistMono-Regular.ttf',
            './assets/fonts/GeistMono-Bold.ttf',
          ],
        },
        // Android has no family-wide weight matching of its own; the plugin
        // generates an XML font family from these definitions and RN's
        // fontWeight/fontStyle select between them.
        android: {
          fonts: [
            {
              fontFamily: 'Geist',
              fontDefinitions: [
                { path: './assets/fonts/Geist-Regular.ttf', weight: 400 },
                { path: './assets/fonts/Geist-Bold.ttf', weight: 700 },
                { path: './assets/fonts/Geist-Italic.ttf', weight: 400, style: 'italic' },
                {
                  path: './assets/fonts/Geist-BoldItalic.ttf',
                  weight: 700,
                  style: 'italic',
                },
              ],
            },
            {
              fontFamily: 'Geist Mono',
              fontDefinitions: [
                { path: './assets/fonts/GeistMono-Regular.ttf', weight: 400 },
                { path: './assets/fonts/GeistMono-Bold.ttf', weight: 700 },
              ],
            },
          ],
        },
      },
    ],
    'expo-notifications',
    [
      'expo-audio',
      {
        microphonePermission: 'Allow FalconDeck to record speech for transcription.',
      },
    ],
    [
      'expo-speech-recognition',
      {
        microphonePermission: 'Allow FalconDeck to record speech for transcription.',
        speechRecognitionPermission: 'Allow FalconDeck to transcribe speech on this device.',
      },
    ],
    [
      'expo-image-picker',
      {
        photosPermission: 'Allow FalconDeck to choose photos to attach to a prompt.',
        cameraPermission: 'Allow FalconDeck to take photos to attach to a prompt.',
      },
    ],
    [
      'expo-camera',
      {
        cameraPermission: 'Allow FalconDeck to use your camera to scan QR codes for pairing.',
      },
    ],
    './plugins/withLibz',
    // Holds the relay WebSocket across a short iOS app switch (~30s).
    // Native AppDelegate change — needs a binary rebuild, not an OTA.
    './plugins/withRelayBackgroundHold',
  ],
  experiments: {
    typedRoutes: true,
  },
  extra: {
    relayUrl: process.env.FALCONDECK_RELAY_URL ?? 'https://connect.falcondeck.com',
    eas: {
      projectId: '14208bcf-41e5-478e-b88c-386745568d6a',
    },
  },
})
