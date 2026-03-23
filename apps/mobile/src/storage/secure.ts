import * as SecureStore from 'expo-secure-store'

const KEY_CLIENT_SECRET = 'fd.clientSecretKey'
const KEY_DATA_KEY = 'fd.dataKey'
const KEY_CLIENT_TOKEN = 'fd.clientToken'

const STORE_OPTIONS: SecureStore.SecureStoreOptions = {
  keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK,
}

export async function persistClientSecretKey(base64: string): Promise<void> {
  try {
    await SecureStore.setItemAsync(KEY_CLIENT_SECRET, base64, STORE_OPTIONS)
  } catch (e) {
    console.warn('[SecureStore] persistClientSecretKey failed', e)
  }
}

export async function loadClientSecretKey(): Promise<string | null> {
  try {
    return await SecureStore.getItemAsync(KEY_CLIENT_SECRET, STORE_OPTIONS)
  } catch (e) {
    console.warn('[SecureStore] loadClientSecretKey failed', e)
    return null
  }
}

export async function persistDataKey(base64: string): Promise<void> {
  try {
    await SecureStore.setItemAsync(KEY_DATA_KEY, base64, STORE_OPTIONS)
  } catch (e) {
    console.warn('[SecureStore] persistDataKey failed', e)
  }
}

export async function loadDataKey(): Promise<string | null> {
  try {
    return await SecureStore.getItemAsync(KEY_DATA_KEY, STORE_OPTIONS)
  } catch (e) {
    console.warn('[SecureStore] loadDataKey failed', e)
    return null
  }
}

export async function persistClientToken(token: string): Promise<void> {
  try {
    await SecureStore.setItemAsync(KEY_CLIENT_TOKEN, token, STORE_OPTIONS)
  } catch (e) {
    console.warn('[SecureStore] persistClientToken failed', e)
  }
}

export async function loadClientToken(): Promise<string | null> {
  try {
    return await SecureStore.getItemAsync(KEY_CLIENT_TOKEN, STORE_OPTIONS)
  } catch (e) {
    console.warn('[SecureStore] loadClientToken failed', e)
    return null
  }
}

export async function clearSecureSession(): Promise<void> {
  try {
    await Promise.all([
      SecureStore.deleteItemAsync(KEY_CLIENT_SECRET, STORE_OPTIONS),
      SecureStore.deleteItemAsync(KEY_DATA_KEY, STORE_OPTIONS),
      SecureStore.deleteItemAsync(KEY_CLIENT_TOKEN, STORE_OPTIONS),
    ])
  } catch (e) {
    console.warn('[SecureStore] clearSecureSession failed', e)
  }
}
