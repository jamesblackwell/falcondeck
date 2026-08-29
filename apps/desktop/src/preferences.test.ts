import { describe, expect, it } from 'vitest'

import { splitPreferencesUpdate } from './preferences'

describe('splitPreferencesUpdate', () => {
  it('keeps daemon-owned fields when thinking display changes in the same update', () => {
    expect(
      splitPreferencesUpdate({
        notifications: { enabled: false },
        conversation: { thinking_display: 'preview' },
      }),
    ).toEqual({
      daemonPayload: { notifications: { enabled: false } },
      thinkingDisplay: 'preview',
    })
  })
})
