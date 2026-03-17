import { defineConfig } from 'vitest/config'
import path from 'path'

export default defineConfig({
  resolve: {
    alias: {
      '@/': path.resolve(__dirname, 'src') + '/',
      '@falcondeck/client-core': path.resolve(__dirname, '../../packages/client-core/src/index.ts'),
      // Stub React Native modules that aren't available in Node
      'react-native': path.resolve(__dirname, 'src/test/__mocks__/react-native.ts'),
      'react-native-mmkv': path.resolve(__dirname, 'src/test/__mocks__/react-native-mmkv.ts'),
      'expo-secure-store': path.resolve(__dirname, 'src/test/__mocks__/expo-secure-store.ts'),
      'expo-haptics': path.resolve(__dirname, 'src/test/__mocks__/expo-haptics.ts'),
      'react-native-unistyles': path.resolve(__dirname, 'src/test/__mocks__/react-native-unistyles.ts'),
      'react-native-reanimated': path.resolve(__dirname, 'src/test/__mocks__/react-native-reanimated.ts'),
      'expo-router': path.resolve(__dirname, 'src/test/__mocks__/expo-router.ts'),
      'expo-router/drawer': path.resolve(__dirname, 'src/test/__mocks__/expo-router.ts'),
      'expo-clipboard': path.resolve(__dirname, 'src/test/__mocks__/expo-clipboard.ts'),
      'expo-device': path.resolve(__dirname, 'src/test/__mocks__/expo-device.ts'),
      'lucide-react-native': path.resolve(__dirname, 'src/test/__mocks__/lucide-react-native.ts'),
      'react-native-safe-area-context': path.resolve(__dirname, 'src/test/__mocks__/react-native-safe-area-context.ts'),
    },
  },
  esbuild: {
    jsx: 'automatic',
  },
  test: {
    globals: true,
    environment: 'node',
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
