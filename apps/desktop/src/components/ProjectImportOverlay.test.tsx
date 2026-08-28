import { act, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  PROJECT_IMPORT_OVERLAY_DELAY_MS,
  PROJECT_IMPORT_OVERLAY_MAX_VISIBLE_MS,
  ProjectImportOverlay,
} from './ProjectImportOverlay'

describe('ProjectImportOverlay', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('avoids flashing for fast imports and caps its visible time', () => {
    render(<ProjectImportOverlay />)

    expect(
      screen.queryByText('Importing existing agent sessions'),
    ).toBeNull()

    act(() => {
      vi.advanceTimersByTime(PROJECT_IMPORT_OVERLAY_DELAY_MS)
    })
    expect(
      screen.getByText('Importing existing agent sessions'),
    ).toBeTruthy()

    act(() => {
      vi.advanceTimersByTime(PROJECT_IMPORT_OVERLAY_MAX_VISIBLE_MS)
    })
    expect(
      screen.queryByText('Importing existing agent sessions'),
    ).toBeNull()
  })
})
