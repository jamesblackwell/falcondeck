import type { TestingLibraryMatchers } from '@testing-library/jest-dom/matchers'

// jest-dom still augments vitest's `Assertion`, which 3.2 replaced with
// `Matchers`. Without this bridge every `toBeInTheDocument` is a type error
// even though the matcher is registered at runtime by the setup file.
declare module 'vitest' {
  interface Matchers<T = unknown> extends TestingLibraryMatchers<void, T> {}
}
