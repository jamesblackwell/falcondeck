import * as SecureStore from 'expo-secure-store'

const KEY_CLIENT_SECRET = 'fd.clientSecretKey'
const KEY_DATA_KEY = 'fd.dataKey'
const KEY_CLIENT_TOKEN = 'fd.clientToken'

export async function persistClientSecretKey(base64: string): Promise<void> {
  await SecureStore.setItemAsync(KEY_CLIENT_SECRET, base64)
}

export async function loadClientSecretKey(): Promise<string | null> {
  return SecureStore.getItemAsync(KEY_CLIENT_SECRET)
}

export async function persistDataKey(base64: string): Promise<void> {
  await SecureStore.setItemAsync(KEY_DATA_KEY, base64)
}

export async function loadDataKey(): Promise<string | null> {
  return SecureStore.getItemAsync(KEY_DATA_KEY)
}

export async function persistClientToken(token: string): Promise<void> {
  await SecureStore.setItemAsync(KEY_CLIENT_TOKEN, token)
}

export async function loadClientToken(): Promise<string | null> {
  return SecureStore.getItemAsync(KEY_CLIENT_TOKEN)
}

export async function clearSecureSession(): Promise<void> {
  await Promise.all([
    SecureStore.deleteItemAsync(KEY_CLIENT_SECRET),
    SecureStore.deleteItemAsync(KEY_DATA_KEY),
    SecureStore.deleteItemAsync(KEY_CLIENT_TOKEN),
  ])
}
