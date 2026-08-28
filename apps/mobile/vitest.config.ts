import { defineConfig } from 'vitest/config'
import path from 'path'

export default defineConfig({
  resolve: {
    alias: {
      '@/': path.resolve(__dirname, 'src') + '/',
      '@falcondeck/client-core': path.resolve(__dirname, '../../packages/client-core/src/index.ts'),
      // Match Metro's single-React invariant. Hoisted Zustand otherwise loads
      // the root desktop React while react-test-renderer uses mobile's React,
      // producing a second dispatcher and invalid-hook-call failures.
      'react/jsx-runtime': path.resolve(__dirname, 'node_modules/react/jsx-runtime.js'),
      'react/jsx-dev-runtime': path.resolve(__dirname, 'node_modules/react/jsx-dev-runtime.js'),
      react: path.resolve(__dirname, 'node_modules/react/index.js'),
      // Stub React Native modules that aren't available in Node
      'react-native': path.resolve(__dirname, 'src/test/__mocks__/react-native.ts'),
      'react-native-mmkv': path.resolve(__dirname, 'src/test/__mocks__/react-native-mmkv.ts'),
      'expo-secure-store': path.resolve(__dirname, 'src/test/__mocks__/expo-secure-store.ts'),
      'expo-haptics': path.resolve(__dirname, 'src/test/__mocks__/expo-haptics.ts'),
      'expo-image': path.resolve(__dirname, 'src/test/__mocks__/expo-image.ts'),
      'expo-image-picker': path.resolve(__dirname, 'src/test/__mocks__/expo-image-picker.ts'),
      'expo-file-system': path.resolve(__dirname, 'src/test/__mocks__/expo-file-system.ts'),
      'expo-asset': path.resolve(__dirname, 'src/test/__mocks__/expo-asset.ts'),
      'expo-audio': path.resolve(__dirname, 'src/test/__mocks__/expo-audio.ts'),
      'expo-speech-recognition': path.resolve(__dirname, 'src/test/__mocks__/expo-speech-recognition.ts'),
      'expo-sharing': path.resolve(__dirname, 'src/test/__mocks__/expo-sharing.ts'),
      'expo-modules-core': path.resolve(__dirname, 'src/test/__mocks__/expo-modules-core.ts'),
      'react-native-unistyles': path.resolve(__dirname, 'src/test/__mocks__/react-native-unistyles.ts'),
      'react-native-reanimated': path.resolve(__dirname, 'src/test/__mocks__/react-native-reanimated.ts'),
      'react-native-audio-api': path.resolve(__dirname, 'src/test/__mocks__/react-native-audio-api.ts'),
      'expo-router': path.resolve(__dirname, 'src/test/__mocks__/expo-router.ts'),
      'expo-router/drawer': path.resolve(__dirname, 'src/test/__mocks__/expo-router.ts'),
      'expo-clipboard': path.resolve(__dirname, 'src/test/__mocks__/expo-clipboard.ts'),
      'expo-constants': path.resolve(__dirname, 'src/test/__mocks__/expo-constants.ts'),
      'expo-device': path.resolve(__dirname, 'src/test/__mocks__/expo-device.ts'),
      'expo-notifications': path.resolve(__dirname, 'src/test/__mocks__/expo-notifications.ts'),
      'lucide-react-native': path.resolve(__dirname, 'src/test/__mocks__/lucide-react-native.ts'),
      'react-native-svg': path.resolve(__dirname, 'src/test/__mocks__/react-native-svg.ts'),
      'react-native-webview': path.resolve(__dirname, 'src/test/__mocks__/react-native-webview.ts'),
      'react-native-safe-area-context': path.resolve(__dirname, 'src/test/__mocks__/react-native-safe-area-context.ts'),
      'react-native-markdown-display': path.resolve(__dirname, 'src/test/__mocks__/react-native-markdown-display.ts'),
      '@shopify/flash-list': path.resolve(__dirname, 'src/test/__mocks__/flash-list.tsx'),
      '@bsky.app/react-native-uitextview': path.resolve(
        __dirname,
        'src/test/__mocks__/react-native-uitextview.ts',
      ),
    },
  },
  esbuild: {
    jsx: 'automatic',
  },
  test: {
    globals: true,
    environment: 'node',
    setupFiles: './src/test/setup.ts',
    server: {
      // Transform the hoisted package so its React import passes through the
      // mobile alias above instead of Node resolving root React directly.
      deps: { inline: ['zustand'] },
    },
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts', 'src/**/*.tsx'],
      exclude: [
        'src/test/**',
        'src/app/**',            // Expo Router screens — UI wiring, tested via component tests
        'src/theme/**',          // Pure token config, no logic
        'src/**/*.test.*',
        'src/hooks/**',          // React hooks — require full RN runtime, tested via E2E
      ],
      thresholds: {
        statements: 100,
        branches: 90,
        functions: 85,
        lines: 100,
      },
    },
  },
})
