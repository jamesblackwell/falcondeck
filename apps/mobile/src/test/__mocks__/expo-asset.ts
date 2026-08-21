let localUri: string | null = 'file:///mock-mermaid.txt'

export class Asset {
  get localUri() {
    return localUri
  }

  static fromModule(_module: unknown) {
    return new Asset()
  }

  async downloadAsync() {
    return this
  }
}

export function __setAssetLocalUri(uri: string | null) {
  localUri = uri
}

export function __resetAssetMock() {
  localUri = 'file:///mock-mermaid.txt'
}
