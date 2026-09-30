// Opt-in, synthetic Release-build workload. No pairing or user data needed.
import { useEffect, useState } from 'react'
import { View, ScrollView } from 'react-native'
import { Redirect, useLocalSearchParams } from 'expo-router'
import { useUnistyles } from 'react-native-unistyles'
import { ActivityDiamond } from '@/components/ui/ActivityDiamond'
import { MarkdownRenderer } from '@/components/chat/MarkdownRenderer'
import { Text } from '@/components/ui/Text'
import { samplePerfStats } from '@/lib/perf-stats'
import { AnimationVisibility } from '@/components/ui/AnimationVisibility'

const PARAGRAPH = 'The agent checks **CPU usage**, memory, and responsiveness. Keep the completed paragraphs stable while the current answer streams.\n\n'
const DOCUMENT = PARAGRAPH.repeat(80)

function Workload({ scenario }: { scenario: string }) {
  const { theme } = useUnistyles()
  const [tick, setTick] = useState(0)
  useEffect(() => {
    if (scenario !== 'streaming' && scenario !== 'sampling') return
    const timer = setInterval(() => {
      if (scenario === 'sampling') samplePerfStats()
      else setTick(value => value + 1)
    }, scenario === 'sampling' ? 10 : 100)
    return () => clearInterval(timer)
  }, [scenario])
  return (
    <AnimationVisibility active={scenario !== 'hidden'}>
    <View style={{ flex: 1, backgroundColor: theme.colors.surface[0], paddingTop: 64 }}>
      <Text accessibilityLabel={`perf-ready-${scenario}`} variant="label">Performance workload: {scenario}</Text>
      {scenario === 'diamonds' || scenario === 'diamond' || scenario === 'hidden' ? (
        <View style={{ gap: 16, padding: 24, opacity: scenario === 'hidden' ? 0 : 1 }}>
          {Array.from({ length: scenario === 'diamond' ? 1 : 20 }, (_, index) => (
            <ActivityDiamond key={index} size={14} color={theme.colors.accent.default} />
          ))}
        </View>
      ) : null}
      {scenario === 'streaming' ? (
        <ScrollView><MarkdownRenderer streaming text={DOCUMENT + 'Streaming tokens '.repeat(1 + tick % 80)} /></ScrollView>
      ) : null}
    </View>
    </AnimationVisibility>
  )
}

export default function PerfQaScreen() {
  const { scenario = 'idle' } = useLocalSearchParams<{ scenario?: string }>()
  if (process.env.EXPO_PUBLIC_PERF_QA !== '1') return <Redirect href="/" />
  return <Workload key={scenario} scenario={scenario} />
}
