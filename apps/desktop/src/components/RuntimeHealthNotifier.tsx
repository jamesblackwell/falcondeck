import { useEffect, useRef } from 'react'
import { useToast } from '@falcondeck/ui'
import type { OperationalCondition } from '@falcondeck/client-core'

const RUNTIME_MEMORY_CONDITION_KEY = 'runtime-memory-pressure'

export function RuntimeHealthNotifier({
  conditions,
}: {
  conditions: readonly OperationalCondition[] | null | undefined
}) {
  const { toast } = useToast()
  const lastVersion = useRef<string | null>(null)

  useEffect(() => {
    const condition = conditions?.find(
      (candidate) => candidate.key === RUNTIME_MEMORY_CONDITION_KEY,
    )
    if (!condition) return
    const version = `${condition.id}:${condition.updated_at}`
    if (lastVersion.current === version) return
    lastVersion.current = version
    toast({
      variant: 'warning',
      title: 'FalconDeck is using a lot of memory',
      description: condition.message,
      duration: 10_000,
    })
  }, [conditions, toast])

  return null
}
