import type { ExpoConfig, ConfigContext } from 'expo/config'

export default ({ config }: ConfigContext): ExpoConfig => ({
  ...config,
  name: 'FalconDeck',
  slug: 'falcondeck-mobile',
  version: '0.1.0',
  scheme: 'falcondeck',
  orientation: 'default',
  userInterfaceStyle: 'dark',
  newArchEnabled: true,
  icon: './assets/icon.png',
  splash: {
    image: './assets/splash.png',
    resizeMode: 'contain',
    backgroundColor: '#09090b',
  },
  ios: {
    bundleIdentifier: 'com.falcondeck.mobile',
    supportsTablet: true,
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
    'expo-font',
    [
      'expo-camera',
      {
        cameraPermission: 'Allow FalconDeck to use your camera to scan QR codes for pairing.',
      },
    ],
  ],
  experiments: {
    typedRoutes: true,
  },
  extra: {
    relayUrl: process.env.FALCONDECK_RELAY_URL ?? 'https://connect.falcondeck.com',
  },
})
