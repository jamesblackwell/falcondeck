import {
  ControlOperationError,
  type AnalyticsAutomation,
  type Automation,
  type DaemonApiClient,
} from '@falcondeck/client-core'
import { AUTOMATION_LIST_FIELDS } from '../automation-list-model'

export type BotSidebarApi = Pick<DaemonApiClient, 'botDocuments' | 'readBotDocument' | 'listTickets' | 'controlGet' | 'controlExecute'>

export async function readBotSidebar(api: BotSidebarApi, botId: string, owner: string) {
  const readStatus = async () => {
    const names = await api.botDocuments(botId)
    return names.includes('STATUS.md') ? api.readBotDocument(botId, 'STATUS.md') : null
  }
  const readSchedules = async () => {
    const rows: Automation[] = []
    let cursor: string | undefined
    do {
      const response = await api.controlGet({
        resource: 'automations', fields: [...AUTOMATION_LIST_FIELDS, 'target.thread'], limit: 100,
        ...(cursor ? { cursor } : {}),
      })
      if (Array.isArray(response.data)) rows.push(...response.data as Automation[])
      cursor = response.next_cursor ?? undefined
    } while (cursor)
    return rows
  }
  const [status, tickets, schedules, health] = await Promise.allSettled([
    readStatus(),
    api.listTickets({ owner, include_closed: false }),
    readSchedules(),
    api.controlGet({ resource: 'automation.health', filters: { days: 7 } }),
  ])
  return {
    status: status.status === 'fulfilled' ? status.value : null,
    statusError: status.status === 'rejected',
    tickets: tickets.status === 'fulfilled' ? tickets.value : [],
    ticketsError: tickets.status === 'rejected',
    schedules: schedules.status === 'fulfilled' ? schedules.value : [],
    schedulesError: schedules.status === 'rejected',
    health: health.status === 'fulfilled' ? (health.value.data as { automations?: AnalyticsAutomation[] }).automations ?? [] : [],
  }
}

/** Preserve the user's requested state across one stale-revision retry. */
export async function setScheduleEnabled(api: BotSidebarApi, automation: Automation, enabled: boolean): Promise<Automation> {
  let current = automation
  for (let attempt = 0; attempt < 2; attempt++) {
    const response = await api.controlExecute({
      operation: enabled ? 'automation.resume' : 'automation.pause',
      arguments: { automation_id: current.id }, expected_revision: current.revision,
    })
    if (response.ok) return response.data as Automation
    if (response.error?.code === 'revision_conflict' && attempt === 0) {
      const latest = await api.controlGet({ resource: 'automation', id: current.id })
      if (!latest.data) throw new Error('This automation is no longer available.')
      current = latest.data as Automation
      if ((current.state === 'enabled') === enabled) return current
      continue
    }
    if (response.error) throw new ControlOperationError(response.error)
    throw new Error('Could not update automation.')
  }
  throw new Error('Could not update automation.')
}
