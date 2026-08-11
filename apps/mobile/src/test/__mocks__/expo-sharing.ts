export const sharingCalls: Array<{ url: string; options: unknown }> = []
let available = true

export async function isAvailableAsync() {
  return available
}

export async function shareAsync(url: string, options: unknown) {
  sharingCalls.push({ url, options })
}

export function setSharingAvailable(value: boolean) {
  available = value
}

export function resetSharingMock() {
  sharingCalls.length = 0
  available = true
}
