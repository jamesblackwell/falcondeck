import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { DEFAULT_REMOTE_RELAY_URL } from '@falcondeck/client-core'
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Input,
  cn,
} from '@falcondeck/ui'
import {
  FolderPlus,
  Globe,
  LoaderCircle,
  Plus,
  RefreshCw,
  Server,
  Trash2,
  X,
} from 'lucide-react'

import type { HostView } from '../../hosts'
import type { HostManager } from '../../hosts'

type SshConfigHost = {
  name: string
  hostname: string | null
  user: string | null
  port: number | null
}

type ProvisionJob = {
  status: 'running' | 'completed' | 'failed'
  stage: string
  log: string[]
  pairing_code: string | null
  error: string | null
}

export type ServersPanelProps = {
  baseUrl: string | null
  manager: HostManager
  hosts: HostView[]
  onToast: (toast: {
    variant: 'success' | 'danger' | 'warning' | 'default'
    title: string
    description?: string
  }) => void
}

const PROVISION_STAGE_LABELS: Record<string, string> = {
  connecting: 'Connecting over SSH…',
  installing: 'Installing the FalconDeck daemon…',
  starting: 'Starting the daemon service…',
  pairing: 'Requesting a pairing code…',
  done: 'Pairing with the relay…',
}

function hostStatus(host: HostView): {
  label: string
  variant: 'success' | 'warning' | 'danger' | 'default'
} {
  if (!host.enabled) return { label: 'Disabled', variant: 'default' }
  if (host.needsRepair) return { label: 'Needs re-pairing', variant: 'danger' }
  if (host.status === 'encrypted' && host.presence?.daemon_connected) {
    return { label: 'Connected', variant: 'success' }
  }
  if (host.status === 'encrypted') return { label: 'Server offline', variant: 'warning' }
  if (host.status === 'connecting' || host.status === 'connected') {
    return { label: 'Connecting', variant: 'warning' }
  }
  return { label: 'Disconnected', variant: 'default' }
}

export function ServersPanel({ baseUrl, manager, hosts, onToast }: ServersPanelProps) {
  const [isAdding, setIsAdding] = useState(false)

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-[length:var(--fd-text-2xl)] font-semibold text-fg-primary">Servers</h1>
        <p className="mt-1 text-[length:var(--fd-text-sm)] text-fg-muted">
          Run agents on remote machines. FalconDeck installs its daemon over SSH; sessions run on
          the server and stream back here — they keep running when this Mac sleeps.
        </p>
      </div>

      <Card>
        <CardHeader className="flex-row items-center justify-between space-y-0">
          <div>
            <CardTitle>Connected servers</CardTitle>
            <CardDescription>
              Enrolled through the relay with end-to-end encryption, like a paired phone.
            </CardDescription>
          </div>
          <Button size="sm" onClick={() => setIsAdding((value) => !value)}>
            {isAdding ? <X className="h-4 w-4" /> : <Plus className="h-4 w-4" />}
            {isAdding ? 'Close' : 'Add server'}
          </Button>
        </CardHeader>
        <CardContent className="space-y-3">
          {isAdding ? (
            <AddServerFlow
              baseUrl={baseUrl}
              manager={manager}
              onToast={onToast}
              onDone={() => setIsAdding(false)}
            />
          ) : null}
          {hosts.length === 0 && !isAdding ? (
            <div className="flex flex-col items-center gap-2 rounded-[var(--fd-radius-lg)] border border-dashed border-border-subtle px-6 py-10 text-center">
              <Server className="h-6 w-6 text-fg-muted" />
              <p className="text-[length:var(--fd-text-sm)] text-fg-secondary">
                No servers yet. Add one to run agents on a remote machine.
              </p>
            </div>
          ) : (
            hosts.map((host) => (
              <ServerRow key={host.id} host={host} manager={manager} baseUrl={baseUrl} onToast={onToast} />
            ))
          )}
        </CardContent>
      </Card>
    </div>
  )
}

function ServerRow({
  host,
  manager,
  baseUrl,
  onToast,
}: {
  host: HostView
  manager: HostManager
  baseUrl: string | null
  onToast: ServersPanelProps['onToast']
}) {
  const status = hostStatus(host)
  const [isAddingProject, setIsAddingProject] = useState(false)
  const [projectPath, setProjectPath] = useState('')
  const [busy, setBusy] = useState<string | null>(null)
  const workspaceCount = host.snapshot?.workspaces.length ?? 0

  const runHostCommand = useCallback(
    async (action: 'restart' | 'pair') => {
      if (!baseUrl || !host.sshTarget) {
        onToast({
          variant: 'warning',
          title: 'No SSH access recorded',
          description: 'This server was added with a pairing code, so remote management is unavailable.',
        })
        return null
      }
      const response = await fetch(`${baseUrl}/api/hosts/command`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          ssh_target: host.sshTarget,
          port: host.sshPort,
          action,
        }),
      })
      if (!response.ok) {
        const payload = (await response.json().catch(() => null)) as { error?: string } | null
        throw new Error(payload?.error ?? `Failed with status ${response.status}`)
      }
      return (await response.json()) as { ok: boolean; pairing_code: string | null; output: string }
    },
    [baseUrl, host.sshPort, host.sshTarget, onToast],
  )

  const handleRestart = useCallback(async () => {
    setBusy('restart')
    try {
      await runHostCommand('restart')
      onToast({ variant: 'success', title: 'Daemon restarted', description: host.name })
    } catch (error) {
      onToast({
        variant: 'danger',
        title: 'Restart failed',
        description: error instanceof Error ? error.message : undefined,
      })
    } finally {
      setBusy(null)
    }
  }, [host.name, onToast, runHostCommand])

  const handleRepair = useCallback(async () => {
    setBusy('repair')
    try {
      const result = await runHostCommand('pair')
      if (!result?.pairing_code) throw new Error('The server did not return a pairing code')
      await manager.repairHost(host.id, result.pairing_code)
      onToast({ variant: 'success', title: 'Re-paired', description: host.name })
    } catch (error) {
      onToast({
        variant: 'danger',
        title: 'Re-pairing failed',
        description: error instanceof Error ? error.message : undefined,
      })
    } finally {
      setBusy(null)
    }
  }, [host.id, host.name, manager, onToast, runHostCommand])

  const handleRemove = useCallback(() => {
    const confirmed = window.confirm(
      `Remove ${host.name}? Its projects disappear from the sidebar. The daemon keeps running on the server until you uninstall it.`,
    )
    if (!confirmed) return
    manager.removeHost(host.id)
  }, [host.id, host.name, manager])

  const handleAddProject = useCallback(async () => {
    const path = projectPath.trim()
    if (!path) return
    setBusy('project')
    try {
      const connection = manager.connection(host.id)
      if (!connection) throw new Error('Server is not connected')
      await connection.api().connectWorkspace(path)
      setProjectPath('')
      setIsAddingProject(false)
      onToast({ variant: 'success', title: 'Project added', description: path })
    } catch (error) {
      onToast({
        variant: 'danger',
        title: 'Failed to add project',
        description: error instanceof Error ? error.message : undefined,
      })
    } finally {
      setBusy(null)
    }
  }, [host.id, manager, onToast, projectPath])

  return (
    <div className="rounded-[var(--fd-radius-lg)] border border-border-subtle bg-surface-2 px-4 py-3">
      <div className="flex items-center gap-3">
        <button
          type="button"
          role="switch"
          aria-checked={host.enabled}
          aria-label={`${host.enabled ? 'Disable' : 'Enable'} ${host.name}`}
          onClick={() => manager.setEnabled(host.id, !host.enabled)}
          className={cn(
            'fd-focus relative h-5 w-9 shrink-0 rounded-full transition-colors',
            host.enabled ? 'bg-accent' : 'bg-surface-3',
          )}
        >
          <span
            className={cn(
              'absolute top-0.5 h-4 w-4 rounded-full bg-white shadow transition-[left]',
              host.enabled ? 'left-[18px]' : 'left-0.5',
            )}
          />
        </button>
        <Globe className="h-4 w-4 shrink-0 text-fg-muted" />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="truncate text-[length:var(--fd-text-sm)] font-medium text-fg-primary">
              {host.name}
            </span>
            <Badge variant={status.variant}>{status.label}</Badge>
          </div>
          <p className="mt-0.5 truncate text-[length:var(--fd-text-xs)] text-fg-muted">
            {[host.sshTarget, `${workspaceCount} ${workspaceCount === 1 ? 'project' : 'projects'}`]
              .filter(Boolean)
              .join(' · ')}
            {host.relayUrl !== DEFAULT_REMOTE_RELAY_URL ? ` · ${host.relayUrl}` : ''}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <Button
            variant="ghost"
            size="sm"
            title="Add a project folder on this server"
            disabled={!host.enabled || host.status !== 'encrypted'}
            onClick={() => setIsAddingProject((value) => !value)}
          >
            <FolderPlus className="h-4 w-4" />
          </Button>
          <Button
            variant="ghost"
            size="sm"
            title="Restart the daemon on this server"
            disabled={busy !== null || !host.sshTarget}
            onClick={() => void handleRestart()}
          >
            {busy === 'restart' ? (
              <LoaderCircle className="h-4 w-4 animate-spin" />
            ) : (
              <RefreshCw className="h-4 w-4" />
            )}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            title="Remove this server"
            onClick={handleRemove}
          >
            <Trash2 className="h-4 w-4" />
          </Button>
        </div>
      </div>
      {host.needsRepair ? (
        <div className="mt-2 flex items-center justify-between rounded-[var(--fd-radius-md)] bg-surface-3 px-3 py-2">
          <span className="text-[length:var(--fd-text-xs)] text-fg-secondary">
            The relay no longer accepts this pairing. Re-pair to reconnect.
          </span>
          <Button size="sm" disabled={busy !== null} onClick={() => void handleRepair()}>
            {busy === 'repair' ? <LoaderCircle className="h-4 w-4 animate-spin" /> : 'Re-pair'}
          </Button>
        </div>
      ) : null}
      {isAddingProject ? (
        <div className="mt-2 flex items-center gap-2">
          <Input
            value={projectPath}
            onChange={(event) => setProjectPath(event.target.value)}
            placeholder="/home/user/projects/my-app"
            className="flex-1"
            onKeyDown={(event) => {
              if (event.key === 'Enter') void handleAddProject()
            }}
          />
          <Button size="sm" disabled={busy === 'project' || !projectPath.trim()} onClick={() => void handleAddProject()}>
            {busy === 'project' ? <LoaderCircle className="h-4 w-4 animate-spin" /> : 'Add project'}
          </Button>
        </div>
      ) : null}
      {host.lastError && host.enabled && status.variant !== 'success' ? (
        <p className="mt-2 text-[length:var(--fd-text-xs)] text-fg-muted">{host.lastError}</p>
      ) : null}
    </div>
  )
}

function AddServerFlow({
  baseUrl,
  manager,
  onToast,
  onDone,
}: {
  baseUrl: string | null
  manager: HostManager
  onToast: ServersPanelProps['onToast']
  onDone: () => void
}) {
  const [mode, setMode] = useState<'ssh' | 'manual' | 'code'>('ssh')
  const [sshHosts, setSshHosts] = useState<SshConfigHost[] | null>(null)
  const [selectedSshHost, setSelectedSshHost] = useState<string | null>(null)
  const [manualName, setManualName] = useState('')
  const [manualTarget, setManualTarget] = useState('')
  const [manualPort, setManualPort] = useState('')
  const [relayUrl, setRelayUrl] = useState(DEFAULT_REMOTE_RELAY_URL)
  const [pairingCode, setPairingCode] = useState('')
  const [showAdvanced, setShowAdvanced] = useState(false)
  const [provisioning, setProvisioning] = useState<ProvisionJob | null>(null)
  const [isSubmitting, setIsSubmitting] = useState(false)
  const cancelledRef = useRef(false)

  useEffect(() => {
    cancelledRef.current = false
    return () => {
      cancelledRef.current = true
    }
  }, [])

  useEffect(() => {
    if (!baseUrl || mode !== 'ssh' || sshHosts !== null) return
    void fetch(`${baseUrl}/api/ssh/hosts`)
      .then(async (response) => {
        if (!response.ok) throw new Error(`Failed with status ${response.status}`)
        return (await response.json()) as { hosts: SshConfigHost[] }
      })
      .then((payload) => {
        if (cancelledRef.current) return
        setSshHosts(payload.hosts)
      })
      .catch(() => {
        if (cancelledRef.current) return
        setSshHosts([])
      })
  }, [baseUrl, mode, sshHosts])

  const target = useMemo(() => {
    if (mode === 'ssh') {
      const host = sshHosts?.find((entry) => entry.name === selectedSshHost)
      return host ? { name: host.name, sshTarget: host.name, port: null as number | null } : null
    }
    if (mode === 'manual') {
      const trimmed = manualTarget.trim()
      if (!trimmed) return null
      const port = manualPort.trim() ? Number.parseInt(manualPort, 10) : null
      return {
        name: manualName.trim() || trimmed.split('@').pop() || trimmed,
        sshTarget: trimmed,
        port: Number.isNaN(port ?? 0) ? null : port,
      }
    }
    return null
  }, [manualName, manualPort, manualTarget, mode, selectedSshHost, sshHosts])

  const handleProvision = useCallback(async () => {
    if (!baseUrl || !target) return
    setIsSubmitting(true)
    setProvisioning({ status: 'running', stage: 'connecting', log: [], pairing_code: null, error: null })
    try {
      const startResponse = await fetch(`${baseUrl}/api/hosts/provision`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          ssh_target: target.sshTarget,
          name: target.name,
          relay_url: relayUrl.trim() || DEFAULT_REMOTE_RELAY_URL,
          port: target.port,
        }),
      })
      if (!startResponse.ok) {
        const payload = (await startResponse.json().catch(() => null)) as { error?: string } | null
        throw new Error(payload?.error ?? `Failed with status ${startResponse.status}`)
      }
      const { job_id } = (await startResponse.json()) as { job_id: string }

      let job: ProvisionJob
      for (;;) {
        await new Promise((resolve) => setTimeout(resolve, 1000))
        if (cancelledRef.current) return
        const jobResponse = await fetch(`${baseUrl}/api/hosts/provision/${job_id}`)
        if (!jobResponse.ok) throw new Error(`Lost track of provisioning (status ${jobResponse.status})`)
        job = (await jobResponse.json()) as ProvisionJob
        setProvisioning(job)
        if (job.status !== 'running') break
      }
      if (job.status === 'failed' || !job.pairing_code) {
        throw new Error(job.error ?? 'Provisioning failed')
      }

      await manager.addHost({
        name: target.name,
        pairingCode: job.pairing_code,
        relayUrl: relayUrl.trim() || DEFAULT_REMOTE_RELAY_URL,
        sshTarget: target.sshTarget,
        sshPort: target.port,
      })
      onToast({ variant: 'success', title: 'Server connected', description: target.name })
      onDone()
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Provisioning failed'
      setProvisioning((current) =>
        current ? { ...current, status: 'failed', error: message } : current,
      )
      onToast({ variant: 'danger', title: 'Failed to add server', description: message })
    } finally {
      setIsSubmitting(false)
    }
  }, [baseUrl, manager, onDone, onToast, relayUrl, target])

  const handlePairWithCode = useCallback(async () => {
    if (!pairingCode.trim()) return
    setIsSubmitting(true)
    try {
      await manager.addHost({
        name: manualName.trim() || 'Server',
        pairingCode,
        relayUrl: relayUrl.trim() || DEFAULT_REMOTE_RELAY_URL,
      })
      onToast({ variant: 'success', title: 'Server connected' })
      onDone()
    } catch (error) {
      onToast({
        variant: 'danger',
        title: 'Pairing failed',
        description: error instanceof Error ? error.message : undefined,
      })
    } finally {
      setIsSubmitting(false)
    }
  }, [manager, manualName, onDone, onToast, pairingCode, relayUrl])

  const stageLabel = provisioning
    ? PROVISION_STAGE_LABELS[provisioning.stage] ?? provisioning.stage
    : null

  return (
    <div className="space-y-4 rounded-[var(--fd-radius-lg)] border border-border-subtle bg-surface-2 p-4">
      <div className="flex items-center gap-2">
        {(
          [
            ['ssh', 'From SSH config'],
            ['manual', 'Enter host'],
            ['code', 'Pairing code'],
          ] as const
        ).map(([value, label]) => (
          <button
            key={value}
            type="button"
            onClick={() => setMode(value)}
            className={cn(
              'fd-focus rounded-full px-3 py-1 text-[length:var(--fd-text-xs)] font-medium transition-colors',
              mode === value
                ? 'bg-surface-3 text-fg-primary'
                : 'text-fg-muted hover:text-fg-primary',
            )}
          >
            {label}
          </button>
        ))}
      </div>

      {mode === 'ssh' ? (
        sshHosts === null ? (
          <div className="flex items-center gap-2 py-4 text-[length:var(--fd-text-sm)] text-fg-muted">
            <LoaderCircle className="h-4 w-4 animate-spin" /> Reading ~/.ssh/config…
          </div>
        ) : sshHosts.length === 0 ? (
          <p className="py-2 text-[length:var(--fd-text-sm)] text-fg-muted">
            No hosts found in ~/.ssh/config. Enter one manually instead.
          </p>
        ) : (
          <div className="max-h-56 space-y-1 overflow-y-auto">
            {sshHosts.map((host) => (
              <button
                key={host.name}
                type="button"
                onClick={() => setSelectedSshHost(host.name)}
                className={cn(
                  'fd-focus flex w-full items-center gap-3 rounded-[var(--fd-radius-md)] border px-3 py-2 text-left transition-colors',
                  selectedSshHost === host.name
                    ? 'border-accent bg-surface-3'
                    : 'border-border-subtle hover:bg-surface-3',
                )}
              >
                <Server className="h-4 w-4 shrink-0 text-fg-muted" />
                <span className="min-w-0">
                  <span className="block truncate text-[length:var(--fd-text-sm)] text-fg-primary">
                    {host.name}
                  </span>
                  <span className="block truncate text-[length:var(--fd-text-xs)] text-fg-muted">
                    {[host.user, host.hostname].filter(Boolean).join('@') || host.name}
                    {host.port ? `:${host.port}` : ''}
                  </span>
                </span>
              </button>
            ))}
          </div>
        )
      ) : mode === 'manual' ? (
        <div className="space-y-2">
          <Input
            value={manualName}
            onChange={(event) => setManualName(event.target.value)}
            placeholder="Display name (optional)"
          />
          <Input
            value={manualTarget}
            onChange={(event) => setManualTarget(event.target.value)}
            placeholder="host.com or user@host.com"
          />
          <Input
            value={manualPort}
            onChange={(event) => setManualPort(event.target.value)}
            placeholder="SSH port (optional)"
          />
        </div>
      ) : (
        <div className="space-y-2">
          <Input
            value={manualName}
            onChange={(event) => setManualName(event.target.value)}
            placeholder="Display name"
          />
          <Input
            value={pairingCode}
            onChange={(event) => setPairingCode(event.target.value)}
            placeholder="Pairing code from the server daemon"
          />
          <p className="text-[length:var(--fd-text-xs)] text-fg-muted">
            On the server: {' '}
            <code className="rounded bg-surface-3 px-1">
              curl -X POST localhost:4123/api/remote/pairing -H 'content-type: application/json' -d
              {' '}{'{"relay_url":"https://connect.falcondeck.com"}'}
            </code>
          </p>
        </div>
      )}

      <div>
        <button
          type="button"
          onClick={() => setShowAdvanced((value) => !value)}
          className="fd-focus text-[length:var(--fd-text-xs)] text-fg-muted hover:text-fg-primary"
        >
          {showAdvanced ? 'Hide advanced' : 'Advanced: custom relay'}
        </button>
        {showAdvanced ? (
          <div className="mt-2">
            <Input
              value={relayUrl}
              onChange={(event) => setRelayUrl(event.target.value)}
              placeholder={DEFAULT_REMOTE_RELAY_URL}
            />
            <p className="mt-1 text-[length:var(--fd-text-xs)] text-fg-muted">
              Point at your own falcondeck-relay for fully self-hosted operation. See
              docs/SELF-HOSTING.md.
            </p>
          </div>
        ) : null}
      </div>

      {provisioning ? (
        <div className="rounded-[var(--fd-radius-md)] bg-surface-3 px-3 py-2">
          <div className="flex items-center gap-2 text-[length:var(--fd-text-sm)] text-fg-secondary">
            {provisioning.status === 'running' ? (
              <LoaderCircle className="h-4 w-4 animate-spin" />
            ) : null}
            {provisioning.status === 'failed' ? (
              <span className="text-[color:var(--color-danger,#e5484d)]">
                {provisioning.error ?? 'Provisioning failed'}
              </span>
            ) : (
              stageLabel
            )}
          </div>
          {provisioning.log.length > 0 ? (
            <pre className="mt-1 max-h-24 overflow-y-auto whitespace-pre-wrap text-[length:var(--fd-text-xs)] text-fg-muted">
              {provisioning.log.slice(-6).join('\n')}
            </pre>
          ) : null}
        </div>
      ) : null}

      <div className="flex justify-end gap-2">
        <Button variant="ghost" size="sm" onClick={onDone}>
          Cancel
        </Button>
        {mode === 'code' ? (
          <Button
            size="sm"
            disabled={isSubmitting || !pairingCode.trim()}
            onClick={() => void handlePairWithCode()}
          >
            {isSubmitting ? <LoaderCircle className="h-4 w-4 animate-spin" /> : 'Connect'}
          </Button>
        ) : (
          <Button
            size="sm"
            disabled={isSubmitting || !target || !baseUrl}
            onClick={() => void handleProvision()}
          >
            {isSubmitting ? <LoaderCircle className="h-4 w-4 animate-spin" /> : 'Connect'}
          </Button>
        )}
      </div>
    </div>
  )
}
