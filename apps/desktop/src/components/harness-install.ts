import type { HarnessSummary } from '@falcondeck/client-core'

export function harnessNeedsRepair(harness: HarnessSummary): boolean {
  return harness.install_state === 'broken'
}

export function harnessSignInCommand(harness: HarnessSummary): string | null {
  if (!harness.installed || harnessNeedsRepair(harness)) return null
  const args = harness.id === 'codex' ? 'login' : harness.id === 'claude' ? 'auth login' : null
  if (!args) return null
  const bin = harness.resolved_path ?? harness.bin
  return `'${bin.replace(/'/g, "'\\''")}' ${args}`
}

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
  harnessId?: string;
  hostLabel: string
  targetSource: string | null | undefined
  unusedInstallCount: number
}): string {
  if ((options.harnessId === 'claude' || options.harnessId === 'codex') && options.targetSource === 'npm') {
    return `Installed a standalone copy for your account on ${options.hostLabel}. The npm install was left unchanged.`
  }
  const source = harnessInstallSourceLabel(options.targetSource)
  const updated = source
    ? `Updated the ${source} install FalconDeck uses on ${options.hostLabel}.`
    : `Updated the install FalconDeck uses on ${options.hostLabel}.`
  if (options.unusedInstallCount > 0) {
    return `${updated} Other installs were left as-is.`
  }
  return updated
}
