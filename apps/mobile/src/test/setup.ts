// React 19 requires test environments to opt in before `act()` can verify
// that component updates are flushed. Keep this global so every component
// test — including tests that import react-test-renderer directly — gets the
// same strict update semantics.
;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true

// React Native 0.81's supported renderer still delegates to
// react-test-renderer, which emits this deprecation notice on every create().
// Suppress only that exact upstream notice so real console errors and act
// warnings remain visible in CI.
const originalConsoleError = console.error
console.error = (...args: unknown[]) => {
  if (
    typeof args[0] === 'string' &&
    args[0].startsWith('react-test-renderer is deprecated.')
  ) {
    return
  }
  originalConsoleError(...args)
}
