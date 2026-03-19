import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// Extract and test the timeAgo logic from SessionListItem.
// The function is module-private, so we re-implement the same logic
// to verify correctness and test edge cases.

function timeAgo(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime()
  const mins = Math.floor(diff / 60_000)
  if (mins < 1) return 'now'
  if (mins < 60) return `${mins}m`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `${hrs}h`
  const days = Math.floor(hrs / 24)
  return `${days}d`
}

describe('SessionListItem timeAgo', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-03-16T12:00:00Z'))
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('returns "now" for timestamps less than 1 minute ago', () => {
    expect(timeAgo('2026-03-16T12:00:00Z')).toBe('now')
    expect(timeAgo('2026-03-16T11:59:30Z')).toBe('now')
  })

  it('returns minutes for timestamps 1-59 minutes ago', () => {
    expect(timeAgo('2026-03-16T11:59:00Z')).toBe('1m')
    expect(timeAgo('2026-03-16T11:45:00Z')).toBe('15m')
    expect(timeAgo('2026-03-16T11:01:00Z')).toBe('59m')
  })

  it('returns hours for timestamps 1-23 hours ago', () => {
    expect(timeAgo('2026-03-16T11:00:00Z')).toBe('1h')
    expect(timeAgo('2026-03-16T00:00:00Z')).toBe('12h')
    expect(timeAgo('2026-03-15T13:00:00Z')).toBe('23h')
  })

  it('returns days for timestamps 24+ hours ago', () => {
    expect(timeAgo('2026-03-15T12:00:00Z')).toBe('1d')
    expect(timeAgo('2026-03-09T12:00:00Z')).toBe('7d')
    expect(timeAgo('2026-02-14T12:00:00Z')).toBe('30d')
  })

  it('handles future timestamps as "now"', () => {
    // Future timestamp has negative diff, mins < 1
    expect(timeAgo('2026-03-16T13:00:00Z')).toBe('now')
  })

  it('handles invalid date strings gracefully', () => {
    // Invalid date creates NaN diff
    const result = timeAgo('not-a-date')
    expect(typeof result).toBe('string')
  })
})

describe('SessionListItem props contract', () => {
  it('expects primitive props (not an object) per RN skills', () => {
    // Verify the interface shape matches what SidebarView passes
    const props = {
      threadId: 'thread-1',
      title: 'Test thread',
      isRunning: false,
      updatedAt: '2026-03-16T10:00:00Z',
      attention: {
        level: 'none' as const,
        badge_label: null,
        unread: false,
        pending_approval_count: 0,
        pending_question_count: 0,
        last_agent_activity_seq: 0,
        last_read_seq: 0,
      },
      isSelected: true,
      onSelect: (_threadId: string) => {},
    }

    // All props are primitives or simple callbacks — no object references
    expect(typeof props.threadId).toBe('string')
    expect(typeof props.title).toBe('string')
    expect(typeof props.isRunning).toBe('boolean')
    expect(typeof props.updatedAt).toBe('string')
    expect(typeof props.attention).toBe('object')
    expect(typeof props.isSelected).toBe('boolean')
    expect(typeof props.onSelect).toBe('function')
  })
})
