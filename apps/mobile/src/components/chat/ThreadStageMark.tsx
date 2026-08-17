import {
  Circle,
  CircleCheck,
  CircleDashed,
  CircleDot,
  CircleX,
} from 'lucide-react-native'
import { useUnistyles } from 'react-native-unistyles'

import type { ThreadTag } from '@falcondeck/client-core'

export function stageColor(
  color: string,
  theme: ReturnType<typeof useUnistyles>['theme'],
): string {
  switch (color) {
    case 'red':
      return theme.colors.danger.default
    case 'orange':
    case 'yellow':
      return theme.colors.warning.default
    case 'green':
      return theme.colors.success.default
    case 'blue':
      return theme.colors.info.default
    case 'purple':
    case 'pink':
      return theme.colors.accent.default
    default:
      return theme.colors.fg.muted
  }
}

export function ThreadStageMark({
  stage,
  color,
}: {
  stage: Pick<ThreadTag, 'id' | 'icon' | 'label'>
  color: string
}) {
  const icon = stage.icon ?? stage.id
  const props = { size: 14, color, accessibilityLabel: stage.label }
  switch (icon) {
    case 'backlog':
      return <CircleDashed {...props} />
    case 'in_progress':
      return <CircleDot {...props} />
    case 'in_review':
      return <Circle {...props} />
    case 'done':
      return <CircleCheck {...props} />
    case 'canceled':
      return <CircleX {...props} />
    default:
      return <Circle {...props} />
  }
}
