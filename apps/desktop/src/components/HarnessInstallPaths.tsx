import type { HarnessSummary } from '@falcondeck/client-core'

export function harnessInstallSourceLabel(
  source: string | null | undefined,
): string | null {
  switch (source) {
    case 'npm':
      return 'npm'
    case 'homebrew':
      return 'Homebrew'
    case 'cargo':
      return 'cargo'
    case 'local':
      return 'standalone'
    default:
      return null
  }
}

export function harnessHasDivergentInstall(harness: HarnessSummary): boolean {
  const extras = harness.extra_installs ?? []
  return extras.some(
    (copy) => Boolean(copy.version) && copy.version !== harness.version,
  )
}

export function upgradeFinishedDescription(options: {
  hostLabel: string
  targetSource: string | null | undefined
  unusedInstallCount: number
}): string {
  const source = harnessInstallSourceLabel(options.targetSource)
  const updated = source
    ? `Updated the ${source} install FalconDeck uses on ${options.hostLabel}.`
    : `Updated the install FalconDeck uses on ${options.hostLabel}.`
  if (options.unusedInstallCount > 0) {
    return `${updated} Other installs were left as-is.`
  }
  return updated
}

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
