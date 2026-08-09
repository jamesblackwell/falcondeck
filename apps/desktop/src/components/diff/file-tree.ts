export type FileTreeNode = {
  name: string
  path: string
  kind: 'directory' | 'file'
  children: FileTreeNode[]
}

type MutableNode = FileTreeNode & { childMap?: Map<string, MutableNode> }

export function buildFileTree(paths: string[]): FileTreeNode[] {
  const roots = new Map<string, MutableNode>()
  for (const path of paths) {
    const parts = path.split('/').filter(Boolean)
    let siblings = roots
    let currentPath = ''
    for (let index = 0; index < parts.length; index += 1) {
      const name = parts[index]
      if (!name) continue
      currentPath = currentPath ? `${currentPath}/${name}` : name
      const kind = index === parts.length - 1 ? 'file' : 'directory'
      let node = siblings.get(name)
      if (!node) {
        node = { name, path: currentPath, kind, children: [], childMap: new Map() }
        siblings.set(name, node)
      }
      if (kind === 'directory') siblings = node.childMap ?? new Map()
    }
  }

  const finalize = (nodes: Map<string, MutableNode>): FileTreeNode[] =>
    [...nodes.values()]
      .sort((left, right) => {
        if (left.kind !== right.kind) return left.kind === 'directory' ? -1 : 1
        return left.name.localeCompare(right.name)
      })
      .map((node) => ({
        name: node.name,
        path: node.path,
        kind: node.kind,
        children: node.childMap ? finalize(node.childMap) : [],
      }))

  return finalize(roots)
}

export function directoryPathsForMatches(paths: string[]) {
  const directories = new Set<string>()
  for (const path of paths) {
    const parts = path.split('/')
    parts.pop()
    let current = ''
    for (const part of parts) {
      current = current ? `${current}/${part}` : part
      directories.add(current)
    }
  }
  return directories
}
