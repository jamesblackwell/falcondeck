import { useState, useRef } from 'react'
import {
  Badge,
  Button,
  Card,
  SettingList,
  SettingRow,
  SettingsPage,
  SettingsPageHeader,
  SettingsSection,
} from '@falcondeck/ui'
import {
  Archive,
  ArrowDownToLine,
  ArrowUpFromLine,
  CheckCircle2,
  AlertTriangle,
  Folder,
  RefreshCw,
  Trash2,
} from 'lucide-react'

import type { BackupSummary, FalconDeckBackup } from '@falcondeck/client-core'
import {
  exportBackup,
  inspectBackupFile,
  executeImportBackup,
  resetLocalAppState,
} from '../../backup-service'

export type BackupPanelProps = {
  baseUrl: string | null
  onToast: (toast: {
    variant: 'success' | 'danger' | 'warning' | 'default'
    title: string
    description?: string
  }) => void
}

export function BackupPanel({ baseUrl, onToast }: BackupPanelProps) {
  const [isExporting, setIsExporting] = useState(false)
  const [isInspecting, setIsInspecting] = useState(false)
  const [isImporting, setIsImporting] = useState(false)
  const [pendingBackup, setPendingBackup] = useState<{
    backup: FalconDeckBackup
    summary: BackupSummary
    filename: string
  } | null>(null)
  const [pathMappings, setPathMappings] = useState<Record<string, string>>({})

  const fileInputRef = useRef<HTMLInputElement>(null)

  const handleExport = async () => {
    if (!baseUrl) {
      onToast({
        variant: 'danger',
        title: 'FalconDeck daemon not connected',
        description: 'Wait for the local daemon to connect before exporting.',
      })
      return
    }

    setIsExporting(true)
    try {
      await exportBackup(baseUrl)
      onToast({
        variant: 'success',
        title: 'Backup exported successfully',
        description: 'Full FalconDeck archive downloaded as JSON.',
      })
    } catch (err) {
      onToast({
        variant: 'danger',
        title: 'Export failed',
        description: err instanceof Error ? err.message : String(err),
      })
    } finally {
      setIsExporting(false)
    }
  }

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file || !baseUrl) return

    setIsInspecting(true)
    try {
      const { backup, summary } = await inspectBackupFile(file, baseUrl)
      setPendingBackup({ backup, summary, filename: file.name })
      setPathMappings({})
    } catch (err) {
      onToast({
        variant: 'danger',
        title: 'Could not read backup file',
        description: err instanceof Error ? err.message : String(err),
      })
      setPendingBackup(null)
    } finally {
      setIsInspecting(false)
      if (fileInputRef.current) {
        fileInputRef.current.value = ''
      }
    }
  }

  const handleConfirmImport = async () => {
    if (!pendingBackup || !baseUrl) return

    setIsImporting(true)
    try {
      const result = await executeImportBackup(
        pendingBackup.backup,
        pathMappings,
        baseUrl,
      )
      onToast({
        variant: 'success',
        title: 'Backup restored successfully',
        description: `Imported ${result.workspaces_imported} workspace(s), ${result.extensions_imported} extension(s), and ${result.automations_imported} automation(s).`,
      })
      setPendingBackup(null)
    } catch (err) {
      onToast({
        variant: 'danger',
        title: 'Import failed',
        description: err instanceof Error ? err.message : String(err),
      })
    } finally {
      setIsImporting(false)
    }
  }

  const handleResetLocal = () => {
    if (
      window.confirm(
        'Reset local desktop preferences (appearance, sounds, shortcuts) and replay onboarding at next launch?',
      )
    ) {
      resetLocalAppState()
      onToast({
        variant: 'success',
        title: 'Local state reset',
        description: 'Desktop preferences cleared. Reload the app to start fresh.',
      })
    }
  }

  return (
    <SettingsPage>
      <SettingsPageHeader
        title="Backup & Data"
        description="Export and import your workspaces, preferences, extensions, automations, and connectors across machines or fresh installations."
      />

      <input
        type="file"
        ref={fileInputRef}
        onChange={handleFileChange}
        accept=".json,application/json"
        className="hidden"
        data-testid="backup-file-input"
      />

      <SettingsSection
        title="Export Backup"
        description="Generate a portable JSON archive of your full FalconDeck setup."
      >
        <SettingList>
          <SettingRow
            title="Full FalconDeck Archive"
            description="Includes workspace pins, appearance & conversation preferences, extension data (Notes, Missions), automations, and connectors."
            control={
              <Button
                variant="secondary"
                onClick={handleExport}
                disabled={isExporting || !baseUrl}
                className="gap-2"
              >
                <ArrowDownToLine className="h-4 w-4" />
                {isExporting ? 'Exporting…' : 'Export Full Backup…'}
              </Button>
            }
          />
        </SettingList>
      </SettingsSection>

      <SettingsSection
        title="Import Backup"
        description="Restore settings, projects, and extensions from a previous backup file."
      >
        {!pendingBackup ? (
          <SettingList>
            <SettingRow
              title="Restore from Archive"
              description="Upload a .json backup file to inspect and restore."
              control={
                <Button
                  variant="secondary"
                  onClick={() => fileInputRef.current?.click()}
                  disabled={isInspecting || !baseUrl}
                  className="gap-2"
                >
                  <ArrowUpFromLine className="h-4 w-4" />
                  {isInspecting ? 'Inspecting…' : 'Select Backup File…'}
                </Button>
              }
            />
          </SettingList>
        ) : (
          <div className="space-y-4 rounded-[var(--fd-radius-lg)] border border-border-subtle bg-surface-2 p-4">
            <div className="flex items-center justify-between border-b border-border-subtle pb-3">
              <div>
                <h4 className="text-[length:var(--fd-text-sm)] font-medium text-fg-primary">
                  Preview: {pendingBackup.filename}
                </h4>
                <p className="text-[length:var(--fd-text-xs)] text-fg-muted">
                  Created {new Date(pendingBackup.summary.created_at).toLocaleString()}
                  {pendingBackup.summary.app_version && ` • FalconDeck v${pendingBackup.summary.app_version}`}
                </p>
              </div>
              <Badge variant="default">Schema v{pendingBackup.summary.version}</Badge>
            </div>

            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <div className="rounded-[var(--fd-radius-md)] bg-surface-1 p-2.5">
                <span className="text-[length:var(--fd-text-xs)] text-fg-muted">Workspaces</span>
                <p className="text-[length:var(--fd-text-base)] font-semibold text-fg-primary">
                  {pendingBackup.summary.workspace_count}
                </p>
              </div>
              <div className="rounded-[var(--fd-radius-md)] bg-surface-1 p-2.5">
                <span className="text-[length:var(--fd-text-xs)] text-fg-muted">Extensions</span>
                <p className="text-[length:var(--fd-text-base)] font-semibold text-fg-primary">
                  {pendingBackup.summary.extension_count}
                </p>
              </div>
              <div className="rounded-[var(--fd-radius-md)] bg-surface-1 p-2.5">
                <span className="text-[length:var(--fd-text-xs)] text-fg-muted">Automations</span>
                <p className="text-[length:var(--fd-text-base)] font-semibold text-fg-primary">
                  {pendingBackup.summary.automation_count}
                </p>
              </div>
              <div className="rounded-[var(--fd-radius-md)] bg-surface-1 p-2.5">
                <span className="text-[length:var(--fd-text-xs)] text-fg-muted">Connectors</span>
                <p className="text-[length:var(--fd-text-base)] font-semibold text-fg-primary">
                  {pendingBackup.summary.connector_count}
                </p>
              </div>
            </div>

            {pendingBackup.summary.workspaces.length > 0 && (
              <div className="space-y-2">
                <span className="text-[length:var(--fd-text-xs)] font-medium text-fg-secondary">
                  Workspaces to register:
                </span>
                <div className="max-h-48 overflow-y-auto rounded-[var(--fd-radius-md)] border border-border-subtle bg-surface-1 p-2 space-y-1.5">
                  {pendingBackup.summary.workspaces.map((ws) => (
                    <div
                      key={ws.path}
                      className="flex items-center justify-between text-[length:var(--fd-text-xs)] py-1 px-1.5 rounded hover:bg-surface-2"
                    >
                      <div className="flex items-center gap-2 min-w-0">
                        <Folder className="h-3.5 w-3.5 text-fg-muted shrink-0" />
                        <span className="truncate text-fg-primary font-mono">{ws.path}</span>
                      </div>
                      {ws.exists_on_disk ? (
                        <span className="flex items-center gap-1 text-emerald-500 shrink-0">
                          <CheckCircle2 className="h-3.5 w-3.5" /> Found
                        </span>
                      ) : (
                        <span className="flex items-center gap-1 text-amber-500 shrink-0" title="Directory not found locally; will be registered as saved workspace.">
                          <AlertTriangle className="h-3.5 w-3.5" /> Missing locally
                        </span>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            )}

            {pendingBackup.summary.extensions.length > 0 && (
              <div className="space-y-1.5">
                <span className="text-[length:var(--fd-text-xs)] font-medium text-fg-secondary">
                  Extension data:
                </span>
                <div className="flex flex-wrap gap-1.5">
                  {pendingBackup.summary.extensions.map((ext) => (
                    <Badge key={ext} variant="secondary">
                      {ext}
                    </Badge>
                  ))}
                </div>
              </div>
            )}

            <div className="flex items-center justify-end gap-2 pt-2 border-t border-border-subtle">
              <Button
                variant="ghost"
                onClick={() => setPendingBackup(null)}
                disabled={isImporting}
              >
                Cancel
              </Button>
              <Button
                variant="primary"
                onClick={handleConfirmImport}
                disabled={isImporting}
                className="gap-2"
              >
                <RefreshCw className={`h-4 w-4 ${isImporting ? 'animate-spin' : ''}`} />
                {isImporting ? 'Restoring…' : 'Confirm & Restore Backup'}
              </Button>
            </div>
          </div>
        )}
      </SettingsSection>

      <SettingsSection
        title="Developer / Testing Clean Slate"
        description="Quickly reset application state when testing fresh onboarding flows."
      >
        <SettingList>
          <SettingRow
            title="Reset WebKit State"
            description="Clears desktop localStorage preferences (theme, sounds, shortcuts) and reactivates the onboarding wizard."
            control={
              <Button
                variant="danger"
                onClick={handleResetLocal}
                className="gap-2"
              >
                <Trash2 className="h-4 w-4" />
                Reset Local Storage
              </Button>
            }
          />
          <SettingRow
            title="Full Daemon & WebKit Stash (CLI)"
            description="Run 'npm run state:fresh' in your terminal to stash ~/.falcondeck and WebKit data, or 'npm run state:restore' to put it back."
            control={
              <code className="rounded bg-surface-2 px-2 py-1 text-[length:var(--fd-text-xs)] text-fg-muted font-mono">
                npm run state:fresh
              </code>
            }
          />
        </SettingList>
      </SettingsSection>
    </SettingsPage>
  )
}
