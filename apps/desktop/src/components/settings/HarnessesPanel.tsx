import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import {
  ActivityDiamond,
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@falcondeck/ui'
import type {
  HarnessesOverview,
  HarnessSummary,
} from '@falcondeck/client-core'
import { normalizeHarnessesOverview, normalizeHarnessUpgradeJob } from '@falcondeck/client-core'
import { CheckCircle2, Download, RefreshCw, Terminal } from 'lucide-react'

import type { HostView } from '../../hosts'

export type HarnessesPanelProps = {
  baseUrl: string | null
  /** SSH-capable hosts; enables the per-host selector. */
  hosts: HostView[]
  onToast: (toast: {
    variant: 'success' | 'danger' | 'warning' | 'default'
    title: string
    description?: string
  }) => void
}

type ActiveJob = {
  jobId: string
  harnessId: string
  hostKey: string
}

const LOCAL_HOST_KEY = 'local'

function harnessStatusLabel(harness: HarnessSummary): {
  label: string
  variant: 'success' | 'warning' | 'danger' | 'default'
} {
  if (!harness.installed) {
    return { label: 'Not installed', variant: 'default' }
  }
  if (harness.update_available === true) {
    return { label: 'Update available', variant: 'warning' }
  }
  if (harness.update_available === false) {
    return { label: 'Up to date', variant: 'success' }
  }
  return { label: 'Installed', variant: 'success' }
}

function kindLabel(kind: HarnessSummary['kind']): string {
  switch (kind) {
    case 'builtin':
      return 'Built in'
    case 'acp':
      return 'ACP'
    default:
      return 'Detected'
  }
}

export function HarnessesPanel({ baseUrl, hosts, onToast }: HarnessesPanelProps) {
  const [hostKey, setHostKey] = useState<string>(LOCAL_HOST_KEY)
  const [overview, setOverview] = useState<HarnessesOverview | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const [isRefreshing, setIsRefreshing] = useState(false)
  const [activeJob, setActiveJob] = useState<ActiveJob | null>(null)
  const [jobLog, setJobLog] = useState<string[]>([])
  const pollRef = useRef<number | null>(null)

  const sshHosts = useMemo(
    () => hosts.filter((host) => host.enabled && host.sshTarget),
    [hosts],
  )

  const hostLabel = useCallback(
    (key: string) => {
      if (key === LOCAL_HOST_KEY) return 'This Mac'
      const host = sshHosts.find(
        (candidate) => `${candidate.sshTarget}:${candidate.sshPort ?? ''}` === key,
      )
      return host?.name ?? key
    },
    [sshHosts],
  )

  const fetchOverview = useCallback(
    async (key: string, deep: boolean) => {
      if (!baseUrl) return null
      if (deep) setIsRefreshing(true)
      try {
        if (deep) {
          const target = key === LOCAL_HOST_KEY ? null : key.split(':')[0]
          const portRaw = key === LOCAL_HOST_KEY ? null : key.split(':')[1]
          const port = portRaw && portRaw !== '' ? Number(portRaw) : null
          const response = await fetch(`${baseUrl}/api/harnesses/refresh`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              ...(target ? { ssh_target: target } : {}),
              ...(port != null && Number.isFinite(port) ? { port } : {}),
            }),
          })
          if (!response.ok) throw new Error(`daemon returned ${response.status}`)
          setOverview(normalizeHarnessesOverview(await response.json()))
        } else {
          const response = await fetch(`${baseUrl}/api/harnesses`)
          if (!response.ok) throw new Error(`daemon returned ${response.status}`)
          setOverview(normalizeHarnessesOverview(await response.json()))
        }
        setLoadError(null)
        return true
      } catch (error) {
        setLoadError(error instanceof Error ? error.message : String(error))
        return false
      } finally {
        if (deep) setIsRefreshing(false)
        setIsLoading(false)
      }
    },
    [baseUrl],
  )

  useEffect(() => {
    void fetchOverview(hostKey, false)
  }, [fetchOverview, hostKey])

  // Poll an upgrade job until it leaves `running`, mirroring the
  // provisioning panel's job loop.
  useEffect(() => {
    if (!activeJob || !baseUrl) return
    const poll = async () => {
      try {
        const response = await fetch(
          `${baseUrl}/api/harnesses/jobs/${encodeURIComponent(activeJob.jobId)}`,
        )
        if (!response.ok) throw new Error(`daemon returned ${response.status}`)
        const job = normalizeHarnessUpgradeJob(await response.json())
        if (!job) throw new Error('invalid job response')
        setJobLog(job.log)
        if (job.status !== 'running') {
          setActiveJob(null)
          if (job.status === 'completed') {
            onToast({
              variant: 'success',
              title: `${job.label} upgraded`,
              description: `Finished on ${hostLabel(job.host)}.`,
            })
          } else {
            onToast({
              variant: 'danger',
              title: `${job.label} upgrade failed`,
              description: job.error ?? 'The upgrade command reported an error.',
            })
          }
          // Re-probe so the panel reflects the new binary.
          void fetchOverview(activeJob.hostKey, true)
        }
      } catch {
        // Transient poll failures keep the job running from the UI's point
        // of view; the next tick retries.
      }
    }
    void poll()
    pollRef.current = window.setInterval(() => void poll(), 1500)
    return () => {
      if (pollRef.current != null) window.clearInterval(pollRef.current)
    }
  }, [activeJob, baseUrl, fetchOverview, hostLabel, onToast])

  const startUpgrade = useCallback(
    async (harness: HarnessSummary) => {
      if (!baseUrl) return
      const target = hostKey === LOCAL_HOST_KEY ? null : hostKey.split(':')[0]
      const portRaw = hostKey === LOCAL_HOST_KEY ? null : hostKey.split(':')[1]
      const port = portRaw && portRaw !== '' ? Number(portRaw) : null
      try {
        const response = await fetch(`${baseUrl}/api/harnesses/upgrade`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            harness_id: harness.id,
            ...(target ? { ssh_target: target } : {}),
            ...(port != null && Number.isFinite(port) ? { port } : {}),
          }),
        })
        if (!response.ok) {
          const body = await response.text()
          throw new Error(body || `daemon returned ${response.status}`)
        }
        const body = (await response.json()) as { job_id?: string }
        if (!body.job_id) throw new Error('daemon did not return a job id')
        setJobLog([])
        setActiveJob({ jobId: body.job_id, harnessId: harness.id, hostKey })
      } catch (error) {
        onToast({
          variant: 'danger',
          title: `Could not start ${harness.label} upgrade`,
          description: error instanceof Error ? error.message : String(error),
        })
      }
    },
    [baseUrl, hostKey, onToast],
  )

  const harnesses = overview?.harnesses ?? []

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-[length:var(--fd-text-2xl)] font-semibold text-fg-primary">Harnesses</h1>
        <p className="mt-1 text-[length:var(--fd-text-sm)] text-fg-muted">
          FalconDeck orchestrates coding CLIs — Codex, Claude Code, OpenCode, and friends — but
          doesn&apos;t ship them. This panel shows where each is installed, whether it&apos;s
          current, and can run the upgrade for you, locally or on a connected server.
        </p>
      </div>

      <Card>
        <CardHeader className="flex-row items-center justify-between space-y-0">
          <div>
            <CardTitle>Install status</CardTitle>
            <CardDescription>
              Latest-version checks run only when you press Check for updates.
            </CardDescription>
          </div>
          <div className="flex items-center gap-2">
            <select
              aria-label="Host"
              className="rounded-[var(--fd-radius-md)] border border-border-subtle bg-surface-2 px-2 py-1.5 text-[length:var(--fd-text-sm)] text-fg-primary"
              value={hostKey}
              onChange={(event) => setHostKey(event.target.value)}
            >
              <option value={LOCAL_HOST_KEY}>This Mac</option>
              {sshHosts.map((host) => (
                <option
                  key={host.id}
                  value={`${host.sshTarget}:${host.sshPort ?? ''}`}
                >
                  {host.name}
                </option>
              ))}
            </select>
            <Button
              size="sm"
              variant="secondary"
              disabled={!baseUrl || isRefreshing}
              onClick={() => void fetchOverview(hostKey, true)}
            >
              {isRefreshing ? (
                <ActivityDiamond size="md" tone="current" />
              ) : (
                <RefreshCw className="h-4 w-4" />
              )}
              Check for updates
            </Button>
          </div>
        </CardHeader>
        <CardContent className="space-y-3">
          {loadError ? (
            <div className="flex items-center gap-3 px-2 py-4">
              <p className="text-[length:var(--fd-text-sm)] text-danger">{loadError}</p>
              <Button size="sm" variant="secondary" onClick={() => void fetchOverview(hostKey, false)}>
                Retry
              </Button>
            </div>
          ) : isLoading && !overview ? (
            <div className="flex items-center justify-center gap-2 px-2 py-10 text-[length:var(--fd-text-sm)] text-fg-muted">
              <ActivityDiamond size="md" />
              Probing harnesses…
            </div>
          ) : harnesses.length === 0 ? (
            <div className="flex flex-col items-center gap-2 rounded-[var(--fd-radius-lg)] border border-dashed border-border-subtle px-6 py-10 text-center">
              <Terminal className="h-6 w-6 text-fg-muted" />
              <p className="text-[length:var(--fd-text-sm)] text-fg-secondary">
                No harnesses detected yet. Install Codex or Claude Code to get started.
              </p>
            </div>
          ) : (
            harnesses.map((harness) => {
              const status = harnessStatusLabel(harness)
              const jobForThisHarness =
                activeJob?.harnessId === harness.id && activeJob.hostKey === hostKey
              return (
                <div
                  key={harness.id}
                  className="rounded-[var(--fd-radius-lg)] border border-border-subtle px-4 py-3"
                >
                  <div className="flex items-center gap-3">
                    <Terminal className="h-4 w-4 shrink-0 text-fg-muted" />
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="text-[length:var(--fd-text-sm)] font-medium text-fg-primary">
                          {harness.label}
                        </span>
                        <Badge variant="default">{kindLabel(harness.kind)}</Badge>
                        <Badge variant={status.variant}>{status.label}</Badge>
                        {harness.version ? (
                          <span className="font-mono text-[length:var(--fd-text-xs)] text-fg-muted">
                            v{harness.version}
                            {harness.latest_version && harness.update_available
                              ? ` → ${harness.latest_version}`
                              : ''}
                          </span>
                        ) : null}
                      </div>
                      {harness.installed && harness.resolved_path ? (
                        <p className="mt-0.5 truncate font-mono text-[length:var(--fd-text-xs)] text-fg-muted">
                          {harness.resolved_path}
                          {harness.install_source && harness.install_source !== 'unknown'
                            ? ` · ${harness.install_source}`
                            : ''}
                        </p>
                      ) : null}
                      {harness.account_status ? (
                        <p className="mt-0.5 truncate text-[length:var(--fd-text-xs)] text-fg-muted">
                          {harness.account_status}
                        </p>
                      ) : null}
                      {jobForThisHarness ? (
                        <p className="mt-1 text-[length:var(--fd-text-xs)] text-fg-secondary">
                          <ActivityDiamond size="sm" tone="current" /> Upgrading…
                        </p>
                      ) : null}
                    </div>
                    {harness.upgrade_command ? (
                      <Button
                        size="sm"
                        variant={harness.update_available === true ? 'default' : 'secondary'}
                        disabled={!baseUrl || isRefreshing || activeJob != null}
                        onClick={() => void startUpgrade(harness)}
                      >
                        {activeJob && !jobForThisHarness ? null : harness.installed ? (
                          harness.update_available === true ? (
                            <Download className="h-4 w-4" />
                          ) : null
                        ) : null}
                        {harness.installed ? 'Upgrade' : 'Install'}
                      </Button>
                    ) : null}
                  </div>
                  {jobForThisHarness && jobLog.length > 0 ? (
                    <pre className="mt-2 max-h-40 overflow-y-auto rounded-[var(--fd-radius-md)] bg-surface-2 p-2 font-mono text-[length:var(--fd-text-xs)] text-fg-secondary">
                      {jobLog.join('\n')}
                    </pre>
                  ) : null}
                </div>
              )
            })
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>How upgrades run</CardTitle>
          <CardDescription>
            Upgrade buttons run the harness&apos;s official install command through your login
            shell (locally) or a single non-interactive SSH session (on servers). MCP connectors
            stay configured through FalconDeck and apply to every harness automatically — no
            per-CLI reinstall needed.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <ul className="list-inside list-disc space-y-1 text-[length:var(--fd-text-sm)] text-fg-muted">
            <li>Custom ACP agents are listed with status but never auto-upgraded.</li>
            <li>
              Detected CLIs without a managed path (e.g. Zcode) show install location and version
              only.
            </li>
          </ul>
        </CardContent>
      </Card>

      {sshHosts.length === 0 ? (
        <p className="text-[length:var(--fd-text-xs)] text-fg-muted">
          <CheckCircle2 className="mr-1 inline h-3 w-3" />
          Add a server in Settings → Servers to manage harnesses on other machines.
        </p>
      ) : null}
    </div>
  )
}
