// Stateful expo-notifications mock for tests
type PermissionsResult = { granted: boolean; canAskAgain: boolean; status: string }
type NotificationBehavior = {
  shouldShowBanner: boolean
  shouldShowList: boolean
  shouldPlaySound: boolean
  shouldSetBadge: boolean
}
export type NotificationResponse = {
  actionIdentifier: string
  notification: { request: { content: { data: unknown } } }
}

let permissions: PermissionsResult = { granted: true, canAskAgain: true, status: 'granted' }
let requestedPermissions: PermissionsResult | null = null
let pushToken: string | null = 'ExponentPushToken[test]'
let tokenError: Error | null = null
let lastResponse: NotificationResponse | null = null
let handler: { handleNotification: (notification: unknown) => Promise<NotificationBehavior> } | null = null

const channels = new Map<string, unknown>()
const responseListeners = new Set<(event: NotificationResponse) => void>()

export const AndroidImportance = { MIN: 1, LOW: 2, DEFAULT: 3, HIGH: 4, MAX: 5 }

export function setNotificationHandler(next: typeof handler) {
  handler = next
}

export async function getPermissionsAsync(): Promise<PermissionsResult> {
  return permissions
}

export async function requestPermissionsAsync(): Promise<PermissionsResult> {
  return requestedPermissions ?? permissions
}

export async function getExpoPushTokenAsync(_options?: { projectId?: string }) {
  if (tokenError) throw tokenError
  if (!pushToken) throw new Error('Push token unavailable')
  return { type: 'expo', data: pushToken }
}

export async function setNotificationChannelAsync(id: string, channel: unknown) {
  channels.set(id, channel)
  return channel
}

export function addNotificationResponseReceivedListener(
  listener: (event: NotificationResponse) => void,
) {
  responseListeners.add(listener)
  return { remove: () => responseListeners.delete(listener) }
}

export async function getLastNotificationResponseAsync(): Promise<NotificationResponse | null> {
  return lastResponse
}

// ── Test helpers ───────────────────────────────────────────────────

export function __setPermissions(next: PermissionsResult, onRequest?: PermissionsResult) {
  permissions = next
  requestedPermissions = onRequest ?? null
}

export function __setPushToken(next: string | null) {
  pushToken = next
  tokenError = null
}

export function __setPushTokenError(error: Error) {
  tokenError = error
}

export function __setLastResponse(next: NotificationResponse | null) {
  lastResponse = next
}

export function __emitResponse(event: NotificationResponse) {
  for (const listener of responseListeners) listener(event)
}

export function __getHandler() {
  return handler
}

export function __getChannels() {
  return channels
}

export function __reset() {
  permissions = { granted: true, canAskAgain: true, status: 'granted' }
  requestedPermissions = null
  pushToken = 'ExponentPushToken[test]'
  tokenError = null
  lastResponse = null
  handler = null
  channels.clear()
  responseListeners.clear()
}
