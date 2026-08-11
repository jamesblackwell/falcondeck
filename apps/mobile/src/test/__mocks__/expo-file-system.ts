export const fileSystemEvents: Array<{ type: string; value?: unknown }> = []

export const Paths = {
  cache: { uri: 'file:///mock-cache/' },
}

export class Directory {
  uri: string
  exists = false

  constructor(directory: { uri?: string }, filename: string) {
    this.uri = `${directory.uri ?? 'file:///mock-cache/'}${filename}/`
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

  constructor(directory: { uri?: string }, filename: string) {
    this.uri = `${directory.uri ?? 'file:///mock-cache/'}${filename}`
  }

  create(options?: unknown) {
    this.exists = true
    fileSystemEvents.push({ type: 'create', value: options })
  }

  write(content: string | Uint8Array, options?: unknown) {
    fileSystemEvents.push({ type: 'write', value: { content, options } })
  }

  delete() {
    this.exists = false
    fileSystemEvents.push({ type: 'delete' })
  }
}

export function resetFileSystemMock() {
  fileSystemEvents.length = 0
}
