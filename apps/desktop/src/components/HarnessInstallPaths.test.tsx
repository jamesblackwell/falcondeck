import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import type { HarnessSummary } from '@falcondeck/client-core'

import {
  HarnessInstallPaths,
  harnessHasDivergentInstall,
  upgradeFinishedDescription,
} from './HarnessInstallPaths'

const claude: HarnessSummary = {
  id: 'claude',
  label: 'Claude Code',
  kind: 'builtin',
  bin: 'claude',
  resolved_path: '/Users/x/.local/share/claude/versions/2.1.258',
  extra_installs: [
    {
      path: '/opt/homebrew/lib/node_modules/@anthropic-ai/claude-code/bin/claude.exe',
      version: '2.1.259',
      install_source: 'npm',
    },
  ],
  installed: true,
  version: '2.1.258',
  install_source: 'local',
}

describe('HarnessInstallPaths', () => {
  it('labels the copy FalconDeck uses and unused extras', () => {
    render(<HarnessInstallPaths harness={claude} />)

    expect(
      screen.getByText(
        /Using \/Users\/x\/\.local\/share\/claude\/versions\/2\.1\.258 · standalone/,
      ),
    ).toBeInTheDocument()
    expect(screen.getByText(/Also found .* · npm · v2\.1\.259 — not used/)).toBeInTheDocument()
    expect(harnessHasDivergentInstall(claude)).toBe(true)
  })

  it('keeps a single install as a plain path line', () => {
    render(
      <HarnessInstallPaths
        harness={{ ...claude, extra_installs: [], install_source: 'npm' }}
      />,
    )

    expect(screen.queryByText(/Using /)).toBeNull()
    expect(screen.queryByText(/Also found/)).toBeNull()
    expect(
      screen.getByText(/\/Users\/x\/\.local\/share\/claude\/versions\/2\.1\.258 · npm/),
    ).toBeInTheDocument()
  })

  it('names the upgraded copy in the toast and mentions leftovers', () => {
    expect(
      upgradeFinishedDescription({
        hostLabel: 'This Mac',
        targetSource: 'local',
        unusedInstallCount: 1,
      }),
    ).toBe(
      'Updated the standalone install FalconDeck uses on This Mac. Other installs were left as-is.',
    )
  })
})
