// Type augmentations for test mock helpers.
// Vitest resolves these modules to our manual mocks which export reset helpers.
// The top-level export makes this a module, so declare module augments rather than replaces.

export {}

declare module 'expo-secure-store' {
  export function __reset(): void
}

declare module 'react-native-mmkv' {
  export function __resetAllStores(): void
}
