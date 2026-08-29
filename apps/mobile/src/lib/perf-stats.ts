/**
 * Own-process CPU/memory sampling, backed by the FalconDeckPerf native module
 * (modules/falcondeck-perf). The module ships with TestFlight builds ≥ 55;
 * older binaries running a newer OTA bundle simply report it as unavailable,
 * so every caller must handle the null case.
 */
import { requireOptionalNativeModule } from 'expo-modules-core'

export type PerfSample = {
  /** Percent of one core; >100 means more than one core busy. */
  cpuPercent: number
  /** Physical footprint in bytes (matches Xcode's memory gauge). */
  memoryBytes: number
  threadCount: number
}

type NativePerfModule = {
  sample(): PerfSample
}

const native = requireOptionalNativeModule<NativePerfModule>('FalconDeckPerf')

export const isPerfStatsAvailable = native !== null

export function samplePerfStats(): PerfSample | null {
  if (!native) return null
  try {
    const sample = native.sample()
    return sample.cpuPercent < 0 || sample.memoryBytes < 0 ? null : sample
  } catch {
    return null
  }
}

export function formatMemory(bytes: number): string {
  const mb = bytes / (1024 * 1024)
  return mb >= 1024 ? `${(mb / 1024).toFixed(2)} GB` : `${Math.round(mb)} MB`
}

export function formatCpu(percent: number): string {
  return `${percent < 10 ? percent.toFixed(1) : Math.round(percent)}%`
}
