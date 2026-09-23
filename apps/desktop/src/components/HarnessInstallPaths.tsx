import type { HarnessSummary } from '@falcondeck/client-core'

import { harnessInstallSourceLabel } from './harness-install'

const pathClassName =
  'mt-0.5 truncate font-mono text-[length:var(--fd-text-xs)] text-fg-muted'

export function HarnessInstallPaths({ harness }: { harness: HarnessSummary }) {
  if (!harness.installed || !harness.resolved_path) return null
  const extras = harness.extra_installs ?? []
  const source = harnessInstallSourceLabel(harness.install_source)
  return (
    <>
      <p className={pathClassName}>
        {extras.length > 0 ? 'Using ' : ''}
        {harness.resolved_path}
        {source ? ` · ${source}` : ''}
      </p>
      {extras.map((copy) => {
        const extraSource = harnessInstallSourceLabel(copy.install_source)
        return (
          <p key={copy.path} className={pathClassName}>
            Also found {copy.path}
            {extraSource ? ` · ${extraSource}` : ''}
            {copy.version ? ` · v${copy.version}` : ''}
            {' — not used'}
          </p>
        )
      })}
    </>
  )
}
