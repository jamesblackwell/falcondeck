import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import {
  Badge,
  Button,
  Card,
  CardContent,
  EmptyState,
  Input,
  cn,
} from '@falcondeck/ui'
import { BookOpenText, Download, Plug, Puzzle, Search, Sparkles, Trash2 } from 'lucide-react'

import { falconDeckHttpError } from '../connection-copy'
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
  workspaces: Array<{ id: string; path: string }>
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

const PLUGIN_TYPES = [
  { id: 'skills', label: 'Skills', icon: BookOpenText },
  { id: 'mcp', label: 'MCP servers', icon: Plug },
] as const

const LIBRARY_VIEWS = [
  {
    id: 'installed',
    label: 'Installed',
    description: 'Manage skills and MCP servers already available to your agents.',
  },
  {
    id: 'browse',
    label: 'Browse',
    description: 'Discover and install skills from the community directory.',
  },
] as const

type PluginTypeId = (typeof PLUGIN_TYPES)[number]['id']
type LibraryViewId = (typeof LIBRARY_VIEWS)[number]['id']

export function PluginsView({ baseUrl, workspaces, onToast }: PluginsViewProps) {
  const [libraryView, setLibraryView] = useState<LibraryViewId>('installed')
  const [pluginType, setPluginType] = useState<PluginTypeId>('skills')

  return (
    <section className="h-full min-h-0 overflow-y-auto bg-surface-1 px-8 py-10 text-fg-primary">
      <div className="mx-auto w-full max-w-4xl">
        <header>
          <h1 className="flex items-center gap-3 text-3xl font-semibold tracking-tight">
            <Puzzle aria-hidden="true" className="h-7 w-7 text-accent" />
            Plugins
          </h1>
          <p className="mt-2 text-fg-secondary">
            Manage what your agents can use, or discover new skills.
          </p>

          <div
            role="tablist"
            aria-label="Plugin library"
            className="mt-6 grid grid-cols-2 gap-2"
          >
            {LIBRARY_VIEWS.map(({ id, label, description }) => (
              <button
                key={id}
                type="button"
                role="tab"
                aria-selected={libraryView === id}
                onClick={() => setLibraryView(id)}
                className={cn(
                  'fd-focus rounded-[var(--fd-radius-lg)] border px-4 py-3 text-left transition-colors',
                  libraryView === id
                    ? 'border-border-strong bg-surface-2'
                    : 'border-border-subtle bg-surface-1 hover:bg-surface-2',
                )}
              >
                <span className="block font-medium text-fg-primary">{label}</span>
                <span className="mt-1 block text-[length:var(--fd-text-sm)] text-fg-secondary">
                  {description}
                </span>
              </button>
            ))}
          </div>
        </header>

        {libraryView === 'browse' ? (
          <SkillsSection view="browse" baseUrl={baseUrl} onToast={onToast} />
        ) : (
          <div className="mt-8">
            <div
              role="tablist"
              aria-label="Installed plugin types"
              className="flex w-fit items-center gap-1 rounded-[var(--fd-radius-lg)] bg-surface-2 p-1"
            >
              {PLUGIN_TYPES.map(({ id, label, icon: Icon }) => (
                <button
                  key={id}
                  type="button"
                  role="tab"
                  aria-selected={pluginType === id}
                  onClick={() => setPluginType(id)}
                  className={cn(
                    'fd-focus flex items-center gap-2 rounded-[var(--fd-radius-md)] px-3 py-1.5 text-[length:var(--fd-text-sm)] transition-colors',
                    pluginType === id
                      ? 'bg-surface-0 font-medium text-fg-primary shadow-[var(--fd-shadow-sm)]'
                      : 'text-fg-secondary hover:text-fg-primary',
                  )}
                >
                  <Icon aria-hidden="true" className="h-4 w-4" />
                  {label}
                </button>
              ))}
            </div>

            {pluginType === 'skills' ? (
              <SkillsSection view="installed" baseUrl={baseUrl} onToast={onToast} />
            ) : (
              <div className="mt-8">
                <ConnectorsPanel
                  baseUrl={baseUrl}
                  workspaces={workspaces}
                  onToast={onToast}
                />
              </div>
            )}
          </div>
        )}
      </div>
    </section>
  )
}

function SkillsSection({
  view,
  baseUrl,
  onToast,
}: Pick<PluginsViewProps, 'baseUrl' | 'onToast'> & { view: 'installed' | 'browse' }) {
  const [library, setLibrary] = useState<LibraryOverview | null>(null)
  const [libraryError, setLibraryError] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [registry, setRegistry] = useState<RegistryResult | null>(null)
  const [registryError, setRegistryError] = useState<string | null>(null)
  const [isSearching, setIsSearching] = useState(false)
  const [busySkillId, setBusySkillId] = useState<string | null>(null)
  const loadGeneration = useRef(0)
  const searchGeneration = useRef(0)

  const loadLibrary = useCallback(async () => {
    if (!baseUrl) return
    const generation = ++loadGeneration.current
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
    }
  }, [baseUrl])

  useEffect(() => {
    if (view !== 'installed') return
    void loadLibrary()
  }, [loadLibrary, view])

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
    if (view !== 'browse') return
    const handle = window.setTimeout(() => {
      void searchRegistry(query.trim())
    }, 300)
    return () => window.clearTimeout(handle)
  }, [query, searchRegistry, view])

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
        await searchRegistry(query.trim())
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
    [baseUrl, onToast, query, searchRegistry],
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
        await loadLibrary()
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
    [baseUrl, loadLibrary, onToast],
  )

  const installedSkills = library?.skills ?? []
  const registrySkills = registry?.skills ?? []
  const trimmedQuery = query.trim()

  const browseCaption = useMemo(() => {
    if (trimmedQuery.length >= 2) return `Results for “${trimmedQuery}”`
    return 'Trending on skills.sh'
  }, [trimmedQuery])

  if (view === 'installed') {
    return (
      <section aria-labelledby="installed-skills-heading" className="mt-8">
        <div className="flex items-baseline justify-between gap-3">
          <h2
            id="installed-skills-heading"
            className="text-[length:var(--fd-text-lg)] font-semibold"
          >
            Installed skills
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
        {libraryError ? (
          <p className="mt-3 text-[length:var(--fd-text-sm)] text-danger">{libraryError}</p>
        ) : installedSkills.length === 0 ? (
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
          <ul className="mt-3 flex flex-col gap-2">
            {installedSkills.map((skill) => (
              <li key={skill.name}>
                <Card variant="flat">
                  <CardContent className="flex items-center gap-4 py-3">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="font-medium">/{skill.name}</span>
                        {skill.source ? (
                          <Badge variant="info">{skill.source}</Badge>
                        ) : (
                          <Badge>manual</Badge>
                        )}
                      </div>
                      {skill.description ? (
                        <p className="mt-1 line-clamp-2 text-[length:var(--fd-text-sm)] text-fg-secondary">
                          {skill.description}
                        </p>
                      ) : null}
                    </div>
                    {skill.managed ? (
                      <Button
                        variant="ghost"
                        size="icon"
                        aria-label={`Remove /${skill.name}`}
                        disabled={busySkillId === skill.name}
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
                  </CardContent>
                </Card>
              </li>
            ))}
          </ul>
        )}
      </section>
    )
  }

  return (
    <section aria-labelledby="browse-skills-heading" className="mt-8">
      <h2
        id="browse-skills-heading"
        className="text-[length:var(--fd-text-lg)] font-semibold"
      >
        Browse skills
      </h2>
        <p className="mt-1 text-[length:var(--fd-text-sm)] text-fg-secondary">
          Skills from the open{' '}
          <a
            href="https://skills.sh"
            target="_blank"
            rel="noreferrer"
            className="fd-focus text-accent underline-offset-2 hover:underline"
          >
            skills.sh
          </a>{' '}
          directory. A skill is instructions your agents follow — install only sources you
          trust.
        </p>
        <label className="relative mt-4 block">
          <Search
            aria-hidden="true"
            className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-fg-muted"
          />
          <Input
            type="search"
            role="searchbox"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search skills…"
            className="pl-10"
          />
        </label>
        <div className="mt-4 flex items-center justify-between">
          <span className="text-[length:var(--fd-text-xs)] font-medium uppercase tracking-wide text-fg-muted">
            {browseCaption}
          </span>
          {isSearching ? (
            <span className="text-[length:var(--fd-text-xs)] text-fg-muted">Searching…</span>
          ) : null}
        </div>
        {registryError ? (
          <p className="mt-3 text-[length:var(--fd-text-sm)] text-danger">{registryError}</p>
        ) : registrySkills.length === 0 && !isSearching ? (
          <Card variant="flat" className="mt-3">
            <CardContent>
              <EmptyState
                icon={<Search aria-hidden="true" className="h-6 w-6" />}
                title={
                  trimmedQuery.length >= 2
                    ? 'No skills matched'
                    : 'Nothing to browse right now'
                }
                description={
                  trimmedQuery.length >= 2
                    ? 'Try a different search term.'
                    : 'Search for a skill by name or topic to get started.'
                }
              />
            </CardContent>
          </Card>
        ) : (
          <ul className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-2">
            {registrySkills.map((skill) => (
              <li key={skill.id}>
                <Card variant="flat" className="h-full">
                  <CardContent className="flex h-full flex-col gap-2 py-3">
                    <div className="flex items-start justify-between gap-2">
                      <span className="min-w-0 truncate font-medium">/{skill.skillId}</span>
                      {skill.installed ? (
                        <Badge variant="success">Installed</Badge>
                      ) : (
                        <Button
                          size="sm"
                          variant="secondary"
                          disabled={busySkillId === skill.id}
                          onClick={() => void handleInstall(skill)}
                        >
                          <Download aria-hidden="true" className="h-3.5 w-3.5" />
                          {busySkillId === skill.id ? 'Installing…' : 'Install'}
                        </Button>
                      )}
                    </div>
                    <div className="mt-auto flex items-center justify-between gap-2 text-[length:var(--fd-text-xs)] text-fg-muted">
                      <span className="min-w-0 truncate" title={skill.source}>
                        {skill.source}
                      </span>
                      <span className="shrink-0 tabular-nums">
                        {formatInstallCount(skill.installs)} installs
                      </span>
                    </div>
                  </CardContent>
                </Card>
              </li>
            ))}
          </ul>
        )}
    </section>
  )
}
