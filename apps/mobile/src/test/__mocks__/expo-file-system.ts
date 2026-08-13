export const fileSystemEvents: Array<{ type: string; value?: unknown }> = []

export const Paths = {
  cache: { uri: 'file:///mock-cache/' },
  document: { uri: 'file:///mock-documents/' },
}

export class Directory {
  uri: string
  exists = false

  constructor(directory: { uri?: string } | string, filename?: string) {
    const base = typeof directory === 'string' ? directory : directory.uri ?? 'file:///mock-cache/'
    this.uri = filename ? `${base}${filename}/` : base
  }

  create(options?: unknown) {
    this.exists = true
    fileSystemEvents.push({ type: 'directory-create', value: options })
  }

  delete() {
    this.exists = false
    fileSystemEvents.push({ type: 'directory-delete' })
  }
}

export class File {
  uri: string
  exists = false

  constructor(directory: { uri?: string } | string, filename?: string) {
    const base = typeof directory === 'string' ? directory : directory.uri ?? 'file:///mock-cache/'
    this.uri = filename ? `${base}${filename}` : base
  }

  create(options?: unknown) {
    this.exists = true
    fileSystemEvents.push({ type: 'create', value: options })
  }

  write(content: string | Uint8Array, options?: unknown) {
    fileSystemEvents.push({ type: 'write', value: { content, options } })
  }

  async base64() {
    return 'bW9jay1hdWRpbw=='
  }

  move(destination: File) {
    this.uri = destination.uri
    this.exists = true
    destination.exists = true
    fileSystemEvents.push({ type: 'move', value: destination.uri })
  }

  delete() {
    this.exists = false
    fileSystemEvents.push({ type: 'delete' })
  }
}

export function resetFileSystemMock() {
  fileSystemEvents.length = 0
}
