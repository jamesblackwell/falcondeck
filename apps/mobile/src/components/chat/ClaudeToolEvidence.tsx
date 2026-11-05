import { claudeEditDiff } from '@falcondeck/client-core'
import { useState } from 'react'
import { View, Pressable } from 'react-native'
import type { ToolCallDetail, ClaudeNestedCall } from '@falcondeck/client-core'
import { Text } from '@/components/ui'
import { CodeBlock } from './CodeBlock'

type Detail = Extract<ToolCallDetail, { kind: 'dynamic' }>

export function ClaudeToolEvidence({ detail }: { detail: Detail }) {
  const diff = claudeEditDiff(detail.claude?.result)
  return <View style={{ gap: 8 }}>
    {detail.arguments != null ? <CodeBlock label="Arguments" code={JSON.stringify(detail.arguments, null, 2)} language="json" previewLines={0} /> : null}
    {detail.claude?.calls.map(call => <NestedCall key={call.id} call={call} />)}
    {diff ? <CodeBlock label="Changes" code={diff} language="diff" previewLines={0} /> : null}
    {detail.claude?.result != null ? <CodeBlock label="Result details" code={JSON.stringify(detail.claude.result, null, 2)} language="json" /> : null}
  </View>
}

function NestedCall({ call }: { call: ClaudeNestedCall }) {
  const [open, setOpen] = useState(false)
  return <View style={{ gap: 8 }}>
    <Pressable onPress={() => setOpen(!open)} accessibilityRole="button" accessibilityState={{ expanded: open }} style={{ minHeight: 44, justifyContent: 'center' }}>
      <Text variant="caption" color="secondary">{call.tool_kind}: {call.title} · {call.status}</Text>
    </Pressable>
    {open ? <>
      <CodeBlock label="Arguments" code={JSON.stringify(call.arguments, null, 2)} language="json" previewLines={0} />
      {call.output != null ? <CodeBlock label="Output" code={call.output} previewLines={0} /> : null}
    </> : null}
  </View>
}
