import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import {
  Badge,
  Button,
  Card,
  CardContent,
  EmptyState,
  Input,
  Tooltip,
  cn,
} from '@falcondeck/ui'
import {
  Check,
  Download,
  Plus,
  Search,
  Settings2,
  Sparkles,
  Trash2,
  X,
} from 'lucide-react'

import { falconDeckHttpError } from '../connection-copy'
import { openExternalUrl } from '../api'
import { ConnectorsPanel } from './settings/ConnectorsPanel'

type LibrarySkill = {
  name: string
  description: string | null
  path: string
  managed: boolean
  source: string | null
  registryId: string | null
  installedAt: string | null
}

type LibraryOverview = {
  root: string
  skills: LibrarySkill[]
}

type RegistrySkill = {
  id: string
  skillId: string
  name: string
  source: string
  installs: number
  installed: boolean
}

type RegistryResult = {
  query: string
  ranking: 'trending' | 'all-time'
  skills: RegistrySkill[]
}

export type PluginsViewProps = {
  baseUrl: string | null
  workspaces: Array<{ id: string; path: string; kind?: 'project' | 'casual' }>
  onToast: (toast: {
    variant: 'success' | 'danger' | 'warning' | 'default'
    title: string
    description?: string
  }) => void
}

function formatInstallCount(installs: number) {
  if (installs >= 1_000_000) return `${(installs / 1_000_000).toFixed(1)}M`
  if (installs >= 1_000) return `${(installs / 1_000).toFixed(1)}K`
  return String(installs)
}

const TOP_TABS = [
  { id: 'plugins', label: 'Plugins' },
  { id: 'skills', label: 'Skills' },
] as const

type TopTabId = (typeof TOP_TABS)[number]['id']

type CatalogServer = {
  id: string
  name: string
  description: string
  category: string
  url: string
  auth: 'oauth' | 'api_key'
  domain: string
  featured: boolean
  installed: boolean
  connected: boolean
}

const CATEGORY_ORDER = [
  'Featured',
  'Productivity',
  'Developer tools',
  'Creativity',
  'Commerce',
]

export function PluginsView({ baseUrl, workspaces, onToast }: PluginsViewProps) {
  const [topTab, setTopTab] = useState<TopTabId>('plugins')
  const [skillsRevision, setSkillsRevision] = useState(0)
  const handleSkillsChanged = useCallback(() => {
    setSkillsRevision((revision) => revision + 1)
  }, [])

  return (
    <section className="h-full min-h-0 overflow-y-auto bg-surface-1 px-8 py-8 text-fg-primary">
      <div className="mx-auto w-full max-w-4xl">
        <div className="flex justify-center">
          <div
            role="tablist"
            aria-label="Plugins and skills"
            className="flex items-center rounded-full bg-surface-2 p-1"
          >
            {TOP_TABS.map(({ id, label }) => (
              <button
                key={id}
                type="button"
                role="tab"
                aria-selected={topTab === id}
                onClick={() => setTopTab(id)}
                className={cn(
                  'fd-focus rounded-full px-4 py-1.5 text-[length:var(--fd-text-sm)] transition-colors',
                  topTab === id
                    ? 'bg-surface-0 font-medium text-fg-primary shadow-[var(--fd-shadow-sm)]'
                    : 'text-fg-secondary hover:text-fg-primary',
                )}
              >
                {label}
              </button>
            ))}
          </div>
        </div>

        {topTab === 'plugins' ? (
          <PluginsSection baseUrl={baseUrl} workspaces={workspaces} onToast={onToast} />
        ) : (
          <SkillsSection
            baseUrl={baseUrl}
            revision={skillsRevision}
            onSkillsChanged={handleSkillsChanged}
            onToast={onToast}
          />
        )}
      </div>
    </section>
  )
}

function PluginLogo({
  baseUrl,
  domain,
  name,
  className,
}: {
  baseUrl: string | null
  domain: string
  name: string
  className?: string
}) {
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    setFailed(false)
  }, [domain])
  const letter = (name.trim().charAt(0) || '?').toUpperCase()
  if (!baseUrl || !domain || failed) {
    return (
      <div
        aria-hidden="true"
        className={cn(
          'flex shrink-0 items-center justify-center bg-surface-3 font-medium text-fg-secondary',
          className,
        )}
      >
        {letter}
      </div>
    )
  }
  return (
    <img
      src={`${baseUrl}/api/plugin-logos?domain=${encodeURIComponent(domain)}`}
      alt=""
      className={cn('shrink-0 bg-surface-3 object-contain', className)}
      onError={() => setFailed(true)}
    />
  )
}

function PluginsSection({
  baseUrl,
  workspaces,
  onToast,
}: PluginsViewProps) {
  const [servers, setServers] = useState<CatalogServer[]>([])
  const [loadError, setLoadError] = useState<string | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [apiKeys, setApiKeys] = useState<Record<string, string>>({})
  const [keyPromptId, setKeyPromptId] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [manageOpen, setManageOpen] = useState(false)
  const [expandedCategories, setExpandedCategories] = useState<Record<string, boolean>>({})
  const loadGeneration = useRef(0)

  const load = useCallback(async () => {
    if (!baseUrl) return
    const generation = ++loadGeneration.current
    setLoadError(null)
    try {
      const response = await fetch(`${baseUrl}/api/connectors/catalog`)
      if (!response.ok) throw new Error(falconDeckHttpError(response.status))
      const data = (await response.json()) as { servers: CatalogServer[] }
      if (generation !== loadGeneration.current) return
      setServers(data.servers ?? [])
    } catch (error) {
      if (generation !== loadGeneration.current) return
      setLoadError(error instanceof Error ? error.message : String(error))
    }
  }, [baseUrl])

  useEffect(() => {
    void load()
  }, [load])

  const waitUntilConnected = useCallback(
    async (id: string) => {
      const deadline = Date.now() + 180_000
      while (Date.now() < deadline) {
        await new Promise((resolve) => window.setTimeout(resolve, 1500))
        const response = await fetch(`${baseUrl}/api/connectors/catalog`)
        if (!response.ok) continue
        const data = (await response.json()) as { servers: CatalogServer[] }
        if (data.servers?.some((server) => server.id === id && server.connected)) {
          return true
        }
      }
      return false
    },
    [baseUrl],
  )

  const handleInstall = useCallback(
    async (server: CatalogServer) => {
      if (!baseUrl) return
      if (server.auth === 'api_key' && keyPromptId !== server.id) {
        setKeyPromptId(server.id)
        return
      }
      setBusyId(server.id)
      try {
        if (server.auth === 'api_key') {
          const apiKey = (apiKeys[server.id] ?? '').trim()
          if (!apiKey) {
            throw new Error('Paste an API key first.')
          }
          const response = await fetch(`${baseUrl}/api/connectors/catalog/install`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id: server.id, api_key: apiKey }),
          })
          if (!response.ok) {
            const body = await response.text()
            throw new Error(body || falconDeckHttpError(response.status))
          }
          onToast({
            variant: 'success',
            title: `Installed ${server.name}`,
            description: 'Available to agents on the next turn.',
          })
          setKeyPromptId(null)
        } else {
          const response = await fetch(`${baseUrl}/api/connectors/oauth/start`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id: server.id }),
          })
          if (!response.ok) {
            const body = await response.text()
            throw new Error(body || falconDeckHttpError(response.status))
          }
          const data = (await response.json()) as { authorization_url?: string }
          if (!data.authorization_url) {
            throw new Error('The daemon did not return a sign-in URL.')
          }
          await openExternalUrl(data.authorization_url)
          onToast({
            variant: 'default',
            title: `Finish signing in to ${server.name}`,
            description: 'Complete the browser prompt, then return here.',
          })
          const connected = await waitUntilConnected(server.id)
          onToast({
            variant: connected ? 'success' : 'warning',
            title: connected
              ? `Connected ${server.name}`
              : `Still waiting on ${server.name}`,
            description: connected
              ? 'Available to every agent on the next turn.'
              : 'Finish the browser sign-in, or try Connect again.',
          })
        }
        await load()
      } catch (error) {
        onToast({
          variant: 'danger',
          title: `Couldn’t install ${server.name}`,
          description: error instanceof Error ? error.message : String(error),
        })
      } finally {
        setBusyId(null)
      }
    },
    [apiKeys, baseUrl, keyPromptId, load, onToast, waitUntilConnected],
  )

  const trimmedQuery = query.trim().toLowerCase()
  const filtered = servers.filter((server) => {
    if (!trimmedQuery) return true
    return (
      server.name.toLowerCase().includes(trimmedQuery) ||
      server.description.toLowerCase().includes(trimmedQuery) ||
      server.category.toLowerCase().includes(trimmedQuery)
    )
  })
  const installed = servers.filter((server) => server.connected || server.installed)
  const featured = filtered.filter((server) => server.featured)

  const grouped = CATEGORY_ORDER.filter((category) => category !== 'Featured')
    .map((category) => ({
      category,
      items: filtered.filter(
        (server) =>
          server.category === category && (Boolean(trimmedQuery) || !server.featured),
      ),
    }))
    .filter((group) => group.items.length > 0)

  return (
    <div className="mt-8">
      <header className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="text-3xl font-semibold tracking-tight">Plugins</h1>
          <p className="mt-1 text-fg-secondary">
            Work with your agents across your favorite tools.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <label className="relative block min-w-0 flex-1 sm:w-64 sm:flex-none">
            <Search
              aria-hidden="true"
              className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-fg-muted"
            />
            <Input
              type="search"
              role="searchbox"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search plugins"
              className="pl-10"
              aria-label="Search plugins"
            />
          </label>
          <Tooltip label="Add a custom MCP server">
            <Button
              variant="secondary"
              size="icon"
              aria-label="Add a custom MCP server"
              aria-pressed={manageOpen}
              onClick={() => setManageOpen((open) => !open)}
            >
              <Plus aria-hidden="true" className="h-4 w-4" />
            </Button>
          </Tooltip>
        </div>
      </header>

      <section aria-labelledby="installed-plugins-heading" className="mt-8">
        <div className="flex items-center justify-between gap-3">
          <h2 id="installed-plugins-heading" className="text-[length:var(--fd-text-sm)] font-medium">
            Installed
          </h2>
          <Tooltip label="Manage MCP servers">
            <Button
              variant="ghost"
              size="icon"
              aria-label="Manage MCP servers"
              aria-pressed={manageOpen}
              onClick={() => setManageOpen((open) => !open)}
            >
              <Settings2 aria-hidden="true" className="h-4 w-4" />
            </Button>
          </Tooltip>
        </div>
        {installed.length === 0 ? (
          <p className="mt-3 text-[length:var(--fd-text-sm)] text-fg-muted">
            Nothing installed yet. Connect a plugin below.
          </p>
        ) : (
          <ul className="mt-3 flex flex-wrap gap-2">
            {installed.map((server) => (
              <li key={server.id}>
                <Tooltip label={server.name}>
                  <span className="inline-flex">
                    <PluginLogo
                      baseUrl={baseUrl}
                      domain={server.domain}
                      name={server.name}
                      className="h-10 w-10 rounded-full"
                    />
                  </span>
                </Tooltip>
              </li>
            ))}
          </ul>
        )}
      </section>

      {manageOpen ? (
        <div className="mt-6">
          <ConnectorsPanel baseUrl={baseUrl} workspaces={workspaces} onToast={onToast} />
        </div>
      ) : null}

      {loadError ? (
        <p className="mt-6 text-[length:var(--fd-text-sm)] text-danger">{loadError}</p>
      ) : servers.length === 0 ? (
        <p className="mt-6 text-[length:var(--fd-text-sm)] text-fg-muted">Loading catalog…</p>
      ) : (
        <>
          {featured.length > 0 && !trimmedQuery ? (
            <PluginCategory
              title="Featured"
              servers={featured}
              baseUrl={baseUrl}
              busyId={busyId}
              apiKeys={apiKeys}
              keyPromptId={keyPromptId}
              expanded
              onInstall={handleInstall}
              onApiKeyChange={(id, value) =>
                setApiKeys((current) => ({ ...current, [id]: value }))
              }
              onCancelKey={() => setKeyPromptId(null)}
            />
          ) : null}
          {grouped.map(({ category, items }) => (
            <PluginCategory
              key={category}
              title={category}
              servers={items}
              baseUrl={baseUrl}
              busyId={busyId}
              apiKeys={apiKeys}
              keyPromptId={keyPromptId}
              expanded={Boolean(trimmedQuery) || expandedCategories[category]}
              onToggle={() =>
                setExpandedCategories((current) => ({
                  ...current,
                  [category]: !current[category],
                }))
              }
              onInstall={handleInstall}
              onApiKeyChange={(id, value) =>
                setApiKeys((current) => ({ ...current, [id]: value }))
              }
              onCancelKey={() => setKeyPromptId(null)}
            />
          ))}
        </>
      )}
    </div>
  )
}

const CATEGORY_PREVIEW = 6

function PluginCategory({
  title,
  servers,
  baseUrl,
  busyId,
  apiKeys,
  keyPromptId,
  expanded,
  onToggle,
  onInstall,
  onApiKeyChange,
  onCancelKey,
}: {
  title: string
  servers: CatalogServer[]
  baseUrl: string | null
  busyId: string | null
  apiKeys: Record<string, string>
  keyPromptId: string | null
  expanded: boolean
  onToggle?: () => void
  onInstall: (server: CatalogServer) => void
  onApiKeyChange: (id: string, value: string) => void
  onCancelKey: () => void
}) {
  const hidden = !expanded && servers.length > CATEGORY_PREVIEW
  const visible = hidden ? servers.slice(0, CATEGORY_PREVIEW) : servers
  const overflow = hidden ? servers.slice(CATEGORY_PREVIEW) : []

  const headingId = `${title.toLowerCase().replace(/\s+/g, '-')}-heading`
  return (
    <section aria-labelledby={headingId} className="mt-8">
      <h2
        id={headingId}
        className="text-[length:var(--fd-text-sm)] font-medium text-fg-secondary"
      >
        {title}
      </h2>
      <ul className="mt-1 divide-y divide-border-subtle">
        {visible.map((server) => (
          <PluginRow
            key={server.id}
            server={server}
            baseUrl={baseUrl}
            busy={busyId === server.id}
            apiKey={apiKeys[server.id] ?? ''}
            showKey={keyPromptId === server.id}
            onInstall={() => onInstall(server)}
            onApiKeyChange={(value) => onApiKeyChange(server.id, value)}
            onCancelKey={onCancelKey}
          />
        ))}
      </ul>
      {overflow.length > 0 && onToggle ? (
        <button
          type="button"
          onClick={onToggle}
          className="fd-focus mt-2 flex items-center gap-2 text-[length:var(--fd-text-sm)] text-fg-secondary hover:text-fg-primary"
        >
          <span className="flex -space-x-1.5">
            {overflow.slice(0, 3).map((server) => (
              <PluginLogo
                key={server.id}
                baseUrl={baseUrl}
                domain={server.domain}
                name={server.name}
                className="h-5 w-5 rounded-full ring-2 ring-surface-1"
              />
            ))}
          </span>
          See {overflow.map((server) => server.name).slice(0, 2).join(', ')}
          {overflow.length > 2 ? `, and ${overflow.length - 2} more` : ''}
        </button>
      ) : null}
    </section>
  )
}

function PluginRow({
  server,
  baseUrl,
  busy,
  apiKey,
  showKey,
  onInstall,
  onApiKeyChange,
  onCancelKey,
}: {
  server: CatalogServer
  baseUrl: string | null
  busy: boolean
  apiKey: string
  showKey: boolean
  onInstall: () => void
  onApiKeyChange: (value: string) => void
  onCancelKey: () => void
}) {
  const actionLabel = busy
    ? server.auth === 'oauth'
      ? 'Waiting…'
      : 'Installing…'
    : server.connected
      ? 'Installed'
      : server.auth === 'oauth'
        ? 'Connect'
        : 'Install'

  return (
    <li className="py-3">
      <div className="flex items-center gap-3">
        <PluginLogo
          baseUrl={baseUrl}
          domain={server.domain}
          name={server.name}
          className="h-10 w-10 rounded-[var(--fd-radius-lg)]"
        />
        <div className="min-w-0 flex-1">
          <div className="truncate font-medium">{server.name}</div>
          <p className="truncate text-[length:var(--fd-text-sm)] text-fg-secondary">
            {server.description}
          </p>
        </div>
        {server.connected ? (
          <span className="text-[length:var(--fd-text-sm)] text-fg-muted">Installed</span>
        ) : (
          <Button
            size="sm"
            variant="secondary"
            disabled={busy}
            onClick={onInstall}
            aria-label={`${actionLabel} ${server.name}`}
          >
            {busy ? actionLabel : server.auth === 'oauth' ? 'Connect' : 'Install'}
          </Button>
        )}
      </div>
      {showKey && !server.connected ? (
        <div className="mt-3 flex items-center gap-2 pl-[3.25rem]">
          <Input
            type="password"
            autoFocus
            aria-label={`${server.name} API key`}
            placeholder={server.id === 'github' ? 'Personal access token' : 'API key'}
            value={apiKey}
            onChange={(event) => onApiKeyChange(event.target.value)}
            className="font-mono"
            onKeyDown={(event) => {
              if (event.key === 'Enter') onInstall()
              if (event.key === 'Escape') onCancelKey()
            }}
          />
          <Button size="sm" disabled={busy} onClick={onInstall}>
            {busy ? 'Installing…' : 'Install'}
          </Button>
          <Button size="icon" variant="ghost" aria-label="Cancel" onClick={onCancelKey}>
            <X aria-hidden="true" className="h-4 w-4" />
          </Button>
        </div>
      ) : null}
    </li>
  )
}

function SkillsSection({
  baseUrl,
  revision,
  onSkillsChanged,
  onToast,
}: Pick<PluginsViewProps, 'baseUrl' | 'onToast'> & {
  revision: number
  onSkillsChanged: () => void
}) {
  const [library, setLibrary] = useState<LibraryOverview | null>(null)
  const [libraryError, setLibraryError] = useState<string | null>(null)
  const [isLoadingLibrary, setIsLoadingLibrary] = useState(Boolean(baseUrl))
  const [query, setQuery] = useState('')
  const [registry, setRegistry] = useState<RegistryResult | null>(null)
  const [registryError, setRegistryError] = useState<string | null>(null)
  const [isSearching, setIsSearching] = useState(Boolean(baseUrl))
  const [busySkillId, setBusySkillId] = useState<string | null>(null)
  const [sourceFilter, setSourceFilter] = useState<string | null>(null)
  const [showAllInstalled, setShowAllInstalled] = useState(false)
  const loadGeneration = useRef(0)
  const searchGeneration = useRef(0)

  const loadLibrary = useCallback(async () => {
    if (!baseUrl) {
      setIsLoadingLibrary(false)
      return
    }
    const generation = ++loadGeneration.current
    setIsLoadingLibrary(true)
    setLibraryError(null)
    try {
      const response = await fetch(`${baseUrl}/api/skills`)
      if (!response.ok) throw new Error(falconDeckHttpError(response.status))
      const data = (await response.json()) as LibraryOverview
      if (generation !== loadGeneration.current) return
      setLibrary(data)
    } catch (error) {
      if (generation !== loadGeneration.current) return
      setLibraryError(error instanceof Error ? error.message : String(error))
    } finally {
      if (generation === loadGeneration.current) setIsLoadingLibrary(false)
    }
  }, [baseUrl])

  useEffect(() => {
    void loadLibrary()
  }, [loadLibrary, revision])

  const searchRegistry = useCallback(
    async (searchQuery: string) => {
      if (!baseUrl) return
      const generation = ++searchGeneration.current
      setIsSearching(true)
      setRegistryError(null)
      try {
        const params = new URLSearchParams({ q: searchQuery, limit: '30' })
        const response = await fetch(`${baseUrl}/api/skills/registry?${params}`)
        if (!response.ok) throw new Error(falconDeckHttpError(response.status))
        const data = (await response.json()) as RegistryResult
        if (generation !== searchGeneration.current) return
        setRegistry(data)
      } catch (error) {
        if (generation !== searchGeneration.current) return
        setRegistryError(error instanceof Error ? error.message : String(error))
      } finally {
        if (generation === searchGeneration.current) setIsSearching(false)
      }
    },
    [baseUrl],
  )

  useEffect(() => {
    const handle = window.setTimeout(() => {
      void searchRegistry(query.trim())
    }, 300)
    return () => window.clearTimeout(handle)
  }, [query, revision, searchRegistry])

  const handleInstall = useCallback(
    async (skill: RegistrySkill) => {
      if (!baseUrl) return
      setBusySkillId(skill.id)
      try {
        const response = await fetch(`${baseUrl}/api/skills/install`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ source: skill.source, skill: skill.skillId }),
        })
        if (!response.ok) {
          const body = await response.text()
          throw new Error(body || falconDeckHttpError(response.status))
        }
        onToast({
          variant: 'success',
          title: `Installed /${skill.skillId}`,
          description: 'Available to every agent in new turns.',
        })
        setIsSearching(true)
        onSkillsChanged()
      } catch (error) {
        onToast({
          variant: 'danger',
          title: `Couldn’t install /${skill.skillId}`,
          description: error instanceof Error ? error.message : String(error),
        })
      } finally {
        setBusySkillId(null)
      }
    },
    [baseUrl, onSkillsChanged, onToast],
  )

  const handleUninstall = useCallback(
    async (skill: LibrarySkill) => {
      if (!baseUrl) return
      setBusySkillId(skill.name)
      try {
        const response = await fetch(
          `${baseUrl}/api/skills/${encodeURIComponent(skill.name)}`,
          { method: 'DELETE' },
        )
        if (!response.ok) {
          const body = await response.text()
          throw new Error(body || falconDeckHttpError(response.status))
        }
        onToast({ variant: 'success', title: `Removed /${skill.name}` })
        setIsLoadingLibrary(true)
        onSkillsChanged()
      } catch (error) {
        onToast({
          variant: 'danger',
          title: `Couldn’t remove /${skill.name}`,
          description: error instanceof Error ? error.message : String(error),
        })
      } finally {
        setBusySkillId(null)
      }
    },
    [baseUrl, onSkillsChanged, onToast],
  )

  const installedSkills = useMemo(() => library?.skills ?? [], [library?.skills])
  const sources = useMemo(() => {
    const counts = new Map<string, number>()
    for (const skill of installedSkills) {
      const source = skill.source ?? 'Personal'
      counts.set(source, (counts.get(source) ?? 0) + 1)
    }
    return [...counts.entries()].sort((a, b) => a[0].localeCompare(b[0]))
  }, [installedSkills])

  const trimmedQuery = query.trim().toLowerCase()
  const visibleInstalled = installedSkills.filter((skill) => {
    if (sourceFilter && (skill.source ?? 'Personal') !== sourceFilter) return false
    if (!trimmedQuery) return true
    return (
      skill.name.toLowerCase().includes(trimmedQuery) ||
      (skill.description ?? '').toLowerCase().includes(trimmedQuery)
    )
  })
  const installedCap = 8
  const shownInstalled =
    showAllInstalled || visibleInstalled.length <= installedCap
      ? visibleInstalled
      : visibleInstalled.slice(0, installedCap)
  const registrySkills = (registry?.skills ?? []).filter((skill) => !skill.installed)
  const browseCaption =
    query.trim().length >= 2 ? `Results for “${query.trim()}”` : 'Trending on skills.sh'

  return (
    <div className="mt-8">
      <header className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="text-3xl font-semibold tracking-tight">Skills</h1>
          <p className="mt-1 text-fg-secondary">
            Extend your agents with task-specific skills.
          </p>
        </div>
        <label className="relative block w-full sm:w-72">
          <Search
            aria-hidden="true"
            className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-fg-muted"
          />
          <Input
            type="search"
            role="searchbox"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search skills"
            className="pl-10"
            aria-label="Search skills"
          />
        </label>
      </header>

      <section aria-labelledby="installed-skills-heading" className="mt-8">
        <div className="flex items-baseline justify-between gap-3">
          <h2 id="installed-skills-heading" className="text-[length:var(--fd-text-sm)] font-medium">
            Installed
          </h2>
          {library ? (
            <span
              className="truncate text-[length:var(--fd-text-xs)] text-fg-muted"
              title={library.root}
            >
              {library.root}
            </span>
          ) : null}
        </div>
        {sources.length > 1 ? (
          <div className="mt-3 flex flex-wrap gap-1.5">
            <button
              type="button"
              onClick={() => setSourceFilter(null)}
              className={cn(
                'fd-focus rounded-full px-2.5 py-1 text-[length:var(--fd-text-xs)]',
                sourceFilter === null
                  ? 'bg-surface-3 text-fg-primary'
                  : 'text-fg-secondary hover:bg-surface-2',
              )}
            >
              All
            </button>
            {sources.map(([source, count]) => (
              <button
                key={source}
                type="button"
                onClick={() => setSourceFilter(source)}
                className={cn(
                  'fd-focus rounded-full px-2.5 py-1 text-[length:var(--fd-text-xs)]',
                  sourceFilter === source
                    ? 'bg-surface-3 text-fg-primary'
                    : 'text-fg-secondary hover:bg-surface-2',
                )}
              >
                {source} · {count}
              </button>
            ))}
          </div>
        ) : null}
        {libraryError ? (
          <p className="mt-3 text-[length:var(--fd-text-sm)] text-danger">{libraryError}</p>
        ) : isLoadingLibrary && !library ? (
          <p className="mt-3 text-[length:var(--fd-text-sm)] text-fg-muted">
            Loading installed skills…
          </p>
        ) : visibleInstalled.length === 0 ? (
          <Card variant="flat" className="mt-3">
            <CardContent>
              <EmptyState
                icon={<Sparkles aria-hidden="true" className="h-6 w-6" />}
                title="No skills installed yet"
                description="Skills installed here are shared with Codex, Claude, OpenCode, and Agy."
              />
            </CardContent>
          </Card>
        ) : (
          <ul className="mt-3 grid grid-cols-1 gap-1 sm:grid-cols-2">
            {shownInstalled.map((skill) => (
              <li key={skill.name}>
                <div className="flex items-start gap-3 rounded-[var(--fd-radius-lg)] px-2 py-2.5 hover:bg-surface-2">
                  <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-[var(--fd-radius-md)] bg-surface-3 text-success">
                    <Check aria-hidden="true" className="h-4 w-4" />
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="truncate font-medium">/{skill.name}</span>
                      {skill.source ? (
                        <Badge variant="info">{skill.source}</Badge>
                      ) : (
                        <Badge>manual</Badge>
                      )}
                    </div>
                    {skill.description ? (
                      <p className="mt-0.5 line-clamp-2 text-[length:var(--fd-text-sm)] text-fg-secondary">
                        {skill.description}
                      </p>
                    ) : null}
                  </div>
                  {skill.managed ? (
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label={`Remove /${skill.name}`}
                      disabled={isLoadingLibrary || busySkillId === skill.name}
                      onClick={() => void handleUninstall(skill)}
                    >
                      <Trash2 aria-hidden="true" className="h-4 w-4 text-danger" />
                    </Button>
                  ) : (
                    <span
                      className="text-[length:var(--fd-text-xs)] text-fg-muted"
                      title="This skill was placed on disk by hand, so FalconDeck won’t delete it."
                    >
                      hand-managed
                    </span>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
        {visibleInstalled.length > installedCap && !showAllInstalled ? (
          <button
            type="button"
            onClick={() => setShowAllInstalled(true)}
            className="fd-focus mt-2 text-[length:var(--fd-text-sm)] text-fg-secondary hover:text-fg-primary"
          >
            See {visibleInstalled.length - installedCap} more
          </button>
        ) : null}
      </section>

      <section aria-labelledby="browse-skills-heading" className="mt-10">
        <div className="flex items-center justify-between">
          <h2 id="browse-skills-heading" className="text-[length:var(--fd-text-sm)] font-medium">
            {browseCaption}
          </h2>
          {isSearching ? (
            <span className="text-[length:var(--fd-text-xs)] text-fg-muted">Searching…</span>
          ) : null}
        </div>
        <p className="mt-1 text-[length:var(--fd-text-sm)] text-fg-secondary">
          From the open{' '}
          <a
            href="https://skills.sh"
            target="_blank"
            rel="noreferrer"
            className="fd-focus text-accent underline-offset-2 hover:underline"
          >
            skills.sh
          </a>{' '}
          directory. Install only sources you trust.
        </p>
        {registryError ? (
          <p className="mt-3 text-[length:var(--fd-text-sm)] text-danger">{registryError}</p>
        ) : registrySkills.length === 0 && !isSearching ? (
          <Card variant="flat" className="mt-3">
            <CardContent>
              <EmptyState
                icon={<Search aria-hidden="true" className="h-6 w-6" />}
                title={
                  query.trim().length >= 2 ? 'No skills matched' : 'Nothing to browse right now'
                }
                description={
                  query.trim().length >= 2
                    ? 'Try a different search term.'
                    : 'Search for a skill by name or topic to get started.'
                }
              />
            </CardContent>
          </Card>
        ) : (
          <ul className="mt-3 grid grid-cols-1 gap-1 sm:grid-cols-2">
            {registrySkills.map((skill) => (
              <li key={skill.id}>
                <div className="flex items-start gap-3 rounded-[var(--fd-radius-lg)] px-2 py-2.5 hover:bg-surface-2">
                  <div className="min-w-0 flex-1">
                    <span className="block truncate font-medium">/{skill.skillId}</span>
                    <div className="mt-0.5 flex items-center justify-between gap-2 text-[length:var(--fd-text-xs)] text-fg-muted">
                      <span className="min-w-0 truncate" title={skill.source}>
                        {skill.source}
                      </span>
                      <span className="shrink-0 tabular-nums">
                        {formatInstallCount(skill.installs)} installs
                      </span>
                    </div>
                  </div>
                  <Button
                    size="sm"
                    variant="secondary"
                    disabled={isSearching || busySkillId === skill.id}
                    onClick={() => void handleInstall(skill)}
                  >
                    <Download aria-hidden="true" className="h-3.5 w-3.5" />
                    {busySkillId === skill.id ? 'Installing…' : 'Install'}
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  )
}
