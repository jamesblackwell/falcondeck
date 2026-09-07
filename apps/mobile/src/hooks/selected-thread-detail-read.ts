let latestRead: object | null = null

/** Screen loads and replay recovery share ownership of the selected tail. */
export function beginSelectedThreadDetailRead(): () => boolean {
  const read = {}
  latestRead = read
  return () => latestRead === read
}
