import '@testing-library/jest-dom/vitest'

// Radix popovers position through floating-ui, which expects ResizeObserver;
// jsdom has none, so tests that open a popover need this stub.
class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}

globalThis.ResizeObserver ??= ResizeObserverStub as unknown as typeof ResizeObserver
