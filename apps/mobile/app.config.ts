import type { ExpoConfig, ConfigContext } from 'expo/config'

export default ({ config }: ConfigContext): ExpoConfig => {
  const owner = process.env.EXPO_OWNER ?? 'quizgecko'
  const projectId = process.env.EXPO_PROJECT_ID ?? '14208bcf-41e5-478e-b88c-386745568d6a'

  return {
    ...config,
    owner,
    name: 'FalconDeck',
    slug: 'falcondeck-mobile',
    version: '0.1.0',
    scheme: 'falcondeck',
    orientation: 'default',
    userInterfaceStyle: 'dark',
    newArchEnabled: true,
    runtimeVersion: {
      policy: 'appVersion',
    },
    icon: './assets/icon.png',
    splash: {
      image: './assets/splash.png',
      resizeMode: 'contain',
      backgroundColor: '#09090b',
    },
    updates: {
      url: `https://u.expo.dev/${projectId}`,
      fallbackToCacheTimeout: 0,
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
        monochromeImage: './assets/adaptive-icon-monochrome.png',
        backgroundColor: '#09090b',
      },
    },
    web: {
      bundler: 'metro',
      favicon: './assets/icon.png',
    },
    plugins: [
      [
        'expo-build-properties',
        {
          ios: {
            deploymentTarget: '16.0',
          },
        },
      ],
      [
        'expo-router',
        {
          root: './src/app',
        },
      ],
      'expo-secure-store',
      'expo-font',
      'expo-splash-screen',
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
      eas: {
        projectId,
      },
    },
  }
}
