/**
 * Developer diagnostics: live CPU/RAM readout for this process, the floating
 * perf overlay toggle, and a shortcut to the connection log. Sampling only
 * runs while this screen is mounted, so it costs nothing in normal use.
 */
import { useEffect, useState } from 'react'
import { ScrollView } from 'react-native'
import { ScrollText } from 'lucide-react-native'
import { useUnistyles } from 'react-native-unistyles'

import {
  PreferenceSwitch,
  SettingsRow,
  SettingsSection,
  settingsPageStyles,
} from '@/components/settings'
import {
  formatCpu,
  formatMemory,
  isPerfStatsAvailable,
  samplePerfStats,
  type PerfSample,
} from '@/lib/perf-stats'
import { openConnectionDebug, useDevSettingsStore } from '@/store'
import { Text } from '@/components/ui/Text'

const SAMPLE_INTERVAL_MS = 1_000

export default function DeveloperScreen() {
  const { theme } = useUnistyles()
  const showPerfOverlay = useDevSettingsStore((s) => s.showPerfOverlay)
  const setShowPerfOverlay = useDevSettingsStore((s) => s.setShowPerfOverlay)
  const [sample, setSample] = useState<PerfSample | null>(() => samplePerfStats())

  useEffect(() => {
    if (!isPerfStatsAvailable) return
    const timer = setInterval(() => setSample(samplePerfStats()), SAMPLE_INTERVAL_MS)
    return () => clearInterval(timer)
  }, [])

  return (
    <ScrollView
      style={settingsPageStyles.container}
      contentContainerStyle={settingsPageStyles.content}
      contentInsetAdjustmentBehavior="automatic"
    >
      <SettingsSection title="Performance">
        {isPerfStatsAvailable && sample ? (
          <>
            <SettingsRow label="CPU" value={formatCpu(sample.cpuPercent)} />
            <SettingsRow label="Memory" value={formatMemory(sample.memoryBytes)} />
            <SettingsRow label="Threads" value={String(sample.threadCount)} />
          </>
        ) : (
          <Text
            variant="caption"
            size="xs"
            color="muted"
            style={{ padding: theme.spacing[4] }}
          >
            Performance sampling needs a newer TestFlight build — this binary
            predates the native sampler.
          </Text>
        )}
        <PreferenceSwitch
          label="Performance overlay"
          description="Float a small CPU and memory readout over the app."
          value={showPerfOverlay}
          disabled={!isPerfStatsAvailable}
          onValueChange={setShowPerfOverlay}
        />
      </SettingsSection>

      <SettingsSection title="Connection">
        <SettingsRow
          label="Connection log"
          detail="Relay, encryption, and sync activity"
          icon={<ScrollText size={theme.iconSize.sm} color={theme.colors.info.default} />}
          onPress={openConnectionDebug}
        />
      </SettingsSection>
    </ScrollView>
  )
}
