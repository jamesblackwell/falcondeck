import '@testing-library/jest-dom/vitest'

// Radix popovers position through floating-ui, which expects ResizeObserver;
// jsdom has none, so tests that open a popover need this stub.
class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}

globalThis.ResizeObserver ??= ResizeObserverStub as unknown as typeof ResizeObserver

Element.prototype.hasPointerCapture ??= (() => false) as typeof Element.prototype.hasPointerCapture
Element.prototype.setPointerCapture ??= (() => {}) as typeof Element.prototype.setPointerCapture
Element.prototype.releasePointerCapture ??= (() => {}) as typeof Element.prototype.releasePointerCapture
Element.prototype.scrollIntoView ??= (() => {}) as typeof Element.prototype.scrollIntoView
