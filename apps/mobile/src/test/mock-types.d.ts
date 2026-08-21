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

declare module 'expo-device' {
  export function __setIsDevice(next: boolean): void
}

declare module 'expo-notifications' {
  export function __reset(): void
  export function __setPermissions(
    next: { granted: boolean; canAskAgain: boolean; status: string },
    onRequest?: { granted: boolean; canAskAgain: boolean; status: string },
  ): void
  export function __setPermissionRequestHook(hook: (() => void | Promise<void>) | null): void
  export function __setPushToken(next: string | null): void
  export function __setPushTokenError(error: Error): void
  export function __setLastResponse(next: unknown): void
  export function __getLastResponse(): unknown
  export function __emitResponse(event: unknown): void
  export function __getHandler(): {
    handleNotification: (notification: unknown) => Promise<{
      shouldShowBanner: boolean
      shouldShowList: boolean
      shouldPlaySound: boolean
      shouldSetBadge: boolean
    }>
  } | null
  export function __getChannels(): Map<string, unknown>
}

declare module 'expo-file-system' {
  export function resetFileSystemMock(): void
  export function __setFileText(impl: () => Promise<string>): void
}

declare module 'expo-asset' {
  export function __setAssetLocalUri(uri: string | null): void
  export function __resetAssetMock(): void
}

declare module 'react-native-webview' {
  export function WebView(props: unknown): null
  export function __setWebViewMessage(next: unknown): void
  export function __resetWebViewMock(): void
}
