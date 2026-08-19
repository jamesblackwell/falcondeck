// Node has no native module registry, so optional lookups always miss — which
// is also what a device build without the module reports.
export function requireOptionalNativeModule(): null {
  return null
}

export function requireNativeModule(name: string): never {
  throw new Error(`Native module ${name} is unavailable in tests`)
}
