// Stub react-native-markdown-display for tests
// The real library uses JSX in .js files which Vite can't parse
import { createElement } from 'react'

export type ASTNode = {
  key: string
  content: string
  sourceInfo?: string
  type: string
  children?: ASTNode[]
}

function Markdown({ children, style, rules }: { children: string; style?: any; rules?: any }) {
  return createElement('View', null, children)
}

export default Markdown
