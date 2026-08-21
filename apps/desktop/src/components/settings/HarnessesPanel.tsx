import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { ProviderIcon } from '@falcondeck/chat-ui'
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

import { falconDeckHttpError } from '../../connection-copy'
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

/** Resolves the selected host key to (ssh_target, port); null for local. */
function hostEndpoint(
  hostKey: string,
  sshHosts: HostView[],
): { sshTarget: string; port: number | null } | null {
  const host = sshHosts.find((candidate) => candidate.id === hostKey)
  if (!host?.sshTarget) return null
  return { sshTarget: host.sshTarget, port: host.sshPort }
}

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
  // Overview and errors are keyed by the host they describe, so a response
  // landing after a host switch simply stops rendering — no manual
  // stale-response guards.
  const [view, setView] = useState<{ hostKey: string; overview: HarnessesOverview } | null>(null)
  const [error, setError] = useState<{ hostKey: string; message: string } | null>(null)
  const [isRefreshing, setIsRefreshing] = useState(false)
  const [activeJob, setActiveJob] = useState<ActiveJob | null>(null)
  const [jobLog, setJobLog] = useState<string[]>([])
  const pollRef = useRef<number | null>(null)

  const sshHosts = useMemo(
    () => hosts.filter((host) => host.enabled && host.sshTarget),
    [hosts],
  )
  // HostView identities churn on every HostManager notification (presence,
  // relay events, snapshots); probing must only react to actual endpoint
  // changes, so effects key off this signature instead of array identity.
  const hostSignature = sshHosts
    .map((host) => `${host.id}|${host.sshTarget}|${host.sshPort ?? ''}`)
    .join(';')
  // Latest read for endpoint resolution inside callbacks/effects without
  // depending on the unstable `sshHosts` identity. Synced in an effect
  // (declared before its consumers) rather than during render.
  const sshHostsRef = useRef(sshHosts)
  useEffect(() => {
    sshHostsRef.current = sshHosts
  }, [sshHosts])
  // Latest selection for write-side guards: a response for a previous host
  // must render as nothing (keyed state) *and* must not evict the current
  // host's entry. Synced in an effect declared before the load effect, so
  // whenever a fetch starts for a key, the ref already holds that key.
  const hostKeyRef = useRef(hostKey)
  useEffect(() => {
    hostKeyRef.current = hostKey
  }, [hostKey])

  // Data for the current selection, or null while loading/stale.
  const overview =
    view?.hostKey === hostKey ? view.overview : null
  const loadError = error?.hostKey === hostKey ? error.message : null
  const isRemote = hostEndpoint(hostKey, sshHosts) != null

  // Job hosts come back from the daemon as "local" or an ssh target.
  const hostLabel = useCallback((host: string) => {
    if (host === LOCAL_HOST_KEY) return 'This Mac'
    return sshHostsRef.current.find((candidate) => candidate.sshTarget === host)?.name ?? host
  }, [])

  const fetchOverview = useCallback(
    async (key: string, deep: boolean) => {
      if (!baseUrl) return null
      if (deep) setIsRefreshing(true)
      try {
        const endpoint = hostEndpoint(key, sshHostsRef.current)
        let next: HarnessesOverview
        if (deep) {
          // Deep always re-probes: on-demand version checks and remote
          // hosts have no shallow path (GET /api/harnesses serves the
          // local machine only).
          const response = await fetch(`${baseUrl}/api/harnesses/refresh`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              ...(endpoint
                ? {
                    ssh_target: endpoint.sshTarget,
                    ...(endpoint.port != null ? { port: endpoint.port } : {}),
                  }
                : {}),
            }),
          })
          if (!response.ok) throw new Error(falconDeckHttpError(response.status))
          next = normalizeHarnessesOverview(await response.json())
        } else {
          const response = await fetch(`${baseUrl}/api/harnesses`)
          if (!response.ok) throw new Error(falconDeckHttpError(response.status))
          next = normalizeHarnessesOverview(await response.json())
        }
        // Write only if the selection still matches: a slow probe for a
        // previous host must not evict the current host's view.
        if (hostKeyRef.current === key) {
          setView({ hostKey: key, overview: next })
          setError((current) => (current?.hostKey === key ? null : current))
        }
        return true
      } catch (cause) {
        if (hostKeyRef.current === key) {
          setError({
            hostKey: key,
            message: cause instanceof Error ? cause.message : String(cause),
          })
        }
        return false
      } finally {
        if (deep) setIsRefreshing(false)
      }
    },
    [baseUrl],
  )

  // Load on mount, host switch, and endpoint changes. Clearing is implicit:
  // keyed state for another host renders as null (spinner) for this one.
  useEffect(() => {
    void fetchOverview(hostKey, isRemote)
  }, [fetchOverview, hostKey, hostSignature, isRemote])

  // Poll an upgrade job until it leaves `running`, mirroring the
  // provisioning panel's job loop.
  useEffect(() => {
    if (!activeJob || !baseUrl) return
    const poll = async () => {
      try {
        const response = await fetch(
          `${baseUrl}/api/harnesses/jobs/${encodeURIComponent(activeJob.jobId)}`,
        )
        if (response.status === 404) {
          // Jobs are in-memory on the daemon: a 404 means a restart (or
          // pruning) erased it. Polling forever would leave every upgrade
          // button disabled with no recovery, so treat it as terminal.
          setActiveJob(null)
          onToast({
            variant: 'warning',
            title: `${activeJob.harnessId} upgrade status lost`,
            description:
              'The daemon restarted while the upgrade was running. Check the harness version after a moment.',
          })
          return
        }
        if (!response.ok) throw new Error(falconDeckHttpError(response.status))
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
          // Re-probe so the panel reflects the new binary — but only if
          // the job's host is still the selected one; fetching another
          // host would render its data under the current selection.
          if (activeJob.hostKey === hostKey) {
            void fetchOverview(activeJob.hostKey, true)
          }
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
  }, [activeJob, baseUrl, fetchOverview, hostKey, hostLabel, onToast])

  const startUpgrade = useCallback(
    async (harness: HarnessSummary) => {
      if (!baseUrl) return
      const endpoint = hostEndpoint(hostKey, sshHostsRef.current)
      try {
        const response = await fetch(`${baseUrl}/api/harnesses/upgrade`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            harness_id: harness.id,
            ...(endpoint
              ? {
                  ssh_target: endpoint.sshTarget,
                  ...(endpoint.port != null ? { port: endpoint.port } : {}),
                }
              : {}),
          }),
        })
        if (!response.ok) {
          const body = await response.text()
          throw new Error(body || falconDeckHttpError(response.status))
        }
        const body = (await response.json()) as { job_id?: string }
        if (!body.job_id) throw new Error('FalconDeck did not start the upgrade.')
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
                <option key={host.id} value={host.id}>
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
              <Button
                size="sm"
                variant="secondary"
                onClick={() => void fetchOverview(hostKey, isRemote)}
              >
                Retry
              </Button>
            </div>
          ) : !overview ? (
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
                    <ProviderIcon
                      provider={harness.id}
                      className="h-4 w-4 text-fg-muted"
                    />
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
                        {harness.installed && harness.update_available === true ? (
                          <Download className="h-4 w-4" />
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
            <li>Detected CLIs without a managed path show install location and version only.</li>
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
