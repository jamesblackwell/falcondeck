import { useState } from 'react'
import { SearchField, SettingsSection, cn } from '@falcondeck/ui'
import type { AnalyticsProject, AnalyticsPrompt } from '@falcondeck/client-core'

import { BOX, BoundedTable, NOTE, NUM, TD, TH } from './analytics-ui'
import { count, when } from './analytics-utils'

function PromptRow({ prompt }: { prompt: AnalyticsPrompt }) {
  const [open, setOpen] = useState(false)
  return (
    <li className="space-y-1 border-t border-border-subtle py-2.5 first:border-t-0">
      <div className="flex flex-wrap items-baseline gap-x-2 text-[length:var(--fd-text-xs)] text-fg-muted">
        <span className="whitespace-nowrap tabular-nums">{when(prompt.at)}</span>
        <span className="text-fg-tertiary">{prompt.project || 'No project'}</span>
        <span className="min-w-0 truncate">· {prompt.title}</span>
      </div>
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        className={cn(
          'fd-focus block w-full whitespace-pre-wrap rounded-[var(--fd-radius-sm)] text-left text-[length:var(--fd-text-sm)] text-fg-secondary',
          open ? null : 'line-clamp-3',
        )}
        aria-expanded={open}
      >
        {prompt.text}
      </button>
    </li>
  )
}

export function MessagesTab({
  projects,
  prompts,
  query,
  onQuery,
}: {
  projects: AnalyticsProject[]
  prompts: AnalyticsPrompt[]
  query: string
  onQuery: (query: string) => void
}) {
  return (
    <SettingsSection
      title="Your messages"
      description="What you send to agents, newest first. Messages written by agents and scheduled tasks are counted but not kept."
    >
      {projects.length ? (
        <BoundedTable
          label="Messages by project"
          rows={projects}
          head={
            <>
              <th className={TH}>Project or bot</th>
              <th className={cn(TH, NUM)}>Messages</th>
              <th className={cn(TH, NUM)}>Avg length</th>
              <th className={cn(TH, NUM)}>Commits</th>
            </>
          }
          row={(project) => (
            <tr key={project.project}>
              <td className={TD}>{project.project}</td>
              <td className={cn(TD, NUM)}>{count(project.messages)}</td>
              <td className={cn(TD, NUM)}>{project.messages ? `${count(project.avg_chars)} chars` : '—'}</td>
              <td className={cn(TD, NUM)}>{count(project.commits ?? 0)}</td>
            </tr>
          )}
        />
      ) : null}
      <SearchField
        label="Search your messages"
        placeholder="Search your messages"
        value={query}
        onChange={(event) => onQuery(event.target.value)}
      />
      {prompts.length ? (
        <ul className={cn(BOX, 'pr-1')} role="region" aria-label="Your messages" tabIndex={0}>
          {prompts.map((prompt, index) => (
            <PromptRow key={`${prompt.at}:${index}`} prompt={prompt} />
          ))}
        </ul>
      ) : (
        <p className={NOTE}>{query ? 'No messages match.' : 'No messages recorded yet.'}</p>
      )}
    </SettingsSection>
  )
}
