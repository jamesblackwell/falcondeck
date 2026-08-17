/**
 * Test renderer for React Native components in Vitest.
 * Uses react-test-renderer which works with any component type
 * (no DOM required — handles View, Pressable, etc).
 */
import React from 'react'
import TestRenderer, { act } from 'react-test-renderer'

const activeRenderers = new Set<TestRenderer.ReactTestRenderer>()

export function renderComponent(
  element: React.ReactElement,
  /** Stand-ins for host refs — components that call imperative methods on a
   *  ref (ScrollView.scrollTo, TextInput.focus) get null without these. */
  nodeMocks?: Record<string, unknown>,
): TestRenderer.ReactTestRenderer {
  let renderer!: TestRenderer.ReactTestRenderer
  act(() => {
    renderer = TestRenderer.create(element, {
      createNodeMock: (node) =>
        nodeMocks?.[String(node.type)] ?? null,
    })
  })
  activeRenderers.add(renderer)
  return renderer
}

export function cleanup() {
  if (activeRenderers.size === 0) return
  act(() => {
    for (const renderer of activeRenderers) {
      renderer.unmount()
    }
  })
  activeRenderers.clear()
}

/**
 * For memo-wrapped components without hooks — call inner function directly.
 */
export function renderPure(Component: any, props: any): any {
  const inner = Component.type ?? Component
  return inner(props)
}

/**
 * Extract all text from a test renderer tree.
 */
export function textOf(renderer: TestRenderer.ReactTestRenderer): string {
  return extractText(renderer.toJSON())
}

function extractText(node: any): string {
  if (node == null) return ''
  if (typeof node === 'string') return node
  if (typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(extractText).join('')
  if (node.children) return node.children.map(extractText).join('')
  return ''
}
