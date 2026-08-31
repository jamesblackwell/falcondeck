/**
 * Small always-on-top CPU/RAM readout, toggled from Settings → Developer.
 * Touch-transparent and cheap: one native sample every 2s, no animations.
 */
import { memo, useEffect, useState } from 'react'
import { View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { StyleSheet } from 'react-native-unistyles'

import {
  formatCpu,
  formatMemory,
  samplePerfStats,
  type PerfSample,
} from '@/lib/perf-stats'
import { useDevSettingsStore } from '@/store'
import { Text } from '@/components/ui/Text'

const SAMPLE_INTERVAL_MS = 2_000

export const PerfOverlay = memo(function PerfOverlay() {
  const enabled = useDevSettingsStore((s) => s.showPerfOverlay)
  if (!enabled) return null
  return <PerfOverlayBody />
})

function PerfOverlayBody() {
  const insets = useSafeAreaInsets()
  const [sample, setSample] = useState<PerfSample | null>(() => samplePerfStats())

  useEffect(() => {
    const timer = setInterval(() => setSample(samplePerfStats()), SAMPLE_INTERVAL_MS)
    return () => clearInterval(timer)
  }, [])

  const label = sample
    ? `CPU ${formatCpu(sample.cpuPercent)} · ${formatMemory(sample.memoryBytes)} · ${sample.threadCount}T`
    : 'perf n/a'

  return (
    <View
      pointerEvents="none"
      style={[styles.container, { top: insets.top }]}
    >
      <View style={styles.pill}>
        <Text variant="mono" size="2xs" color="secondary" style={styles.label}>
          {label}
        </Text>
      </View>
    </View>
  )
}

const styles = StyleSheet.create((theme) => ({
  container: {
    position: 'absolute',
    right: theme.spacing[2],
    zIndex: 10_000,
  },
  pill: {
    backgroundColor: theme.colors.surface[2],
    borderRadius: theme.radius.full,
    borderWidth: 1,
    borderColor: theme.colors.border.subtle,
    paddingHorizontal: theme.spacing[2],
    paddingVertical: 2,
    opacity: 0.85,
  },
  label: {
    fontVariant: ['tabular-nums'],
  },
}))
